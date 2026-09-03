// 设置页（MIUIX 三段式）：翻译服务 / 译文样式 / 图片翻译
// 普通浏览器中打开时进入预览模式（chrome.storage 不可用）

(() => {
  'use strict';

  const PROVIDER_META = {
    zhipu: {
      model: 'glm-4.7-flash',
      main: '智谱 BigModel',
      sub: 'glm-4.7-flash 免费 · 国内直连（推荐）',
      hint: '到 <a href="https://open.bigmodel.cn/userinfo/apikey" target="_blank">open.bigmodel.cn</a> 注册后创建 API Key；flash 系列免费，繁忙时自动降级 glm-4-flash-250414。',
    },
    bailian: {
      model: 'qwen3.5-flash',
      main: '阿里云百炼',
      sub: '千问全系列 · 新人每模型 100 万 Token',
      hint: '到 <a href="https://bailian.console.aliyun.com/" target="_blank">bailian.console.aliyun.com</a> 开通百炼取 API-KEY；千问系列翻译质量好，国内直连。',
    },
    volc: {
      model: 'doubao-seed-1.6-flash-250815',
      main: '火山方舟 · 豆包',
      sub: '新用户每日 200 万 Token · 每日续杯',
      hint: '到 <a href="https://console.volcengine.com/ark" target="_blank">console.volcengine.com/ark</a> 创建 API Key；免费额度每日刷新；模型名可在方舟控制台「在线推理」页查看并修改。',
    },
    siliconflow: {
      model: 'Qwen/Qwen3-8B',
      main: '硅基流动',
      sub: 'Qwen3-8B 等 0 元小模型',
      hint: '到 <a href="https://cloud.siliconflow.cn/account/ak" target="_blank">cloud.siliconflow.cn</a> 注册，模型中心带「免费」标签的模型 0 元可用（有 RPM 限速）。',
    },
    gemini: {
      model: 'gemini-flash-latest',
      main: 'Google Gemini',
      sub: '免费档 · 需代理',
      hint: '到 <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com</a> 免费创建 Key；国内需代理；走 Gemini 的 OpenAI 兼容端点。',
    },
    groq: {
      model: 'llama-3.3-70b-versatile',
      main: 'Groq',
      sub: 'llama-3.3-70b 免费档 · 需代理',
      hint: '到 <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a> 免费创建 Key；国内网络需代理访问。',
    },
    custom: {
      model: '',
      main: '自定义',
      sub: 'Ollama / OpenRouter / one-api 等 OpenAI 兼容',
      hint: '任意 OpenAI 兼容端点。Ollama：<code>http://localhost:11434/v1/chat/completions</code>（Key 任意填）；OpenRouter 免费模型名以 <code>:free</code> 结尾。',
    },
  };

  const V_PROVIDER_META = {
    zhipu: {
      main: '智谱 BigModel（同 Key 通用）',
      sub: 'glm-4.6v-flash 视觉免费',
      hint: '与翻译服务共用同一个智谱 Key，视觉 Key 留空即可。glm-4.6v-flash 完全免费。',
    },
    custom: {
      main: '自定义 OpenAI 兼容视觉端点',
      sub: '支持 image_url 消息的任意端点',
      hint: '填写支持视觉输入的 OpenAI 兼容完整 URL（需支持 messages 中 image_url 类型）。',
    },
  };

  const STYLES = [
    { v: 'color',   name: '简约彩字', hint: '默认样式：译文以所选颜色显示在原文下方。' },
    { v: 'blur',    name: '悬停显示', hint: '译文默认模糊，鼠标掠过才清晰，不剧透、适合先自读原文。' },
    { v: 'dashed',  name: '虚线下划线', hint: '译文加虚线下划线，与原文轻量区隔。' },
    { v: 'bg',      name: '浅色底纹', hint: '译文带浅色背景色块，颜色跟随译文颜色。' },
    { v: 'quote',   name: '引用竖线', hint: '仿引用块样式，左侧竖线缩进显示。' },
    { v: 'card',    name: '卡片边框', hint: '译文装进圆角卡片，区隔感最强。' },
    { v: 'italic',  name: '斜体淡彩', hint: '斜体 + 淡化，最不干扰原版式。' },
    { v: 'marker',  name: '荧光笔', hint: '黄色荧光笔划过效果，文字颜色跟随原文（不使用自定义颜色）。' },
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    providerHint: $('providerHint'), provList: $('provList'),
    customUrlRow: $('customUrlRow'), customBaseUrl: $('customBaseUrl'),
    apiKey: $('apiKey'), model: $('model'), targetLang: $('targetLang'),
    styleGallery: $('styleGallery'), styleHint: $('styleHint'),
    trColor: $('trColor'), previewTr: $('previewTr'),
    swEnableImage: $('swEnableImage'), imgMinSize: $('imgMinSize'),
    vProvList: $('vProvList'), vProviderHint: $('vProviderHint'),
    vCustomRow: $('vCustomRow'), visionCustomUrl: $('visionCustomUrl'),
    visionModel: $('visionModel'), visionApiKey: $('visionApiKey'),
    btnTest: $('btnTest'), status: $('status'),
  };

  let current = {
    provider: 'zhipu', apiKey: '', model: '', customBaseUrl: '',
    targetLang: '简体中文', trColor: '#3482FF', trStyle: 'color',
    enableImage: true, imgMinSize: 200,
    visionProvider: 'zhipu', visionModel: 'glm-4.6v-flash',
    visionApiKey: '', visionCustomUrl: '',
    autoTranslate: false, blacklist: '', customInstruction: '', enableSubtitle: true,
    backupProvider: '', backupApiKey: '',
  };

  function setStatus(text, cls) {
    els.status.textContent = text || '';
    els.status.className = cls || '';
  }

  // ---------- tab 切换 ----------
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ---------- 服务商单选列表 ----------
  function buildProvList(container, meta, value, onPick) {
    container.innerHTML = '';
    for (const key of Object.keys(meta)) {
      const m = meta[key];
      const div = document.createElement('div');
      div.className = 'prov' + (key === value ? ' sel' : '');
      div.dataset.v = key;
      div.innerHTML =
        '<span class="radio"></span><span><div class="p-main">' + m.main + '</div>' +
        (m.sub ? '<div class="p-sub">' + m.sub + '</div>' : '') + '</span>';
      div.addEventListener('click', () => onPick(key));
      container.appendChild(div);
    }
  }

  function applyProviderUI(fillModel) {
    const meta = PROVIDER_META[current.provider];
    els.providerHint.innerHTML = meta.hint;
    els.customUrlRow.style.display = current.provider === 'custom' ? '' : 'none';
    if (fillModel) els.model.value = meta.model;
    buildProvList(els.provList, PROVIDER_META, current.provider, (v) => {
      current.provider = v;
      applyProviderUI(true);
    });
  }

  function applyVProviderUI() {
    els.vProviderHint.innerHTML = V_PROVIDER_META[current.visionProvider].hint;
    els.vCustomRow.style.display = current.visionProvider === 'custom' ? '' : 'none';
    buildProvList(els.vProvList, V_PROVIDER_META, current.visionProvider, (v) => {
      current.visionProvider = v;
      applyVProviderUI();
    });
  }

  // ---------- 样式画廊 ----------
  function applyStyle(v) {
    current.trStyle = v;
    els.styleGallery.querySelectorAll('.opt').forEach((el) => {
      el.classList.toggle('sel', el.dataset.v === v);
    });
    const meta = STYLES.find((s) => s.v === v);
    els.styleHint.textContent = meta ? meta.hint : '';
    els.previewTr.className = 'ift-tr ift-s-' + v;
  }

  function buildGallery() {
    for (const s of STYLES) {
      const card = document.createElement('div');
      card.className = 'opt';
      card.dataset.v = s.v;
      card.innerHTML =
        '<div class="demo ift-tr ift-s-' + s.v + '">这是译文预览</div>' +
        '<div class="name">' + s.name + '</div>';
      card.addEventListener('click', () => applyStyle(s.v));
      els.styleGallery.appendChild(card);
    }
  }

  // ---------- 开关与联动 ----------
  function bindSwitch(id, key, onChange) {
    const el = $(id);
    const apply = () => {
      el.classList.toggle('on', !!current[key]);
      el.setAttribute('aria-checked', String(!!current[key]));
    };
    const toggle = () => {
      current[key] = !current[key];
      apply();
      if (onChange) onChange();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    return apply;
  }
  const applyImgSw = bindSwitch('swEnableImage', 'enableImage');
  const applyAutoSw = bindSwitch('swAutoTranslate', 'autoTranslate');
  const applySubSw = bindSwitch('swSubtitle', 'enableSubtitle');

  $('blacklist').addEventListener('change', () => { current.blacklist = $('blacklist').value; });
  $('customInstruction').addEventListener('change', () => { current.customInstruction = $('customInstruction').value; });
  els.imgMinSize.addEventListener('change', () => {
    const n = parseInt(els.imgMinSize.value, 10);
    current.imgMinSize = isNaN(n) ? 200 : Math.min(2000, Math.max(80, n));
    els.imgMinSize.value = current.imgMinSize;
  });
  els.trColor.addEventListener('input', () => {
    current.trColor = els.trColor.value;
    syncPreviewColor();
  });

  function syncPreviewColor() {
    document.documentElement.style.setProperty('--ift-color', current.trColor);
  }

  // ---------- 保存 / 测试 ----------
  function collectForm() {
    current.apiKey = els.apiKey.value.trim();
    current.model = els.model.value.trim() || PROVIDER_META[current.provider].model;
    current.customBaseUrl = els.customBaseUrl.value.trim();
    current.targetLang = els.targetLang.value;
    current.trColor = els.trColor.value;
    current.imgMinSize = parseInt(els.imgMinSize.value, 10) || 200;
    current.visionModel = els.visionModel.value.trim() || 'glm-4.6v-flash';
    current.visionApiKey = els.visionApiKey.value.trim();
    current.visionCustomUrl = els.visionCustomUrl.value.trim();
    current.blacklist = $('blacklist').value;
    current.customInstruction = $('customInstruction').value;
    current.backupProvider = $('backupProvider').value;
    current.backupApiKey = $('backupApiKey').value.trim();
    return current;
  }

  function save() {
    const cfg = collectForm();
    if (!cfg.apiKey) {
      setStatus('请先填写 API Key（翻译服务）', 'err');
      document.querySelector('.tabs button[data-tab="service"]').click();
      return;
    }
    if (cfg.provider === 'custom' && !cfg.customBaseUrl) {
      setStatus('自定义服务商需填写 API 地址', 'err');
      return;
    }
    if (cfg.visionProvider === 'custom' && !cfg.visionCustomUrl) {
      setStatus('自定义视觉服务商需填写 API 地址', 'err');
      return;
    }
    chrome.storage.sync.set(cfg, () => setStatus('已保存 ✓（已打开的页面即时生效）', 'ok'));
  }

  ['btnSave', 'btnSave2', 'btnSave3'].forEach((id) => $(id).addEventListener('click', save));

  els.btnTest.addEventListener('click', async () => {
    const cfg = collectForm();
    if (!cfg.apiKey) {
      setStatus('请先填写 API Key', 'err');
      return;
    }
    await chrome.storage.sync.set(cfg);
    setStatus('测试中…', '');
    chrome.runtime.sendMessage({ type: 'test' }, (r) => {
      void chrome.runtime.lastError;
      if (r && r.ok) setStatus('连接成功：「' + r.text + '」', 'ok');
      else setStatus('失败：' + ((r && r.error) || '无响应'), 'err');
    });
  });

  // ---------- 初始化 ----------
  const storageApi = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage : null;
  buildGallery();

  if (!storageApi) {
    // 浏览器预览模式
    els.visionModel.value = current.visionModel;
    els.imgMinSize.value = current.imgMinSize;
    applyProviderUI(false);
    applyVProviderUI();
    applyStyle('color');
    syncPreviewColor();
    document.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
    setStatus('预览模式：请通过扩展打开本页进行配置', '');
  } else {
    storageApi.sync.get({ ...current }, (s) => {
      Object.assign(current, s);
      els.apiKey.value = s.apiKey;
      els.model.value = s.model || PROVIDER_META[s.provider].model;
      els.customBaseUrl.value = s.customBaseUrl;
      els.targetLang.value = s.targetLang;
      els.trColor.value = s.trColor;
      els.imgMinSize.value = s.imgMinSize;
      els.visionModel.value = s.visionModel;
      els.visionApiKey.value = s.visionApiKey;
      els.visionCustomUrl.value = s.visionCustomUrl;
      $('backupProvider').value = s.backupProvider || '';
      $('backupApiKey').value = s.backupApiKey || '';
      els.swEnableImage.classList.toggle('on', s.enableImage !== false);
      els.swEnableImage.setAttribute('aria-checked', String(s.enableImage !== false));
      $('blacklist').value = s.blacklist || '';
      $('customInstruction').value = s.customInstruction || '';
      applyAutoSw();
      applySubSw();
      applyProviderUI(false);
      applyVProviderUI();
      applyStyle(STYLES.some((x) => x.v === s.trStyle) ? s.trStyle : 'color');
      syncPreviewColor();
    });
  }
})();
