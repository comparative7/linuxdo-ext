/**
 * LinuxDo Auto-Browser — Background Service Worker
 * 状态持久化、消息路由、标签页导航调度、防封限制。
 */

importScripts("utils.js");

const POST_READ_NAV_DELAY_MIN_MS = 2000;
const POST_READ_NAV_DELAY_MAX_MS = 5000;
const REST_ALARM_NAME = "rest_complete";
const IDLE_POLL_ALARM_NAME = "idle_poll_new_topics";
/** 无未读时等待再次扫描的随机区间（拟人 + 避开 MV3 alarm 过密） */
const IDLE_POLL_MIN_MS = 2 * 60 * 1000;
const IDLE_POLL_MAX_MS = 5 * 60 * 1000;
const ERROR_RECOVERY_BASE_MS = 5000;
const ERROR_RECOVERY_MAX_MS = 120000;
const ERROR_RECOVERY_MAX_RETRIES = 20;

const DEFAULT_STATE = {
  isRunning: false,
  listUrl: "",
  activeTabId: null,
  visitedTopicIds: [],
  lastFinishedReason: null,
  sessionBatchCount: 0,
  isResting: false,
  restUntil: null,
  isWaitingForUnread: false,
  waitUntil: null,
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

async function sendToActiveTab(type, payload) {
  const state = await getState();
  if (state.activeTabId == null) {
    return;
  }
  await sendToTab(state.activeTabId, type, payload);
}

function isActiveSessionTab(state, tabId) {
  return (
    !!state.isRunning &&
    state.activeTabId != null &&
    tabId === state.activeTabId
  );
}

async function ensureActiveTabExists(state) {
  if (state.activeTabId == null) {
    return false;
  }
  try {
    await chrome.tabs.get(state.activeTabId);
    return true;
  } catch {
    return false;
  }
}

function buildStatePayload(state) {
  return {
    isRunning: !!state.isRunning,
    listUrl: state.listUrl || "",
    isResting: !!state.isResting,
    isWaitingForUnread: !!state.isWaitingForUnread,
    restUntil: state.restUntil || null,
    waitUntil: state.waitUntil || null,
  };
}

function notifyRuntime(type, payload = {}) {
  try {
    const sent = chrome.runtime.sendMessage(makeMessage(type, payload));
    if (sent && typeof sent.catch === "function") {
      // 无接收方或未 sendResponse 时 Promise 会拒，属预期（Popup 可能已关闭）
      sent.catch(() => {});
    }
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

async function clearIdlePollAlarm() {
  await chrome.alarms.clear(IDLE_POLL_ALARM_NAME);
}

function isPaused(state) {
  return !!(state.isResting || state.isWaitingForUnread);
}

async function buildStatusPayload(state, dailyStats, settings) {
  const history = await ensureBrowseHistory();
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
    isWaitingForUnread: !!state.isWaitingForUnread,
    waitUntil: state.waitUntil,
    browseHistory: history.items || [],
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
  await sendToActiveTab("CMD_PAUSE", payload);
  await sendToActiveTab("EVT_REST_STARTED", payload);
  notifyRuntime("EVT_REST_STARTED", payload);

  const state = await getState();
  const dailyStats = await ensureDailyStats();
  await updateActionBadge(state, dailyStats, settings);

  log("Rest started until", new Date(restUntil).toISOString());
}

async function resumeAfterRest() {
  const state = await getState();
  if (!state.isRunning || !state.listUrl) {
    return;
  }

  if (!(await ensureActiveTabExists(state))) {
    await stopRunning("tab_closed");
    return;
  }

  const tabId = state.activeTabId;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    logError("resumeAfterRest tabs.get failed:", tabId, err);
    await stopRunning("tab_closed");
    return;
  }

  const runningPayload = buildStatePayload({
    ...state,
    isResting: false,
    isWaitingForUnread: false,
    restUntil: null,
    waitUntil: null,
    isRunning: true,
  });

  if (tab.url && isLinuxDoUrl(tab.url) && listUrlsMatch(tab.url, state.listUrl)) {
    await sendToTab(tabId, "EVT_STATE_CHANGED", runningPayload);
    return;
  }

  try {
    await chrome.tabs.update(tabId, { url: state.listUrl });
    log("Navigated to list after rest:", state.listUrl);
  } catch (err) {
    logError("tabs.update after rest failed:", tabId, err);
    await stopRunning("tab_closed");
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

  await sendToActiveTab("EVT_REST_ENDED", {});
  notifyRuntime("EVT_REST_ENDED", {});
  await resumeAfterRest();

  const fresh = await getState();
  const dailyStats = await ensureDailyStats();
  const settings = await getSettingsWithDefaults();
  await updateActionBadge(fresh, dailyStats, settings);

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
  await sendToActiveTab("CMD_PAUSE", {
    restUntil: state.restUntil,
  });
  log("Rest alarm restored until", new Date(state.restUntil).toISOString());
}

async function enterIdlePoll(extra = {}) {
  const waitMs = randomInt(IDLE_POLL_MIN_MS, IDLE_POLL_MAX_MS);
  const waitUntil = Date.now() + waitMs;

  await setState({
    isWaitingForUnread: true,
    waitUntil,
  });
  await chrome.alarms.create(IDLE_POLL_ALARM_NAME, { when: waitUntil });

  const payload = {
    waitUntil,
    waitMs,
    ...extra,
  };
  await sendToActiveTab("CMD_PAUSE", { restUntil: waitUntil });
  await sendToActiveTab("EVT_IDLE_POLL_STARTED", payload);
  notifyRuntime("EVT_IDLE_POLL_STARTED", payload);

  const state = await getState();
  const dailyStats = await ensureDailyStats();
  const settings = await getSettingsWithDefaults();
  await updateActionBadge(state, dailyStats, settings);

  log(
    "No unread, idle poll until",
    new Date(waitUntil).toISOString(),
    `(${(waitMs / 1000).toFixed(0)}s)`
  );
}

async function resumeAfterIdlePoll() {
  const state = await getState();
  if (!state.isRunning || !state.listUrl) {
    return;
  }

  if (!(await ensureActiveTabExists(state))) {
    await stopRunning("tab_closed");
    return;
  }

  const tabId = state.activeTabId;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    logError("resumeAfterIdlePoll tabs.get failed:", tabId, err);
    await stopRunning("tab_closed");
    return;
  }

  if (tab.url && isLinuxDoUrl(tab.url) && listUrlsMatch(tab.url, state.listUrl)) {
    try {
      await chrome.tabs.reload(tabId);
      log("Reloaded list after idle poll:", state.listUrl);
    } catch (err) {
      logError("tabs.reload after idle poll failed:", tabId, err);
      await stopRunning("tab_closed");
    }
    return;
  }

  try {
    await chrome.tabs.update(tabId, { url: state.listUrl });
    log("Navigated to list after idle poll:", state.listUrl);
  } catch (err) {
    logError("tabs.update after idle poll failed:", tabId, err);
    await stopRunning("tab_closed");
  }
}

async function endIdlePoll() {
  await clearIdlePollAlarm();

  const state = await getState();
  await setState({
    isWaitingForUnread: false,
    waitUntil: null,
  });

  if (!state.isRunning) {
    return;
  }

  // 先刷新列表，避免 content 在旧 DOM 上立刻再发 EVT_NO_UNREAD
  notifyRuntime("EVT_IDLE_POLL_ENDED", {});
  await resumeAfterIdlePoll();
  await sendToActiveTab("EVT_IDLE_POLL_ENDED", {});

  const fresh = await getState();
  const dailyStats = await ensureDailyStats();
  const settings = await getSettingsWithDefaults();
  await updateActionBadge(fresh, dailyStats, settings);

  log("Idle poll ended, rescanning list");
}

async function restoreIdlePollAlarmIfNeeded() {
  const state = await getState();
  if (!state.isWaitingForUnread || !state.waitUntil) {
    return;
  }

  if (Date.now() >= state.waitUntil) {
    await endIdlePoll();
    return;
  }

  await chrome.alarms.create(IDLE_POLL_ALARM_NAME, { when: state.waitUntil });
  await sendToActiveTab("CMD_PAUSE", {
    restUntil: state.waitUntil,
  });
  log("Idle poll alarm restored until", new Date(state.waitUntil).toISOString());
}

async function stopRunning(reason = "user_stop", extra = {}) {
  const state = await getState();
  if (!state.isRunning && reason === "user_stop") {
    return;
  }

  abortPendingNavigation();
  await clearRestAlarm();
  await clearIdlePollAlarm();

  await setState({
    isRunning: false,
    activeTabId: null,
    lastFinishedReason: reason,
    isResting: false,
    restUntil: null,
    isWaitingForUnread: false,
    waitUntil: null,
    sessionBatchCount: 0,
    errorRetryCount: 0,
  });

  await broadcastToLinuxDoTabs("CMD_ABORT", { reason });
  await broadcastToLinuxDoTabs(
    "EVT_STATE_CHANGED",
    buildStatePayload({
      isRunning: false,
      listUrl: state.listUrl,
      isResting: false,
      isWaitingForUnread: false,
      restUntil: null,
      waitUntil: null,
    })
  );

  notifyRuntime("EVT_RUN_FINISHED", { reason, ...extra });

  const dailyStats = await ensureDailyStats();
  const settings = await getSettingsWithDefaults();
  await updateActionBadge(
    { isRunning: false, isResting: false, isWaitingForUnread: false },
    dailyStats,
    settings
  );

  log("Stopped, reason:", reason);
}

function computeErrorRecoveryDelayMs(retryCount) {
  const scaled = ERROR_RECOVERY_BASE_MS * 1.5 ** (retryCount - 1);
  const capped = Math.min(scaled, ERROR_RECOVERY_MAX_MS);
  return Math.round(capped) + randomInt(0, 3000);
}

async function startRunning(listUrl, tabId) {
  await clearIdlePollAlarm();
  await setState({
    isRunning: true,
    listUrl,
    activeTabId: tabId,
    visitedTopicIds: [],
    lastFinishedReason: null,
    sessionBatchCount: 0,
    isResting: false,
    restUntil: null,
    isWaitingForUnread: false,
    waitUntil: null,
    errorRetryCount: 0,
  });

  await sendToTab(
    tabId,
    "EVT_STATE_CHANGED",
    buildStatePayload({
      isRunning: true,
      listUrl,
      isResting: false,
      isWaitingForUnread: false,
      restUntil: null,
      waitUntil: null,
    })
  );

  const dailyStats = await ensureDailyStats();
  const settings = await getSettingsWithDefaults();
  await updateActionBadge(
    { isRunning: true, isResting: false, isWaitingForUnread: false },
    dailyStats,
    settings
  );

  log("Started, listUrl:", listUrl, "activeTabId:", tabId);
}

async function restoreAndBroadcast() {
  await restoreRestAlarmIfNeeded();
  await restoreIdlePollAlarmIfNeeded();

  const state = await getState();
  const dailyStats = await ensureDailyStats();
  const settings = await getSettingsWithDefaults();
  await updateActionBadge(state, dailyStats, settings);

  if (!state.isRunning) {
    return;
  }

  if (!(await ensureActiveTabExists(state))) {
    await stopRunning("tab_closed");
    return;
  }

  await sendToActiveTab("EVT_STATE_CHANGED", buildStatePayload(state));
  if (isPaused(state)) {
    await sendToActiveTab("CMD_PAUSE", {
      restUntil: state.restUntil || state.waitUntil,
    });
  }
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
  if (!fresh.isRunning || !fresh.listUrl || isPaused(fresh)) {
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
  if (!state.isRunning || !state.listUrl || isPaused(state)) {
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

  if (!state.isRunning || !state.listUrl || isPaused(state)) {
    return;
  }

  const { topicId, newlyReadReplies, title, exitReason, topicUrl } =
    message.payload || {};
  if (topicId) {
    const visited = [...state.visitedTopicIds];
    const id = String(topicId);
    if (!visited.includes(id)) {
      visited.push(id);
      await setState({ visitedTopicIds: visited });
    }
  }

  const history = await appendBrowseHistory({
    topicId,
    title,
    url: topicUrl || sender.tab?.url || "",
    newlyReadReplies,
    exitReason: exitReason || "complete",
    at: Date.now(),
  });
  notifyRuntime("EVT_HISTORY_UPDATED", { browseHistory: history.items });

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

  state = await getState();
  await updateActionBadge(state, dailyStats, settings);

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
  const isSessionTab = isActiveSessionTab(state, tabId);

  switch (message.type) {
    case "EVT_PAGE_READY": {
      if (state.isRunning && isSessionTab) {
        await sendToTab(tabId, "EVT_STATE_CHANGED", buildStatePayload(state));
        if (isPaused(state)) {
          await sendToTab(tabId, "CMD_PAUSE", {
            restUntil: state.restUntil || state.waitUntil,
          });
        }
      } else if (state.isRunning && !isSessionTab) {
        await sendToTab(
          tabId,
          "EVT_STATE_CHANGED",
          buildStatePayload({
            isRunning: false,
            listUrl: state.listUrl,
            isResting: false,
            isWaitingForUnread: false,
            restUntil: null,
            waitUntil: null,
          })
        );
      }
      break;
    }
    case "EVT_TOPIC_ENTERED": {
      if (!isSessionTab || !state.isRunning || isPaused(state)) {
        break;
      }
      const { topicId } = message.payload || {};
      if (!topicId) {
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
      if (!isSessionTab) {
        break;
      }
      await handlePostReadComplete(message, sender);
      break;
    }
    case "EVT_NO_UNREAD": {
      if (!isSessionTab || !state.isRunning || isPaused(state)) {
        break;
      }
      const { scannedCount } = message.payload || {};
      abortPendingNavigation();
      await enterIdlePoll({ scannedCount });
      break;
    }
    case "EVT_ERROR": {
      if (!isSessionTab) {
        break;
      }
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
  if (alarm.name === REST_ALARM_NAME) {
    await endRestPeriod();
    return;
  }
  if (alarm.name === IDLE_POLL_ALARM_NAME) {
    await endIdlePoll();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  if (!tab.url || !isLinuxDoUrl(tab.url) || !isListPage(tab.url)) {
    return;
  }

  const state = await getState();
  if (!isActiveSessionTab(state, tabId) || !state.listUrl || isPaused(state)) {
    return;
  }
  if (!listUrlsMatch(tab.url, state.listUrl)) {
    return;
  }

  log("List page loaded (onUpdated), waking content:", tabId);
  await sendToTab(tabId, "EVT_STATE_CHANGED", buildStatePayload({
    ...state,
    isResting: false,
    isWaitingForUnread: false,
    restUntil: null,
    waitUntil: null,
  }));
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const state = await getState();
    if (state.isRunning && state.activeTabId === tabId) {
      log("Active session tab closed:", tabId);
      await stopRunning("tab_closed");
    }
  } catch (err) {
    logError("tabs.onRemoved handler failed:", err);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isValidMessage(message)) {
    return false;
  }

  (async () => {
    try {
      if (message.type === "CMD_START") {
        const { listUrl, tabId } = message.payload || {};
        if (!listUrl || !isListPage(listUrl)) {
          sendResponse({ ok: false, error: "invalid_list_url" });
          return;
        }
        if (tabId == null || typeof tabId !== "number") {
          sendResponse({ ok: false, error: "invalid_tab_id" });
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
        if (state.isResting || state.isWaitingForUnread) {
          sendResponse({
            ok: false,
            error: "still_resting",
            restUntil: state.restUntil || state.waitUntil,
          });
          return;
        }

        await startRunning(listUrl, tabId);
        sendResponse({ ok: true, isRunning: true });
        return;
      }

      if (message.type === "CMD_STOP") {
        await stopRunning("user_stop");
        sendResponse({ ok: true, isRunning: false });
        return;
      }

      if (message.type === "CMD_SKIP_PAUSE") {
        const state = await getState();
        if (!state.isRunning) {
          sendResponse({ ok: false, error: "not_running" });
          return;
        }
        if (state.isResting) {
          await endRestPeriod();
          sendResponse({ ok: true, skipped: "rest" });
          return;
        }
        if (state.isWaitingForUnread) {
          await endIdlePoll();
          sendResponse({ ok: true, skipped: "idle_poll" });
          return;
        }
        sendResponse({ ok: false, error: "not_paused" });
        return;
      }

      if (message.type === "CMD_CLEAR_HISTORY") {
        const history = await clearBrowseHistory();
        sendResponse({ ok: true, browseHistory: history.items });
        notifyRuntime("EVT_HISTORY_UPDATED", { browseHistory: history.items });
        return;
      }

      if (message.type === "CMD_RESET_DAILY_COUNT") {
        const dailyStats = await resetDailyPostCount();
        const settings = await getSettingsWithDefaults();
        let state = await getState();
        if (state.lastFinishedReason === "daily_limit") {
          await setState({ lastFinishedReason: null });
          state = await getState();
        }
        await updateActionBadge(state, dailyStats, settings);
        // 先 sendResponse，避免嵌套 runtime.sendMessage 打断 Popup 等待中的响应通道。
        // 徽章已刷新；HUD 靠 storage.onChanged；Popup 用本响应更新 UI。
        sendResponse({
          ok: true,
          dailyCount: dailyStats.count,
          dailyReplyCount: dailyStats.replyCount || 0,
          dailyLimit: settings.dailyLimit,
        });
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
restoreIdlePollAlarmIfNeeded();
(async () => {
  try {
    const state = await getState();
    const dailyStats = await ensureDailyStats();
    const settings = await getSettingsWithDefaults();
    await updateActionBadge(state, dailyStats, settings);
  } catch (err) {
    logError("Initial badge refresh failed:", err);
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  const badgeKeys = [
    "badgeEnabled",
    "badgeShowCount",
    "badgeShowStatus",
    "dailyLimit",
    "dailyStats",
  ];
  if (!badgeKeys.some((k) => Object.prototype.hasOwnProperty.call(changes, k))) {
    return;
  }
  (async () => {
    try {
      await updateActionBadge();
    } catch (err) {
      logError("Badge prefs refresh failed:", err);
    }
  })();
});
