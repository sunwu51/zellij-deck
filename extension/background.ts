chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
// Pairing tokens stay in extension storage, never exposed to content scripts.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
