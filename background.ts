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

function isUserLinkNavigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): boolean {
  return details.transitionType === 'link';
}

async function findDuplicateTabs(targetUrl: URL, currentTabId: number) {
  const tabs = await chrome.tabs.query({});
  const current = await chrome.tabs.get(currentTabId);

  if (!current.windowId) return { sameWindow: [], otherWindows: [] };

  const sameWindow: chrome.tabs.Tab[] = [];
  const otherWindows: chrome.tabs.Tab[] = [];

  for (const tab of tabs) {
    if (tab.id === currentTabId || !tab.url) continue;

    try {
      const url = new URL(tab.url);
      if (!isDuplicateUrl(targetUrl, url)) continue;

      (tab.windowId === current.windowId ? sameWindow : otherWindows).push(tab);
    } catch {
      continue;
    }
  }

  return { sameWindow, otherWindows };
}

/** 重複タブの処理 */
async function handleDuplicate(tabId: number, isNewTab: boolean, existing: chrome.tabs.Tab) {
  if (isNewTab) {
    // 新規タブなら閉じるだけ
    await chrome.tabs.remove(tabId).catch(() => {});
    return;
  }

  // 既存タブを優先
  processingTabs.add(tabId);
  try {
    await chrome.tabs.goBack(tabId).catch(() => {});
    if (existing.id) {
      await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    }
  } finally {
    processingTabs.delete(tabId);
  }
}

/** 重複タブ処理本体 */
async function handleDuplicateTabs(tabId: number, details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) {
  const isNew = newlyCreatedTabs.delete(tabId);
  const targetUrl = new URL(details.url);

  const { sameWindow, otherWindows } = await findDuplicateTabs(targetUrl, tabId);

  // 同一ウィンドウに重複タブがあるならそれを優先
  if (sameWindow[0]) {
    await handleDuplicate(tabId, isNew, sameWindow[0]);
  }

  // 他ウィンドウの重複は問答無用で閉じる
  for (const t of otherWindows) {
    if (t.id) await chrome.tabs.remove(t.id).catch(() => {});
  }
}

// ──────────────────────────────
// Event Listeners
// ──────────────────────────────

chrome.tabs.onCreated.addListener(tab => {
  if (isValidTabId(tab)) newlyCreatedTabs.add(tab.id);
});

chrome.webNavigation.onCommitted.addListener(async details => {
  if (!isMainFrame(details)) return;

  const tabId = details.tabId;

  // goBack 直後の二重処理回避
  if (processingTabs.has(tabId)) {
    processingTabs.delete(tabId);
    return;
  }

  // 「ユーザーがページ内リンクをクリックして開いた」場合だけ、重複タブ制御を行う
  if (!isUserLinkNavigation(details)) {
    return;
  }

  try {
    await handleDuplicateTabs(tabId, details);
  } catch (e) {
    console.error('[duplicate-tab-handler] Error:', e);
    processingTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  processingTabs.delete(tabId);
  newlyCreatedTabs.delete(tabId);
});