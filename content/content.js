/**
 * AI Tool AutoApprove — Content Script v0.3
 * - Removed offsetParent visibility check (breaks position:fixed overlays like Perplexity)
 * - Walk UP the DOM from Approve button to find a container that also holds a Deny button
 * - Added interval fallback in case MutationObserver fires too early
 */

// ─── Patterns ────────────────────────────────────────────────────────────────

const APPROVE_PATTERNS = [
  /^approve$/i, /^allow$/i, /^confirm$/i, /^yes$/i,
  /^allow access$/i, /^grant access$/i, /^accept$/i,
  /allow tool/i, /approve action/i, /approve request/i
];

const DENY_PATTERNS = [
  /^deny$/i, /^reject$/i, /^cancel$/i, /^no$/i, /^block$/i
];

const DESTRUCTIVE = [
  /delete/i, /remove/i, /destroy/i, /drop/i,
  /wipe/i, /erase/i, /purge/i, /format/i
];

// ─── Settings ────────────────────────────────────────────────────────────────
let settings = null;

chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
  settings = res?.settings ?? null;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) settings = changes.settings.newValue;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function btnText(el) {
  return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
}

function isApprove(el) { return APPROVE_PATTERNS.some(p => p.test(btnText(el))); }
function isDeny(el)    { return DENY_PATTERNS.some(p => p.test(btnText(el))); }

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

// Walk UP from a button until we find a container that has BOTH
// an Approve-text button AND a Deny-text button inside it.
function findDialogContainer(approveBtn) {
  let el = approveBtn.parentElement;
  for (let i = 0; i < 8 && el && el !== document.body; i++) {
    const btns = Array.from(el.querySelectorAll('button, [role="button"]'));
    if (btns.some(isDeny) && btns.some(isApprove)) return el;
    el = el.parentElement;
  }
  return null;
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function showToast(msg) {
  if (!settings?.showToast) return;
  document.getElementById('aa-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'aa-toast';
  el.textContent = '✅ AutoApprove: ' + msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '20px', right: '20px',
    zIndex: '2147483647', background: '#1a1a1a', color: '#e5e5e5',
    padding: '10px 16px', borderRadius: '8px', fontSize: '13px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
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

  // NOTE: NO offsetParent check — fixed-position overlays have offsetParent===null
  const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(b => !b.disabled);

  for (const btn of allButtons) {
    if (clicked.has(btn)) continue;
    if (!isApprove(btn)) continue;

    // Walk up to find a container holding both Approve + Deny
    const container = findDialogContainer(btn);
    if (!container) continue;

    const text = container.innerText || '';
    if (!passesRules(text)) continue;

    // Fire!
    clicked.add(btn);
    btn.click();

    const label = btnText(btn);
    const site = location.hostname.replace(/^www\./, '');
    const excerpt = text.slice(0, 120).replace(/\n+/g, ' ').trim();
    showToast(`“${label}” approved on ${site}`);
    chrome.runtime.sendMessage({ type: 'LOG_APPROVAL', payload: { site, label, excerpt } });
  }
}

// ─── Observer + interval fallback ──────────────────────────────────────────────
let scanPending = false;
function scheduleScan() {
  if (scanPending) return;
  scanPending = true;
  requestAnimationFrame(() => { scanPending = false; scanDocument(); });
}

// MutationObserver — catches dynamically injected dialogs
new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true, subtree: true
});

// Interval fallback every 800ms — catches dialogs MutationObserver misses
// (e.g. if the dialog was already in DOM before content script loaded)
setInterval(scanDocument, 800);

// ─── Boot ────────────────────────────────────────────────────────────────────
function waitForSettings(n = 0) {
  if (settings !== null) { scanDocument(); return; }
  if (n > 30) return;
  setTimeout(() => waitForSettings(n + 1), 100);
}
waitForSettings();
