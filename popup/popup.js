/**
 * LinuxDo Auto-Browser — Popup
 * 开始/停止控制，与 Background 同步状态。
 */

const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const hintEl = document.querySelector(".hint");

const DEFAULT_HINT = "请在 LinuxDo 帖子列表页使用";

let isRunning = false;

function updateUI() {
  statusEl.textContent = isRunning ? "运行中" : "已停止";
  statusEl.classList.toggle("running", isRunning);
  btnStart.disabled = isRunning;
  btnStop.disabled = !isRunning;
}

function showHint(text) {
  hintEl.textContent = text;
}

async function sendCommand(type, payload = {}) {
  return chrome.runtime.sendMessage(makeMessage(type, payload));
}

async function syncStatus() {
  try {
    const res = await sendCommand("CMD_GET_STATUS");
    if (res?.ok) {
      isRunning = !!res.isRunning;
      updateUI();
      if (res.lastFinishedReason === "no_unread") {
        showHint("没有未读帖子，已自动停止");
      } else if (res.lastFinishedReason === "error") {
        showHint("发生错误，已停止");
      }
    }
  } catch (err) {
    console.error("[LinuxDo-Bot] syncStatus failed:", err);
  }
}

btnStart.addEventListener("click", async () => {
  showHint(DEFAULT_HINT);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";

    if (!isLinuxDoUrl(url) || !isListPage(url)) {
      showHint("请在帖子列表页点击开始");
      return;
    }

    const res = await sendCommand("CMD_START", { listUrl: url });
    if (!res?.ok) {
      showHint("启动失败，请确认当前在列表页");
      return;
    }

    isRunning = true;
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
    updateUI();
    showHint(DEFAULT_HINT);
  } catch (err) {
    console.error("[LinuxDo-Bot] stop failed:", err);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "linuxdo-ext") {
    return;
  }
  if (message.type !== "EVT_RUN_FINISHED") {
    return;
  }

  isRunning = false;
  updateUI();

  const reason = message.payload?.reason;
  if (reason === "no_unread") {
    showHint("没有未读帖子，已自动停止");
  } else if (reason === "error") {
    showHint("发生错误，已停止");
  }
});

syncStatus();
updateUI();
