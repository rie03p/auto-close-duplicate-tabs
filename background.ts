const DOMAIN_LIST = [
  "x.com",
  "twitter.com",
]

chrome.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
  if (!tab.url) return;

  const newUrl = new URL(tab.url);
  const tabs = await chrome.tabs.query({});

  for (const other of tabs) {
    if (other.id === tab.id || !other.url) continue;

    const otherUrl = new URL(other.url);
    const domainMatch = DOMAIN_LIST.some(domain =>
      newUrl.hostname.endsWith(domain) && otherUrl.hostname.endsWith(domain)
    )
    
    let isDuplicate = false;
    if (domainMatch) {
      isDuplicate = true;
    }
    else if (newUrl.href === otherUrl.href) {
      isDuplicate = true;
    }

    if (isDuplicate) {
      chrome.tabs.remove(other.id);
    }
  }
});
