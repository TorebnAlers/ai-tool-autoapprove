// AI Tool AutoApprove - Content Script v0.7
// Broadened context detection for inline permission prompts (Perplexity, Comet, etc.)
// that do not use dialog/modal wrappers.

var APPROVE_PATTERNS = [
  /^approve$/i, /^allow$/i, /^confirm$/i, /^yes$/i, /^continue$/i, /^proceed$/i,
  /^allow access$/i, /^grant access$/i, /^accept$/i, /^run$/i, /^run anyway$/i,
  /^allow once$/i,
  /^always allow$/i,
  /^allow for this chat$/i,
  /^allow for this session$/i,
  /^approve all$/i,
  /^auto ?approve$/i,
  /allow tool/i, /approve action/i, /approve request/i, /allow .*request/i,
  /allow .*permission/i, /run tool/i, /authorize/i, /execute/i
];

var DENY_PATTERNS = [
  /^deny$/i, /^reject$/i, /^cancel$/i, /^no$/i, /^block$/i, /^decline$/i,
  /^disallow$/i, /^stop$/i, /^abort$/i
];

var DESTRUCTIVE = [
  /delete/i, /remove/i, /destroy/i, /drop/i,
  /wipe/i, /erase/i, /purge/i, /format/i
];
var DIALOG_CLASS_PATTERN = /\b(dialog|modal|popover|sheet|drawer|overlay|prompt|confirm)\b/i;
// Context terms commonly present in tool-permission prompts where button text is generic
// (e.g., "Allow", "Run"). Includes "mcp" (Model Context Protocol) and common chat UI terms.
var PROMPT_CONTEXT_PATTERN = /\b(tool|permission|access|request|authorize|approval|agent|mcp|run|execute|connect|github|function|action)\b/i;
var MAX_CLICK_ATTEMPTS = 3;
var CLICK_RETRY_DELAY_MS = 140;
var MAX_SCAN_ATTEMPTS = 5;
var SCAN_SCHEDULE_DELAY_MS = 60;
var SCAN_INTERVAL_MS = 800;
var MAX_EXCERPT_LENGTH = 120;
var ACTIONABLE_SELECTOR = [
  'button',
  '[role="button"]',
  'input[type="button"]',
  'input[type="submit"]',
  '[data-testid*="approve" i]',
  '[data-testid*="allow" i]',
  '[data-testid*="confirm" i]',
  '[data-testid*="permission" i]',
  '[data-testid*="authorize" i]',
  '[aria-label*="approve" i]',
  '[aria-label*="allow" i]',
  '[aria-label*="confirm" i]',
  '[aria-label*="permission" i]',
  '[aria-label*="authorize" i]',
  '[title*="approve" i]',
  '[title*="allow" i]',
  '[title*="confirm" i]',
  '[title*="permission" i]',
  '[title*="authorize" i]'
].join(',');

var DEFAULT_ADAPTERS = {
  'perplexity.ai': {
    selectors: [
      '[data-testid*="permission" i] button',
      '[data-testid*="tool" i] button',
      '[data-testid*="confirm" i] button'
    ]
  },
  // Comet is a Perplexity product — same permission UI style
  'comet.perplexity.ai': {
    selectors: [
      '[data-testid*="permission" i] button',
      '[data-testid*="tool" i] button',
      '[data-testid*="confirm" i] button',
      'button'
    ]
  },
  'claude.ai': {
    selectors: [
      '[data-testid*="tool" i] button',
      '[data-testid*="permission" i] button',
      '[data-testid*="confirm" i] button'
    ]
  },
  'github.com': {
    selectors: [
      '[data-testid*="copilot" i] button',
      '[data-testid*="confirmation" i] button',
      '[data-testid*="tool" i] button'
    ]
  },
  'chatgpt.com': {
    selectors: ['[data-testid*="confirm" i]', '[data-testid*="approve" i]']
  },
  'chat.openai.com': {
    selectors: ['[data-testid*="confirm" i]', '[data-testid*="approve" i]']
  },
  'copilot.microsoft.com': {
    selectors: [
      '[data-testid*="confirm" i]',
      '[data-testid*="permission" i]',
      '[data-testid*="approve" i]'
    ]
  }
};

const defaultSettings = {
  enabled: true,
  showToast: true,
  debug: false,
  confidenceThreshold: 50,
  destructiveThreshold: 75,
  heuristics: {
    approveHints: [],
    denyHints: []
  },
  adapters: {},
  rules: {
    mode: 'auto',
    whitelist: [],
    blacklist: []
  },
  sites: {
    '*': true,
    'perplexity.ai': true,
    'comet.perplexity.ai': true,
    'claude.ai': true,
    'chatgpt.com': true,
    'chat.openai.com': true,
    'github.com': true,
    'copilot.microsoft.com': true
  }
};

let settings = null;

chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, function(res) {
  settings = (res && res.settings) ? res.settings : defaultSettings;
});

chrome.storage.onChanged.addListener(function(changes) {
  if (changes.settings) settings = changes.settings.newValue;
});

function debugLog(reason, meta) {
  var debugEnabled = settings ? !!settings.debug : !!defaultSettings.debug;
  if (!debugEnabled) return;
  console.log('[AutoApprove][debug]', reason, meta || {});
}

function cleanBtnText(el) {
  var text = '';
  var nodes = el.childNodes || [];
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.nodeType === 3) {
      text += node.textContent;
    } else if (node.nodeName === 'SPAN' || node.nodeName === 'DIV') {
      var t = (node.textContent || '').trim();
      if (!/^(\^|Ctrl|Alt|Cmd|Shift|Meta)/i.test(t)) text += ' ' + t;
    }
  }
  text = text.trim();
  if (!text) text = (el.innerText || el.textContent || '').trim();
  text = text.replace(/\s*(\^|Ctrl\+|Alt\+|Cmd\+|Shift\+|Meta\+)\S+/gi, '').trim();
  return text.split('\n')[0].trim();
}

function norm(s) {
  return (s || '').toString().trim().toLowerCase();
}

function elementSignals(el) {
  var text = cleanBtnText(el);
  return {
    text: text,
    aria: el.getAttribute('aria-label') || '',
    title: el.getAttribute('title') || '',
    testid: el.getAttribute('data-testid') || '',
    value: el.value || ''
  };
}

function getPatterns(basePatterns, hintList) {
  var patterns = basePatterns.slice();
  for (var i = 0; i < (hintList || []).length; i++) {
    var hint = norm(hintList[i]);
    if (!hint) continue;
    patterns.push(new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  return patterns;
}

function isApprove(el) {
  var s = elementSignals(el);
  var joined = [s.text, s.aria, s.title, s.testid, s.value].join(' ');
  var approve = getPatterns(APPROVE_PATTERNS, settings && settings.heuristics && settings.heuristics.approveHints);
  return approve.some(function(p) { return p.test(joined); });
}

function isDeny(el) {
  var s = elementSignals(el);
  var joined = [s.text, s.aria, s.title, s.testid, s.value].join(' ');
  var deny = getPatterns(DENY_PATTERNS, settings && settings.heuristics && settings.heuristics.denyHints);
  return deny.some(function(p) { return p.test(joined); });
}

function isSiteEnabled() {
  if (!settings) return true;
  var host = location.hostname.replace(/^www\./, '');
  var sites = settings.sites || {};
  var keys = Object.keys(sites);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === '*' && host) return sites[keys[i]];
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
  var t = norm(text);
  if (mode === 'blacklist') {
    for (var i = 0; i < blacklist.length; i++) {
      if (t.indexOf(norm(blacklist[i])) !== -1) return false;
    }
    for (var j = 0; j < DESTRUCTIVE.length; j++) {
      if (DESTRUCTIVE[j].test(t)) return false;
    }
    return true;
  }
  if (mode === 'whitelist') {
    if (!whitelist.length) return true;
    for (var k = 0; k < whitelist.length; k++) {
      if (t.indexOf(norm(whitelist[k])) !== -1) return true;
    }
    return false;
  }
  return true;
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  var style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false;
  var rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isDisabled(el) {
  return !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
}

function getRootNodeDocument(root) {
  if (!root) return document;
  if (root.nodeType === 9) return root;
  return (root.ownerDocument || document);
}

function collectSearchRootsFromDocument(doc, roots, seenDocs) {
  if (!doc || seenDocs.has(doc)) return;
  seenDocs.add(doc);
  roots.push(doc);
  var rootNode = doc.documentElement || doc.body;
  if (!rootNode) return;
  var walker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    var node = walker.currentNode;
    if (node.shadowRoot) roots.push(node.shadowRoot);
    if (node.tagName === 'IFRAME') {
      try {
        if (node.contentDocument) collectSearchRootsFromDocument(node.contentDocument, roots, seenDocs);
      } catch (_e) {
        // ignore inaccessible frame/document traversal errors
      }
    }
  }
}

function collectSearchRoots() {
  var roots = [];
  collectSearchRootsFromDocument(document, roots, new Set());
  return roots;
}

function getHostAdapter(host) {
  var merged = {};
  // Match adapter by longest suffix (so comet.perplexity.ai beats perplexity.ai)
  var bestKey = null;
  var keys = Object.keys(DEFAULT_ADAPTERS);
  for (var i = 0; i < keys.length; i++) {
    if (host === keys[i] || host.endsWith('.' + keys[i]) || host.indexOf(keys[i]) !== -1) {
      if (!bestKey || keys[i].length > bestKey.length) bestKey = keys[i];
    }
  }
  var defaults = bestKey ? DEFAULT_ADAPTERS[bestKey] : { selectors: [] };
  var fromSettings = (settings && settings.adapters && settings.adapters[host]) || { selectors: [] };
  merged.selectors = (defaults.selectors || []).concat(fromSettings.selectors || []);
  return merged;
}

function queryCandidates() {
  var roots = collectSearchRoots();
  var candidates = new Set();
  var host = location.hostname.replace(/^www\./, '');
  var adapter = getHostAdapter(host);
  for (var i = 0; i < roots.length; i++) {
    var root = roots[i];
    var queried = root.querySelectorAll(ACTIONABLE_SELECTOR);
    for (var j = 0; j < queried.length; j++) candidates.add(queried[j]);
    for (var k = 0; k < adapter.selectors.length; k++) {
      var sel = adapter.selectors[k];
      try {
        var sem = root.querySelectorAll(sel);
        for (var m = 0; m < sem.length; m++) candidates.add(sem[m]);
      } catch (_e) {
        // ignore adapter selector/query errors
      }
    }
  }
  return Array.from(candidates);
}

function findDialogContainer(approveBtn) {
  var el = approveBtn;
  for (var i = 0; i < 14 && el; i++) {
    if (el.nodeType !== 1) {
      el = el.parentElement;
      continue;
    }
    var btns = Array.from(el.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
    if (btns.some(isDeny) && btns.some(isApprove)) return el;

    var role = norm(el.getAttribute('role'));
    var ariaModal = norm(el.getAttribute('aria-modal'));
    var className = norm(el.className);
    if (role === 'dialog' || role === 'alertdialog' || ariaModal === 'true' || DIALOG_CLASS_PATTERN.test(className)) {
      return el;
    }
    var root = el.getRootNode();
    if (root && root.host && el === root) {
      el = root.host;
    } else {
      el = el.parentElement;
    }
  }
  return null;
}

function hasSiblingDeny(container) {
  if (!container) return false;
  var btns = Array.from(container.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
  for (var i = 0; i < btns.length; i++) {
    if (isDeny(btns[i])) return true;
  }
  return false;
}

/**
 * hasPromptContext checks if a button is inside (or near) a permission prompt.
 *
 * Strategy:
 *  1. Walk up to 12 ancestor levels looking for context text.
 *  2. Also check the page-level body text as a last resort (weaker signal).
 *
 * This handles Perplexity/Comet inline prompts that are NOT wrapped in a
 * formal dialog/modal element — they render as a plain <div> inside the chat.
 */
function hasPromptContext(btn) {
  // First: try the formal dialog wrapper (original logic)
  var scope =
    btn.closest('[role="dialog"], [aria-modal="true"], dialog, form') ||
    btn.closest('[class*="dialog" i], [class*="modal" i], [class*="popover" i], [class*="prompt" i]');
  if (scope) {
    var contextText = (scope.innerText || '').toLowerCase();
    if (PROMPT_CONTEXT_PATTERN.test(contextText)) return true;
  }

  // Second: walk ancestor chain looking for prompt context text (inline prompts)
  var el = btn.parentElement;
  for (var i = 0; i < 12 && el && el !== document.body; i++) {
    var text = (el.innerText || '').toLowerCase();
    if (PROMPT_CONTEXT_PATTERN.test(text)) return true;
    // Extra: if this ancestor has both an Approve and a Deny sibling button — strong signal
    var sibBtns = Array.from(el.querySelectorAll('button, [role="button"]'));
    if (sibBtns.length >= 2 && sibBtns.some(isApprove) && sibBtns.some(isDeny)) return true;
    el = el.parentElement;
  }

  // Third (weakest): check visible text near the button (5 ancestor levels, short text only)
  var near = btn.parentElement;
  for (var j = 0; j < 5 && near; j++) {
    var t = (near.innerText || '').replace(/\s+/g, ' ').trim();
    if (t.length < 400 && PROMPT_CONTEXT_PATTERN.test(t.toLowerCase())) return true;
    near = near.parentElement;
  }

  return false;
}

function scoreCandidate(btn, container, text, isSemanticHit, hasContextHint) {
  var score = 0;
  var s = elementSignals(btn);
  var combined = [s.text, s.aria, s.title, s.testid, s.value].join(' ');
  if (isApprove(btn)) score += 40;
  if (/^approve$|^allow$|^confirm$|^continue$|^run$/i.test(norm(s.text))) score += 20;
  if (isSemanticHit) score += 25;
  if (hasContextHint) score += 15;
  if (container) score += 15;
  if (hasSiblingDeny(container)) score += 20;
  if (DIALOG_CLASS_PATTERN.test(norm((container && container.className) || ''))) score += 5;
  if (isDisabled(btn) || !isVisible(btn)) score -= 50;
  if (isDeny(btn)) score -= 100;
  if (DESTRUCTIVE.some(function(p) { return p.test(combined); })) score -= 50;
  if (DESTRUCTIVE.some(function(p) { return p.test(text); })) score -= 25;
  return score;
}

function clickWithEvents(el) {
  var evs = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (var i = 0; i < evs.length; i++) {
    el.dispatchEvent(new MouseEvent(evs[i], { bubbles: true, cancelable: true, view: window }));
  }
}

function stillActionable(btn, container) {
  if (!btn || !btn.isConnected) return false;
  if (!isVisible(btn) || isDisabled(btn)) return false;
  if (container && !container.isConnected) return false;
  return isApprove(btn);
}

function showToast(msg) {
  if (!settings || !settings.showToast) return;
  if (!document.body) return;
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

var attempted = new WeakMap();
var clicked = new WeakSet();

function markAttempt(btn) {
  var n = attempted.get(btn) || 0;
  attempted.set(btn, n + 1);
  return n + 1;
}

function executeApproval(btn, container, text, score) {
  if (clicked.has(btn)) return;
  clicked.add(btn);

  var attempts = 0;
  function attempt() {
    attempts += 1;
    try {
      btn.click();
    } catch (_e) {
      debugLog('native-click-failed', { label: cleanBtnText(btn) });
    }
    try {
      clickWithEvents(btn);
    } catch (_e2) {
      debugLog('event-click-failed', { label: cleanBtnText(btn) });
    }
    setTimeout(function() {
      if (!stillActionable(btn, container) || attempts >= MAX_CLICK_ATTEMPTS) {
        var label = cleanBtnText(btn) || btn.getAttribute('aria-label') || 'approve';
        var site = location.hostname.replace(/^www\./, '');
        var excerpt = (text || '').slice(0, MAX_EXCERPT_LENGTH).replace(/\n+/g, ' ').trim();
        showToast('"' + label + '" approved on ' + site);
        chrome.runtime.sendMessage({
          type: 'LOG_APPROVAL',
          payload: { site: site, label: label, excerpt: excerpt, score: score, attempts: attempts }
        });
        return;
      }
      attempt();
    }, CLICK_RETRY_DELAY_MS);
  }
  attempt();
}

function scanDocument() {
  if (!settings || !settings.enabled) return;
  if (!isSiteEnabled()) return;

  var candidates = queryCandidates();
  if (!candidates.length) return;

  var best = null;
  for (var i = 0; i < candidates.length; i++) {
    var btn = candidates[i];
    if (!btn || clicked.has(btn)) continue;
    if (isDisabled(btn) || !isVisible(btn)) continue;
    if (!isApprove(btn)) continue;

    var attemptCount = attempted.get(btn) || 0;
    if (attemptCount >= MAX_SCAN_ATTEMPTS) continue;
    markAttempt(btn);

    var container = findDialogContainer(btn);
    var contextText = (container ? container.innerText : (btn.closest('form, section, div') || btn).innerText) || '';
    if (!passesRules(contextText)) {
      debugLog('rules-blocked', { label: cleanBtnText(btn) });
      continue;
    }

    var host = location.hostname.replace(/^www\./, '');
    var adapter = getHostAdapter(host);
    var semanticHit = adapter.selectors.some(function(sel) {
      try { return btn.matches(sel) || !!btn.closest(sel); } catch (_e) { return false; }
    });
    var contextHint = hasPromptContext(btn);
    var score = scoreCandidate(btn, container, contextText, semanticHit, contextHint);
    var baseThreshold = Number(settings.confidenceThreshold || defaultSettings.confidenceThreshold) || 50;
    var destructiveThreshold = Number(settings.destructiveThreshold || defaultSettings.destructiveThreshold) || 75;
    var hasDestructive = DESTRUCTIVE.some(function(p) { return p.test(contextText); });
    var threshold = hasDestructive ? destructiveThreshold : baseThreshold;

    // Allow inline permission prompts to qualify via contextHint even without a formal dialog wrapper.
    // Perplexity and Comet render permission boxes as plain divs inside the chat, so container
    // and semanticHit may both be falsy — contextHint from the ancestor walk covers them.
    if (!container && !semanticHit && !contextHint) {
      debugLog('no-dialog-context', { label: cleanBtnText(btn), score: score });
      continue;
    }
    if (score < threshold) {
      debugLog('low-score', { label: cleanBtnText(btn), score: score, threshold: threshold });
      continue;
    }

    if (!best || score > best.score) {
      best = { btn: btn, container: container, text: contextText, score: score };
    }
  }

  if (best) executeApproval(best.btn, best.container, best.text, best.score);
}

var scanPending = false;
function scheduleScan() {
  if (scanPending) return;
  scanPending = true;
  setTimeout(function() {
    scanPending = false;
    scanDocument();
  }, SCAN_SCHEDULE_DELAY_MS);
}

new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  characterData: true
});

document.addEventListener('visibilitychange', scheduleScan, true);
window.addEventListener('focus', scheduleScan, true);
window.addEventListener('pageshow', scheduleScan, true);

setInterval(scanDocument, SCAN_INTERVAL_MS);

function waitForSettings(n) {
  n = n || 0;
  if (settings !== null) {
    scanDocument();
    return;
  }
  if (n > 30) {
    settings = defaultSettings;
    scanDocument();
    return;
  }
  setTimeout(function() { waitForSettings(n + 1); }, 100);
}
waitForSettings();
