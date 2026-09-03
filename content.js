// 沉浸式免费翻译 - Content Script
// 职责：收集可翻译段落 → 批量请求译文 → 双语对照插入；悬浮球交互
// 说明：顶部有桥接层，既支持真实扩展(chrome.runtime)，也支持测试页注入 mock

(() => {
  'use strict';

  const MARK_ATTR = 'data-ift'; // 段落已收集标记
  const TR_CLS = 'ift-tr';      // 译文元素
  const ERR_CLS = 'ift-error';  // 失败占位（点击重试）
  const BALL_ID = 'ift-ball';
  const IS_TOP = window === window.top;
  // Chrome 内置 PDF 查看器页面无法注入译文层：检测到 PDF 时跳转自带的双语查看器
  const IS_PDF =
    document.contentType === 'application/pdf' ||
    /\.pdf(\?|#|$)/i.test(location.pathname + location.search);

  // ---------- 桥接层 ----------
  let sendTranslate;
  let storageGet = async () => ({ trColor: '#3d7ea6' });

  const hasChromeApi =
    typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

  if (hasChromeApi) {
    sendTranslate = (payload) =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(payload, (r) => {
            void chrome.runtime.lastError; // 抑制未读 lastError 告警
            resolve(r || { ok: false, error: '后台无响应，请重载扩展' });
          });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      });
    storageGet = (defaults) => chrome.storage.sync.get(defaults);
  } else if (window.__IFT_MOCK__) {
    // 测试页模式：harness.html 提供 window.__IFT_MOCK__(payload) => Promise
    // 以及可选的 window.__IFT_MOCK_SETTINGS__（覆盖默认 storage 返回值，用于测样式切换）
    sendTranslate = window.__IFT_MOCK__;
    storageGet = async (defaults) => ({ ...defaults, ...(window.__IFT_MOCK_SETTINGS__ || {}) });
  } else {
    return; // 既非扩展也无 mock，静默退出
  }

  // ---------- 全局状态 ----------
  const state = {
    translating: false,
    translated: false,
    batchSeq: 0,        // 批次自增 id，用于防止过期响应回填
    targetLang: '简体中文',
    trStyle: 'color',   // 译文样式主题（ift-s-*）
      enableHover: true,
      imgMinSize: 200,
      subtitle: true,
      hoverTr: false,     // 悬停段落翻译开关（会话级）
      onlyTr: false,      // 仅显示译文开关（隐藏原文）
    cache: new Map(),   // 原文 -> 译文（页面内缓存，重复段落复用）
    imgBusy: new Map(), // img 元素 -> 状态：'loading' | 'done'
  };

  // ---------- 语言判定 ----------
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

  const TARGET_KEY = {
    '简体中文': 'zh', '繁體中文': 'zh', 'English': 'latin',
    '日本語': 'ja', '한국어': 'ko', 'Français': 'latin',
    'Deutsch': 'latin', 'Español': 'latin', 'Русский': 'cyr',
  };

  // 段落是否已是目标语言（是则跳过）
  function alreadyTargetLang(p, targetKey) {
    if (targetKey === 'zh') {
      // 汉字明显多于其他文字 → 视为中文页（日文假名多则仍需翻）
      return p.cjk > p.latin + p.kana + p.hangul + p.cyr;
    }
    const sum = p.latin + p.cjk + p.kana + p.hangul + p.cyr;
    if (!sum) return true;
    const main =
      p.latin >= p.cjk && p.latin >= p.kana && p.latin >= p.hangul && p.latin >= p.cyr ? 'latin'
      : p.cjk >= p.kana && p.cjk >= p.hangul && p.cjk >= p.cyr ? 'cjk'
      : p.kana >= p.hangul && p.kana >= p.cyr ? 'kana'
      : p.hangul >= p.cyr ? 'hangul' : 'cyr';
    return main === targetKey;
  }

  // ---------- 段落收集 ----------
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT',
    'BUTTON', 'INPUT', 'CODE', 'PRE', 'SVG', 'CANVAS', 'IFRAME',
    'AUDIO', 'VIDEO', 'OBJECT', 'EMBED', 'MAP',
  ]);
  const LEAF_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
    'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'SUMMARY', 'LABEL', 'LEGEND',
  ]);
  // 子块选择器：元素内部还有这些块级结构时，它本身不是翻译单元
  const CHILD_BLOCK_SEL =
    'p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,figcaption,div,pre,table,ul,ol,dl,section,article,header,footer,aside,main,nav,form,figure,details';

  function collectText(el) {
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script,style,code,pre,noscript,textarea,.' + TR_CLS + ',.' + ERR_CLS)) {
          return NodeFilter.FILTER_REJECT;
        }
        return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out += n.nodeValue + ' ';
    return out.replace(/\s+/g, ' ').trim();
  }

  function isCollectable(el) {
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return false;
    // 我们自己的 UI
    if (el.closest('#' + BALL_ID + ',.' + TR_CLS)) return false;
    // 已处理过
    if (el.hasAttribute(MARK_ATTR)) return false;
    // 翻译单元：显式块标签，或"只含行内内容"的 DIV
    if (!LEAF_TAGS.has(tag) && tag !== 'DIV') return false;
    if (el.querySelector(CHILD_BLOCK_SEL)) return false;
    // 可见性：display:none 时 rect 为 0
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function collectParagraphs() {
    const result = [];
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      if (!isCollectable(el)) continue;
      const text = collectText(el);
      if (text.length < 2) continue;
      // 纯数字/符号/非常短的无字母串跳过
      if (!/\p{L}/u.test(text)) continue;
      const prof = scriptProfile(text);
      const letters = prof.latin + prof.cjk + prof.kana + prof.hangul + prof.cyr;
      if (letters < 2) continue;
      const targetKey = TARGET_KEY[state.targetLang] || 'zh';
      if (alreadyTargetLang(prof, targetKey)) continue;
      el.setAttribute(MARK_ATTR, '1');
      result.push({ el, text });
    }
    return result;
  }

  // ---------- 批量切分 ----------
  const MAX_ITEMS = 12;
  const MAX_CHARS = 1000;
  function makeBatches(paras) {
    const batches = [];
    let cur = [], curChars = 0;
    for (const p of paras) {
      if (cur.length && (cur.length >= MAX_ITEMS || curChars + p.text.length > MAX_CHARS)) {
        batches.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(p);
      curChars += p.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  // ---------- 译文插入 ----------
  function makeTrEl(text, isError) {
    const span = document.createElement('span');
    span.className = isError ? ERR_CLS : TR_CLS + ' ift-s-' + state.trStyle;
    span.textContent = text;
    if (text === '正在翻译…') span.classList.add('ift-ph'); // shimmer 占位
    return span;
  }

  function fillTranslation(el, text, delayMs) {
    // 移除该段旧的占位/错误节点再插入
    for (const old of el.querySelectorAll(':scope > .' + TR_CLS + ',:scope > .' + ERR_CLS)) {
      old.remove();
    }
    const span = makeTrEl(text, false);
    if (delayMs) span.style.animationDelay = delayMs + 'ms'; // 批内错落浮现
    el.appendChild(span);
    syncOnlyTr(el); // 仅译文模式下包裹原文
  }

  function fillError(el, message) {
    for (const old of el.querySelectorAll(':scope > .' + TR_CLS + ',:scope > .' + ERR_CLS)) {
      old.remove();
    }
    // 错误摘要直接可见（完整信息在悬停 title），便于用户定位问题
    const brief = String(message || '未知错误').slice(0, 60);
    const err = makeTrEl('⚠ ' + brief + '（点击重试）', true);
    err.title = message;
    el.appendChild(err);
  }

  // ---------- 翻译主流程 ----------
  const PAGE_CONCURRENCY = 2; // 页面侧同时在途批次

  async function runBatch(batch, batchToken) {
    // 命中缓存的段落直接回填，其余送后台
    const pending = [];
    for (const p of batch) {
      const cached = state.cache.get(p.text);
      if (cached !== undefined) fillTranslation(p.el, cached);
      else pending.push(p);
    }
    if (!pending.length) return;

    for (const p of pending) fillTranslation(p.el, '正在翻译…');
    const items = pending.map((p, i) => ({ id: i, text: p.text }));
    // 同页上下文：标题 + 已译对照样本（尾部 6 条），保证术语与风格前后一致
    const samples = [...state.cache.entries()].slice(-6);
    let res;
    try {
      res = await sendTranslate({
        type: 'translate',
        items,
        targetLang: state.targetLang,
        context: { title: document.title, samples },
      });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (batchToken !== state.batchSeq) return; // 已被"还原"打断，丢弃结果

    if (res && res.ok) {
      pending.forEach((p, i) => {
        const t = res.map[i];
        if (typeof t === 'string' && t.trim()) {
          state.cache.set(p.text, t);
          fillTranslation(p.el, t, Math.min(i * 35, 400));
        } else {
          fillError(p.el, '该段落无译文');
        }
      });
    } else {
      const err = (res && res.error) || '未知错误';
      pending.forEach((p) => fillError(p.el, err));
      if (state.ball) flashBall('❗ ' + String(err).slice(0, 40));
    }
  }

  async function translatePage(opts) {
    if (state.translating) return false;
    const quiet = opts && opts.quiet;
    await syncSettings(); // 翻译前刷新目标语言/样式/颜色
    const paras = collectParagraphs();
    if (!paras.length) {
      if (!quiet) flashBall('未发现需翻译的内容');
      return false;
    }
    state.translating = true;
    state.translated = true;
    setBallText('翻译中…');
    setBallLoading(true);

    await translateParagraphs(paras, (done, total) => {
      setBallProgress('翻译中 ' + done + '/' + total);
    });

    state.translating = false;
    setBallLoading(false);
    hideBallTip();
    setBallText('还原译文');
    startIncremental(); // 无限滚动页面：新内容自动增量翻译
    return true;
  }

  // 翻译一组已收集的段落（整页与增量共用），可选进度回调
  async function translateParagraphs(paras, onProgress) {
    const token = state.batchSeq;
    const batches = makeBatches(paras);
    let done = 0;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(PAGE_CONCURRENCY, batches.length) },
      async () => {
        while (cursor < batches.length) {
          const b = batches[cursor++];
          await runBatch(b, token);
          done += b.length;
          if (onProgress) onProgress(done, paras.length);
        }
      }
    );
    await Promise.all(workers);
  }

  function restorePage() {
    state.batchSeq++; // 使在途响应失效
    state.translating = false;
    state.translated = false;
    stopIncremental();
    document.querySelectorAll('.' + TR_CLS + ',.' + ERR_CLS).forEach((n) => n.remove());
    document.querySelectorAll('[' + MARK_ATTR + ']').forEach((n) => n.removeAttribute(MARK_ATTR));
    document.querySelectorAll('.' + SRC_CLS).forEach((w) => w.replaceWith(...w.childNodes)); // 释放被包裹的原文
    setBallLoading(false);
    setBallText('翻译本页');
  }

  // ---------- 增量翻译：翻译状态下页面新增内容自动补翻（无限滚动） ----------
  let contentObserver = null;
  let incTimer = null;
  const SELF_ROOT_SEL = '.ift-tr,.ift-error,.ift-src,#ift-ball,#ift-menu,#ift-side,#ift-imgbtn,#ift-selbtn,#ift-selpop';

  function startIncremental() {
    if (contentObserver || !document.body) return;
    contentObserver = new MutationObserver((muts) => {
      if (!state.translated) return;
      const external = muts.some(
        (m) => !(m.target && m.target.closest && m.target.closest(SELF_ROOT_SEL))
      );
      if (!external) return;
      clearTimeout(incTimer);
      incTimer = setTimeout(async () => {
        if (!state.translated || state.translating) return;
        const paras = collectParagraphs(); // 幂等：只收集未标记的新段落
        if (paras.length) await translateParagraphs(paras);
      }, 1200);
    });
    contentObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopIncremental() {
    if (contentObserver) {
      contentObserver.disconnect();
      contentObserver = null;
    }
    clearTimeout(incTimer);
  }

  // ---------- 自动翻译（打开外文页自动翻，含站点黑名单） ----------
  function isBlacklisted(list) {
    const host = location.hostname.toLowerCase();
    return String(list || '')
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .some((pat) =>
        pat.startsWith('*.') ? host.endsWith(pat.slice(1)) : host === pat || host.endsWith('.' + pat)
      );
  }

  function pageNeedsTranslate() {
    const targetKey = TARGET_KEY[state.targetLang] || 'zh';
    // 正文采样为主信号：html lang 可能与实际内容不符
    // （如 fab.com 按浏览器 locale 返回中文界面壳 + 英文正文，lang="zh-CN" 但需要翻译）
    const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
    if (text.length >= 40) {
      return !alreadyTargetLang(scriptProfile(text.slice(0, 1200)), targetKey);
    }
    // 正文尚无内容（SPA 未渲染）：退回 html lang 兜底
    const lang = (document.documentElement.lang || '').toLowerCase();
    if (!lang) return false;
    if (targetKey === 'zh') return !lang.startsWith('zh');
    const iso = { latin: 'en', ja: 'ja', ko: 'ko', cyr: 'ru' }[targetKey] || 'en';
    return !lang.startsWith(iso);
  }

  async function maybeAutoTranslate() {
    if (IS_PDF || isBlacklisted(state.blacklist) || !state.autoTranslate) return;
    if (!pageNeedsTranslate()) return;
    // SPA 首屏可能未渲染：无内容时轻量重试（700ms / 2.2s / 3.7s）
    const attempt = async (tries) => {
      if (state.translated || state.translating) return;
      const done = await translatePage({ quiet: true });
      if (!done && tries > 0) setTimeout(() => attempt(tries - 1), 1500);
    };
    setTimeout(() => attempt(2), 700);
  }

  function toggle() {
    if (IS_PDF) {
      openPdfViewer();
      return;
    }
    // 翻译进行中再次点击 = 打断并还原；已翻译状态点击 = 还原
    if (state.translating || state.translated) restorePage();
    else translatePage();
  }

  function openPdfViewer() {
    if (hasChromeApi) {
      location.href =
        chrome.runtime.getURL('pdf/viewer.html') +
        '?file=' + encodeURIComponent(location.href);
    } else {
      flashBall('PDF 查看器需以扩展方式运行');
    }
  }

  // 失败批次点击重试（事件委托）；collectText 已排除译文/占位节点，可直接取原文
  document.addEventListener('click', (ev) => {
    const errEl = ev.target && ev.target.closest && ev.target.closest('.' + ERR_CLS);
    if (!errEl) return;
    ev.stopPropagation();
    const host = errEl.parentElement;
    if (!host) return;
    const text = collectText(host);
    if (!text) return;
    errEl.textContent = '正在翻译…';
    sendTranslate({ type: 'translate', items: [{ id: 0, text }], targetLang: state.targetLang })
      .then((res) => {
        if (res && res.ok && typeof res.map[0] === 'string') {
          state.cache.set(text, res.map[0]);
          fillTranslation(host, res.map[0]);
        } else {
          fillError(host, (res && res.error) || '重试失败');
        }
      });
  }, true);

  // ---------- 图片/漫画翻译 ----------
  const WRAP_CLS = 'ift-imgwrap';
  const IMGCV_CLS = 'ift-imgcv';

  function isValidImage(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if ((img.naturalWidth || 0) < state.imgMinSize || (img.naturalHeight || 0) < state.imgMinSize) return false;
    const src = img.currentSrc || img.src || '';
    if (!src || /^data:image\/svg/.test(src) || /\.svg(\?|#|$)/i.test(src)) return false;
    const rect = img.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    return true;
  }

  // 包一层 wrap 作为 canvas 的定位上下文；把 img 的已解析 margin 挪到 wrap 上保持布局
  function ensureWrap(img) {
    let wrap = img.parentElement;
    if (wrap && wrap.classList && wrap.classList.contains(WRAP_CLS)) return wrap;
    const cs = getComputedStyle(img);
    wrap = document.createElement('span');
    wrap.className = WRAP_CLS;
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    wrap.style.margin = cs.margin;
    img.style.margin = '0';
    return wrap;
  }

  // 断行：CJK 逐字可断，拉丁尽量按空格
  function layoutText(ctx, text, maxW) {
    const lines = [];
    let cur = '';
    let lastBreak = -1;
    for (const ch of text) {
      const trial = cur + ch;
      if (ch === ' ' || ch === '\n') lastBreak = trial.length;
      if (ch === '\n' || ctx.measureText(trial).width > maxW) {
        if (ch === '\n') { lines.push(cur); cur = ''; lastBreak = -1; continue; }
        if (cur === '') { cur = ch; continue; }
        if (lastBreak > 0 && lastBreak < trial.length) {
          lines.push(trial.slice(0, lastBreak).trimEnd());
          cur = trial.slice(lastBreak).trimStart();
        } else {
          lines.push(cur);
          cur = ch;
        }
        lastBreak = -1;
      } else {
        cur = trial;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function paintTranslation(canvas, img, items) {
    const W = img.naturalWidth, H = img.naturalHeight;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    for (const it of items) {
      const x = Math.round(it.x * W), y = Math.round(it.y * H);
      const w = Math.max(6, Math.round(it.w * W)), h = Math.max(6, Math.round(it.h * H));
      // 文字框外扩一点，覆盖原文字描边
      const pad = Math.max(2, Math.round(Math.min(w, h) * 0.06));
      const bx = x - pad, by = y - pad, bw = w + pad * 2, bh = h + pad * 2;

      // 取文字框边缘环的中位色做"橡皮擦"，避免生硬白块
      ctx.fillStyle = edgeColor(ctx, bx, by, bw, bh);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, Math.min(bw, bh) * 0.18);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();

      // 自适应字号 + 换行
      const maxW = bw - pad;
      let fs = Math.min(bh * 0.95, maxW * 0.6, 64), lines = null;
      for (; fs >= 9; fs -= 1) {
        ctx.font = '600 ' + fs + 'px "MiSans","Microsoft YaHei",sans-serif';
        lines = layoutText(ctx, it.translation, maxW);
        const lineH = fs * 1.18;
        if (lines.length * lineH <= bh * 1.02) break;
      }
      if (!lines) continue;
      ctx.fillStyle = '#1c1c1e';
      const lineH = fs * 1.18;
      let ty = by + (bh - lines.length * lineH) / 2 + lineH * 0.78;
      for (const ln of lines) {
        ctx.fillText(ln, bx + bw / 2, ty, bw);
        ty += lineH;
      }
    }
  }

  // 采样矩形外圈 2~6px 环的中位色
  function edgeColor(ctx, bx, by, bw, bh) {
    try {
      const ring = [];
      const x0 = Math.max(0, bx - 4), y0 = Math.max(0, by - 4);
      const x1 = Math.min(ctx.canvas.width, bx + bw + 4), y1 = Math.min(ctx.canvas.height, by + bh + 4);
      const data = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
      const iw = (x1 - x0) * 4;
      const inRect = (px, py) => px >= bx - x0 && px < bx - x0 + bw && py >= by - y0 && py < by - y0 + bh;
      for (let py = 0; py < y1 - y0; py += 2) {
        for (let px = 0; px < x1 - x0; px += 2) {
          if (!inRect(px, py)) {
            const i = py * iw + px * 4;
            ring.push([data[i], data[i + 1], data[i + 2]]);
          }
        }
      }
      if (!ring.length) return '#ffffff';
      for (const c of [0, 1, 2]) ring.sort((a, b) => a[c] - b[c]);
      const m = ring[Math.floor(ring.length / 2)];
      return 'rgb(' + m[0] + ',' + m[1] + ',' + m[2] + ')';
    } catch (_) {
      return '#ffffff';
    }
  }

  async function translateOneImage(img) {
    const busy = state.imgBusy.get(img);
    if (busy === 'done') { restoreImage(img); return; } // 已翻译 → 还原
    if (busy === 'loading') return;
    state.imgBusy.set(img, 'loading');
    const src = img.currentSrc || img.src;

    let res;
    try {
      res = await sendTranslate({ type: 'translateImage', src, targetLang: state.targetLang });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }
    if (res && res.ok) {
      if (res.items && res.items.length) {
        const wrap = ensureWrap(img);
        const old = wrap.querySelector('.' + IMGCV_CLS);
        if (old) old.remove();
        const canvas = document.createElement('canvas');
        canvas.className = IMGCV_CLS;
        canvas.title = '点击还原原图';
        paintTranslation(canvas, img, res.items);
        canvas.addEventListener('click', (ev) => {
          ev.stopPropagation();
          restoreImage(img);
        });
        wrap.appendChild(canvas);
        state.imgBusy.set(img, 'done');
      } else {
        state.imgBusy.delete(img);
        flashBall && flashBall('图片中未检测到文字');
      }
    } else {
      state.imgBusy.delete(img);
      flashBall && flashBall('图片翻译失败：' + String((res && res.error) || '').slice(0, 40));
    }
  }

  function restoreImage(img) {
    const wrap = img.parentElement;
    if (wrap && wrap.classList && wrap.classList.contains(WRAP_CLS)) {
      const cv = wrap.querySelector('.' + IMGCV_CLS);
      if (cv) cv.remove();
    }
    state.imgBusy.delete(img);
  }

  // 全页图片批量翻译（漫画模式）
  async function translateAllImages() {
    await syncSettings();
    const imgs = [...document.images].filter(
      (im) => isValidImage(im) && !state.imgBusy.has(im)
    );
    if (!imgs.length) {
      flashBall('未发现可翻译的图片（需 ≥' + state.imgMinSize + 'px）');
      return;
    }
    setBallLoading(true);
    let done = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < imgs.length) {
        const im = imgs[idx++];
        await translateOneImage(im);
        done++;
      }
    };
    await Promise.all([worker(), worker()]);
    setBallLoading(false);
    flashBall('已处理 ' + done + ' 张图片');
  }

  // ---------- 悬浮图片按钮（hover 触发） ----------
  let imgBtn = null;
  let imgBtnTarget = null;
  let imgBtnHideTimer = null;

  function buildImgBtn() {
    if (imgBtn || !IS_TOP) return;
    imgBtn = document.createElement('div');
    imgBtn.id = 'ift-imgbtn';
    imgBtn.className = 'ift-root';
    imgBtn.textContent = '译';
    imgBtn.title = '翻译此图片 / 还原';
    imgBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (imgBtnTarget) {
        translateOneImage(imgBtnTarget);
        hideImgBtn();
      }
    });
    imgBtn.addEventListener('mouseenter', () => clearTimeout(imgBtnHideTimer));
    document.documentElement.appendChild(imgBtn);

    const over = (e) => {
      if (!state.enableHover) return;
      const img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (!img) return;
      if (!isValidImage(img)) {
        // 移到小图/svg 等无效目标：主动隐藏（真实鼠标的 mouseout 兜底，合成事件场景加固）
        clearTimeout(imgBtnHideTimer);
        hideImgBtn();
        return;
      }
      if (imgBtnTarget === img) return;
      imgBtnTarget = img;
      clearTimeout(imgBtnHideTimer);
      const r = img.getBoundingClientRect();
      imgBtn.textContent = state.imgBusy.get(img) === 'done' ? '↺' : '译';
      imgBtn.style.display = 'flex';
      imgBtn.style.left = Math.min(window.innerWidth - 46, Math.max(6, r.right - 40)) + 'px';
      imgBtn.style.top = Math.max(6, r.top + 6) + 'px';
    };
    const out = (e) => {
      const img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (!img || img !== imgBtnTarget) return;
      clearTimeout(imgBtnHideTimer);
      imgBtnHideTimer = setTimeout(hideImgBtn, 260);
    };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('mouseout', out, true);
    window.addEventListener('scroll', hideImgBtn, { passive: true });
  }

  function hideImgBtn() {
    if (!imgBtn) return;
    imgBtn.style.display = 'none';
    imgBtnTarget = null;
  }

  // 样式应用到全部已插入译文（菜单切换与 storage.onChanged 共用）
  function applyTrStyle(style) {
    state.trStyle = style;
    document.querySelectorAll('.' + TR_CLS).forEach((el) => {
      el.classList.forEach((c) => {
        if (c.indexOf('ift-s-') === 0) el.classList.remove(c);
      });
      el.classList.add('ift-s-' + style);
    });
  }

  // ---------- 仅显示译文：把原文文本节点包进隐藏 span ----------
  const SRC_CLS = 'ift-src';

  function wrapSource(el) {
    if (el.querySelector(':scope > .' + SRC_CLS)) return;
    const nodes = [...el.childNodes].filter(
      (n) =>
        !(n.classList && (n.classList.contains(TR_CLS) || n.classList.contains(ERR_CLS) || n.classList.contains(SRC_CLS)))
    );
    if (!nodes.length) return;
    const wrap = document.createElement('span');
    wrap.className = SRC_CLS;
    el.insertBefore(wrap, nodes[0]);
    nodes.forEach((n) => wrap.appendChild(n));
  }

  function unwrapSource(el) {
    el.querySelectorAll(':scope > .' + SRC_CLS).forEach((w) => w.replaceWith(...w.childNodes));
  }

  function setOnlyTranslation(on) {
    state.onlyTr = on;
    document.querySelectorAll('[' + MARK_ATTR + ']').forEach((el) => {
      if (on) wrapSource(el);
      else unwrapSource(el);
    });
  }

  // fillTranslation 后若仅译文模式开启，同步包裹新翻译的原文
  function syncOnlyTr(el) {
    if (state.onlyTr) wrapSource(el);
  }

  // ---------- 悬停段落翻译（指哪翻哪） ----------
  let hoverTimer = null;
  let hoverTarget = null;

  function startHoverParagraph() {
    document.addEventListener(
      'mouseover',
      (e) => {
        if (!state.hoverTr || IS_PDF) return;
        const el = e.target && e.target.closest
          ? e.target.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,figcaption,dt,dd')
          : null;
        if (el === hoverTarget) return;
        hoverTarget = el;
        clearTimeout(hoverTimer);
        if (!el || el.hasAttribute(MARK_ATTR) || !isCollectable(el)) return;
        const text = collectText(el);
        const targetKey = TARGET_KEY[state.targetLang] || 'zh';
        if (!text || text.length < 2 || alreadyTargetLang(scriptProfile(text), targetKey)) return;
        hoverTimer = setTimeout(async () => {
          el.setAttribute(MARK_ATTR, '1');
          const cached = state.cache.get(text);
          if (cached !== undefined) {
            fillTranslation(el, cached);
            syncOnlyTr(el);
            return;
          }
          fillTranslation(el, '正在翻译…');
          const res = await sendTranslate({
            type: 'translate',
            items: [{ id: 0, text }],
            targetLang: state.targetLang,
          });
          if (res && res.ok && typeof res.map[0] === 'string' && res.map[0].trim()) {
            state.cache.set(text, res.map[0]);
            fillTranslation(el, res.map[0]);
          } else {
            fillError(el, (res && res.error) || '翻译失败');
          }
          syncOnlyTr(el);
        }, 600);
      },
      true
    );
  }

  // ---------- 划词翻译 ----------
  const SELBTN_ID = 'ift-selbtn';
  const SELPOP_ID = 'ift-selpop';

  function hideSelUI() {
    const b = document.getElementById(SELBTN_ID);
    const p = document.getElementById(SELPOP_ID);
    if (b) b.remove();
    if (p) p.remove();
  }

  function startSelectionTranslate() {
    document.addEventListener(
      'mouseup',
      (e) => {
        if (IS_PDF) return;
        if (e.target && e.target.closest && e.target.closest('#' + SELBTN_ID + ',#' + SELPOP_ID)) return;
        setTimeout(() => {
          const sel = window.getSelection();
          const text = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
          if (!text || text.length < 2 || text.length > 2000 || !sel.rangeCount) {
            return; // 不隐藏：点击译文气泡时选择消失属正常
          }
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (!rect.width && !rect.height) return;
          hideSelUI();
          const btn = document.createElement('div');
          btn.id = SELBTN_ID;
          btn.className = 'ift-root';
          btn.textContent = '译';
          btn.title = '翻译选中内容';
          btn.addEventListener('mousedown', (ev) => ev.preventDefault()); // 保住选区
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            showSelectionPopup(text, rect);
          });
          document.documentElement.appendChild(btn);
          btn.style.left = Math.min(window.innerWidth - 46, Math.max(6, rect.left)) + 'px';
          btn.style.top = Math.max(6, rect.top - 44) + 'px';
        }, 10);
      },
      true
    );
    document.addEventListener(
      'mousedown',
      (e) => {
        if (e.target && e.target.closest && e.target.closest('#' + SELBTN_ID + ',#' + SELPOP_ID)) return;
        hideSelUI();
      },
      true
    );
  }

  async function showSelectionPopup(text, rect) {
    hideSelUI();
    const pop = document.createElement('div');
    pop.id = SELPOP_ID;
    pop.className = 'ift-root';
    pop.textContent = '正在翻译…';
    document.documentElement.appendChild(pop);
    const pw = 300;
    pop.style.left = Math.min(window.innerWidth - pw - 10, Math.max(8, rect.left)) + 'px';
    pop.style.top = Math.min(window.innerHeight - 90, rect.bottom + 10) + 'px';

    const cached = state.cache.get(text);
    if (cached !== undefined) {
      pop.textContent = cached;
      return;
    }
    const res = await sendTranslate({
      type: 'translate',
      items: [{ id: 0, text }],
      targetLang: state.targetLang,
    });
    if (res && res.ok && typeof res.map[0] === 'string' && res.map[0].trim()) {
      state.cache.set(text, res.map[0]);
      pop.textContent = res.map[0];
    } else {
      pop.textContent = '⚠ ' + ((res && res.error) || '翻译失败');
      pop.classList.add('ift-selpop-err');
    }
  }

  // ---------- 输入框翻译（Alt+I：翻译 / 再按还原） ----------
  function startInputBoxTranslate() {
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'i' && e.key !== 'I')) return;
      const el = document.activeElement;
      if (!el || !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();

      const get = () => (el.isContentEditable ? el.textContent : el.value);
      const set = (v) => {
        if (el.isContentEditable) el.textContent = v;
        else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };

      // 再按一次还原
      if (el.dataset && el.dataset.iftOriginal !== undefined) {
        set(el.dataset.iftOriginal);
        delete el.dataset.iftOriginal;
        return;
      }
      const text = get().trim();
      if (!text) return;
      const from = state.targetLang === '简体中文' || state.targetLang === '繁體中文' ? '中文' : '当前语言';
      const origin = get();
      el.dataset.iftOriginal = origin;
      set('正在翻译' + from + '内容…');
      sendTranslate({ type: 'translate', items: [{ id: 0, text }], targetLang: TARGET_WRITING_LANG[state.targetLang] || 'English' })
        .then((res) => {
          if (res && res.ok && typeof res.map[0] === 'string' && res.map[0].trim()) set(res.map[0]);
          else {
            set(origin);
            delete el.dataset.iftOriginal;
            flashBall('输入框翻译失败：' + String((res && res.error) || '').slice(0, 30));
          }
        });
    });
  }

  // 输入框翻译的目标语（输入场景：中文→英文，英文→中文，默认英文）
  const TARGET_WRITING_LANG = {
    '简体中文': 'English', '繁體中文': 'English',
    'English': '简体中文', '日本語': '简体中文', '한국어': '简体中文',
    'Français': 'English', 'Deutsch': 'English', 'Español': 'English', 'Русский': 'English',
  };

  // ---------- 侧边翻译面板（Alt+S / 弹窗触发） ----------
  const SIDE_ID = 'ift-side';
  let sideHistory = [];

  function toggleSidePanel() {
    const existing = document.getElementById(SIDE_ID);
    if (existing) {
      existing.classList.remove('open');
      setTimeout(() => existing.remove(), 240);
      return;
    }
    const side = document.createElement('aside');
    side.id = SIDE_ID;
    side.className = 'ift-root';
    side.innerHTML =
      '<div class="ift-side-hd"><span>翻译面板</span><button class="ift-side-x" title="关闭">✕</button></div>' +
      '<div class="ift-side-body">' +
      '<textarea class="ift-side-input" placeholder="输入要翻译的文字，Ctrl+Enter 翻译"></textarea>' +
      '<div class="ift-side-actions"><span class="ift-side-lang"></span><button class="ift-side-go">翻译</button></div>' +
      '<div class="ift-side-result">在上方输入文字开始翻译。</div>' +
      '<div class="ift-side-tools"><button class="ift-side-tts" title="朗读译文">🔊 朗读</button></div>' +
      '<div class="ift-side-hist-hd">历史（本次浏览）</div>' +
      '<div class="ift-side-hist"></div>' +
      '</div>';
    document.documentElement.appendChild(side);
    requestAnimationFrame(() => side.classList.add('open'));

    const input = side.querySelector('.ift-side-input');
    const result = side.querySelector('.ift-side-result');
    const lang = side.querySelector('.ift-side-lang');
    const go = side.querySelector('.ift-side-go');
    const hist = side.querySelector('.ift-side-hist');
    lang.textContent = '→ ' + state.targetLang;

    const renderHist = () => {
      hist.innerHTML = '';
      for (const h of sideHistory.slice(0, 10)) {
        const item = document.createElement('div');
        item.className = 'ift-side-item';
        item.innerHTML = '<div class="ift-side-q"></div><div class="ift-side-a"></div>';
        item.querySelector('.ift-side-q').textContent = h.q;
        item.querySelector('.ift-side-a').textContent = h.a;
        hist.appendChild(item);
      }
    };

    // 朗读译文（本地 TTS，免费）
    const TTS_LANG = {
      '简体中文': 'zh-CN', '繁體中文': 'zh-TW', 'English': 'en-US', '日本語': 'ja-JP',
      '한국어': 'ko-KR', 'Français': 'fr-FR', 'Deutsch': 'de-DE', 'Español': 'es-ES', 'Русский': 'ru-RU',
    };
    side.querySelector('.ift-side-tts').addEventListener('click', () => {
      const text = result.textContent;
      if (!text || text.startsWith('⚠')) return;
      if (!window.speechSynthesis) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = TTS_LANG[state.targetLang] || 'zh-CN';
      u.rate = 1;
      speechSynthesis.speak(u);
    });

    const run = async () => {
      const text = input.value.trim();
      if (!text) return;
      go.disabled = true;
      go.textContent = '翻译中…';
      result.textContent = '正在翻译…';
      result.classList.add('loading');
      const res = await sendTranslate({
        type: 'translate',
        items: [{ id: 0, text }],
        targetLang: state.targetLang,
      });
      go.disabled = false;
      go.textContent = '翻译';
      result.classList.remove('loading');
      if (res && res.ok && typeof res.map[0] === 'string') {
        result.textContent = res.map[0];
        sideHistory.unshift({ q: text, a: res.map[0] });
        renderHist();
      } else {
        result.textContent = '⚠ ' + ((res && res.error) || '翻译失败');
      }
    };

    go.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
    });
    side.querySelector('.ift-side-x').addEventListener('click', toggleSidePanel);
    input.focus();
  }

  // ---------- 译文手动修正（双击编辑，回写页面缓存与持久缓存） ----------
  document.addEventListener('dblclick', (ev) => {
    const tr = ev.target && ev.target.closest ? ev.target.closest('.' + TR_CLS) : null;
    if (!tr || tr.classList.contains('ift-ph') || tr.isContentEditable) return;
    const host = tr.parentElement;
    if (!host) return;
    ev.stopPropagation();
    tr.contentEditable = 'true';
    tr.classList.add('ift-editing');
    tr.focus();
    // 全选便于整体替换
    const range = document.createRange();
    range.selectNodeContents(tr);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = () => {
      tr.contentEditable = 'false';
      tr.classList.remove('ift-editing');
      const newText = tr.textContent.trim();
      const srcText = collectText(host);
      if (srcText && newText) {
        state.cache.set(srcText, newText);
        if (hasChromeApi) {
          chrome.runtime.sendMessage(
            { type: 'cacheKey', text: srcText, targetLang: state.targetLang },
            (key) => {
              void chrome.runtime.lastError;
              if (key && typeof key === 'string' && key.startsWith('tc:')) {
                chrome.runtime.sendMessage({ type: 'cachePut', key, value: newText });
              }
            }
          );
        }
      }
    };
    tr.addEventListener('blur', finish, { once: true });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        tr.removeEventListener('blur', finish);
        tr.contentEditable = 'false';
        tr.classList.remove('ift-editing');
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        tr.blur();
      }
      e.stopPropagation();
    }, { once: true });
  }, true);

  // ---------- 导出双语 HTML ----------
  function exportBilingual() {
    if (!state.translated) {
      flashBall('请先翻译页面再导出');
      return;
    }
    const clone = document.documentElement.cloneNode(true);
    // 移除插件自身 UI
    clone
      .querySelectorAll('#ift-ball,#ift-menu,#ift-side,#ift-imgbtn,#ift-selbtn,#ift-selpop')
      .forEach((n) => n.remove());
    // 译文 canvas 固化为图片，保证离线可看
    clone.querySelectorAll('canvas.' + 'ift-imgcv').forEach((cv) => {
      try {
        const img = document.createElement('img');
        img.src = cv.toDataURL('image/png');
        img.className = cv.className;
        img.style.cssText = cv.style.cssText;
        cv.replaceWith(img);
      } catch (_) {}
    });
    // 注入译文样式兜底（站点样式离线不可用时译文仍有基本观感）
    const style = document.createElement('style');
    style.textContent =
      '.ift-tr{display:block;margin-top:3px;font-size:.95em;line-height:1.65;color:var(--ift-color,#3482FF);word-break:break-word}' +
      '.ift-imgwrap{position:relative;display:inline-block}.ift-imgwrap>img[src^="data:image"]{position:absolute;inset:0;max-width:100%}' +
      '.ift-src{display:none}';
    clone.querySelector('head') && clone.querySelector('head').appendChild(style);
    const html = '<!DOCTYPE html>\n' + clone.outerHTML;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download =
      (document.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '-双语.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    flashBall('已导出双语 HTML');
  }

  // ---------- 悬浮球（仅顶层 frame） ----------
  let ballEl = null;
  let flashTimer = null;
  const MENU_ID = 'ift-menu';

  function buildBall() {
    if (!IS_TOP || document.getElementById(BALL_ID)) return;
    const b = document.createElement('div');
    b.id = BALL_ID;
    b.className = 'ift-root';
    b.innerHTML =
      '<span class="ift-ball-label">译</span>' +
      '<span class="ift-ball-text">翻译本页</span>' +
      '<span class="ift-ball-spin"></span>';
    b.title = '点击翻译/还原 · 右键或长按打开菜单 · 按住可拖动';
    b.addEventListener('click', onBallClick);
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleBallMenu();
    });
    b.addEventListener('pointerdown', onBallPointerDown);
    document.documentElement.appendChild(b);
    ballEl = b;
    loadBallPos();
  }

  let suppressClick = false;

  function onBallClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (isMenuOpen()) {
      hideBallMenu();
      return;
    }
    toggle();
  }

  // 悬浮球展开文案随状态切换
  function setBallText(text) {
    if (!ballEl) return;
    const t = ballEl.querySelector('.ift-ball-text');
    if (t) t.textContent = text;
  }

  // ---------- 悬浮球拖拽 + 长按菜单 ----------
  const TR_STYLE_NAMES = {
    color: '彩字', blur: '悬停显示', dashed: '虚线', bg: '底纹',
    quote: '竖线', card: '卡片', italic: '斜体', marker: '荧光笔',
  };

  let drag = null; // {startX, startY, moved, pointerId, offX, offY}
  let longPressTimer = null;

  function onBallPointerDown(e) {
    if (e.button !== 0) return;
    drag = { startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (drag && !drag.moved) {
        drag = null;
        suppressClick = true;
        try { navigator.vibrate && navigator.vibrate(12); } catch (_) {}
        toggleBallMenu();
      }
    }, 480);
  }

  function onBallPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId || !ballEl) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 6) {
      drag.moved = true;
      clearTimeout(longPressTimer);
      hideBallMenu();
      ballEl.classList.add('ift-dragging');
      ballEl.style.transition = 'none';
      const r = ballEl.getBoundingClientRect();
      drag.offX = drag.startX - r.left;
      drag.offY = drag.startY - r.top;
    }
    if (drag.moved) {
      const w = ballEl.offsetWidth;
      const h = ballEl.offsetHeight;
      const x = Math.min(Math.max(4, e.clientX - drag.offX), window.innerWidth - w - 4);
      const y = Math.min(Math.max(4, e.clientY - drag.offY), window.innerHeight - h - 4);
      ballEl.style.left = x + 'px';
      ballEl.style.top = y + 'px';
      ballEl.style.right = 'auto';
      ballEl.style.bottom = 'auto';
    }
  }

  function onBallPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    clearTimeout(longPressTimer);
    if (drag.moved) {
      suppressClick = true;
      ballEl.classList.remove('ift-dragging');
      ballEl.style.transition = '';
      snapBallToEdge();
      ballEl.style.top = 'auto'; // 统一用 bottom 定位
    }
    drag = null;
  }

  // 吸附到较近的左右边缘并持久化
  function snapBallToEdge() {
    const r = ballEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const side = cx < window.innerWidth / 2 ? 'left' : 'right';
    const pos = {
      side,
      x: Math.round(side === 'left' ? r.left : window.innerWidth - r.right),
      y: Math.round(window.innerHeight - r.bottom),
    };
    applyBallPos(pos);
    saveBallPos(pos);
  }

  function applyBallPos(pos) {
    if (!ballEl || !pos) return;
    ballEl.style.left = '';
    ballEl.style.right = '';
    const y = Math.min(Math.max(8, pos.y), Math.max(8, window.innerHeight - 60));
    ballEl.style.bottom = y + 'px';
    if (pos.side === 'left') ballEl.style.left = Math.max(4, pos.x) + 'px';
    else ballEl.style.right = Math.max(4, pos.x) + 'px';
  }

  function saveBallPos(pos) {
    if (hasChromeApi) {
      try { chrome.storage.local.set({ ballPos: pos }); } catch (_) {}
    } else {
      window.__IFT_BALL_POS__ = pos; // mock 模式仅会话内记忆
    }
  }

  async function loadBallPos() {
    let pos = null;
    if (hasChromeApi) {
      try { pos = (await chrome.storage.local.get({ ballPos: null })).ballPos; } catch (_) {}
    } else {
      pos = window.__IFT_BALL_POS__ || null;
    }
    if (pos) applyBallPos(pos);
  }

  // ---------- 悬浮球菜单 ----------
  function isMenuOpen() {
    return !!document.getElementById(MENU_ID);
  }

  function toggleBallMenu() {
    if (isMenuOpen()) hideBallMenu();
    else showBallMenu();
  }

  function showBallMenu() {
    if (!ballEl || isMenuOpen()) return;
    const m = document.createElement('div');
    m.id = MENU_ID;
    m.className = 'ift-root';
    const chips = ['color', 'blur', 'dashed', 'bg', 'quote', 'card', 'italic', 'marker']
      .map((v) =>
        '<button class="ift-menu-chip' + (state.trStyle === v ? ' on' : '') + '" data-style="' + v + '">' +
        TR_STYLE_NAMES[v] + '</button>'
      ).join('');
    m.innerHTML =
      '<div class="ift-menu-item" data-act="images">翻译本页图片</div>' +
      '<div class="ift-menu-item" data-act="retranslate">重新翻译</div>' +
      '<div class="ift-menu-item' + (state.hoverTr ? ' ift-menu-on' : '') + '" data-act="hovertr">悬停翻译' +
      '<span class="ift-menu-state">' + (state.hoverTr ? '开' : '关') + '</span></div>' +
      '<div class="ift-menu-item' + (state.onlyTr ? ' ift-menu-on' : '') + '" data-act="onlytr">仅显示译文' +
      '<span class="ift-menu-state">' + (state.onlyTr ? '开' : '关') + '</span></div>' +
      '<div class="ift-menu-item' + (state.subtitle ? ' ift-menu-on' : '') + '" data-act="subtitle">视频字幕' +
      '<span class="ift-menu-state">' + (state.subtitle ? '开' : '关') + '</span></div>' +
      '<div class="ift-menu-item" data-act="sidepanel">翻译面板 (Alt+S)</div>' +
      '<div class="ift-menu-item ift-menu-dim" data-act="export">导出双语 HTML</div>' +
      '<div class="ift-menu-sec">译文样式</div>' +
      '<div class="ift-menu-chips">' + chips + '</div>' +
      '<div class="ift-menu-item ift-menu-dim" data-act="hide">隐藏悬浮球（刷新恢复）</div>' +
      '<div class="ift-menu-item ift-menu-dim" data-act="options">设置…</div>';

    m.addEventListener('click', (e) => {
      e.stopPropagation();
      const chip = e.target.closest('.ift-menu-chip');
      if (chip) {
        applyTrStyle(chip.dataset.style);
        m.querySelectorAll('.ift-menu-chip').forEach((c) => c.classList.toggle('on', c === chip));
        return; // 连续试样式，菜单不关
      }
      const item = e.target.closest('.ift-menu-item');
      if (!item) return;
      const act = item.dataset.act;
      hideBallMenu();
      if (act === 'images') translateAllImages();
      else if (act === 'retranslate') {
        restorePage();
        state.cache.clear();
        translatePage();
      } else if (act === 'hovertr') {
        state.hoverTr = !state.hoverTr;
        showBallMenu(); // 重开刷新开关文案
      } else if (act === 'onlytr') {
        setOnlyTranslation(!state.onlyTr);
        showBallMenu();
      } else if (act === 'subtitle') {
        state.subtitle = !state.subtitle;
        if (hasChromeApi) chrome.storage.sync.set({ enableSubtitle: state.subtitle });
        showBallMenu();
      } else if (act === 'sidepanel') {
        toggleSidePanel();
      } else if (act === 'export') {
        exportBilingual();
      } else if (act === 'hide') {
        if (ballEl) ballEl.style.display = 'none';
      } else if (act === 'options') {
        if (hasChromeApi) chrome.runtime.sendMessage({ type: 'openOptions' });
        else flashBall('设置页需以扩展方式运行');
      }
    });

    document.documentElement.appendChild(m);
    // 定位：球上方，右对齐（球在左侧时左对齐）
    const r = ballEl.getBoundingClientRect();
    const mw = 216;
    m.style.bottom = (window.innerHeight - r.top + 10) + 'px';
    const alignLeft = r.left + r.width / 2 < window.innerWidth / 2;
    if (alignLeft) m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + 'px';
    else m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  }

  function hideBallMenu() {
    const m = document.getElementById(MENU_ID);
    if (m) m.remove();
  }

  // 点击菜单外部 / ESC 关闭
  document.addEventListener(
    'click',
    (e) => {
      if (isMenuOpen() && !e.target.closest('#' + MENU_ID + ',#' + BALL_ID)) hideBallMenu();
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideBallMenu();
  });
  window.addEventListener('pointermove', onBallPointerMove);
  window.addEventListener('pointerup', onBallPointerUp);
  window.addEventListener('pointercancel', onBallPointerUp);

  function setBallLoading(on) {
    if (!ballEl) return;
    ballEl.classList.toggle('ift-loading', !!on);
    if (!on) {
      // 反馈：加载结束轻脉冲一次（重置后重播）
      ballEl.classList.remove('ift-pop');
      void ballEl.offsetWidth;
      ballEl.classList.add('ift-pop');
    }
  }

  function flashBall(msg) {
    if (!ballEl) return;
    let tip = ballEl.querySelector('.ift-ball-tip');
    if (!tip) {
      tip = document.createElement('span');
      tip.className = 'ift-ball-tip';
      ballEl.appendChild(tip);
    }
    tip.textContent = msg;
    tip.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => tip.classList.remove('show'), 2200);
  }

  // 持续进度提示（翻译期间常驻，结束由 hideBallTip 收起）
  function setBallProgress(text) {
    if (!ballEl) return;
    let tip = ballEl.querySelector('.ift-ball-tip');
    if (!tip) {
      tip = document.createElement('span');
      tip.className = 'ift-ball-tip';
      ballEl.appendChild(tip);
    }
    tip.textContent = text;
    tip.classList.add('show');
    clearTimeout(flashTimer);
  }

  function hideBallTip() {
    const tip = ballEl && ballEl.querySelector('.ift-ball-tip');
    if (tip) tip.classList.remove('show');
  }

  // ---------- 初始化 ----------
  // 每次翻译前都会重新同步：设置页改动后无需刷新页面
  async function syncSettings() {
    const s = await storageGet({
      targetLang: '简体中文',
      trColor: '#3482FF',
      trStyle: 'color',
      enableHover: true,
      imgMinSize: 200,
      enableSubtitle: true,
      autoTranslate: false,
      blacklist: '',
    });
    state.targetLang = s.targetLang || '简体中文';
    state.trStyle = s.trStyle || 'color';
    state.enableHover = s.enableHover !== false;
    state.imgMinSize = s.imgMinSize || 200;
    state.subtitle = s.enableSubtitle !== false;
    state.autoTranslate = s.autoTranslate === true;
    state.blacklist = s.blacklist || '';
    if (document.body) {
      document.documentElement.style.setProperty('--ift-color', s.trColor || '#3482FF');
    }
  }

  async function init() {
    await syncSettings();
    if (hasChromeApi) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg && msg.type === 'toggle') toggle();
        if (msg && msg.type === 'translateImages') translateAllImages();
        if (msg && msg.type === 'sidepanel') toggleSidePanel();
        // 弹窗查询当前页面翻译状态
        if (msg && msg.type === 'getStatus') {
          sendResponse({
            translated: state.translated,
            translating: state.translating,
            paragraphs: document.querySelectorAll('.' + TR_CLS).length,
          });
          return;
        }
        // 右键菜单
        if (msg && msg.type === 'ctxPage') toggle();
        if (msg && msg.type === 'ctxSelection') {
          const sel = window.getSelection();
          const text = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
          if (text) {
            const center = { left: Math.max(8, window.innerWidth / 2 - 150), bottom: window.innerHeight / 2, width: 300 };
            showSelectionPopup(text, center);
          }
        }
        if (msg && msg.type === 'ctxImage' && msg.src) {
          const img = [...document.images].find(
            (im) => (im.currentSrc || im.src) === msg.src
          );
          if (img) translateOneImage(img);
          else flashBall('未找到该图片元素');
        }
      });
      // 设置页改动即时生效：已翻译的段落原地换样式/换色，无需重新翻译
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.trColor) {
          document.documentElement.style.setProperty(
            '--ift-color', changes.trColor.newValue || '#3d7ea6'
          );
        }
        if (changes.trStyle) {
          applyTrStyle(changes.trStyle.newValue || 'color');
        }
      });
    }
    buildBall();
    buildImgBtn();
    startHoverParagraph();
    startSelectionTranslate();
    startInputBoxTranslate();
    maybeAutoTranslate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
