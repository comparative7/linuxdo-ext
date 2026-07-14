/**
 * LinuxDo Auto-Browser — Background Service Worker
 * 状态持久化、消息路由、标签页导航调度、防封限制。
 */

importScripts("utils.js");

const POST_READ_NAV_DELAY_MIN_MS = 2000;
const POST_READ_NAV_DELAY_MAX_MS = 5000;
const REST_ALARM_NAME = "rest_complete";
const ERROR_RECOVERY_BASE_MS = 5000;
const ERROR_RECOVERY_MAX_MS = 120000;
const ERROR_RECOVERY_MAX_RETRIES = 20;

const DEFAULT_STATE = {
  isRunning: false,
  listUrl: "",
  visitedTopicIds: [],
  lastFinishedReason: null,
  sessionBatchCount: 0,
  isResting: false,
  restUntil: null,
  errorRetryCount: 0,
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

function notifyRuntime(type, payload = {}) {
  try {
    chrome.runtime.sendMessage(makeMessage(type, payload));
  } catch {
    // Popup may be closed.
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

async function clearRestAlarm() {
  await chrome.alarms.clear(REST_ALARM_NAME);
}

async function buildStatusPayload(state, dailyStats, settings) {
  return {
    ok: true,
    isRunning: state.isRunning,
    listUrl: state.listUrl,
    lastFinishedReason: state.lastFinishedReason,
    dailyCount: dailyStats.count,
    dailyReplyCount: dailyStats.replyCount || 0,
    dailyLimit: settings.dailyLimit,
    sessionBatchCount: state.sessionBatchCount || 0,
    restBatchSize: settings.restBatchSize,
    restMinutes: settings.restMinutes,
    isResting: !!state.isResting,
    restUntil: state.restUntil,
  };
}

async function enterRestPeriod(settings) {
  const restUntil = Date.now() + settings.restMinutes * 60 * 1000;
  await setState({
    isResting: true,
    restUntil,
  });
  await chrome.alarms.create(REST_ALARM_NAME, { when: restUntil });

  const payload = {
    restUntil,
    restMinutes: settings.restMinutes,
  };
  await broadcastToLinuxDoTabs("CMD_PAUSE", payload);
  await broadcastToLinuxDoTabs("EVT_REST_STARTED", payload);
  notifyRuntime("EVT_REST_STARTED", payload);

  log("Rest started until", new Date(restUntil).toISOString());
}

async function resumeAfterRest() {
  const state = await getState();
  if (!state.isRunning || !state.listUrl) {
    return;
  }

  const tabs = await chrome.tabs.query({ url: "https://linux.do/*" });
  let resumed = false;

  for (const tab of tabs) {
    if (!tab.id || !tab.url || !isLinuxDoUrl(tab.url)) {
      continue;
    }

    if (listUrlsMatch(tab.url, state.listUrl)) {
      await sendToTab(tab.id, "EVT_STATE_CHANGED", {
        isRunning: true,
        listUrl: state.listUrl,
        isResting: false,
      });
      resumed = true;
      continue;
    }

    if (!resumed) {
      try {
        await chrome.tabs.update(tab.id, { url: state.listUrl });
        log("Navigated to list after rest:", state.listUrl);
        resumed = true;
      } catch (err) {
        logError("tabs.update after rest failed:", tab.id, err);
      }
    }
  }
}

async function endRestPeriod() {
  await clearRestAlarm();

  const state = await getState();
  await setState({
    isResting: false,
    restUntil: null,
    sessionBatchCount: 0,
  });

  if (!state.isRunning) {
    return;
  }

  await broadcastToLinuxDoTabs("EVT_REST_ENDED", {});
  notifyRuntime("EVT_REST_ENDED", {});
  await resumeAfterRest();
  log("Rest ended, resuming");
}

async function restoreRestAlarmIfNeeded() {
  const state = await getState();
  if (!state.isResting || !state.restUntil) {
    return;
  }

  if (Date.now() >= state.restUntil) {
    await endRestPeriod();
    return;
  }

  await chrome.alarms.create(REST_ALARM_NAME, { when: state.restUntil });
  await broadcastToLinuxDoTabs("CMD_PAUSE", {
    restUntil: state.restUntil,
  });
  log("Rest alarm restored until", new Date(state.restUntil).toISOString());
}

async function stopRunning(reason = "user_stop", extra = {}) {
  const state = await getState();
  if (!state.isRunning && reason === "user_stop") {
    return;
  }

  abortPendingNavigation();
  await clearRestAlarm();

  await setState({
    isRunning: false,
    lastFinishedReason: reason,
    isResting: false,
    restUntil: null,
    sessionBatchCount: 0,
    errorRetryCount: 0,
  });

  await broadcastToLinuxDoTabs("CMD_ABORT", { reason });
  await broadcastToLinuxDoTabs("EVT_STATE_CHANGED", {
    isRunning: false,
    listUrl: state.listUrl,
    isResting: false,
  });

  notifyRuntime("EVT_RUN_FINISHED", { reason, ...extra });
  log("Stopped, reason:", reason);
}

function computeErrorRecoveryDelayMs(retryCount) {
  const scaled = ERROR_RECOVERY_BASE_MS * 1.5 ** (retryCount - 1);
  const capped = Math.min(scaled, ERROR_RECOVERY_MAX_MS);
  return Math.round(capped) + randomInt(0, 3000);
}

async function startRunning(listUrl) {
  await setState({
    isRunning: true,
    listUrl,
    visitedTopicIds: [],
    lastFinishedReason: null,
    sessionBatchCount: 0,
    isResting: false,
    restUntil: null,
    errorRetryCount: 0,
  });

  await broadcastToLinuxDoTabs("EVT_STATE_CHANGED", {
    isRunning: true,
    listUrl,
    isResting: false,
  });

  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab?.id && tab.url && isLinuxDoUrl(tab.url)) {
    await sendToTab(tab.id, "EVT_STATE_CHANGED", {
      isRunning: true,
      listUrl,
      isResting: false,
    });
  }

  log("Started, listUrl:", listUrl);
}

async function restoreAndBroadcast() {
  await restoreRestAlarmIfNeeded();

  const state = await getState();
  if (!state.isRunning) {
    return;
  }

  await broadcastToLinuxDoTabs("EVT_STATE_CHANGED", {
    isRunning: true,
    listUrl: state.listUrl,
    isResting: !!state.isResting,
  });
}

async function scheduleTabNavigation(tabId, delayMs, logLabel) {
  abortPendingNavigation();
  navAbort = createAbortScope();
  const scope = navAbort;

  log(logLabel, "waiting", (delayMs / 1000).toFixed(1), "s");
  await scope.delay(delayMs);

  if (scope.isAborted()) {
    return;
  }

  const fresh = await getState();
  if (!fresh.isRunning || !fresh.listUrl || fresh.isResting) {
    navAbort = null;
    return;
  }

  try {
    await chrome.tabs.update(tabId, { url: fresh.listUrl });
    log("Navigated tab to list:", fresh.listUrl);
  } catch (err) {
    logError("tabs.update failed:", tabId, err);
  }
  navAbort = null;
}

async function navigateBackToList(tabId) {
  const navDelay = randomInt(
    POST_READ_NAV_DELAY_MIN_MS,
    POST_READ_NAV_DELAY_MAX_MS
  );
  await scheduleTabNavigation(
    tabId,
    navDelay,
    "Post-read complete,"
  );
}

async function handleRecoverableError(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return;
  }

  const state = await getState();
  if (!state.isRunning || !state.listUrl || state.isResting) {
    return;
  }

  const { code, pageMode } = message.payload || {};
  const retryCount = (state.errorRetryCount || 0) + 1;

  if (retryCount > ERROR_RECOVERY_MAX_RETRIES) {
    logError("Error recovery max retries reached:", retryCount, code);
    await stopRunning("error_max_retries", { code, retryCount });
    return;
  }

  await setState({ errorRetryCount: retryCount });
  const waitMs = computeErrorRecoveryDelayMs(retryCount);

  log(
    "Recoverable error:",
    code,
    "pageMode:",
    pageMode,
    "retry:",
    retryCount,
    "wait:",
    waitMs,
    "ms"
  );

  if (pageMode === "topic") {
    await scheduleTabNavigation(
      tabId,
      waitMs,
      "Topic error, returning to list,"
    );
    return;
  }

  if (pageMode === "list") {
    await scheduleTabNavigation(tabId, waitMs, "List error, refreshing,");
    return;
  }

  await scheduleTabNavigation(tabId, waitMs, "Error recovery,");
}

async function handlePostReadComplete(message, sender) {
  const tabId = sender.tab.id;
  let state = await getState();

  if (!state.isRunning || !state.listUrl || state.isResting) {
    return;
  }

  const { topicId, newlyReadReplies } = message.payload || {};
  if (topicId) {
    const visited = [...state.visitedTopicIds];
    const id = String(topicId);
    if (!visited.includes(id)) {
      visited.push(id);
      await setState({ visitedTopicIds: visited });
    }
  }

  const settings = await getSettingsWithDefaults();
  const dailyStats = await incrementDailyStats(newlyReadReplies);
  const sessionBatchCount = (state.sessionBatchCount || 0) + 1;
  await setState({ sessionBatchCount, errorRetryCount: 0 });

  const thisVisitReplies = Math.max(
    0,
    Math.floor(Number(newlyReadReplies) || 0)
  );
  log(
    "本次浏览统计:",
    `topic=${topicId || "?"}`,
    `本帖新读=${thisVisitReplies}楼`,
    `今日=${dailyStats.count}/${settings.dailyLimit}帖`,
    `今日新读累计=${dailyStats.replyCount || 0}楼`,
    `本批=${sessionBatchCount}/${settings.restBatchSize}`
  );

  notifyRuntime("EVT_STATS_UPDATED", {
    dailyCount: dailyStats.count,
    dailyReplyCount: dailyStats.replyCount || 0,
    dailyLimit: settings.dailyLimit,
  });

  if (dailyStats.count >= settings.dailyLimit) {
    await stopRunning("daily_limit", {
      count: dailyStats.count,
      replyCount: dailyStats.replyCount || 0,
      dailyLimit: settings.dailyLimit,
    });
    return;
  }

  if (sessionBatchCount >= settings.restBatchSize) {
    abortPendingNavigation();
    await enterRestPeriod(settings);
    return;
  }

  await navigateBackToList(tabId);
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
          isResting: !!state.isResting,
        });
        if (state.isResting) {
          await sendToTab(tabId, "CMD_PAUSE", {
            restUntil: state.restUntil,
          });
        }
      }
      break;
    }
    case "EVT_TOPIC_ENTERED": {
      const { topicId } = message.payload || {};
      if (!topicId || !state.isRunning || state.isResting) {
        break;
      }
      const visited = [...state.visitedTopicIds];
      const id = String(topicId);
      if (!visited.includes(id)) {
        visited.push(id);
        await setState({ visitedTopicIds: visited, errorRetryCount: 0 });
      }
      break;
    }
    case "EVT_POST_READ_COMPLETE": {
      await handlePostReadComplete(message, sender);
      break;
    }
    case "EVT_NO_UNREAD": {
      const { scannedCount } = message.payload || {};
      await stopRunning("no_unread", { scannedCount });
      break;
    }
    case "EVT_ERROR": {
      await handleRecoverableError(message, sender);
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REST_ALARM_NAME) {
    return;
  }
  await endRestPeriod();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  if (!tab.url || !isLinuxDoUrl(tab.url) || !isListPage(tab.url)) {
    return;
  }

  const state = await getState();
  if (!state.isRunning || !state.listUrl || state.isResting) {
    return;
  }
  if (!listUrlsMatch(tab.url, state.listUrl)) {
    return;
  }

  log("List page loaded (onUpdated), waking content:", tabId);
  await sendToTab(tabId, "EVT_STATE_CHANGED", {
    isRunning: true,
    listUrl: state.listUrl,
    isResting: false,
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

        const settings = await getSettingsWithDefaults();
        const dailyStats = await ensureDailyStats();
        if (dailyStats.count >= settings.dailyLimit) {
          sendResponse({
            ok: false,
            error: "daily_limit_reached",
            dailyCount: dailyStats.count,
            dailyReplyCount: dailyStats.replyCount || 0,
            dailyLimit: settings.dailyLimit,
          });
          return;
        }

        const state = await getState();
        if (state.isResting) {
          sendResponse({
            ok: false,
            error: "still_resting",
            restUntil: state.restUntil,
          });
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
        const dailyStats = await ensureDailyStats();
        const settings = await getSettingsWithDefaults();
        sendResponse(await buildStatusPayload(state, dailyStats, settings));
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

restoreRestAlarmIfNeeded();
