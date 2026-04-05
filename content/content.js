/**
 * AI Tool AutoApprove — Content Script
 * Watches for AI agent tool-call permission dialogs and auto-clicks approve.
 * Uses MutationObserver so it reacts to dynamically injected dialogs.
 */

// ─── Site selector map ───────────────────────────────────────────────────────
// Each entry is { containerSelector, buttonSelector, labelSelector }
// labelSelector is used to extract the dialog text for rule matching.
const SITE_SELECTORS = [
  // Perplexity — tool-call allow dialog
  {
    site: 'perplexity.ai',
    containers: [
      '[data-testid="tool-call-confirmation"]',
      '[class*="ToolConfirmation"]',
      '[class*="tool-confirm"]',
      '[class*="ToolApproval"]',
      '[aria-label*="allow"]',
      '[aria-label*="approve"]',
      'div[role="dialog"]'
    ],
    approveButtons: [
      'button[data-testid*="allow"]',
      'button[data-testid*="approve"]',
      'button[data-testid*="confirm"]',
    ]
  },
  // Claude.ai — tool-use permission prompt
  {
    site: 'claude.ai',
    containers: [
      '[data-testid*="tool"]',
      '[class*="ToolUse"]',
      'div[role="dialog"]'
    ],
    approveButtons: [
      'button[data-testid*="allow"]',
      'button[data-testid*="approve"]',
      'button[data-testid*="confirm"]'
    ]
  },
  // ChatGPT / OpenAI
  {
    site: 'chatgpt.com',
    containers: ['div[role="dialog"]', '[class*="confirmation"]'],
    approveButtons: [
      'button[data-testid*="allow"]',
      'button[data-testid*="confirm"]'
    ]
  },
  // GitHub Copilot / github.com agent
  {
    site: 'github.com',
    containers: ['[class*="Confirm"]', 'div[role="dialog"]'],
    approveButtons: [
      'button[data-testid*="confirm"]',
      'button[data-testid*="allow"]'
    ]
  },
  // Microsoft Copilot
  {
    site: 'copilot.microsoft.com',
    containers: ['div[role="dialog"]'],
    approveButtons: [
      'button[data-testid*="allow"]',
      'button[data-testid*="confirm"]'
    ]
  }
];

// ─── Approve-button text heuristic (fallback) ────────────────────────────────
// If none of the data-testid selectors match, scan buttons by visible text.
const APPROVE_TEXT_PATTERNS = [
  /^allow$/i,
  /^approve$/i,
  /^confirm$/i,
  /^yes$/i,
  /^allow access$/i,
  /^grant access$/i,
  /allow tool/i,
  /approve action/i,
  /continue/i
];

// Text patterns that mean "this is a destructive action" — skip by default in blacklist mode
const DESTRUCTIVE_PATTERNS = [
  /delete/i,
  /remove/i,
  /destroy/i,
  /drop/i,
  /wipe/i,
  /erase/i,
  /purge/i,
  /format/i
];

// ─── Settings cache ──────────────────────────────────────────────────────────
let settings = null;

function loadSettings(cb) {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
    settings = res?.settings;
    if (cb) cb(settings);
  });
}

// Reload settings whenever they change (popup toggled kill switch etc.)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    settings = changes.settings.newValue;
  }
});

// ─── Core logic ──────────────────────────────────────────────────────────────
function getCurrentSite() {
  return location.hostname.replace(/^www\./, '');
}

function isSiteEnabled(site, cfg) {
  // Check exact hostname or partial match in the sites map
  for (const key of Object.keys(cfg.sites)) {
    if (site.includes(key)) return cfg.sites[key];
  }
  return true; // default: allow on unlisted sites
}

function dialogText(el) {
  return (el?.innerText || '').toLowerCase();
}

function passesRules(text, rules) {
  if (rules.mode === 'blacklist') {
    for (const term of rules.blacklist) {
      if (text.includes(term.toLowerCase())) return false;
    }
    // Also respect built-in destructive patterns when blacklist mode is on
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(text)) return false;
    }
    return true;
  }

  if (rules.mode === 'whitelist') {
    if (rules.whitelist.length === 0) return true; // empty whitelist = allow all
    for (const term of rules.whitelist) {
      if (text.includes(term.toLowerCase())) return true;
    }
    return false; // not in whitelist
  }

  return true; // mode === 'auto'
}

function findApproveButton(container, siteConfig) {
  // 1. Try site-specific selectors
  if (siteConfig) {
    for (const sel of siteConfig.approveButtons) {
      const btn = container.querySelector(sel);
      if (btn && !btn.disabled) return btn;
    }
  }

  // 2. Fallback: scan all buttons by visible text
  const allButtons = container.querySelectorAll('button, [role="button"]');
  for (const btn of allButtons) {
    if (btn.disabled) continue;
    const label = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
    for (const pattern of APPROVE_TEXT_PATTERNS) {
      if (pattern.test(label)) return btn;
    }
  }
  return null;
}

function showToast(message) {
  if (!settings?.showToast) return;

  const toast = document.createElement('div');
  toast.setAttribute('id', 'autoapprove-toast');
  toast.innerText = '✅ AutoApprove: ' + message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '2147483647',
    background: '#1a1a1a',
    color: '#e5e5e5',
    padding: '10px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    maxWidth: '340px',
    lineHeight: '1.4',
    opacity: '0',
    transition: 'opacity 0.25s ease'
  });

  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

const approvedSet = new WeakSet(); // track buttons already clicked

function tryApprove(root) {
  if (!settings?.enabled) return;
  const site = getCurrentSite();
  if (!isSiteEnabled(site, settings)) return;

  const siteConfig = SITE_SELECTORS.find(s => site.includes(s.site));
  const containerSelectors = siteConfig?.containers || ['div[role="dialog"]'];

  for (const sel of containerSelectors) {
    const containers = root.querySelectorAll
      ? root.querySelectorAll(sel)
      : [];
    for (const container of containers) {
      const text = dialogText(container);
      if (!passesRules(text, settings.rules)) continue;

      const btn = findApproveButton(container, siteConfig);
      if (btn && !approvedSet.has(btn)) {
        approvedSet.add(btn);
        btn.click();
        const label = (btn.innerText || '').trim() || 'action';
        const excerpt = text.slice(0, 80).trim();
        showToast(`"${label}" on ${site}${excerpt ? ' — ' + excerpt : ''}`);
        chrome.runtime.sendMessage({ type: 'LOG_APPROVAL', payload: { site, label, excerpt } });
      }
    }
  }
}

// ─── MutationObserver ────────────────────────────────────────────────────────
function startObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          tryApprove(node);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Boot ────────────────────────────────────────────────────────────────────
loadSettings(() => {
  startObserver();
  // Also scan the existing DOM in case dialog was already present
  tryApprove(document.body);
});
