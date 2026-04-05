# AI Tool AutoApprove — Chrome Extension

A Manifest V3 Chrome extension that automatically approves AI agent tool-call permission prompts — so you stop manually clicking "Allow" every time an AI agent wants to access your GitHub repo or run a tool.

## Supported Sites

| Site | Status |
|---|---|
| Perplexity.ai | ✅ Primary |
| Claude.ai | ✅ |
| ChatGPT / chat.openai.com | ✅ |
| GitHub.com (Copilot) | ✅ |
| Microsoft Copilot | ✅ |

## Features

- 🔄 **Auto-approve** — clicks Allow/Approve/Confirm buttons in AI chat dialogs automatically
- 🔔 **Toast notification** — shows a small overlay so you always know the extension acted
- ☠️ **Kill switch** — instantly disable the extension from the popup
- 🏷️ **Approval modes** — Auto (approve everything), Whitelist (approve only matching keywords), Blacklist (block matching keywords, approve the rest)
- 🌐 **Per-site toggle** — enable/disable on each supported domain independently

## How It Works

The extension runs a `MutationObserver` in each supported page. When a new dialog or confirmation element appears in the DOM, it:

1. Checks if the extension is globally enabled
2. Checks if the current site is enabled
3. Applies whitelist/blacklist rules against the dialog text
4. Finds the approve button (by `data-testid` selector first, then by visible button text)
5. Clicks it and shows a toast

## Installation (Developer Mode)

```bash
git clone https://github.com/TorebnAlers/ai-tool-autoapprove.git
cd ai-tool-autoapprove
```

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the cloned `ai-tool-autoapprove` folder
5. The extension icon appears in your toolbar

## Popup Settings

- **Master toggle** — enable/disable globally
- **Toast notifications** — show/hide the approval toast
- **Approval Mode** — Auto / Whitelist / Blacklist
- **Keyword list** — keywords to match in the dialog text
- **Sites** — per-domain enable/disable

## ⚠️ Security Warning

This extension removes a safety checkpoint. Use with care:
- Use **Blacklist mode** to block auto-approval of destructive actions (`delete`, `remove`, etc.)
- Use the **kill switch** when working on sensitive repos
- Never leave it enabled unattended on production systems

## Updating Selectors

AI chat UIs change their DOM frequently. If auto-approve stops working on a site, update the selectors in `content/content.js` under `SITE_SELECTORS`.

## Roadmap

- [ ] Approval history log page
- [ ] Per-tool-type rules (e.g. never auto-approve `delete_file`)
- [ ] Firefox support (WebExtensions)
- [ ] Auto-detect new approve buttons via ML heuristic

## License

MIT
