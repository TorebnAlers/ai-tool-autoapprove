// AI Tool AutoApprove - Content Script v0.5
// Strips keyboard shortcut hints (e.g. ^Enter) before matching button text

var APPROVE_PATTERNS = [
  /^approve$/i, /^allow$/i, /^confirm$/i, /^yes$/i,
  /^allow access$/i, /^grant access$/i, /^accept$/i,
  /^auto ?approve$/i, /auto ?approve/i,
  /allow tool/i, /approve action/i, /approve request/i
];

var DENY_PATTERNS = [
  /^deny$/i, /^reject$/i, /^cancel$/i, /^no$/i, /^block$/i, /^decline$/i
];

var DESTRUCTIVE = [
  /delete/i, /remove/i, /destroy/i, /drop/i,
  /wipe/i, /erase/i, /purge/i, /format/i
];

const defaultSettings = {
  enabled: true,
  showToast: true,
  rules: {
    mode: 'auto',
    whitelist: [],
    blacklist: []
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

// Settings
let settings = null;

chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, function(res) {
  settings = (res && res.settings) ? res.settings : defaultSettings;
});

chrome.storage.onChanged.addListener(function(changes) {
  if (changes.settings) settings = changes.settings.newValue;
});

// Strip ^Enter, ^Esc etc from button text before matching
function cleanBtnText(el) {
  var text = '';
  var nodes = el.childNodes;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.nodeType === 3) { // TEXT_NODE
      text += node.textContent;
    } else if (node.nodeName === 'SPAN' || node.nodeName === 'DIV') {
      var t = node.textContent.trim();
      // Skip shortcut spans like "^Enter", "^Esc", "Ctrl+X"
      if (!/^(\^|Ctrl|Alt|Cmd|Shift|Meta)/i.test(t)) {
        text += ' ' + t;
      }
    }
  }
  text = text.trim();
  if (!text) {
    text = (el.innerText || el.textContent || '').trim();
  }
  // Strip trailing shortcut suffixes
  text = text.replace(/\s*(\^|Ctrl\+|Alt\+|Cmd\+|Shift\+|Meta\+)\S+/gi, '').trim();
  // Take only first line
  text = text.split('\n')[0].trim();
  return text;
}

function isApprove(el) {
  var t = cleanBtnText(el);
  return APPROVE_PATTERNS.some(function(p) { return p.test(t); });
}

function isDeny(el) {
  var t = cleanBtnText(el);
  return DENY_PATTERNS.some(function(p) { return p.test(t); });
}

function isSiteEnabled() {
  if (!settings) return true;
  var host = location.hostname.replace(/^www\./, '');
  var sites = settings.sites || {};
  var keys = Object.keys(sites);
  for (var i = 0; i < keys.length; i++) {
    if (host.indexOf(keys[i]) !== -1) return sites[keys[i]];
  }
  return true;
}

function passesRules(text) {
  if (!settings) return true;
  var rules = settings.rules || {};
  var mode = rules.mode || 'auto';
  var whitelist = rules.whitelist || [];
  var blacklist = rules.blacklist || [];
  var t = text.toLowerCase();
  if (mode === 'blacklist') {
    for (var i = 0; i < blacklist.length; i++) {
      if (t.indexOf(blacklist[i].toLowerCase()) !== -1) return false;
    }
    for (var j = 0; j < DESTRUCTIVE.length; j++) {
      if (DESTRUCTIVE[j].test(t)) return false;
    }
    return true;
  }
  if (mode === 'whitelist') {
    if (!whitelist.length) return true;
    for (var k = 0; k < whitelist.length; k++) {
      if (t.indexOf(whitelist[k].toLowerCase()) !== -1) return true;
    }
    return false;
  }
  return true;
}

// Walk up DOM to find a container with both Approve + Deny buttons
function findDialogContainer(approveBtn) {
  var el = approveBtn.parentElement;
  for (var i = 0; i < 12 && el && el !== document.body; i++) {
    var btns = Array.from(el.querySelectorAll('button, [role="button"]'));
    if (btns.some(isDeny) && btns.some(isApprove)) return el;

    var role = (el.getAttribute('role') || '').toLowerCase();
    var ariaModal = (el.getAttribute('aria-modal') || '').toLowerCase();
    var className = (el.className || '').toString().toLowerCase();
    if (
      role === 'dialog' ||
      role === 'alertdialog' ||
      ariaModal === 'true' ||
      /(dialog|modal|popover|sheet|drawer|overlay)/i.test(className)
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function showToast(msg) {
  if (!settings || !settings.showToast) return;
  var old = document.getElementById('aa-toast');
  if (old) old.remove();
  var el = document.createElement('div');
  el.id = 'aa-toast';
  el.textContent = 'AutoApprove: ' + msg;
  el.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px',
    'z-index:2147483647', 'background:#1c1b19', 'color:#e5e5e5',
    'padding:10px 16px', 'border-radius:8px', 'font-size:13px',
    'font-family:system-ui,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,0.5)',
    'max-width:360px', 'line-height:1.5',
    'opacity:0', 'transition:opacity 0.2s ease',
    'pointer-events:none'
  ].join(';');
  document.body.appendChild(el);
  requestAnimationFrame(function() { el.style.opacity = '1'; });
  setTimeout(function() {
    el.style.opacity = '0';
    setTimeout(function() { el.remove(); }, 250);
  }, 4000);
}

var clicked = new WeakSet();

function scanDocument() {
  if (!settings || !settings.enabled) return;
  if (!isSiteEnabled()) return;

  var allButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(function(b) { return !b.disabled; });

  for (var i = 0; i < allButtons.length; i++) {
    var btn = allButtons[i];
    if (clicked.has(btn)) continue;
    if (!isApprove(btn)) continue;

    var container = findDialogContainer(btn);
    if (!container) continue;

    var text = container.innerText || '';
    if (!passesRules(text)) continue;

    clicked.add(btn);
    btn.click();

    var label = cleanBtnText(btn);
    var site = location.hostname.replace(/^www\./, '');
    var excerpt = text.slice(0, 120).replace(/\n+/g, ' ').trim();
    showToast('"' + label + '" approved on ' + site);
    chrome.runtime.sendMessage({ type: 'LOG_APPROVAL', payload: { site: site, label: label, excerpt: excerpt } });
  }
}

var scanPending = false;
function scheduleScan() {
  if (scanPending) return;
  scanPending = true;
  requestAnimationFrame(function() { scanPending = false; scanDocument(); });
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true, subtree: true
});

setInterval(scanDocument, 800);

function waitForSettings(n) {
  n = n || 0;
  if (settings !== null) { scanDocument(); return; }
  if (n > 30) { settings = defaultSettings; scanDocument(); return; }
  setTimeout(function() { waitForSettings(n + 1); }, 100);
}
waitForSettings();
