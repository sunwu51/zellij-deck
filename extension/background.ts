import { openDashboard } from './window-controls';

chrome.action.onClicked.addListener(() => {
  void openDashboard().catch(console.error);
});
// Reloading the extension leaves already-open terminal windows blank; reload them so they reattach.
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: `${chrome.runtime.getURL('terminal.html')}*` })
    .then(tabs => tabs.forEach(tab => { if (tab.id !== undefined) void chrome.tabs.reload(tab.id); }))
    .catch(console.error);
});
// Pairing tokens stay in extension storage, never exposed to content scripts.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
