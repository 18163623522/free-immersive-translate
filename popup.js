// 弹出窗：状态 + 网页翻译 / 图片批量翻译 / 设置

(() => {
  'use strict';

  const metaEl = document.getElementById('meta');
  const warnEl = document.getElementById('warn');

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
      '服务商：<b>' + (providerNames[s.provider] || s.provider) + '</b> · 模型 <b>' +
      s.model + '</b><br>目标语言：' + s.targetLang +
      (s.hasKey ? ' · Key 尾号 ' + s.keyTail : '');

    if (!s.hasKey) {
      warnEl.style.display = 'block';
      warnEl.textContent = '⚠ 尚未配置 API Key（免费），请先到设置页填写';
    }
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

  document.getElementById('btnToggle').addEventListener('click', async () => {
    warnEl.style.display = 'none';
    if (await sendToTab('toggle')) window.close();
  });

  document.getElementById('btnImages').addEventListener('click', async () => {
    warnEl.style.display = 'none';
    if (await sendToTab('translateImages')) window.close();
  });

  document.getElementById('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
})();
