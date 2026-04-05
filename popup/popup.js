const SITES = [
  'perplexity.ai',
  'claude.ai',
  'chatgpt.com',
  'chat.openai.com',
  'github.com',
  'copilot.microsoft.com'
];

let settings = null;

function loadSettings(cb) {
  chrome.storage.sync.get('settings', (data) => {
    settings = data.settings;
    cb(settings);
  });
}

function saveSettings(cb) {
  chrome.storage.sync.set({ settings }, () => {
    showStatus('Saved');
    if (cb) cb();
  });
}

function showStatus(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

function renderSites() {
  const container = document.getElementById('sitesContainer');
  container.innerHTML = '';
  for (const site of SITES) {
    const row = document.createElement('div');
    row.className = 'site-row';
    const enabled = settings.sites[site] !== false;
    row.innerHTML = `
      <span>${site}</span>
      <label class="toggle small" aria-label="Toggle ${site}">
        <input type="checkbox" data-site="${site}" ${enabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>`;
    container.appendChild(row);
  }
  container.querySelectorAll('input[data-site]').forEach(input => {
    input.addEventListener('change', () => {
      settings.sites[input.dataset.site] = input.checked;
      saveSettings();
    });
  });
}

function renderListSection() {
  const mode = settings.rules.mode;
  const section = document.getElementById('listSection');
  const title = document.getElementById('listTitle');
  const textarea = document.getElementById('listInput');

  if (mode === 'auto') {
    section.style.display = 'none';
  } else {
    section.style.display = 'block';
    title.textContent = mode === 'whitelist'
      ? 'Whitelist — approve ONLY if dialog contains:'
      : 'Blacklist — NEVER approve if dialog contains:';
    const list = mode === 'whitelist' ? settings.rules.whitelist : settings.rules.blacklist;
    textarea.value = list.join('\n');
  }
}

function parseList(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings((s) => {
    // Master toggle
    const masterToggle = document.getElementById('masterToggle');
    masterToggle.checked = s.enabled;
    masterToggle.addEventListener('change', () => {
      settings.enabled = masterToggle.checked;
      saveSettings();
    });

    // Toast toggle
    const toastToggle = document.getElementById('toastToggle');
    toastToggle.checked = s.showToast;
    toastToggle.addEventListener('change', () => {
      settings.showToast = toastToggle.checked;
      saveSettings();
    });

    // Mode radios
    document.querySelectorAll('input[name="mode"]').forEach(radio => {
      if (radio.value === s.rules.mode) radio.checked = true;
      radio.addEventListener('change', () => {
        if (radio.checked) {
          settings.rules.mode = radio.value;
          renderListSection();
          saveSettings();
        }
      });
    });

    // List textarea
    const textarea = document.getElementById('listInput');
    textarea.addEventListener('blur', () => {
      const list = parseList(textarea.value);
      if (settings.rules.mode === 'whitelist') settings.rules.whitelist = list;
      else settings.rules.blacklist = list;
      saveSettings();
    });

    renderListSection();
    renderSites();
  });
});
