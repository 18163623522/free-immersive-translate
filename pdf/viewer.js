// 双语 PDF 查看器：pdf.js 渲染 + 三种布局（覆盖 / 网页对照 / 双页对比）
// 既作为扩展页面运行（chrome.runtime 桥），也支持 ?mock=1 在普通页面演示/测试

import * as pdfjsLib from './pdf.min.mjs';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const fileUrl = qs.get('file');
const MOCK_MODE = qs.get('mock') === '1';

const isExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

// ---------- 桥接：翻译通道与设置 ----------
let sendTranslate;
let storageGet;

if (isExt) {
  sendTranslate = (payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (r) => {
          void chrome.runtime.lastError;
          resolve(r || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  storageGet = (defaults) => chrome.storage.sync.get(defaults);
} else if (MOCK_MODE) {
  sendTranslate = async (payload) => {
    await new Promise((r) => setTimeout(r, 300));
    const map = {};
    for (const it of payload.items) map[it.id] = '【译】' + it.text.slice(0, 28) + '……';
    return { ok: true, map };
  };
  storageGet = async (defaults) => ({
    ...defaults,
    ...(window.__IFT_MOCK_SETTINGS__ || {}),
  });
} else {
  sendTranslate = null;
  storageGet = async (d) => d;
}

const state = {
  pdf: null,
  scale: 1,
  baseWidth: 0,
  layout: 'overlay',    // overlay | web | dual
  pages: [],            // 每页 { pgEl, lines, paras, trHost }
  targetLang: '简体中文',
  trColor: '#3482FF',
  translating: false,
  cache: new Map(),     // 文本 -> 译文
};

// ---------- 语言判定（与 content.js 同规则，精简版） ----------
function scriptProfile(text) {
  let latin = 0, cjk = 0, kana = 0, hangul = 0, cyr = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin++;
    else if (c >= 0x4e00 && c <= 0x9fff) cjk++;
    else if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0xac00 && c <= 0xd7af) hangul++;
    else if (c >= 0x0400 && c <= 0x04ff) cyr++;
  }
  return { latin, cjk, kana, hangul, cyr };
}

function needsTranslate(text) {
  if (text.replace(/\s+/g, '').length < 2) return false;
  if (!/\p{L}/u.test(text)) return false;
  const p = scriptProfile(text);
  if (p.latin + p.cjk + p.kana + p.hangul + p.cyr < 2) return false;
  const key = ({ '简体中文': 'zh', '繁體中文': 'zh', 'English': 'latin', '日本語': 'ja', '한국어': 'ko', 'Русский': 'cyr' })[state.targetLang] || 'zh';
  if (key === 'zh') return !(p.cjk > p.latin + p.kana + p.hangul + p.cyr);
  const main = ['latin', 'cjk', 'kana', 'hangul', 'cyr'].reduce((a, b) => (p[a] >= p[b] ? a : b));
  const targetMain = { latin: 'latin', ja: 'kana', ko: 'hangul', cyr: 'cyr' }[key] || 'latin';
  return main !== targetMain;
}

// ---------- 文本抽取：textContent → 行 → 段落 ----------
// 用 PDF 变换矩阵直接算行位置（y 是基线、tr[3] 是字号），三种布局共用
function extractLines(textContent, viewport) {
  const scale = viewport.scale;
  const rows = [];
  for (const item of textContent.items) {
    const t = (item.str || '').trim();
    if (!t) continue;
    const tr = item.transform;
    const fs = Math.abs(tr[3]) * scale || 12;
    const x = tr[4] * scale;
    const y = viewport.height - tr[5] * scale; // PDF y 轴向上，翻成自顶向下坐标
    const row = rows.find((r) => Math.abs(r.y - y) <= Math.max(r.fs, fs) * 0.55);
    if (row) {
      row.items.push({ x, text: t });
      row.fs = Math.max(row.fs, fs);
    } else {
      rows.push({ y, fs, items: [{ x, text: t }] });
    }
  }
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    const text = r.items.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push({
      top: Math.max(0, r.y - r.fs * 0.85), // 基线上提约一个字高
      left: r.items[0].x,
      fs: r.fs,
      width: viewport.width,
      text,
    });
  }
  return lines;
}

// 行合并成段落：行距 < 1 行高视为同段
function linesToParas(lines) {
  const paras = [];
  let cur = null;
  for (const ln of lines) {
    if (cur && ln.top - cur.bottom < ln.fs * 0.85) {
      cur.text += (cur.text.endsWith('-') ? '' : ' ') + ln.text;
      cur.bottom = ln.top + ln.fs * 1.25;
    } else {
      cur = { top: ln.top, fs: ln.fs, text: ln.text, bottom: ln.top + ln.fs * 1.25 };
      paras.push(cur);
    }
  }
  return paras.filter((p) => p.text.trim().length > 1);
}

// ---------- 渲染 ----------
async function renderAll() {
  const viewer = $('viewer');
  viewer.innerHTML = '';
  viewer.className = state.layout;
  state.pages = [];
  const n = state.pdf.numPages;
  $('pageLabel').textContent = '共 ' + n + ' 页';

  for (let i = 1; i <= n; i++) {
    const page = await state.pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const fit = state.baseWidth / base.width;
    const viewport = page.getViewport({ scale: fit * state.scale });
    const dpr = window.devicePixelRatio || 1;
    const textContent = await page.getTextContent();
    const lines = extractLines(textContent, viewport);

    let pgEl, trHost;
    if (state.layout === 'overlay') {
      pgEl = document.createElement('div');
      pgEl.className = 'pg';
      pgEl.style.width = viewport.width + 'px';
      pgEl.style.height = viewport.height + 'px';
      const canvas = renderCanvas(page, viewport, dpr);
      pgEl.appendChild(canvas);
      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      pgEl.appendChild(textLayer);
      await new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport }).render();
      trHost = document.createElement('div');
      trHost.className = 'trLayer';
      pgEl.appendChild(trHost);
      viewer.appendChild(pgEl);
    } else if (state.layout === 'web') {
      pgEl = document.createElement('section');
      pgEl.className = 'pg-web';
      const no = document.createElement('div');
      no.className = 'web-pageno';
      no.textContent = '第 ' + i + ' 页 / ' + n;
      pgEl.appendChild(no);
      for (const para of linesToParas(lines)) {
        const wrap = document.createElement('div');
        wrap.className = 'web-para';
        const src = document.createElement('div');
        src.className = 'web-src';
        src.textContent = para.text;
        const tr = document.createElement('div');
        tr.className = 'web-tr';
        tr.textContent = '';
        wrap.appendChild(src);
        wrap.appendChild(tr);
        pgEl.appendChild(wrap);
      }
      trHost = pgEl;
      viewer.appendChild(pgEl);
    } else {
      // dual：左原页 canvas，右译文列
      pgEl = document.createElement('section');
      pgEl.className = 'pg-dual';
      const left = document.createElement('div');
      left.className = 'dual-left';
      const canvas = renderCanvas(page, viewport, dpr);
      left.appendChild(canvas);
      const right = document.createElement('div');
      right.className = 'dual-right';
      for (const para of linesToParas(lines)) {
        const d = document.createElement('div');
        d.className = 'web-src';
        d.textContent = para.text;
        d.dataset.para = '1';
        right.appendChild(d);
        const tr = document.createElement('div');
        tr.className = 'web-tr';
        right.appendChild(tr);
      }
      pgEl.appendChild(left);
      pgEl.appendChild(right);
      trHost = right;
      viewer.appendChild(pgEl);
    }
    state.pages.push({ pgEl, lines, paras: linesToParas(lines), trHost });
  }
}

function renderCanvas(page, viewport, dpr) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  return canvas;
}

// ---------- 翻译：按布局收集任务并批量执行 ----------
async function translateAll() {
  if (state.translating || !sendTranslate) return;
  state.translating = true;
  const btn = $('btnTranslate');
  btn.disabled = true;
  btn.textContent = '翻译中…';
  try {
    const jobs = [];
    for (const p of state.pages) {
      if (state.layout === 'overlay') {
        for (const line of p.lines) {
          if (!needsTranslate(line.text)) continue;
          const el = makeOverlayTr(line, '…');
          p.pgEl.querySelector('.trLayer').appendChild(el);
          jobs.push({ text: line.text, el });
        }
      } else {
        // web / dual：段落原文后面紧跟空译文节点
        const srcs = p.trHost.querySelectorAll('.web-src');
        srcs.forEach((src) => {
          const text = src.textContent.trim();
          if (!needsTranslate(text)) return;
          let tr = src.nextElementSibling;
          if (!tr || !tr.classList.contains('web-tr')) return;
          tr.textContent = '…';
          jobs.push({ text, el: tr });
        });
      }
    }
    if (!jobs.length) {
      $('status').textContent = '未发现需要翻译的内容';
      return;
    }

    const batches = [];
    let cur = [], chars = 0;
    for (const j of jobs) {
      if (cur.length && (cur.length >= 12 || chars + j.text.length > 1000)) {
        batches.push(cur); cur = []; chars = 0;
      }
      cur.push(j); chars += j.text.length;
    }
    if (cur.length) batches.push(cur);

    let idx = 0;
    let seq = 0;
    for (const j of jobs) j.el.style.animationDelay = Math.min((seq++ % 14) * 28, 380) + 'ms';

    const worker = async () => {
      while (idx < batches.length) {
        const batch = batches[idx++];
        const pending = batch.filter((j) => !state.cache.has(j.text));
        if (pending.length) {
          const res = await sendTranslate({
            type: 'translate',
            items: pending.map((j, i) => ({ id: i, text: j.text })),
            targetLang: state.targetLang,
          });
          if (res && res.ok) {
            pending.forEach((j, i) => {
              if (typeof res.map[i] === 'string' && res.map[i].trim()) {
                state.cache.set(j.text, res.map[i]);
              }
            });
          } else {
            $('status').textContent = '部分批次失败：' + ((res && res.error) || '未知错误');
          }
        }
        for (const j of batch) {
          const t = state.cache.get(j.text);
          if (state.layout === 'overlay') j.el.textContent = t || '⚠ 翻译失败';
          else j.el.textContent = t || '⚠ 翻译失败';
        }
      }
    };
    await Promise.all([worker(), worker()].slice(0, Math.min(2, batches.length)));
    $('status').textContent = '';
  } finally {
    state.translating = false;
    btn.disabled = false;
    btn.textContent = '翻译全文';
  }
}

function makeOverlayTr(line, text) {
  const el = document.createElement('div');
  el.className = 'pdf-tr';
  el.textContent = text;
  el.style.top = line.top + 'px';
  el.style.left = line.left + 'px';
  el.style.maxWidth = Math.max(40, line.width - line.left) + 'px';
  el.style.fontSize = Math.max(9, Math.min(line.fs, 18)) + 'px';
  return el;
}

function restore() {
  if (state.layout === 'overlay') {
    for (const p of state.pages) {
      const l = p.pgEl.querySelector('.trLayer');
      if (l) l.innerHTML = '';
    }
  } else {
    for (const p of state.pages) p.trHost.querySelectorAll('.web-tr').forEach((t) => (t.textContent = ''));
  }
}

// ---------- 初始化 ----------
async function init() {
  const s = await storageGet({ targetLang: '简体中文', trColor: '#3482FF' });
  state.targetLang = s.targetLang || '简体中文';
  state.trColor = s.trColor || '#3482FF';
  document.documentElement.style.setProperty('--ift-color', state.trColor);

  if (!fileUrl) {
    $('empty').style.display = 'flex';
    $('toolbar').style.visibility = 'hidden';
    return;
  }
  $('openRaw').href = fileUrl;

  if (!sendTranslate) {
    $('status').textContent = '演示模式：请在扩展中打开以启用真实翻译（当前可浏览）';
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';
  state.baseWidth = Math.min(document.documentElement.clientWidth - 32, 1000);

  try {
    state.pdf = await pdfjsLib.getDocument({
      url: fileUrl,
      cMapUrl: './cmaps/',
      cMapPacked: true,
      standardFontDataUrl: './standard_fonts/',
    }).promise;
    await renderAll();
  } catch (e) {
    $('pageLabel').textContent = '加载失败';
    $('status').textContent = String(e && e.message ? e.message : e);
  }
}

// ---------- 工具条事件 ----------
$('btnTranslate').addEventListener('click', () => {
  const has = state.pages.some((p) =>
    state.layout === 'overlay'
      ? p.pgEl.querySelector('.trLayer') && p.pgEl.querySelector('.trLayer').children.length
      : p.trHost.querySelector('.web-tr') && [...p.trHost.querySelectorAll('.web-tr')].some((t) => t.textContent)
  );
  if (has) restore();
  else translateAll();
});

$('btnMode').addEventListener('click', () => {
  const on = document.body.classList.toggle('side-by-side');
  $('btnMode').textContent = on ? '不透视' : '透视';
});

async function setLayout(v) {
  state.layout = v;
  ['layOverlay', 'layWeb', 'layDual'].forEach((id) => $(id).classList.remove('on'));
  $({ overlay: 'layOverlay', web: 'layWeb', dual: 'layDual' }[v]).classList.add('on');
  if (state.pdf) await renderAll();
}
$('layOverlay').addEventListener('click', () => setLayout('overlay'));
$('layWeb').addEventListener('click', () => setLayout('web'));
$('layDual').addEventListener('click', () => setLayout('dual'));

async function setScale(v) {
  state.scale = Math.min(2.5, Math.max(0.5, Math.round(v * 100) / 100));
  $('zoomLabel').textContent = Math.round(state.scale * 100) + '%';
  if (state.pdf) await renderAll();
}

$('btnZoomIn').addEventListener('click', () => setScale(state.scale + 0.1));
$('btnZoomOut').addEventListener('click', () => setScale(state.scale - 0.1));

init();
