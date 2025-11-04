const DOMAIN_LIST = ['x.com', 'twitter.com'];

// タブ処理用のガード
const processingTabs = new Set<number>();
const newlyCreatedTabs = new Set<number>();

// --- ユーティリティ関数群 ---

function isMainFrame(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): boolean {
  return details.frameId === 0;
}

function isValidTabId(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number } {
  return typeof tab.id === 'number';
}

function isSameDomain(urlA: URL, urlB: URL): boolean {
  return DOMAIN_LIST.some(domain =>
    urlA.hostname.endsWith(domain) && urlB.hostname.endsWith(domain)
  );
}

function isDuplicateUrl(targetUrl: URL, otherUrl: URL): boolean {
  return isSameDomain(targetUrl, otherUrl) || targetUrl.href === otherUrl.href;
}

async function findDuplicateTabs(targetUrl: URL, currentTabId: number): Promise<{
  sameWindow: chrome.tabs.Tab[];
  otherWindows: chrome.tabs.Tab[];
}> {
  const tabs = await chrome.tabs.query({});
  const sameWindow: chrome.tabs.Tab[] = [];
  const otherWindows: chrome.tabs.Tab[] = [];

  const currentTab = await chrome.tabs.get(currentTabId);
  if (!currentTab.windowId) return { sameWindow, otherWindows };

  for (const tab of tabs) {
    if (tab.id === currentTabId || !tab.url) continue;

    try {
      const otherUrl = new URL(tab.url);
      if (!isDuplicateUrl(targetUrl, otherUrl)) continue;

      if (tab.windowId === currentTab.windowId) sameWindow.push(tab);
      else otherWindows.push(tab);
    } catch {
      continue;
    }
  }

  return { sameWindow, otherWindows };
}

async function revertOrCloseDuplicate(tabId: number, wasNewTab: boolean, duplicate: chrome.tabs.Tab) {
  if (wasNewTab) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return;
  }

  processingTabs.add(tabId);
  try {
    await chrome.tabs.goBack(tabId);
    if (duplicate.id) {
      await chrome.tabs.update(duplicate.id, { active: true }).catch(() => {});
    }
  } catch (error) {
    console.warn('Cannot go back, keeping current page', error);
  } finally {
    processingTabs.delete(tabId);
  }
}

// --- イベントハンドラ群 ---

chrome.tabs.onCreated.addListener(tab => {
  if (isValidTabId(tab)) newlyCreatedTabs.add(tab.id);
});

chrome.webNavigation.onCommitted.addListener(async details => {
  if (!isMainFrame(details)) return;

  const tabId = details.tabId;
  if (processingTabs.has(tabId)) return processingTabs.delete(tabId);

  const wasNewTab = newlyCreatedTabs.delete(tabId);

  try {
    const targetUrl = new URL(details.url);
    const { sameWindow, otherWindows } = await findDuplicateTabs(targetUrl, tabId);

    if (sameWindow.length > 0) {
      await revertOrCloseDuplicate(tabId, wasNewTab, sameWindow[0]);
    }

    for (const dup of otherWindows) {
      if (dup.id) await chrome.tabs.remove(dup.id).catch(() => {});
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
