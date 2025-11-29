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
  const all = await chrome.tabs.query({});
  const current = await chrome.tabs.get(currentTabId);

  if (!current.windowId) return { sameWindow: [], otherWindows: [] };

  const sameWindow: chrome.tabs.Tab[] = [];
  const otherWindows: chrome.tabs.Tab[] = [];

  for (const tab of all) {
    if (tab.id === currentTabId || !tab.url) continue;
    try {
      const url = new URL(tab.url);
      if (!isDuplicateUrl(targetUrl, url)) continue;

      (tab.windowId === current.windowId ? sameWindow : otherWindows).push(tab);
    } catch {}
  }

  return { sameWindow, otherWindows };
}

// ──────────────────────────────
// 重複タブの整理
// ──────────────────────────────

/** A: ページ内リンク・ホイールクリック（既存タブ優先） */
async function handleInternalNavigation(tabId: number, isNew: boolean, targetUrl: URL) {
  const { sameWindow, otherWindows } = await findDuplicateTabs(targetUrl, tabId);

  if (sameWindow[0]) {
    // 既存タブを優先
    await closeOrRevert(tabId, isNew, sameWindow[0]);
  }

  // 他ウィンドウは問答無用で閉じる
  for (const dup of otherWindows) {
    if (dup.id) chrome.tabs.remove(dup.id).catch(() => {});
  }
}

/** B: 外部アプリ・アドレスバー → 新規タブ優先（既存重複を閉じる） */
async function handleExternalNavigation(tabId: number, targetUrl: URL) {
  const { sameWindow, otherWindows } = await findDuplicateTabs(targetUrl, tabId);

  // 新しく開いたタブを残して、既存の重複タブを閉じる
  for (const tab of [...sameWindow, ...otherWindows]) {
    if (tab.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function closeOrRevert(
  newTabId: number,
  isNew: boolean,
  existing: chrome.tabs.Tab
) {
  if (isNew) {
    // 新規なら閉じるだけ
    await chrome.tabs.remove(newTabId).catch(() => {});
    return;
  }

  // goBack → 既存タブにフォーカス
  processingTabs.add(newTabId);
  try {
    await chrome.tabs.goBack(newTabId).catch(() => {});
    if (existing.id) {
      await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    }
  } finally {
    processingTabs.delete(newTabId);
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
  if (processingTabs.has(tabId)) {
    processingTabs.delete(tabId);
    return;
  }

  const isNew = newlyCreatedTabs.delete(tabId);
  const targetUrl = new URL(details.url);

  try {
    if (isUserLinkNavigation(details)) {
      // A: ページ内リンク・ホイールクリック
      await handleInternalNavigation(tabId, isNew, targetUrl);
    } else {
      // B: 外部アプリ・アドレスバー・ブックマーク
      await handleExternalNavigation(tabId, targetUrl);
    }
  } catch (e) {
    console.error('[duplicate-handler] error:', e);
    processingTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  processingTabs.delete(tabId);
  newlyCreatedTabs.delete(tabId);
});
