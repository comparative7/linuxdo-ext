/**
 * LinuxDo Auto-Browser — Popup
 * 开始/停止控制、防封配置，与 Background 同步状态。
 */

const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const hintEl = document.querySelector(".hint");
const inputDailyLimit = document.getElementById("input-daily-limit");
const inputRestBatch = document.getElementById("input-rest-batch");
const inputRestMinutes = document.getElementById("input-rest-minutes");
const inputScrollStepMin = document.getElementById("input-scroll-step-min");
const inputScrollStepMax = document.getElementById("input-scroll-step-max");
const inputScrollPauseMin = document.getElementById("input-scroll-pause-min");
const inputScrollPauseMax = document.getElementById("input-scroll-pause-max");
const inputScrollDurationMin = document.getElementById("input-scroll-duration-min");
const inputScrollDurationMax = document.getElementById("input-scroll-duration-max");
const settingInputs = [
  inputDailyLimit,
  inputRestBatch,
  inputRestMinutes,
  inputScrollStepMin,
  inputScrollStepMax,
  inputScrollPauseMin,
  inputScrollPauseMax,
  inputScrollDurationMin,
  inputScrollDurationMax,
];

const DEFAULT_HINT = "请在 LinuxDo 帖子列表页使用";

let isRunning = false;
let isResting = false;
let restUntil = null;
let dailyCount = 0;
let dailyLimit = DEFAULT_SETTINGS.dailyLimit;
let statusTimer = null;

function formatRestRemaining(until) {
  const ms = Math.max(0, until - Date.now());
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function readSettingsFromForm() {
  return normalizeSettings({
    dailyLimit: inputDailyLimit.value,
    restBatchSize: inputRestBatch.value,
    restMinutes: inputRestMinutes.value,
    scrollStepMinPx: inputScrollStepMin.value,
    scrollStepMaxPx: inputScrollStepMax.value,
    scrollPauseMinMs: inputScrollPauseMin.value,
    scrollPauseMaxMs: inputScrollPauseMax.value,
    scrollDurationMinMs: inputScrollDurationMin.value,
    scrollDurationMaxMs: inputScrollDurationMax.value,
  });
}

function applySettingsToForm(settings) {
  inputDailyLimit.value = settings.dailyLimit;
  inputRestBatch.value = settings.restBatchSize;
  inputRestMinutes.value = settings.restMinutes;
  inputScrollStepMin.value = settings.scrollStepMinPx;
  inputScrollStepMax.value = settings.scrollStepMaxPx;
  inputScrollPauseMin.value = settings.scrollPauseMinMs;
  inputScrollPauseMax.value = settings.scrollPauseMaxMs;
  inputScrollDurationMin.value = settings.scrollDurationMinMs;
  inputScrollDurationMax.value = settings.scrollDurationMaxMs;
}

function setInputsLocked(locked) {
  for (const input of settingInputs) {
    input.disabled = locked;
  }
}

function updateStatusText() {
  const dailyText = `今日 ${dailyCount}/${dailyLimit}`;

  if (isResting && restUntil) {
    statusEl.textContent = `休息中 · 剩余 ${formatRestRemaining(restUntil)} · ${dailyText}`;
    statusEl.className = "status resting";
    return;
  }

  statusEl.textContent = isRunning ? `运行中 · ${dailyText}` : `已停止 · ${dailyText}`;
  statusEl.className = isRunning ? "status running" : "status";
}

function updateUI() {
  updateStatusText();
  btnStart.disabled = isRunning || isResting;
  btnStop.disabled = !isRunning && !isResting;
  setInputsLocked(isRunning || isResting);
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
  if (!isResting || !restUntil) {
    return;
  }
  statusTimer = setInterval(() => {
    if (!isResting || !restUntil) {
      clearStatusTimer();
      return;
    }
    updateStatusText();
    if (Date.now() >= restUntil) {
      clearStatusTimer();
    }
  }, 1000);
}

async function sendCommand(type, payload = {}) {
  return chrome.runtime.sendMessage(makeMessage(type, payload));
}

async function loadSettings() {
  const settings = await getSettingsWithDefaults();
  applySettingsToForm(settings);
  dailyLimit = settings.dailyLimit;
}

function applyStatusResponse(res) {
  if (!res?.ok) {
    return;
  }

  isRunning = !!res.isRunning;
  isResting = !!res.isResting;
  restUntil = res.restUntil || null;
  dailyCount = res.dailyCount ?? 0;
  dailyLimit = res.dailyLimit ?? dailyLimit;

  if (res.restBatchSize != null) {
    inputRestBatch.value = res.restBatchSize;
  }
  if (res.restMinutes != null) {
    inputRestMinutes.value = res.restMinutes;
  }
  if (res.dailyLimit != null) {
    inputDailyLimit.value = res.dailyLimit;
  }

  updateUI();
  startStatusTimer();

  if (res.lastFinishedReason === "no_unread") {
    showHint("没有未读帖子，已自动停止");
  } else if (res.lastFinishedReason === "error") {
    showHint("发生错误，已停止");
  } else if (res.lastFinishedReason === "daily_limit") {
    showHint("今日已达上限，明天自动重置");
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
    const settings = readSettingsFromForm();
    await saveSettings(settings);
    dailyLimit = settings.dailyLimit;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";

    if (!isLinuxDoUrl(url) || !isListPage(url)) {
      showHint("请在帖子列表页点击开始");
      return;
    }

    const res = await sendCommand("CMD_START", { listUrl: url });
    if (!res?.ok) {
      if (res?.error === "daily_limit_reached") {
        dailyCount = res.dailyCount ?? dailyCount;
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
    restUntil = null;
    updateUI();
  } catch (err) {
    console.error("[LinuxDo-Bot] start failed:", err);
    showHint("启动失败，请重试");
  }
});

btnStop.addEventListener("click", async () => {
  try {
    await sendCommand("CMD_STOP");
    isRunning = false;
    isResting = false;
    restUntil = null;
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
    restUntil = null;
    clearStatusTimer();

    const reason = message.payload?.reason;
    if (reason === "daily_limit") {
      dailyCount = message.payload?.count ?? dailyCount;
      dailyLimit = message.payload?.dailyLimit ?? dailyLimit;
      showHint("今日已达上限，明天自动重置");
    } else if (reason === "no_unread") {
      showHint("没有未读帖子，已自动停止");
    } else if (reason === "error") {
      showHint("发生错误，已停止");
    }

    updateUI();
    return;
  }

  if (message.type === "EVT_REST_STARTED") {
    isRunning = true;
    isResting = true;
    restUntil = message.payload?.restUntil || null;
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
  }
});

(async function initPopup() {
  await loadSettings();
  await syncStatus();
  updateUI();
})();
