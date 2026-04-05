/**
 * AI Tool AutoApprove — Content Script v0.4
 * KEY FIX: Strip keyboard shortcut hints (e.g. "^Enter", "^Esc") from button
 * text before matching — Perplexity renders "Approve ^Enter" as the button label.
 */

// ─── Patterns ─────────────────────────────────────────────────────────────

const APPROVE_PATTERNS = [
  /^approve$/i, /^allow$/i, /^confirm$/i, /^yes$/i,
  /^allow access$/i, /^grant access$/i, /^accept$/i,
  /allow tool/i, /approve action/i, /approve request/i
];

const DENY_PATTERNS = [
  /^deny$/i, /^reject$/i, /^cancel$/i, /^no$/i, /^block$/i, /^decline$/i
];

const DESTRUCTIVE = [
  /delete/i, /remove/i, /destroy/i, /drop/i,
  /wipe/i, /erase/i, /purge/i, /format/i
];

// ─── Settings ─────────────────────────────────────────────────────────────

let settings = null;

chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
  settings = res?.settings ?? null;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) settings = changes.settings.newValue;
});

// ─── Text extraction ──────────────────────────────────────────────────────────

/**
 * Get clean button label, stripping:
 * - Keyboard shortcut hints: ^Enter, ^Esc, Ctrl+Z, ↵, ⌫, etc.
 * - Leading/trailing whitespace and newlines
 * - Non-printable characters
 */
function cleanBtnText(el) {
  // Try to get only the first text node (avoids picking up nested kbd/span shortcuts)
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    } else if (node.nodeName === 'SPAN' || node.nodeName === 'DIV') {
      // Only include span/div text if it looks like a real word, not a shortcut
      const t = node.textContent.trim();
      // Skip if it's a keyboard shortcut like "^Enter", "^Esc", "Ctrl+X"
      if (!/^(\^|Ctrl|Alt|Cmd|Shift|Meta)/.test(t) && !/^[↵⌫⌘⌃]/.test(t)) {
        text += t;
      }
    }
  }
  text = text.trim();

  // Fallback: use full innerText but strip shortcut patterns
  if (!text) {
    text = (el.innerText || el.textContent || '').trim();
  }

  // Strip keyboard hint suffixes like " ^Enter", " ^Esc", " Ctrl+Z"
  text = text
    .replace(/\s*(\^|Ctrl\+|Alt\+|Cmd\+|Shift\+|Meta\+)\S+/gi, '')
    .replace(/\s+[↵⌫⌘⌃]\S*/g, '')
    .replace(/\n.*/s, '')  // take only first line
    .trim();

  return text;
}

function isApprove(el) {
  const t = cleanBtnText(el);
  return APPROVE_PATTERNS.some(p => p.test(t));
}

function isDeny(el) {
  const t = cleanBtnText(el);
  return DENY_PATTERNS.some(p => p.test(t));
}

function isSiteEnabled() {
  if (!settings) return true;
  const host = location.hostname.replace(/^www\./, '');
  for (const [k, v] of Object.entries(settings.sites || {})) {
    if (host.includes(k)) return v;
  }
  return true;
}

function passesRules(text) {
  if (!settings) return true;
  const { mode, whitelist = [], blacklist = [] } = settings.rules;
  const t = text.toLowerCase();
  if (mode === 'blacklist') {
    if (blacklist.some(k => t.includes(k.toLowerCase()))) return false;
    if (DESTRUCTIVE.some(p => p.test(t))) return false;
    return true;
  }
  if (mode === 'whitelist') {
    if (!whitelist.length) return true;
    return whitelist.some(k => t.includes(k.toLowerCase()));
  }
  return true;
}

// Walk UP the DOM from approveBtn until we find a node that contains
// BOTH an approve-text button AND a deny-text button.
function findDialogContainer(approveBtn) {
  let el = approveBtn.parentElement;
  for (let i = 0; i < 10 && el && el !== document.body; i++) {
    const btns = Array.from(el.querySelectorAll('button, [role="button"]'));
    if (btns.some(isDeny) && btns.some(isApprove)) return el;
    el = el.parentElement;
  }
  return null;
}

// ─── Toast ──────────────────────────────────────────────────────────────────

function showToast(msg) {
  if (!settings?.showToast) return;
  document.getElementById('aa-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'aa-toast';
  el.textContent = '✅ AutoApprove: ' + msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '20px', right: '20px',
    zIndex: '2147483647', background: '#1c1b19', color: '#e5e5e5',
    padding: '10px 16px', borderRadius: '8px', fontSize: '13px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    maxWidth: '360px', lineHeight: '1.5',
    opacity: '0', transition: 'opacity 0.2s ease',
    pointerEvents: 'none'
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 4000);
}

// ─── Core scanner ────────────────────────────────────────────────────────────

const clicked = new WeakSet();

function scanDocument() {
  if (!settings?.enabled) return;
  if (!isSiteEnabled()) return;

  const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(b => !b.disabled);

  for (const btn of allButtons) {
    if (clicked.has(btn)) continue;
    if (!isApprove(btn)) continue;

    const container = findDialogContainer(btn);
    if (!container) continue;

    const text = container.innerText || '';
    if (!passesRules(text)) continue;

    clicked.add(btn);
    btn.click();

    const label = cleanBtnText(btn);
    const site = location.hostname.replace(/^www\./, '');
    const excerpt = text.slice(0, 120).replace(/\n+/g, ' ').trim();
    showToast(`“${label}” approved on ${site}`);
    chrome.runtime.sendMessage({ type: 'LOG_APPROVAL', payload: { site, label, excerpt } });
  }
}

// ─── Observer + interval fallback ─────────────────────────────────────────────

let scanPending = false;
function scheduleScan() {
  if (scanPending) return;
  scanPending = true;
  requestAnimationFrame(() => { scanPending = false; scanDocument(); });
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true, subtree: true
});

// Interval fallback — catches dialogs already in DOM before script loaded
setInterval(scanDocument, 800);

// ─── Boot ────────────────────────────────────────────────────────────────────

function waitForSettings(n = 0) {
  if (settings !== null) { scanDocument(); return; }
  if (n > 30) return;
  setTimeout(() => waitForSettings(n + 1), 100);
}
waitForSettings();
