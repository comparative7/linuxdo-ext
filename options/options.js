/**
 * LinuxDo Auto-Browser — Options page
 * 全部浏览参数配置；运行中锁定编辑。
 */

const bannerEl = document.getElementById("banner");
const btnSave = document.getElementById("btn-save");
const btnReset = document.getElementById("btn-reset");

const inputDailyLimit = document.getElementById("input-daily-limit");
const inputRestBatch = document.getElementById("input-rest-batch");
const inputRestMinutes = document.getElementById("input-rest-minutes");
const inputScrollStepMin = document.getElementById("input-scroll-step-min");
const inputScrollStepMax = document.getElementById("input-scroll-step-max");
const inputScrollPauseMin = document.getElementById("input-scroll-pause-min");
const inputScrollPauseMax = document.getElementById("input-scroll-pause-max");
const inputScrollDurationMin = document.getElementById("input-scroll-duration-min");
const inputScrollDurationMax = document.getElementById("input-scroll-duration-max");
const inputEarlyExitEnabled = document.getElementById("input-early-exit-enabled");
const inputEarlyExitPosts = document.getElementById("input-early-exit-posts");
const inputEarlyExitMin = document.getElementById("input-early-exit-min");
const inputEarlyExitChance = document.getElementById("input-early-exit-chance");
const inputPartialEnabled = document.getElementById("input-partial-enabled");
const inputPartialChance = document.getElementById("input-partial-chance");
const inputPartialMin = document.getElementById("input-partial-min");
const inputPartialMax = document.getElementById("input-partial-max");
const inputDebugListScan = document.getElementById("input-debug-list-scan");

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
  inputEarlyExitEnabled,
  inputEarlyExitPosts,
  inputEarlyExitMin,
  inputEarlyExitChance,
  inputPartialEnabled,
  inputPartialChance,
  inputPartialMin,
  inputPartialMax,
  inputDebugListScan,
];

let formLocked = false;

function showBanner(text, kind = "") {
  bannerEl.textContent = text;
  bannerEl.className = "banner visible" + (kind ? ` ${kind}` : "");
}

function hideBanner() {
  bannerEl.textContent = "";
  bannerEl.className = "banner";
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
    earlyExitEnabled: inputEarlyExitEnabled.checked,
    earlyExitMaxPosts: inputEarlyExitPosts.value,
    earlyExitMaxMs: Number(inputEarlyExitMin.value) * 60 * 1000,
    earlyExitChance: inputEarlyExitChance.value,
    partialReadEnabled: inputPartialEnabled.checked,
    partialReadChance: inputPartialChance.value,
    partialReadMinPct: inputPartialMin.value,
    partialReadMaxPct: inputPartialMax.value,
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
  inputEarlyExitEnabled.checked = !!settings.earlyExitEnabled;
  inputEarlyExitPosts.value = settings.earlyExitMaxPosts;
  inputEarlyExitMin.value = Math.max(1, Math.round(settings.earlyExitMaxMs / 60000));
  inputEarlyExitChance.value = settings.earlyExitChance;
  inputPartialEnabled.checked = !!settings.partialReadEnabled;
  inputPartialChance.value = settings.partialReadChance;
  inputPartialMin.value = settings.partialReadMinPct;
  inputPartialMax.value = settings.partialReadMaxPct;
}

async function loadDebugFlag() {
  const data = await chrome.storage.local.get("debugListScan");
  inputDebugListScan.checked = !!data.debugListScan;
}

function setInputsLocked(locked) {
  formLocked = locked;
  for (const input of settingInputs) {
    input.disabled = locked;
  }
  btnSave.disabled = locked;
  btnReset.disabled = locked;
  if (locked) {
    showBanner("插件运行中（含休息/等待），请先在 Popup 停止后再改配置");
  } else if (bannerEl.classList.contains("visible") && !bannerEl.classList.contains("ok")) {
    hideBanner();
  }
}

async function syncLockFromStatus() {
  try {
    const res = await chrome.runtime.sendMessage(makeMessage("CMD_GET_STATUS"));
    if (!res?.ok) {
      return;
    }
    const locked = !!(res.isRunning || res.isResting || res.isWaitingForUnread);
    setInputsLocked(locked);
  } catch (err) {
    console.error("[LinuxDo-Bot] options sync status failed:", err);
  }
}

async function loadAll() {
  const settings = await getSettingsWithDefaults();
  applySettingsToForm(settings);
  await loadDebugFlag();
  await syncLockFromStatus();
}

btnSave.addEventListener("click", async () => {
  if (formLocked) {
    return;
  }
  try {
    const settings = readSettingsFromForm();
    await saveSettings(settings);
    await chrome.storage.local.set({ debugListScan: !!inputDebugListScan.checked });
    applySettingsToForm(settings);
    showBanner("已保存。下次开始或下一帖生效。", "ok");
  } catch (err) {
    console.error("[LinuxDo-Bot] save settings failed:", err);
    showBanner("保存失败，请重试");
  }
});

btnReset.addEventListener("click", async () => {
  if (formLocked) {
    return;
  }
  try {
    applySettingsToForm(DEFAULT_SETTINGS);
    inputDebugListScan.checked = false;
    await saveSettings(DEFAULT_SETTINGS);
    await chrome.storage.local.set({ debugListScan: false });
    showBanner("已恢复默认并保存。", "ok");
  } catch (err) {
    console.error("[LinuxDo-Bot] reset settings failed:", err);
    showBanner("恢复默认失败，请重试");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "linuxdo-ext") {
    return;
  }
  const lockTypes = [
    "EVT_RUN_FINISHED",
    "EVT_REST_STARTED",
    "EVT_REST_ENDED",
    "EVT_IDLE_POLL_STARTED",
    "EVT_IDLE_POLL_ENDED",
  ];
  if (lockTypes.includes(message.type)) {
    syncLockFromStatus();
  }
});

(async function initOptions() {
  await loadAll();
})();
