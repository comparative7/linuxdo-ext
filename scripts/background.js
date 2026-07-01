/**
 * LinuxDo Auto-Browser — Background Service Worker
 * 状态持久化、消息路由、标签页导航调度。
 */

importScripts("utils.js");

const POST_READ_NAV_DELAY_MIN_MS = 8000;
const POST_READ_NAV_DELAY_MAX_MS = 15000;

const DEFAULT_STATE = {
  isRunning: false,
  listUrl: "",
  visitedTopicIds: [],
  lastFinishedReason: null,
};

async function getState() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  return { ...DEFAULT_STATE, ...data };
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
}

function isValidMessage(message) {
  return message && message.source === "linuxdo-ext";
}

function isContentSender(sender) {
  return !!(sender.tab && sender.tab.url && isLinuxDoUrl(sender.tab.url));
}

async function broadcastToLinuxDoTabs(type, payload) {
  const tabs = await chrome.tabs.query({ url: "https://linux.do/*" });
  const message = makeMessage(type, payload);
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // Tab may not have a content script yet.
    }
  }
}

async function sendToTab(tabId, type, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, makeMessage(type, payload));
  } catch (err) {
    logError("sendToTab failed:", tabId, err);
  }
}

let navAbort = null;

function abortPendingNavigation() {
  if (navAbort) {
    navAbort.abort();
    navAbort = null;
  }
}

function listUrlsMatch(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin + ua.pathname === ub.origin + ub.pathname;
  } catch {
    return a === b;
  }
}

async function stopRunning(reason = "user_stop", extra = {}) {
  const state = await getState();
  if (!state.isRunning && reason === "user_stop") {
    return;
  }

  abortPendingNavigation();

  await setState({
    isRunning: false,
    lastFinishedReason: reason,
  });

  await broadcastToLinuxDoTabs("CMD_ABORT", { reason });
  await broadcastToLinuxDoTabs("EVT_STATE_CHANGED", {
    isRunning: false,
    listUrl: state.listUrl,
  });

  try {
    chrome.runtime.sendMessage(
      makeMessage("EVT_RUN_FINISHED", { reason, ...extra })
    );
  } catch {
    // Popup may be closed.
  }

  log("Stopped, reason:", reason);
}

async function startRunning(listUrl) {
  await setState({
    isRunning: true,
    listUrl,
    visitedTopicIds: [],
    lastFinishedReason: null,
  });

  await broadcastToLinuxDoTabs("EVT_STATE_CHANGED", {
    isRunning: true,
    listUrl,
  });

  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab?.id && tab.url && isLinuxDoUrl(tab.url)) {
    await sendToTab(tab.id, "EVT_STATE_CHANGED", { isRunning: true, listUrl });
  }

  log("Started, listUrl:", listUrl);
}

async function restoreAndBroadcast() {
  const state = await getState();
  if (!state.isRunning) {
    return;
  }
  await broadcastToLinuxDoTabs("EVT_STATE_CHANGED", {
    isRunning: true,
    listUrl: state.listUrl,
  });
}

async function handleContentMessage(message, sender) {
  const tabId = sender.tab.id;
  const state = await getState();

  switch (message.type) {
    case "EVT_PAGE_READY": {
      if (state.isRunning) {
        await sendToTab(tabId, "EVT_STATE_CHANGED", {
          isRunning: true,
          listUrl: state.listUrl,
        });
      }
      break;
    }
    case "EVT_TOPIC_ENTERED": {
      const { topicId } = message.payload || {};
      if (!topicId || !state.isRunning) {
        break;
      }
      const visited = [...state.visitedTopicIds];
      const id = String(topicId);
      if (!visited.includes(id)) {
        visited.push(id);
        await setState({ visitedTopicIds: visited });
      }
      break;
    }
    case "EVT_POST_READ_COMPLETE": {
      if (!state.isRunning || !state.listUrl) {
        break;
      }
      const { topicId } = message.payload || {};
      if (topicId) {
        const visited = [...state.visitedTopicIds];
        const id = String(topicId);
        if (!visited.includes(id)) {
          visited.push(id);
          await setState({ visitedTopicIds: visited });
        }
      }

      abortPendingNavigation();
      navAbort = createAbortScope();
      const scope = navAbort;

      const navDelay = randomInt(
        POST_READ_NAV_DELAY_MIN_MS,
        POST_READ_NAV_DELAY_MAX_MS
      );
      log(
        "Post-read complete, waiting",
        navDelay / 1000,
        "s before list navigation"
      );
      await scope.delay(navDelay);

      if (scope.isAborted()) {
        break;
      }

      const fresh = await getState();
      if (!fresh.isRunning || !fresh.listUrl) {
        navAbort = null;
        break;
      }

      try {
        await chrome.tabs.update(tabId, { url: fresh.listUrl });
        log("Navigated back to list:", fresh.listUrl);
      } catch (err) {
        logError("tabs.update failed:", tabId, err);
      }
      navAbort = null;
      break;
    }
    case "EVT_NO_UNREAD": {
      const { scannedCount } = message.payload || {};
      await stopRunning("no_unread", { scannedCount });
      break;
    }
    case "EVT_ERROR": {
      await stopRunning("error", { code: message.payload?.code });
      break;
    }
    default:
      break;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  restoreAndBroadcast();
});

chrome.runtime.onStartup.addListener(() => {
  restoreAndBroadcast();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  if (!tab.url || !isLinuxDoUrl(tab.url) || !isListPage(tab.url)) {
    return;
  }

  const state = await getState();
  if (!state.isRunning || !state.listUrl) {
    return;
  }
  if (!listUrlsMatch(tab.url, state.listUrl)) {
    return;
  }

  log("List page loaded (onUpdated), waking content:", tabId);
  await sendToTab(tabId, "EVT_STATE_CHANGED", {
    isRunning: true,
    listUrl: state.listUrl,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isValidMessage(message)) {
    return false;
  }

  (async () => {
    try {
      if (message.type === "CMD_START") {
        const { listUrl } = message.payload || {};
        if (!listUrl || !isListPage(listUrl)) {
          sendResponse({ ok: false, error: "invalid_list_url" });
          return;
        }
        await startRunning(listUrl);
        sendResponse({ ok: true, isRunning: true });
        return;
      }

      if (message.type === "CMD_STOP") {
        await stopRunning("user_stop");
        sendResponse({ ok: true, isRunning: false });
        return;
      }

      if (message.type === "CMD_GET_STATUS") {
        const state = await getState();
        sendResponse({
          ok: true,
          isRunning: state.isRunning,
          listUrl: state.listUrl,
          lastFinishedReason: state.lastFinishedReason,
        });
        return;
      }

      if (isContentSender(sender)) {
        await handleContentMessage(message, sender);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unhandled" });
    } catch (err) {
      logError("onMessage error:", err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true;
});
