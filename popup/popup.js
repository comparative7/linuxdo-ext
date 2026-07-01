/**
 * LinuxDo Auto-Browser — Popup
 * Phase 1: 骨架 UI，仅本地按钮状态切换，不含业务通信逻辑。
 */

const statusEl = document.getElementById("status");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");

let isRunning = false;

function updateUI() {
  statusEl.textContent = isRunning ? "运行中" : "已停止";
  statusEl.classList.toggle("running", isRunning);
  btnStart.disabled = isRunning;
  btnStop.disabled = !isRunning;
}

btnStart.addEventListener("click", () => {
  isRunning = true;
  updateUI();
});

btnStop.addEventListener("click", () => {
  isRunning = false;
  updateUI();
});

updateUI();
