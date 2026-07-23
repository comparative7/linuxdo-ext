/**
 * LinuxDo Auto-Browser — Popup
 * 开始/停止控制与状态展示；配置迁至 Options 页。
 */

const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnSkipPause = document.getElementById("btn-skip-pause");
const btnOpenHome = document.getElementById("btn-open-home");
const btnOpenOptions = document.getElementById("btn-open-options");
const btnClearHistory = document.getElementById("btn-clear-history");
const btnResetDailyCount = document.getElementById("btn-reset-daily-count");
const historyCountEl = document.getElementById("history-count");
const historyListEl = document.getElementById("history-list");
const hintEl = document.querySelector(".hint");

const DEFAULT_HINT = "请在 LinuxDo 帖子列表页使用";

let isRunning = false;
let isResting = false;
let isWaitingForUnread = false;
let restUntil = null;
let waitUntil = null;
let dailyCount = 0;
let dailyReplyCount = 0;
let dailyLimit = DEFAULT_SETTINGS.dailyLimit;
let statusTimer = null;
let browseHistoryItems = [];

function formatRestRemaining(until) {
  const ms = Math.max(0, until - Date.now());
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatHistoryTime(ts) {
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "--:--";
  }
}

function isPausedUI() {
  return isResting || isWaitingForUnread;
}

function getPauseUntil() {
  if (isResting && restUntil) {
    return restUntil;
  }
  if (isWaitingForUnread && waitUntil) {
    return waitUntil;
  }
  return null;
}

function renderBrowseHistory(items) {
  browseHistoryItems = Array.isArray(items) ? items : [];
  if (historyCountEl) {
    historyCountEl.textContent = String(browseHistoryItems.length);
  }
  if (!historyListEl) {
    return;
  }
  historyListEl.textContent = "";
  if (browseHistoryItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "暂无记录";
    historyListEl.appendChild(empty);
    return;
  }

  for (const item of browseHistoryItems) {
    const link = document.createElement("a");
    link.className = "history-item";
    link.href = item.url || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${formatHistoryTime(item.at)} · ${item.exitReason || "complete"} · +${item.newlyReadReplies || 0}楼`;

    const title = document.createElement("div");
    title.textContent = item.title || `主题 ${item.topicId || "?"}`;

    link.appendChild(meta);
    link.appendChild(title);
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (item.url) {
        chrome.tabs.create({ url: item.url });
      }
    });
    historyListEl.appendChild(link);
  }
}

function updateStatusText() {
  const dailyText = `今日 ${dailyCount}/${dailyLimit} 帖 · 新读 ${dailyReplyCount} 楼`;
  const pauseUntil = getPauseUntil();

  if (isWaitingForUnread && pauseUntil) {
    statusEl.textContent = `等待新帖 · 剩余 ${formatRestRemaining(pauseUntil)} · ${dailyText}`;
    statusEl.className = "status waiting";
    return;
  }

  if (isResting && pauseUntil) {
    statusEl.textContent = `休息中 · 剩余 ${formatRestRemaining(pauseUntil)} · ${dailyText}`;
    statusEl.className = "status resting";
    return;
  }

  statusEl.textContent = isRunning ? `运行中 · ${dailyText}` : `已停止 · ${dailyText}`;
  statusEl.className = isRunning ? "status running" : "status";
}

function updateUI() {
  updateStatusText();
  btnStart.disabled = isRunning || isPausedUI();
  btnStop.disabled = !isRunning && !isPausedUI();
  btnSkipPause.disabled = !isPausedUI();
  btnSkipPause.textContent = isWaitingForUnread ? "立即扫描" : "跳过休息";
  if (btnClearHistory) {
    btnClearHistory.disabled = isRunning || isPausedUI();
  }
  if (btnResetDailyCount) {
    btnResetDailyCount.disabled = dailyCount === 0;
  }
}

function showHint(text) {
  hintEl.textContent = text;
}

function clearStatusTimer() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

function startStatusTimer() {
  clearStatusTimer();
  const pauseUntil = getPauseUntil();
  if (!isPausedUI() || !pauseUntil) {
    return;
  }
  statusTimer = setInterval(() => {
    if (!isPausedUI() || !getPauseUntil()) {
      clearStatusTimer();
      return;
    }
    updateStatusText();
    if (Date.now() >= getPauseUntil()) {
      clearStatusTimer();
    }
  }, 1000);
}

async function sendCommand(type, payload = {}) {
  return chrome.runtime.sendMessage(makeMessage(type, payload));
}

function applyStatusResponse(res) {
  if (!res?.ok) {
    return;
  }

  isRunning = !!res.isRunning;
  isResting = !!res.isResting;
  isWaitingForUnread = !!res.isWaitingForUnread;
  restUntil = res.restUntil || null;
  waitUntil = res.waitUntil || null;
  dailyCount = res.dailyCount ?? 0;
  dailyReplyCount = res.dailyReplyCount ?? 0;
  dailyLimit = res.dailyLimit ?? dailyLimit;

  if (Array.isArray(res.browseHistory)) {
    renderBrowseHistory(res.browseHistory);
  }

  updateUI();
  startStatusTimer();

  if (isWaitingForUnread) {
    showHint("暂无未读，稍后自动刷新列表");
  } else if (res.lastFinishedReason === "error") {
    showHint("发生错误，已停止");
  } else if (res.lastFinishedReason === "daily_limit") {
    showHint("今日已达上限，明天自动重置");
  } else if (res.lastFinishedReason === "tab_closed") {
    showHint("会话标签已关闭，已停止");
  }
}

async function syncStatus() {
  try {
    const res = await sendCommand("CMD_GET_STATUS");
    applyStatusResponse(res);
  } catch (err) {
    console.error("[LinuxDo-Bot] syncStatus failed:", err);
  }
}

btnStart.addEventListener("click", async () => {
  showHint(DEFAULT_HINT);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";

    if (!tab?.id || !isLinuxDoUrl(url) || !isListPage(url)) {
      showHint("请在帖子列表页点击开始");
      return;
    }

    const res = await sendCommand("CMD_START", { listUrl: url, tabId: tab.id });
    if (!res?.ok) {
      if (res?.error === "daily_limit_reached") {
        dailyCount = res.dailyCount ?? dailyCount;
        dailyReplyCount = res.dailyReplyCount ?? dailyReplyCount;
        dailyLimit = res.dailyLimit ?? dailyLimit;
        updateUI();
        showHint("今日已达上限，明天自动重置");
        return;
      }
      if (res?.error === "still_resting") {
        isResting = true;
        restUntil = res.restUntil || null;
        updateUI();
        startStatusTimer();
        showHint("休息中，请稍后再试");
        return;
      }
      showHint("启动失败，请确认当前在列表页");
      return;
    }

    isRunning = true;
    isResting = false;
    isWaitingForUnread = false;
    restUntil = null;
    waitUntil = null;
    updateUI();
  } catch (err) {
    console.error("[LinuxDo-Bot] start failed:", err);
    showHint("启动失败，请重试");
  }
});

btnOpenHome.addEventListener("click", () => {
  chrome.tabs.create({ url: LINUXDO_HOME_URL });
});

btnOpenOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

btnSkipPause.addEventListener("click", async () => {
  try {
    const res = await sendCommand("CMD_SKIP_PAUSE");
    if (!res?.ok) {
      if (res?.error === "not_paused") {
        showHint("当前不在休息或等待状态");
      } else {
        showHint("跳过失败，请重试");
      }
      await syncStatus();
      return;
    }
    isResting = false;
    isWaitingForUnread = false;
    restUntil = null;
    waitUntil = null;
    clearStatusTimer();
    updateUI();
    showHint(res.skipped === "idle_poll" ? "正在刷新列表…" : "已跳过休息，继续浏览");
    await syncStatus();
  } catch (err) {
    console.error("[LinuxDo-Bot] skip pause failed:", err);
    showHint("跳过失败，请重试");
  }
});

btnClearHistory.addEventListener("click", async () => {
  try {
    const res = await sendCommand("CMD_CLEAR_HISTORY");
    if (res?.ok) {
      renderBrowseHistory([]);
      showHint("已清空今日足迹");
    } else {
      showHint("清空失败，请重试");
    }
  } catch (err) {
    console.error("[LinuxDo-Bot] clear history failed:", err);
    showHint("清空失败，请重试");
  }
});

btnResetDailyCount?.addEventListener("click", async () => {
  try {
    const res = await sendCommand("CMD_RESET_DAILY_COUNT");
    if (res?.ok) {
      dailyCount = res.dailyCount ?? 0;
      dailyReplyCount = res.dailyReplyCount ?? dailyReplyCount;
      dailyLimit = res.dailyLimit ?? dailyLimit;
      updateUI();
      showHint("已重置今日帖数");
      return;
    }
    console.error("[LinuxDo-Bot] reset daily count rejected:", res);
    showHint(
      res?.error ? `重置失败：${res.error}` : "重置失败，请重试（先到扩展页点重新加载）"
    );
  } catch (err) {
    console.error("[LinuxDo-Bot] reset daily count failed:", err);
    showHint("重置失败，请重试（先到扩展页点重新加载）");
  }
});

btnStop.addEventListener("click", async () => {
  try {
    await sendCommand("CMD_STOP");
    isRunning = false;
    isResting = false;
    isWaitingForUnread = false;
    restUntil = null;
    waitUntil = null;
    clearStatusTimer();
    updateUI();
    showHint(DEFAULT_HINT);
    await syncStatus();
  } catch (err) {
    console.error("[LinuxDo-Bot] stop failed:", err);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "linuxdo-ext") {
    return;
  }

  if (message.type === "EVT_RUN_FINISHED") {
    isRunning = false;
    isResting = false;
    isWaitingForUnread = false;
    restUntil = null;
    waitUntil = null;
    clearStatusTimer();

    const reason = message.payload?.reason;
    if (reason === "daily_limit") {
      dailyCount = message.payload?.count ?? dailyCount;
      dailyReplyCount = message.payload?.replyCount ?? dailyReplyCount;
      dailyLimit = message.payload?.dailyLimit ?? dailyLimit;
      showHint("今日已达上限，明天自动重置");
    } else if (reason === "error") {
      showHint("发生错误，已停止");
    } else if (reason === "tab_closed") {
      showHint("会话标签已关闭，已停止");
    }

    updateUI();
    return;
  }

  if (message.type === "EVT_STATS_UPDATED") {
    dailyCount = message.payload?.dailyCount ?? dailyCount;
    dailyReplyCount = message.payload?.dailyReplyCount ?? dailyReplyCount;
    dailyLimit = message.payload?.dailyLimit ?? dailyLimit;
    updateUI();
    return;
  }

  if (message.type === "EVT_HISTORY_UPDATED") {
    renderBrowseHistory(message.payload?.browseHistory || []);
    return;
  }

  if (message.type === "EVT_REST_STARTED") {
    isRunning = true;
    isResting = true;
    isWaitingForUnread = false;
    restUntil = message.payload?.restUntil || null;
    waitUntil = null;
    updateUI();
    startStatusTimer();
    showHint("已连续浏览一批帖子，休息中…");
    return;
  }

  if (message.type === "EVT_REST_ENDED") {
    isResting = false;
    restUntil = null;
    clearStatusTimer();
    updateUI();
    showHint(DEFAULT_HINT);
    return;
  }

  if (message.type === "EVT_IDLE_POLL_STARTED") {
    isRunning = true;
    isWaitingForUnread = true;
    isResting = false;
    waitUntil = message.payload?.waitUntil || null;
    restUntil = null;
    updateUI();
    startStatusTimer();
    showHint("暂无未读，稍后自动刷新列表");
    return;
  }

  if (message.type === "EVT_IDLE_POLL_ENDED") {
    isWaitingForUnread = false;
    waitUntil = null;
    clearStatusTimer();
    updateUI();
    showHint(DEFAULT_HINT);
  }
});

(async function initPopup() {
  try {
    const settings = await getSettingsWithDefaults();
    dailyLimit = settings.dailyLimit;
  } catch (err) {
    console.error("[LinuxDo-Bot] load settings failed:", err);
  }
  await syncStatus();
  updateUI();
})();
