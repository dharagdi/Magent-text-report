/* background.js — service worker.
   Opens the side panel when the toolbar icon is clicked, and (defensively)
   ensures the content scripts are present on the active tab before the panel
   messages them (some tabs load before the extension is installed/updated). */

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

// Fallback: if setPanelBehavior isn't honored, open on click explicitly.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (e) { /* panel opens via behavior */ }
});

// Let the side panel ask us to (re)inject content scripts into a tab that
// predates the install, so "Pull job" / "Autofill" work without a reload.
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && msg.type === "ensureScripts" && msg.tabId) {
    chrome.scripting.executeScript({
      target: { tabId: msg.tabId },
      files: ["content-scrape.js", "content-autofill.js"],
    }).then(() => send({ ok: true })).catch((e) => send({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
