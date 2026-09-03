// 弹出窗：目标语言快切 + 页面状态 + 翻译统计 + 常规操作

(() => {
  'use strict';

  const metaEl = document.getElementById('meta');
  const warnEl = document.getElementById('warn');
  const langQuick = document.getElementById('langQuick');
  const pageStatus = document.getElementById('pageStatus');
  const statusText = document.getElementById('statusText');
  const btnToggle = document.getElementById('btnToggle');
  const statsEl = document.getElementById('stats');

  chrome.runtime.sendMessage({ type: 'getSettings' }, (s) => {
    void chrome.runtime.lastError;
    if (!s || !s.ok) {
      metaEl.textContent = '无法读取配置';
      return;
    }
    const providerNames = {
      zhipu: '智谱', bailian: '阿里百炼', volc: '豆包', siliconflow: '硅基流动',
      gemini: 'Gemini', groq: 'Groq', custom: '自定义',
    };
    metaEl.innerHTML =
      '服务商：<b>' + (providerNames[s.provider] || s.provider) + '</b> · <b>' +
      s.model + '</b>' + (s.hasKey ? ' · Key 尾号 ' + s.keyTail : '');
    if (!s.hasKey) {
      warnEl.style.display = 'block';
      warnEl.textContent = '⚠ 尚未配置 API Key（免费），请先到设置页填写';
    }
    if (s.targetLang && [...langQuick.options].some((o) => o.value === s.targetLang)) {
      langQuick.value = s.targetLang;
    }
  });

  // 语言快切：写存储即可，content 下次翻译前 syncSettings 生效
  langQuick.addEventListener('change', () => {
    chrome.storage.sync.set({ targetLang: langQuick.value });
    statusText.textContent = '目标语言已切换为 ' + langQuick.value + '（翻译时生效）';
  });

  // 页面状态
  function refreshStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }, (st) => {
        void chrome.runtime.lastError;
        const dot = pageStatus.querySelector('.dot');
        if (chrome.runtime.lastError || !st) {
          dot.className = 'dot';
          statusText.textContent = '此页面不可注入（刷新后重试）';
          return;
        }
        if (st.translating) {
          dot.className = 'dot busy';
          statusText.textContent = '翻译进行中…';
          btnToggle.textContent = '翻译中…';
        } else if (st.translated) {
          dot.className = 'dot on';
          statusText.textContent = '本页已翻译 ' + st.paragraphs + ' 段';
          btnToggle.textContent = '还原译文';
        } else {
          dot.className = 'dot';
          statusText.textContent = '本页未翻译';
          btnToggle.textContent = '翻译此页';
        }
      });
    });
  }
  refreshStatus();

  // 翻译统计（会话级）
  chrome.runtime.sendMessage({ type: 'getStats' }, (r) => {
    void chrome.runtime.lastError;
    if (!r || !r.ok) return;
    const st = r.stats;
    const hitRate = st.hits + st.reqs > 0 ? Math.round((st.hits / (st.hits + st.reqs)) * 100) : 0;
    statsEl.textContent =
      '本次浏览：翻译 ' + (st.chars >= 1000 ? (st.chars / 1000).toFixed(1) + 'k' : st.chars) +
      ' 字 · ' + st.reqs + ' 次请求' + (st.hits ? ' · 缓存命中 ' + hitRate + '%' : '');
  });

  function warn(text) {
    warnEl.style.display = 'block';
    warnEl.textContent = text;
  }

  async function sendToTab(type) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return false;
    if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
      warn('此页面类型不支持');
      return false;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type });
      return true;
    } catch (e) {
      warn('此页面无法注入脚本（请刷新页面后重试）');
      return false;
    }
  }

  btnToggle.addEventListener('click', async () => {
    warnEl.style.display = 'none';
    if (await sendToTab('toggle')) {
      setTimeout(refreshStatus, 400);
    }
  });

  document.getElementById('btnImages').addEventListener('click', async () => {
    warnEl.style.display = 'none';
    if (await sendToTab('translateImages')) window.close();
  });

  document.getElementById('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
})();
