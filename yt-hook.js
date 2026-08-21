// 视频字幕拦截器 - MAIN world fetch hook
// 拦截 YouTube timedtext / B 站 ai_subtitle 字幕请求，
// 经 isolated 侧（yt-subtitle.js）翻译后返回修改版响应
(() => {
  'use strict';
  if (window.__IFT_YT_HOOKED__) return;
  window.__IFT_YT_HOOKED__ = true;

  const SUBTITLE_URL_RE = /timedtext|aisubtitle|\/subtitle\/|subtitle_url/;

  const pending = new Map(); // id -> resolve
  let seq = 0;

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.source === 'ift-yt-res' && pending.has(d.id)) {
      const resolve = pending.get(d.id);
      pending.delete(d.id);
      resolve(d.body);
    }
  });

  function requestTranslate(text) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null); // 超时：返回 null 表示放弃，使用原字幕
        }
      }, 8000);
      window.postMessage({ source: 'ift-yt', id, body: text }, '*');
    });
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const res = await origFetch.apply(this, args);
    try {
      if (!SUBTITLE_URL_RE.test(url)) return res;
      const ct = res.headers.get('content-type') || '';
      if (!/json|xml|text/.test(ct)) return res;
      let text = await res.text();
      if (text && text.trim().startsWith('{')) {
        const translated = await requestTranslate(text);
        if (translated) text = translated;
      }
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (_) {
      return res;
    }
  };
})();
