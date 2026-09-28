// No default_popup is set in the manifest, so clicking the toolbar icon
// fires this instead. We open the control UI as a normal browser tab
// rather than a small dropdown popup -- easier to read, and it won't
// auto-close if you click elsewhere while a run is in progress.
chrome.action.onClicked.addListener(async () => {
  const existing = await chrome.tabs.query({
    url: chrome.runtime.getURL("popup.html*"),
  });

  if (existing.length > 0) {
    // Already open -- just focus it instead of opening a duplicate.
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});
