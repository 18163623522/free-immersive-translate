// 视频双语字幕 - isolated 侧翻译器（YouTube / B 站）
// 收到 MAIN world 拦截器发来的字幕 JSON：批量翻译字幕行，
// 把译文追加到每条字幕末尾（换行分隔），播放器渲染为双语两行

(() => {
  'use strict';

  const isExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  if (!isExt) return;

  function sendTranslate(items, targetLang) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'translate', items, targetLang }, (r) => {
          void chrome.runtime.lastError;
          resolve(r || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function getTargetLang() {
    try {
      const s = await chrome.storage.sync.get({ targetLang: '简体中文', enableSubtitle: true });
      return s;
    } catch (_) {
      return { targetLang: '简体中文', enableSubtitle: true };
    }
  }

  // 统一字幕行抽象：
  // YouTube timedtext: {events:[{segs:[{utf8}]}]}
  // B 站 ai_subtitle:  {body:[{content}]}
  function extractEntries(data) {
    if (Array.isArray(data.events)) {
      return data.events
        .filter((ev) => ev.segs && ev.segs.length)
        .map((ev) => ({
          kind: 'yt',
          ev,
          text: ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
          write: (tr) => {
            const last = ev.segs[ev.segs.length - 1];
            last.utf8 = (last.utf8 || '').replace(/\s+$/, '') + '\n' + tr;
          },
        }))
        .filter((e) => e.text.length >= 1);
    }
    if (Array.isArray(data.body)) {
      return data.body
        .filter((b) => typeof b.content === 'string' && b.content.trim())
        .map((b) => ({
          kind: 'bili',
          ev: b,
          text: b.content.trim(),
          write: (tr) => {
            b.content = b.content.replace(/\s+$/, '') + '\n' + tr;
          },
        }));
    }
    return [];
  }

  async function translateSubtitleJson(body) {
    const cfg = await getTargetLang();
    if (cfg.enableSubtitle === false) return body; // 关闭时原样返回
    let data;
    try {
      data = JSON.parse(body);
    } catch (_) {
      return body;
    }

    const entries = extractEntries(data);
    if (!entries.length) return body;

    // 分批翻译（每批 20 条，字幕行都很短）
    const BATCH = 20;
    const writes = [];
    for (let i = 0; i < entries.length; i += BATCH) {
      const slice = entries.slice(i, i + BATCH);
      const res = await sendTranslate(
        slice.map((e, j) => ({ id: j, text: e.text })),
        cfg.targetLang
      );
      if (res && res.ok) {
        slice.forEach((e, j) => {
          if (typeof res.map[j] === 'string' && res.map[j].trim()) {
            writes.push(() => e.write(res.map[j].trim()));
          }
        });
      }
    }
    if (!writes.length) return body;

    for (const w of writes) w();
    return JSON.stringify(data);
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || d.source !== 'ift-yt' || typeof d.id !== 'number') return;
    const result = await translateSubtitleJson(d.body);
    window.postMessage({ source: 'ift-yt-res', id: d.id, body: result }, '*');
  });
})();
