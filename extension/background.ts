import { openDashboard } from './window-controls';

chrome.action.onClicked.addListener(() => {
  void openDashboard().catch(console.error);
});
// Pairing tokens stay in extension storage, never exposed to content scripts.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
