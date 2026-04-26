// background.js - Service Worker

const closedTabs = [];

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // 閉じたタブのURLを記録（復元用）
  // タブ削除前にURLを取得できないため、tabs.onUpdatedで管理
});

// タブのURLをキャッシュ
const tabUrlCache = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url) {
    tabUrlCache.set(tabId, tab.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const url = tabUrlCache.get(tabId);
  if (url && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://")) {
    closedTabs.push(url);
    if (closedTabs.length > 20) closedTabs.shift();
  }
  tabUrlCache.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "TAB_PREV": {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const sorted = tabs.sort((a, b) => a.index - b.index);
        const current = sorted.find((t) => t.active);
        if (!current) return;
        const idx = sorted.indexOf(current);
        const prev = sorted[(idx - 1 + sorted.length) % sorted.length];
        chrome.tabs.update(prev.id, { active: true });
      });
      break;
    }
    case "TAB_NEXT": {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const sorted = tabs.sort((a, b) => a.index - b.index);
        const current = sorted.find((t) => t.active);
        if (!current) return;
        const idx = sorted.indexOf(current);
        const next = sorted[(idx + 1) % sorted.length];
        chrome.tabs.update(next.id, { active: true });
      });
      break;
    }
    case "TAB_NEW": {
      chrome.tabs.create({ url: message.url || "chrome://newtab" });
      break;
    }
    case "TAB_CLOSE": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.remove(tabs[0].id);
      });
      break;
    }
    case "TAB_RESTORE": {
      const url = closedTabs.pop();
      if (url) chrome.tabs.create({ url });
      break;
    }
    case "GET_TABS": {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        sendResponse(tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })));
      });
      return true; // 非同期レスポンス
    }
    case "SWITCH_TAB": {
      chrome.tabs.update(message.tabId, { active: true });
      break;
    }
    case "GET_HISTORY": {
      chrome.history.search({ text: message.query || "", maxResults: 20 }, (items) => {
        sendResponse(items.map((h) => ({ title: h.title, url: h.url })));
      });
      return true;
    }
    case "GET_BOOKMARKS": {
      chrome.bookmarks.search(message.query || "", (items) => {
        sendResponse(items.filter((b) => b.url).map((b) => ({ title: b.title, url: b.url })));
      });
      return true;
    }
  }
});
