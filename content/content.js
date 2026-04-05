/**
 * AI Tool AutoApprove — Content Script v0.2
 * Aggressively scans the full document (not just added nodes) on every
 * DOM mutation so portal-rendered dialogs (Perplexity, Claude) are caught.
 */

// ─── Approve button text patterns ───────────────────────────────────────────
// Matched against trimmed innerText of every visible button.
const APPROVE_PATTERNS = [
  /^approve$/i,
  /^allow$/i,
  /^confirm$/i,
  /^yes$/i,
  /^allow access$/i,
  /^grant access$/i,
  /^continue$/i,
  /^accept$/i,
  /allow tool/i,
  /approve action/i,
  /approve request/i
];

// Deny-button patterns — used to confirm we're inside a real approval dialog
const DENY_PATTERNS = [
  /^deny$/i,
  /^reject$/i,
  /^cancel$/i,
  /^no$/i,
  /^block$/i
];

// Destructive keywords — blocked when blacklist mode is active
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
function getButtonText(btn) {
  return (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim();
}

function isApproveButton(btn) {
  const t = getButtonText(btn);
  return APPROVE_PATTERNS.some(p => p.test(t));
}

function isDenyButton(btn) {
  const t = getButtonText(btn);
  return DENY_PATTERNS.some(p => p.test(t));
}

function passesRules(dialogText) {
  if (!settings) return true;
  const { mode, whitelist = [], blacklist = [] } = settings.rules;
  const t = dialogText.toLowerCase();

  if (mode === 'blacklist') {
    if (blacklist.some(k => t.includes(k.toLowerCase()))) return false;
    if (DESTRUCTIVE.some(p => p.test(t))) return false;
    return true;
  }
  if (mode === 'whitelist') {
    if (whitelist.length === 0) return true;
    return whitelist.some(k => t.includes(k.toLowerCase()));
  }
  return true; // auto
}

function isSiteEnabled() {
  if (!settings) return true;
  const host = location.hostname.replace(/^www\./, '');
  for (const [key, val] of Object.entries(settings.sites || {})) {
    if (host.includes(key)) return val;
  }
  return true;
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg) {
  if (!settings?.showToast) return;
  // Remove any existing toast
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
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, 4000);
}

// ─── Core scanner ────────────────────────────────────────────────────────────
// Scans the ENTIRE document for approval dialogs.
// Strategy: find any button matching APPROVE_PATTERNS that appears alongside
// a DENY_PATTERNS button — that pairing is the strongest signal we're inside
// a real approval dialog and not just a random "Continue" button on the page.

const clicked = new WeakSet();

function scanDocument() {
  if (!settings?.enabled) return;
  if (!isSiteEnabled()) return;

  // Grab every visible, enabled button on the page
  const allButtons = Array.from(
    document.querySelectorAll('button, [role="button"]')
  ).filter(b => !b.disabled && b.offsetParent !== null);

  for (const btn of allButtons) {
    if (clicked.has(btn)) continue;
    if (!isApproveButton(btn)) continue;

    // Verify: is there a Deny-style button nearby?
    // "Nearby" = same parent, grandparent, or great-grandparent container
    const container = btn.closest(
      '[role="dialog"], [class*="modal"], [class*="Modal"],
       [class*="dialog"], [class*="Dialog"],
       [class*="confirm"], [class*="Confirm"],
       [class*="approval"], [class*="Approval"],
       [class*="permission"], [class*="Permission"],
       [class*="tool"], [class*="Tool"]'
    ) || btn.parentElement?.parentElement || btn.parentElement;

    if (!container) continue;

    const siblings = Array.from(
      container.querySelectorAll('button, [role="button"]')
    );
    const hasDenyPartner = siblings.some(s => isDenyButton(s));

    // On Perplexity the Deny/Approve pair is always together
    // On other sites we also accept solo approve buttons inside a dialog role
    const isDialog = !!btn.closest('[role="dialog"]');
    if (!hasDenyPartner && !isDialog) continue;

    // Rules check against the container text
    const dialogText = container.innerText || '';
    if (!passesRules(dialogText)) continue;

    // Fire!
    clicked.add(btn);
    btn.click();

    const label = getButtonText(btn);
    const site = location.hostname.replace(/^www\./, '');
    const excerpt = dialogText.slice(0, 100).trim().replace(/\n+/g, ' ');
    showToast(`"${label}" on ${site} — ${excerpt}`);
    chrome.runtime.sendMessage({
      type: 'LOG_APPROVAL',
      payload: { site, label, excerpt }
    });
  }
}

// ─── MutationObserver — scan full doc on any DOM change ──────────────────────
let scanPending = false;

function scheduleScan() {
  if (scanPending) return;
  scanPending = true;
  // Use requestAnimationFrame so the new DOM is fully painted before scanning
  requestAnimationFrame(() => {
    scanPending = false;
    scanDocument();
  });
}

const observer = new MutationObserver(scheduleScan);

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: false,
  characterData: false
});

// ─── Boot ────────────────────────────────────────────────────────────────────
// Wait for settings then do an initial scan
function waitForSettings(attempts = 0) {
  if (settings !== null) {
    scanDocument();
    return;
  }
  if (attempts > 20) return; // give up after 2s
  setTimeout(() => waitForSettings(attempts + 1), 100);
}

waitForSettings();
