// 沉浸式免费翻译 - Service Worker
// 职责：持有 API 配置、限速调用 LLM、解析 JSON 批量翻译、转发快捷键命令

'use strict';

// ---------- 服务商预设（全部 OpenAI 兼容协议） ----------
const PROVIDERS = {
  zhipu: {
    label: '智谱 BigModel（glm-4.7-flash 免费）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4.7-flash',
    keyUrl: 'https://open.bigmodel.cn/userinfo/apikey',
    keyHint: 'open.bigmodel.cn → 控制台 → API Keys，glm-4.7-flash 模型完全免费',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（Qwen3-8B 等免费档）',
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    defaultModel: 'Qwen/Qwen3-8B',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyHint: 'cloud.siliconflow.cn 注册送额度，且有多款 0 元小模型（带「免费」标签）',
  },
  groq: {
    label: 'Groq（llama-3.3-70b 免费档，需代理）',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'console.groq.com 免费注册；国内网络需代理才能访问',
  },
  custom: {
    label: '自定义（OpenAI 兼容：Ollama / OpenRouter / one-api…）',
    baseUrl: '',
    defaultModel: '',
    keyUrl: '',
    keyHint: '填写任意 OpenAI 兼容完整 URL。本地 Ollama 填 http://localhost:11434/v1/chat/completions（Key 任意）',
  },
};

const DEFAULT_SETTINGS = {
  provider: 'zhipu',
  apiKey: '',
  model: 'glm-4.7-flash',
  customBaseUrl: '',
  targetLang: '简体中文',
  trColor: '#3482FF',
  trStyle: 'color',
  // 图片/漫画翻译（视觉模型，独立配置，默认智谱免费档）
  enableImage: true,
  enableHover: true,
  imgMinSize: 200,
  visionProvider: 'zhipu',
  visionModel: 'glm-4.6v-flash',
  visionApiKey: '',
  visionCustomUrl: '',
  // 偏好与规则
  autoTranslate: false,
  blacklist: '',
  customInstruction: '',
  enableSubtitle: true,
};

async function getVisionSettings() {
  const s = await getSettings();
  // 视觉 Key 默认复用主 Key（智谱 Key 文本/视觉通用）
  return {
    provider: s.visionProvider,
    model: s.visionModel,
    apiKey: s.visionApiKey || s.apiKey,
    customBaseUrl: s.visionCustomUrl,
    preset: PROVIDERS[s.visionProvider] || PROVIDERS.zhipu,
  };
}

async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const preset = PROVIDERS[s.provider] || PROVIDERS.zhipu;
  // 退役模型自动迁移：官方已宣布下线的模型（服务降级为挂起/极慢），
  // 已存的旧默认值必须显式迁移——只改 DEFAULT_SETTINGS 救不了老用户
  const RETIRED = { 'glm-4.5-flash': 'glm-4.7-flash' };
  if (RETIRED[s.model]) {
    s.model = RETIRED[s.model];
    try { chrome.storage.sync.set({ model: s.model }); } catch (_) {}
  }
  // model 为空时回落到该服务商默认模型
  if (!s.model) s.model = preset.defaultModel;
  return { ...s, preset };
}

// ---------- 全局限速：免费档并发敏感，最多 3 个在途请求 ----------
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiters = [];
function acquire() {
  return new Promise((resolve) => {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight++;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
}
function release() {
  inFlight--;
  if (waiters.length && inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    waiters.shift()();
  }
}

// ---------- LLM 调用 ----------
// 429（免费档过载，智谱 code 1305）应对：指数退避 + 全局冷却排队 + 智谱体系内自动降级轻量模型
let providerCooldownUntil = 0; // 429 后所有请求排队等待，避免雪上加霜
const ZHIPU_FALLBACK = 'glm-4-flash-250414';
const FALLBACK_TTL = 30 * 60 * 1000; // 降级决定保留 30 分钟，之后自动重试主力模型
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 降级状态存 session storage：SW 重启后仍生效，避免每个会话都重新挨一次超时
async function getZhipuFallback() {
  try {
    const s = await chrome.storage.session.get({ zhipuFallback: null });
    if (s.zhipuFallback && s.zhipuFallback.until > Date.now()) return s.zhipuFallback.model;
  } catch (_) {}
  return '';
}

async function setZhipuFallback(model) {
  try {
    await chrome.storage.session.set({ zhipuFallback: { model, until: Date.now() + FALLBACK_TTL } });
  } catch (_) {}
}

async function callLLM(settings, systemPrompt, userPrompt, maxTokens) {
  const url =
    settings.provider === 'custom'
      ? settings.customBaseUrl
      : settings.preset.baseUrl;
  if (!url) throw new Error('未配置 API 地址（自定义服务商需填 Base URL）');
  if (!settings.apiKey) throw new Error('未配置 API Key，请到设置页填写');

  let model = settings.model;
  if (settings.provider === 'zhipu') {
    const fb = await getZhipuFallback();
    if (fb && model !== fb) model = fb; // 会话内已确认主模型过载，直接走降级
  }

  const result = await callModelWithRetry(settings, url, model, systemPrompt, userPrompt, maxTokens);
  if (result.ok) return result.content;

  // 智谱主模型持续 429/超时：同 Key 自动降级到免费轻量款再试
  if (
    settings.provider === 'zhipu' &&
    result.rateLimited &&
    model !== ZHIPU_FALLBACK
  ) {
    await setZhipuFallback(ZHIPU_FALLBACK);
    const fb = await callModelWithRetry(settings, url, ZHIPU_FALLBACK, systemPrompt, userPrompt, maxTokens);
    if (fb.ok) return fb.content;
    throw fb.error;
  }
  throw result.error;
}

// ---------- 按官方 API 规范构建请求体 ----------
// 智谱对话补全规范（docs.bigmodel.cn 对话补全 API）：
// - do_sample:false 时忽略 temperature/top_p，官方推荐用于翻译等一致性任务
// - response_format:{type:'json_object'} 保证输出合法 JSON（文本模型支持）
// - thinking 仅 GLM-4.5+ 支持；GLM-4.7 系列强制思考关不掉；4.5/4.6 可 disabled 提速
function buildRequestBody(settings, model, systemPrompt, userPrompt, maxTokens) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.6,
    max_tokens: Math.max(2000, maxTokens),
  };

  if (settings.provider === 'zhipu') {
    body.do_sample = false; // 翻译一致性；同时绕开 temperature 约束差异
    body.response_format = { type: 'json_object' };
    if (/^glm-4\.7/.test(model)) {
      // 4.7 系列强制思考：不传 thinking，输出预算放大容纳 reasoning
      body.max_tokens = Math.max(4096, maxTokens * 2);
    } else if (/^glm-4\.[56]/.test(model)) {
      body.thinking = { type: 'disabled' }; // 4.5/4.6 可关思考提速
    }
    // glm-4 老款（4-flash-250414 等）不支持 thinking 字段，不传
  } else if (settings.provider === 'siliconflow' && /^Qwen\/Qwen3/i.test(model)) {
    body.enable_thinking = false; // Qwen3 hybrid 关思考
  }
  return body;
}

async function callModelWithRetry(settings, url, model, systemPrompt, userPrompt, maxTokens) {
  const base = buildRequestBody(settings, model, systemPrompt, userPrompt, maxTokens);

  // 参数自适应降级：4xx 时逐步去掉可选参数重试（兼容各代模型校验差异）
  const variants = [
    (b) => b,
    (b) => {
      const c = { ...b };
      delete c.thinking;
      delete c.enable_thinking;
      return c;
    },
    (b) => {
      const c = { ...b };
      delete c.thinking;
      delete c.enable_thinking;
      delete c.response_format;
      delete c.do_sample;
      delete c.temperature;
      return c;
    },
  ];

  // 429/5xx 指数退避：1s → 2.5s → 5s
  const BACKOFF = [1000, 2500, 5000];
  let rateLimited = false;
  let lastErr = null;

  for (let round = 0; round <= BACKOFF.length; round++) {
    if (round > 0) await sleep(BACKOFF[round - 1]);
    // 全局冷却排队（429 后其他在途请求让服务器喘口气）
    const cool = providerCooldownUntil - Date.now();
    if (cool > 0) await sleep(cool);

    for (const build of variants) {
      let res;
      // 超时保护：4.7 系列强制思考且免费档排队慢，20s 没回直接降级；其他模型 45s
      const timeoutMs = /^glm-4\.7/.test(model) ? 20000 : 45000;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + settings.apiKey,
          },
          body: JSON.stringify(build(base)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        const timedOut = /abort|timeout|超时/i.test(msg);
        lastErr = new Error((timedOut ? '模型响应超时（' + Math.round(timeoutMs / 1000) + 's，服务器繁忙）' : '网络错误：') + (timedOut ? '' : msg));
        if (timedOut) return { ok: false, rateLimited: true, error: lastErr }; // 触发智谱自动降级换模型
        return { ok: false, error: lastErr };
      }
      if (res.ok) {
        const data = await res.json();
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        let content = msg && typeof msg.content === 'string' ? msg.content : '';
        if (!content.trim() && msg && typeof msg.reasoning_content === 'string') {
          content = msg.reasoning_content;
        }
        if (!content.trim()) {
          lastErr = new Error('模型返回了空内容（可在设置页换模型试试）');
          continue; // 换参数变体再试
        }
        return { ok: true, content };
      }
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 160);
      } catch (_) {}
      lastErr = new Error('HTTP ' + res.status + ' ' + detail);
      if (res.status === 429 || res.status >= 500) {
        rateLimited = true;
        providerCooldownUntil = Date.now() + 2500; // 全局冷却 2.5s
        break; // 跳出变体循环，进入退避等待
      }
      // 其余 4xx：尝试更简参数变体
    }
  }
  if (rateLimited) {
    lastErr = new Error(
      '模型访问量过大（429），退避重试后仍限流' +
        (settings.provider === 'zhipu' ? '，将尝试自动切换轻量模型' : '')
    );
  }
  return { ok: false, rateLimited, error: lastErr || new Error('请求失败') };
}

// ---------- 翻译缓存（chrome.storage.local，7 天有效，跨页面/会话） ----------
const CACHE_PREFIX = 'tc:';
const IMG_CACHE_PREFIX = 'ic:';
const CACHE_TTL = 7 * 24 * 3600 * 1000;

function hashKey(str) {
  // FNV-1a 双通道，碰撞概率足够低且 key 短
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

function textCacheKey(text, targetLang, model, instruction) {
  return (
    CACHE_PREFIX +
    hashKey(text + '|' + targetLang + '|' + model + '|' + (instruction || '').slice(0, 64))
  );
}

function imgCacheKey(src, targetLang, model) {
  return IMG_CACHE_PREFIX + hashKey(src + '|' + targetLang + '|' + model);
}

async function cacheGet(keys) {
  try {
    const obj = await chrome.storage.local.get(keys);
    const now = Date.now();
    const map = {};
    for (const k of keys) {
      const e = obj[k];
      if (e && typeof e.v !== 'undefined' && now - e.t < CACHE_TTL) map[k] = e.v;
    }
    return map;
  } catch (_) {
    return {};
  }
}

async function cachePut(entries) {
  try {
    const obj = {};
    const now = Date.now();
    for (const [k, v] of entries) obj[k] = { v, t: now };
    await chrome.storage.local.set(obj);
  } catch (_) {}
}

// ---------- 批量翻译 ----------
function buildPrompts(items, targetLang, customInstruction) {
  const system =
    '你是网页翻译引擎。用户给出一个 JSON 数组，每项形如 {"id":数字,"text":"原文"}。' +
    `把每项 text 翻译成${targetLang}。要求：忠实原意、书面通顺；代码、命令、URL、邮箱、专有名词保留原文；不要扩写。` +
    (customInstruction && customInstruction.trim()
      ? '\n补充要求（优先级高于以上默认风格）：' + customInstruction.trim()
      : '') +
    '只输出 JSON 数组：[{"id":..,"text":"译文"}]，id 与输入一一对应，顺序一致，不要输出任何解释、前后缀或 Markdown 代码块。';
  return [system, JSON.stringify(items)];
}

function parseTranslations(raw, ids) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('返回内容不是 JSON 数组');
  }
  let arr;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new Error('JSON 解析失败: ' + e.message);
  }
  if (!Array.isArray(arr)) throw new Error('返回的不是数组');
  const map = {};
  for (const it of arr) {
    if (it && typeof it.id === 'number' && typeof it.text === 'string') {
      map[it.id] = it.text;
    }
  }
  const missing = ids.filter((id) => !(id in map));
  if (missing.length) throw new Error(`缺少 ${missing.length} 条译文（模型输出不完整）`);
  return map;
}

async function translateBatch(items, targetLang) {
  const settings = await getSettings();
  const keys = items.map((it) =>
    textCacheKey(it.text, targetLang, settings.model, settings.customInstruction)
  );
  // 1. 命中持久缓存的直接返回
  const cached = await cacheGet(keys);
  const map = {};
  const pending = [];
  items.forEach((it, i) => {
    if (cached[keys[i]] !== undefined) map[it.id] = cached[keys[i]];
    else pending.push({ it, key: keys[i] });
  });
  if (!pending.length) return { ok: true, map };

  // 2. 未命中的走 LLM
  const [system, user] = buildPrompts(
    pending.map((p) => p.it),
    targetLang,
    settings.customInstruction
  );
  const maxTokens = Math.min(8000, 600 + Math.ceil(user.length * 1.5));
  await acquire();
  try {
    let raw;
    try {
      raw = await callLLM(settings, system, user, maxTokens);
    } catch (e) {
      // 失败重试一次（免费档偶发 429/502）
      await new Promise((r) => setTimeout(r, 800));
      raw = await callLLM(settings, system, user, maxTokens);
    }
    const fresh = parseTranslations(raw, pending.map((p) => p.it.id));
    // 3. 合并 + 写入持久缓存
    const puts = [];
    pending.forEach((p) => {
      const t = fresh[p.it.id];
      if (typeof t === 'string') {
        map[p.it.id] = t;
        puts.push([p.key, t]);
      }
    });
    if (puts.length) cachePut(puts);
    return { ok: true, map };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    release();
  }
}

// ---------- 图片/漫画翻译（视觉模型） ----------
function buildVisionPrompt(targetLang) {
  return (
    '你是漫画/图片翻译引擎。找出图片中的所有文字（漫画气泡、标题、招牌、字幕等），并翻译成' +
    targetLang + '。' +
    '只输出 JSON 数组，不要任何解释或 Markdown，每项形如：' +
    '{"x":0.1,"y":0.2,"w":0.3,"h":0.1,"text":"识别出的原文","translation":"译文"}。' +
    'x/y/w/h 是每段文字紧密外接框相对整图的比例(0~1)。图片中没有文字时输出 []。'
  );
}

function parseVisionResult(raw) {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('返回内容不是 JSON 数组');
  const arr = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('返回的不是数组');
  const out = [];
  for (const it of arr) {
    const n = (v) => typeof v === 'number' && isFinite(v);
    if (
      it && n(it.x) && n(it.y) && n(it.w) && n(it.h) &&
      typeof it.translation === 'string' && it.translation.trim() &&
      it.w > 0.005 && it.h > 0.005 && it.w <= 1 && it.h <= 1 &&
      it.x >= 0 && it.y >= 0 && it.x + it.w <= 1.01 && it.y + it.h <= 1.01
    ) {
      out.push({ x: it.x, y: it.y, w: it.w, h: it.h, translation: it.translation.trim() });
    }
  }
  return out;
}

async function translateImage(src, targetLang) {
  const vs = await getVisionSettings();
  if (!vs.apiKey) throw new Error('未配置 API Key（视觉翻译默认复用翻译服务的 Key）');
  const url = vs.provider === 'custom' ? vs.customBaseUrl : vs.preset.baseUrl;
  if (!url) throw new Error('未配置视觉 API 地址');
  const model = vs.model || 'glm-4.6v-flash';

  // 图片翻译结果（含文字框坐标）持久缓存：漫画二刷零请求
  const imgKey = imgCacheKey(src, targetLang, model);
  const cachedImg = await cacheGet([imgKey]);
  if (cachedImg[imgKey] !== undefined) {
    return { ok: true, items: cachedImg[imgKey], cached: true };
  }

  // 拉图并转 base64（扩展后台不受 CORS 限制）
  let base64 = '', mime = 'image/png';
  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;,]+)[^,]*,(.*)$/);
    if (m) { mime = m[1]; base64 = m[2]; }
  } else {
    const imgRes = await fetch(src);
    if (!imgRes.ok) throw new Error('图片下载失败 HTTP ' + imgRes.status + '（可能被防盗链拦截）');
    mime = (imgRes.headers.get('content-type') || 'image/png').split(';')[0];
    const buf = new Uint8Array(await imgRes.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    base64 = btoa(binary);
  }
  if (!base64) throw new Error('图片内容为空');
  if (base64.length > 7 * 1024 * 1024) throw new Error('图片过大（>5MB），请缩放后重试');

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + base64 } },
          { type: 'text', text: buildVisionPrompt(targetLang) },
        ],
      },
    ],
    max_tokens: 3000,
  };
  // 按官方规范：视觉模型用 do_sample:false（一致性，忽略温度）；
  // 4.6V 思考可关提速；4.5V 同理；不支持 thinking 的老款走参数降级变体兜底
  if (vs.provider === 'zhipu') {
    body.do_sample = false;
    if (/^glm-4\.[56]/.test(model)) body.thinking = { type: 'disabled' };
  }

  await acquire();
  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + vs.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, 800));
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + vs.apiKey,
        },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (_) {}
      throw new Error('HTTP ' + res.status + ' ' + detail);
    }
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let content = msg && typeof msg.content === 'string' ? msg.content : '';
    if (!content.trim() && msg && typeof msg.reasoning_content === 'string') {
      content = msg.reasoning_content;
    }
    if (!content.trim()) throw new Error('模型返回了空内容');
    const items = parseVisionResult(content);
    if (items.length) cachePut([[imgKey, items]]);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    release();
  }
}

// ---------- 消息入口 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'translate') {
    const items = Array.isArray(msg.items) ? msg.items : [];
    const target = msg.targetLang || '简体中文';
    translateBatch(items, target).then(sendResponse);
    return true; // 异步响应
  }

  if (msg.type === 'test') {
    translateBatch([{ id: 1, text: 'Hello, this is a translation test.' }], '简体中文')
      .then((r) =>
        sendResponse(
          r.ok
            ? { ok: true, text: r.map[1] }
            : { ok: false, error: r.error }
        )
      );
    return true;
  }

  if (msg.type === 'translateImage') {
    translateImage(msg.src || '', msg.targetLang || '简体中文').then(sendResponse);
    return true;
  }

  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'cacheKey') {
    getSettings().then((s) => {
      sendResponse(textCacheKey(String(msg.text || ''), msg.targetLang || '简体中文', s.model, s.customInstruction));
    });
    return true;
  }

  if (msg.type === 'cachePut') {
    // 页面侧手动修正译文后回写持久缓存（key 由 background 统一计算规则）
    if (typeof msg.key === 'string' && msg.key.startsWith(CACHE_PREFIX)) {
      cachePut([[msg.key, String(msg.value || '')]]);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'bad key' });
    }
    return;
  }

  if (msg.type === 'getSettings') {
    getSettings().then((s) => {
      // 不把完整 key 回传给页面脚本，只回显尾 4 位
      sendResponse({
        ok: true,
        provider: s.provider,
        model: s.model,
        hasKey: !!s.apiKey,
        keyTail: s.apiKey ? s.apiKey.slice(-4) : '',
        targetLang: s.targetLang,
      });
    });
    return true;
  }
});

// ---------- 右键菜单 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ift-page',
      title: '翻译 / 还原本页',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'ift-selection',
      title: '翻译选中文字',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'ift-image',
      title: '翻译此图片',
      contexts: ['image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const send = (msg) =>
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  if (info.menuItemId === 'ift-page') send({ type: 'ctxPage' });
  else if (info.menuItemId === 'ift-selection') {
    // 选中文本由 content 侧自行读取（右键时选区仍在）
    send({ type: 'ctxSelection' });
  } else if (info.menuItemId === 'ift-image') {
    send({ type: 'ctxImage', src: info.srcUrl });
  }
});

// ---------- 快捷键：转发给当前标签页的 content script ----------
const COMMAND_TAB_MESSAGE = {
  'toggle-translate': 'toggle',
  'toggle-sidepanel': 'sidepanel',
};

chrome.commands.onCommand.addListener(async (command) => {
  const msgType = COMMAND_TAB_MESSAGE[command];
  if (!msgType) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: msgType });
  } catch (_) {
    // 页面没有 content script（如 chrome:// 页面），忽略
  }
});
