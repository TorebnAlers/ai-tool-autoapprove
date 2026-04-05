// Background service worker — handles settings defaults and cross-tab messaging

const DEFAULT_SETTINGS = {
  enabled: true,
  showToast: true,
  rules: {
    mode: 'auto', // 'auto' | 'whitelist' | 'blacklist'
    whitelist: [],  // e.g. ['github', 'create_file'] — approve ONLY if dialog contains these
    blacklist: []   // e.g. ['delete', 'remove'] — never approve if dialog contains these
  },
  sites: {
    'perplexity.ai': true,
    'claude.ai': true,
    'chatgpt.com': true,
    'chat.openai.com': true,
    'github.com': true,
    'copilot.microsoft.com': true
  }
};

// Initialise defaults on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    }
  });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.sync.get('settings', (data) => {
      sendResponse({ settings: data.settings || DEFAULT_SETTINGS });
    });
    return true; // keep channel open for async response
  }

  if (msg.type === 'LOG_APPROVAL') {
    // Could be used in future to log to a history page
    console.log('[AutoApprove] Approved:', msg.payload);
  }
});
