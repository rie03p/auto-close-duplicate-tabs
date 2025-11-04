const DOMAIN_LIST = [
  'x.com',
  'twitter.com',
];

// Navigation guard used to prevent handling synthetic history changes.
const processingTabs = new Set<number>();

// Keep track of tabs that have just been created (e.g. via cmd+click).
const newlyCreatedTabs = new Set<number>();

chrome.tabs.onCreated.addListener(tab => {
  if (typeof tab.id === 'number') {
    newlyCreatedTabs.add(tab.id);
  }
});

chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0) return;

  const tabId = details.tabId;
  const newUrl = details.url;

  if (processingTabs.has(tabId)) {
    processingTabs.delete(tabId);
    return;
  }

  const wasNewTab = newlyCreatedTabs.delete(tabId);

  try {
    const targetUrl = new URL(newUrl);

    const currentTab = await chrome.tabs.get(tabId);
    if (!currentTab.windowId) return;

    const tabs = await chrome.tabs.query({});

    const sameWindowDuplicates: chrome.tabs.Tab[] = [];
    const otherWindowDuplicates: chrome.tabs.Tab[] = [];

    for (const other of tabs) {
      if (other.id === tabId || !other.url) continue;

      let otherUrl: URL;
      try {
        otherUrl = new URL(other.url);
      } catch {
        continue;
      }

      const domainMatch = DOMAIN_LIST.some(domain =>
        targetUrl.hostname.endsWith(domain) && otherUrl.hostname.endsWith(domain)
      );

      const isDuplicate = domainMatch || targetUrl.href === otherUrl.href;

      if (!isDuplicate) continue;

      if (other.windowId === currentTab.windowId) {
        sameWindowDuplicates.push(other);
      } else {
        otherWindowDuplicates.push(other);
      }
    }

    if (sameWindowDuplicates.length > 0) {
      const targetTab = sameWindowDuplicates[0];

      if (wasNewTab) {
        await chrome.tabs.remove(tabId).catch(() => undefined);
      } else {
        processingTabs.add(tabId);

        let reverted = false;
        try {
          await chrome.tabs.goBack(tabId);
          reverted = true;
        } catch (error) {
          processingTabs.delete(tabId);
          console.log('Cannot go back, keeping current page', error);
        }

        if (reverted && typeof targetTab.id === 'number') {
          await chrome.tabs.update(targetTab.id, { active: true }).catch(() => undefined);
        }
      }
    }

    for (const other of otherWindowDuplicates) {
      if (typeof other.id === 'number') {
        await chrome.tabs.remove(other.id).catch(() => undefined);
      }
    }
  } catch (error) {
    console.error('Error processing navigation:', error);
    processingTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  processingTabs.delete(tabId);
  newlyCreatedTabs.delete(tabId);
});
