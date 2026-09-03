// 双语电子书阅读器：手写 ZIP/EPUB 解析（零依赖）+ 章节渲染 + 视口懒翻译
// 翻译走 background translateBatch（持久缓存/上下文一致/故障转移全部自动复用）

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const isExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  const MOCK = new URLSearchParams(location.search).get('mock') === '1';

  const sendTranslate = isExt
    ? (payload) =>
        new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(payload, (r) => {
              void chrome.runtime.lastError;
              resolve(r || { ok: false, error: '后台无响应' });
            });
          } catch (e) {
            resolve({ ok: false, error: String(e) });
          }
        })
    : MOCK
      ? async (p) => {
          await new Promise((r) => setTimeout(r, 300));
          const map = {};
          for (const it of p.items || []) map[it.id] = '【译】' + it.text.slice(0, 26) + '……';
          return { ok: true, map };
        }
      : null;

  const state = {
    book: null,        // { title, chapters:[{href,label}], zip }
    index: 0,
    onlyTr: false,
    translated: false,
    lazyIO: null,
    pending: 0,
    cache: new Map(), // 原文 -> 译文（页面内，跨章生效）
    samples: [],       // 上下文样本（同书前文对照）
    blobUrls: [],
  };

  // ============================================================
  // ZIP 解压（EOCD → central directory → local file → inflate-raw）
  // ============================================================
  async function unzip(buffer) {
    const u8 = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const td = new TextDecoder();

    // 1. 从尾部定位 EOCD（PK\x05\x06）
    let eocd = -1;
    const scanStart = Math.max(0, u8.length - 65558);
    for (let i = u8.length - 22; i >= scanStart; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB（ZIP 结构缺失）');

    // 2. central directory
    const count = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(ptr, true) !== 0x02014b50) break;
      const method = view.getUint16(ptr + 10, true);
      const csize = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const lfhOffset = view.getUint32(ptr + 42, true);
      const name = td.decode(u8.subarray(ptr + 46, ptr + 46 + nameLen));
      entries.set(name, { method, csize, lfhOffset });
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    // 3. 惰性读取文件内容
    async function readFile(name) {
      const f = entries.get(name);
      if (!f) return null;
      const nameLen = view.getUint16(f.lfhOffset + 26, true);
      const extraLen = view.getUint16(f.lfhOffset + 28, true);
      const dataStart = f.lfhOffset + 30 + nameLen + extraLen;
      let end = dataStart + f.csize;
      if (f.csize === 0 && f.method === 8) {
        // data descriptor 型 zip：csize 记在尾部，向后搜下一个 local header 兜底
        for (let i = dataStart + 1; i < u8.length - 4; i++) {
          const sig = view.getUint32(i, true);
          if (sig === 0x04034b50 || sig === 0x02014b50) {
            end = i;
            break;
          }
        }
      }
      const comp = u8.subarray(dataStart, end);
      if (f.method === 0) return comp;
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([comp]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    return { readFile, names: [...entries.keys()] };
  }

  // ============================================================
  // EPUB 结构解析（container.xml → OPF → manifest/spine/toc）
  // ============================================================
  function parseXml(text) {
    return new DOMParser().parseFromString(text, 'application/xml');
  }

  function resolvePath(base, href) {
    // OPF 目录相对路径 → zip 内规范路径
    const parts = (base + '/' + href).split('/');
    const out = [];
    for (const seg of parts) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  async function parseEpub(zip, buffer) {
    const td = new TextDecoder();
    const container = parseXml(td.decode(await zip.readFile('META-INF/container.xml')));
    const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB 缺少 container.xml / OPF');
    const opfDir = dirOf(opfPath);
    const opf = parseXml(td.decode(await zip.readFile(opfPath)));

    const title =
      opf.getElementsByTagName('dc:title')[0]?.textContent ||
      opf.querySelector('title')?.textContent ||
      '未命名书籍';

    // manifest: id -> zip 路径
    const manifest = new Map();
    for (const item of opf.querySelectorAll('manifest > item')) {
      manifest.set(item.getAttribute('id'), {
        href: resolvePath(opfDir, item.getAttribute('href')),
        mediaType: item.getAttribute('media-type') || '',
        properties: item.getAttribute('properties') || '',
      });
    }

    // spine：阅读顺序
    const spineIds = [...opf.querySelectorAll('spine > itemref')].map((r) =>
      r.getAttribute('idref')
    );

    // 目录标签：优先 EPUB3 nav.xhtml，退回 EPUB2 toc.ncx，最后用文档内标题
    const tocMap = new Map();
    try {
      const navItem = [...manifest.values()].find((m) => m.properties.includes('nav'));
      if (navItem) {
        const nav = parseXml(td.decode(await zip.readFile(navItem.href)));
        for (const a of nav.querySelectorAll('nav a[href]')) {
          const label = a.textContent.trim();
          if (label) tocMap.set(resolvePath(dirOf(navItem.href), a.getAttribute('href')), label);
        }
      } else {
        const ncxId = opf.querySelector('spine')?.getAttribute('toc');
        const ncxItem = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((m) => m.mediaType.includes('ncx'));
        if (ncxItem) {
          const ncx = parseXml(td.decode(await zip.readFile(ncxItem.href)));
          for (const cp of ncx.getElementsByTagName('content')) {
            const label = cp.previousElementSibling?.textContent.trim() || '';
            if (label) tocMap.set(resolvePath(dirOf(ncxItem.href), cp.getAttribute('src')), label);
          }
        }
      }
    } catch (_) {}

    const chapters = spineIds
      .map((id) => manifest.get(id))
      .filter((m) => m && /x?html/.test(m.mediaType))
      .map((m, i) => ({
        href: m.href,
        label: tocMap.get(m.href) || tocMap.get(m.href.split('#')[0]) || '第 ' + (i + 1) + ' 章',
      }));
    if (!chapters.length) throw new Error('EPUB 无可读章节（spine 为空）');

    return { title, chapters, zip, buffer };
  }

  // ============================================================
  // 章节渲染（净化 + 图片映射为 blob URL）
  // ============================================================
  async function renderChapter(idx) {
    state.index = idx;
    const ch = state.book.chapters[idx];
    const raw = new TextDecoder().decode(await state.book.zip.readFile(ch.href));
    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) {
      doc = new DOMParser().parseFromString(raw, 'text/html');
    }
    const body = doc.body || doc.documentElement;

    // 净化：去掉脚本/样式/框架
    body.querySelectorAll('script,style,link,iframe,object,embed').forEach((n) => n.remove());

    // 图片 → zip 内文件 → blob URL
    const imgDir = dirOf(ch.href);
    for (const img of body.querySelectorAll('img[image-src], img[src]')) {
      const src = img.getAttribute('image-src') || img.getAttribute('src');
      if (!src || /^(data|https?|blob):/.test(src)) continue;
      const path = resolvePath(imgDir, src.split('#')[0]);
      try {
        const data = await state.book.zip.readFile(path);
        if (data) {
          const url = URL.createObjectURL(new Blob([data], { type: 'image/*' }));
          state.blobUrls.push(url);
          img.setAttribute('src', url);
        } else {
          img.remove();
        }
      } catch (_) {
        img.remove();
      }
    }

    const article = $('chapter');
    article.innerHTML = '';
    while (body.firstChild) article.appendChild(body.firstChild);
    article.classList.remove('eb-fade');
    void article.offsetWidth;

    $('chapterSel').value = String(idx);
    $('pageInfo').textContent = (idx + 1) + ' / ' + state.book.chapters.length;
    $('btnPrev').disabled = $('btnPrev2').disabled = idx === 0;
    $('btnNext').disabled = $('btnNext2').disabled = idx === state.book.chapters.length - 1;

    state.translated = false;
    stopLazy();
    // 阅读进度记忆（扩展页 localStorage）
    try {
      localStorage.setItem('ift-epub-pos', JSON.stringify({ title: state.book.title, index: idx }));
    } catch (_) {}
    window.scrollTo(0, 0);
  }

  // ============================================================
  // 翻译（视口懒翻译 + 上下文样本 + 占位/错误态）
  // ============================================================
  const TRANS_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption';

  function collectParas() {
    const out = [];
    for (const el of $('chapter').querySelectorAll(TRANS_SEL)) {
      if (el.querySelector(TRANS_SEL)) continue; // 只取叶子块
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || !/\p{L}/u.test(text)) continue;
      if (el.querySelector('.eb-tr, .eb-err')) continue;
      el.classList.add('eb-src'); // 仅译文模式隐藏已翻译段落的原文
      out.push({ el, text });
    }
    return out;
  }

  function stopLazy() {
    if (state.lazyIO) {
      state.lazyIO.disconnect();
      state.lazyIO = null;
    }
  }

  async function translateParas(paras) {
    state.pending += paras.length;
    setStatus('翻译中…');
    // 切批
    const batches = [];
    let cur = [], chars = 0;
    for (const p of paras) {
      if (cur.length && (cur.length >= 12 || chars + p.text.length > 1000)) {
        batches.push(cur); cur = []; chars = 0;
      }
      cur.push(p); chars += p.text.length;
    }
    if (cur.length) batches.push(cur);

    let idx = 0;
    const worker = async () => {
      while (idx < batches.length) {
        const batch = batches[idx++];
        await runBatch(batch);
        state.pending -= batch.length;
        setStatus(state.pending > 0 ? '翻译中… 剩 ' + state.pending + ' 段' : '');
      }
    };
    await Promise.all([worker(), worker()].slice(0, Math.min(2, batches.length)));
  }

  async function runBatch(batch) {
    const pending = [];
    for (const p of batch) {
      const cached = state.cache.get(p.text);
      if (cached !== undefined) {
        insertTr(p.el, cached);
      } else {
        insertPh(p.el);
        pending.push(p);
      }
    }
    if (!pending.length) return;
    const res = await sendTranslate({
      type: 'translate',
      items: pending.map((p, i) => ({ id: i, text: p.text })),
      targetLang: '简体中文',
      context: { title: state.book.title, samples: state.samples.slice(-6) },
    });
    if (res && res.ok) {
      pending.forEach((p, i) => {
        const t = res.map[i];
        if (typeof t === 'string' && t.trim()) {
          state.cache.set(p.text, t);
          state.samples.push([p.text, t]);
          insertTr(p.el, t);
        } else {
          insertErr(p.el, '该段无译文');
        }
      });
    } else {
      pending.forEach((p) => insertErr(p.el, (res && res.error) || '失败'));
      setStatus(String((res && res.error) || '翻译失败').slice(0, 60));
    }
  }

  function insertPh(el) {
    const s = document.createElement('span');
    s.className = 'eb-tr eb-ph';
    s.textContent = '正在翻译…';
    el.appendChild(s);
  }

  function insertTr(el, text) {
    const old = el.querySelector('.eb-tr, .eb-err');
    if (old) old.remove();
    const s = document.createElement('span');
    s.className = 'eb-tr';
    s.textContent = text;
    el.appendChild(s);
  }

  function insertErr(el, msg) {
    insertTr(el, '⚠ ' + msg);
    const t = el.querySelector('.eb-tr');
    t.classList.add('eb-err');
    t.title = msg;
  }

  function translateChapter() {
    const paras = collectParas();
    if (!paras.length) {
      setStatus('本章没有可翻译的段落');
      return;
    }
    state.translated = true;
    const ahead = window.innerHeight * 1.5;
    const immediate = [];
    const lazy = [];
    for (const p of paras) {
      const r = p.el.getBoundingClientRect();
      if (r.top < ahead && r.bottom > -window.innerHeight * 0.5) immediate.push(p);
      else lazy.push(p);
    }
    if (immediate.length) translateParas(immediate);
    if (lazy.length) {
      stopLazy();
      state.lazyIO = new IntersectionObserver(
        (entries) => {
          const due = [];
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            state.lazyIO.unobserve(en.target);
            if (en.target.__para) due.push(en.target.__para);
            en.target.__para = null;
          }
          if (due.length && state.translated) translateParas(due);
        },
        { rootMargin: '150% 0px 150% 0px' }
      );
      for (const p of lazy) {
        p.el.__para = p;
        state.lazyIO.observe(p.el);
      }
    }
  }

  function restoreChapter() {
    stopLazy();
    $('chapter').querySelectorAll('.eb-tr,.eb-err').forEach((n) => n.remove());
    state.translated = false;
    state.pending = 0;
    setStatus('');
  }

  const setStatus = (t) => ($('status').textContent = t);

  // ============================================================
  // 书架（IndexedDB 持久存书，重开免选文件）
  // ============================================================
  function idb() {
    return new Promise((res) => {
      const q = indexedDB.open('ift-epub', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('books', { keyPath: 'id' });
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(null);
    });
  }
  const shelfAll = async () => {
    const db = await idb();
    if (!db) return [];
    return new Promise((res) => {
      const r = db.transaction('books').objectStore('books').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
  };
  const shelfPut = async (book) => {
    const db = await idb();
    if (!db) return;
    return new Promise((res) => {
      const r = db.transaction('books', 'readwrite').objectStore('books').put(book);
      r.onsuccess = res;
      r.onerror = res;
    });
  };
  const shelfDel = async (id) => {
    const db = await idb();
    if (!db) return;
    return new Promise((res) => {
      const r = db.transaction('books', 'readwrite').objectStore('books').delete(id);
      r.onsuccess = res;
      r.onerror = res;
    });
  };

  function bookId(title, size) {
    let h = 5381;
    const s = title + '|' + size;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  async function renderShelf() {
    const el = $('shelf');
    if (!el) return;
    const books = (await shelfAll()).sort((a, b) => b.addedAt - a.addedAt);
    el.innerHTML = '';
    el.hidden = books.length === 0;
    for (const b of books) {
      const card = document.createElement('div');
      card.className = 'shelf-item';
      const title = document.createElement('div');
      title.className = 'shelf-title';
      title.textContent = b.title;
      title.title = '点击继续阅读';
      const meta = document.createElement('div');
      meta.className = 'shelf-meta';
      meta.textContent =
        (b.size / 1048576).toFixed(1) + ' MB · ' + new Date(b.addedAt).toLocaleDateString();
      const del = document.createElement('button');
      del.className = 'shelf-del';
      del.textContent = '✕';
      del.title = '从书架删除';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        shelfDel(b.id).then(renderShelf);
      });
      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(del);
      card.addEventListener('click', () => openBuffer(b.buffer));
      el.appendChild(card);
    }
  }

  // ============================================================
  // 打开书籍 / UI 事件
  // ============================================================
  async function openBuffer(buffer) {
    try {
      setStatus('解析中…');
      const zip = await unzip(buffer);
      state.book = await parseEpub(zip, buffer);
      state.blobUrls.forEach((u) => URL.revokeObjectURL(u));
      state.blobUrls = [];

      $('bookTitle').textContent = state.book.title;
      document.title = state.book.title + ' · 双语电子书';
      const sel = $('chapterSel');
      sel.innerHTML = '';
      state.book.chapters.forEach((c, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = c.label;
        sel.appendChild(o);
      });

      // 恢复上次进度
      let start = 0;
      try {
        const saved = JSON.parse(localStorage.getItem('ift-epub-pos') || 'null');
        if (saved && saved.title === state.book.title && saved.index < state.book.chapters.length) {
          start = saved.index;
        }
      } catch (_) {}

      $('drop').hidden = true;
      $('reader').hidden = false;
      $('toolbar').style.visibility = 'visible';
      await renderChapter(start);
      setStatus('');
    } catch (e) {
      setStatus('');
      alert('打开失败：' + (e && e.message ? e.message : e));
    }
  }

  async function openFile(file) {
    const buffer = await file.arrayBuffer();
    // 先解析确认有效，再入库书架
    await openBuffer(buffer);
    if (state.book) {
      shelfPut({
        id: bookId(state.book.title, buffer.byteLength),
        title: state.book.title,
        addedAt: Date.now(),
        size: buffer.byteLength,
        buffer,
      }).then(renderShelf);
    }
  }

  function showShelf() {
    stopLazy();
    state.blobUrls.forEach((u) => URL.revokeObjectURL(u));
    state.blobUrls = [];
    $('reader').hidden = true;
    $('drop').hidden = false;
    renderShelf();
  }

  // ---------- 事件 ----------
  $('btnOpen').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) openFile(e.target.files[0]);
  });

  const dropEl = $('drop');
  ['dragenter', 'dragover'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (!dropEl.hidden) dropEl.querySelector('.drop-inner').classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      dropEl.querySelector('.drop-inner').classList.remove('dragover');
      if (ev === 'drop' && !dropEl.hidden && e.dataTransfer?.files?.[0]) {
        openFile(e.dataTransfer.files[0]);
      }
    })
  );

  $('btnTranslate').addEventListener('click', () => {
    if (state.translated) restoreChapter();
    else translateChapter();
  });
  $('btnOnlyTr').addEventListener('click', () => {
    state.onlyTr = !state.onlyTr;
    document.body.classList.toggle('only-tr', state.onlyTr);
    $('btnOnlyTr').textContent = state.onlyTr ? '双语' : '仅译文';
  });
  $('btnShelf').addEventListener('click', showShelf);
  $('chapterSel').addEventListener('change', (e) => renderChapter(parseInt(e.target.value, 10)));
  const nav = (d) => {
    const n = state.index + d;
    if (n >= 0 && n < state.book.chapters.length) {
      renderChapter(n);
    }
  };
  $('btnPrev').addEventListener('click', () => nav(-1));
  $('btnNext').addEventListener('click', () => nav(1));
  $('btnPrev2').addEventListener('click', () => nav(-1));
  $('btnNext2').addEventListener('click', () => nav(1));

  if (!sendTranslate) setStatus('预览模式：请在扩展中打开');
  renderShelf();
})();
