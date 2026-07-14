/**
 * LinuxDo Auto-Browser — Content Script
 * 列表页：扫描未读帖并点击进入；详情页：拟人滚动。
 */

const ACTION_DELAY_MIN_MS = 1500;
const ACTION_DELAY_MAX_MS = 4000;
const LIST_ENTER_DELAY_MIN_MS = 1000;
const LIST_ENTER_DELAY_MAX_MS = 2500;
const POST_READ_FINAL_DELAY_MIN_MS = 1000;
const POST_READ_FINAL_DELAY_MAX_MS = 3000;
const BOTTOM_THRESHOLD_PX = 50;
const STABLE_BOTTOM_COUNT = 3;
const DOM_RETRY_MAX = 3;
const POLL_MIN_MS = 800;
const POLL_MAX_MS = 2000;
const NAV_WAIT_MIN_MS = 800;
const NAV_WAIT_MAX_MS = 2000;
/** 遮挡/后台时用定时器拟人滚动的步进间隔（会被 Chrome 节流，但不会像 rAF 那样卡死） */
const HIDDEN_SCROLL_FRAME_MS = 50;
const STATS_HUD_ID = "linuxdo-ext-stats-hud";
const HUD_TITLE_COLORS = {
  topic: "#9ecbff",
  list: "#81c784",
  resting: "#ffb74d",
  waiting: "#64b5f6",
};

let isRunning = false;
let isResting = false;
let isWaitingForUnread = false;
let pauseUntil = null;
let scrollAbort = null;
let scrollInProgress = false;
let listAbort = null;
let listInProgress = false;
let lastHandledUrl = "";
/** @type {{ count: number, replyCount: number, dailyLimit: number } | null} */
let hudDailySnapshot = null;
let hudPauseTimer = null;
/** @type {"topic"|"list"|"resting"|"waiting"|null} */
let hudMode = null;
/** @type {{ read?: number, newlyRead?: number, total?: number|null }|null} */
let hudTopicStats = null;

function formatHudCountdown(until) {
  const ms = Math.max(0, (until || 0) - Date.now());
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function clearHudPauseTimer() {
  if (hudPauseTimer) {
    clearInterval(hudPauseTimer);
    hudPauseTimer = null;
  }
}

function removeStatsHud() {
  clearHudPauseTimer();
  hudMode = null;
  hudTopicStats = null;
  const el = document.getElementById(STATS_HUD_ID);
  if (el) {
    el.remove();
  }
}

function ensureStatsHud() {
  let root = document.getElementById(STATS_HUD_ID);
  if (root) {
    return root;
  }

  root = document.createElement("div");
  root.id = STATS_HUD_ID;
  Object.assign(root.style, {
    position: "fixed",
    right: "16px",
    bottom: "72px",
    zIndex: "2147483646",
    minWidth: "168px",
    maxWidth: "240px",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "rgba(20, 24, 28, 0.88)",
    color: "#f5f5f5",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: "12px",
    lineHeight: "1.45",
    boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
    pointerEvents: "none",
    letterSpacing: "0.01em",
  });

  const title = document.createElement("div");
  title.dataset.role = "title";
  Object.assign(title.style, {
    fontWeight: "600",
    marginBottom: "4px",
    color: HUD_TITLE_COLORS.topic,
  });
  title.textContent = "LinuxDo Bot";

  const status = document.createElement("div");
  status.dataset.role = "status";

  const daily = document.createElement("div");
  daily.dataset.role = "daily";

  const topic = document.createElement("div");
  topic.dataset.role = "topic";

  root.appendChild(title);
  root.appendChild(status);
  root.appendChild(daily);
  root.appendChild(topic);
  (document.documentElement || document.body).appendChild(root);
  return root;
}

function paintStatsHud() {
  try {
    if (!hudMode) {
      return;
    }
    const root = ensureStatsHud();
    const titleEl = root.querySelector('[data-role="title"]');
    const statusEl = root.querySelector('[data-role="status"]');
    const dailyEl = root.querySelector('[data-role="daily"]');
    const topicEl = root.querySelector('[data-role="topic"]');
    const daily = hudDailySnapshot || { count: 0, replyCount: 0, dailyLimit: 0 };
    const dailyText = `今日 ${daily.count}/${daily.dailyLimit} 帖 · 新读 ${daily.replyCount} 楼`;

    if (titleEl) {
      titleEl.style.color = HUD_TITLE_COLORS[hudMode] || HUD_TITLE_COLORS.topic;
      titleEl.textContent = "LinuxDo Bot";
    }
    if (dailyEl) {
      dailyEl.textContent = dailyText;
    }

    if (hudMode === "resting") {
      if (statusEl) {
        statusEl.textContent = pauseUntil
          ? `休息中 · ${formatHudCountdown(pauseUntil)}`
          : "休息中";
      }
      if (topicEl) {
        topicEl.textContent = "";
      }
      return;
    }
    if (hudMode === "waiting") {
      if (statusEl) {
        statusEl.textContent = pauseUntil
          ? `等待新帖 · ${formatHudCountdown(pauseUntil)}`
          : "等待新帖";
      }
      if (topicEl) {
        topicEl.textContent = "";
      }
      return;
    }
    if (hudMode === "list") {
      if (statusEl) {
        statusEl.textContent = "运行中 · 扫描未读…";
      }
      if (topicEl) {
        topicEl.textContent = "";
      }
      return;
    }

    // topic
    if (statusEl) {
      statusEl.textContent = "阅读中";
    }
    if (topicEl) {
      const stats = hudTopicStats || {};
      const read = stats.read ?? 0;
      const newly = stats.newlyRead ?? 0;
      const total =
        stats.total == null || stats.total <= 0 ? "?" : String(stats.total);
      topicEl.textContent = `本主题 ${read}/${total} · 本次+${newly}`;
    }
  } catch (err) {
    logError("paintStatsHud failed:", err);
  }
}

function startHudPauseTimer() {
  clearHudPauseTimer();
  if (!pauseUntil || (hudMode !== "resting" && hudMode !== "waiting")) {
    return;
  }
  hudPauseTimer = setInterval(() => {
    if (!pauseUntil || Date.now() >= pauseUntil) {
      paintStatsHud();
      clearHudPauseTimer();
      return;
    }
    paintStatsHud();
  }, 1000);
}

/**
 * @param {"topic"|"list"|"resting"|"waiting"} mode
 * @param {{ read?: number, newlyRead?: number, total?: number|null }} [topicStats]
 */
async function showStatsHud(mode, topicStats) {
  hudMode = mode;
  if (mode === "topic") {
    hudTopicStats = topicStats || hudTopicStats || {};
  } else {
    hudTopicStats = null;
  }
  await refreshHudDailySnapshot();
  paintStatsHud();
  if (mode === "resting" || mode === "waiting") {
    startHudPauseTimer();
  } else {
    clearHudPauseTimer();
  }
}

function updateStatsHud(topicStats = {}) {
  hudMode = "topic";
  hudTopicStats = topicStats;
  paintStatsHud();
}

async function refreshHudDailySnapshot() {
  try {
    const [data, settings] = await Promise.all([
      chrome.storage.local.get("dailyStats"),
      getSettingsWithDefaults(),
    ]);
    const stats = data.dailyStats || {};
    const today = todayDateKey();
    const isToday = stats.date === today;
    hudDailySnapshot = {
      count: isToday ? stats.count || 0 : 0,
      replyCount: isToday ? stats.replyCount || 0 : 0,
      dailyLimit: settings.dailyLimit,
    };
  } catch (err) {
    logError("refreshHudDailySnapshot failed:", err);
    hudDailySnapshot = {
      count: 0,
      replyCount: 0,
      dailyLimit: DEFAULT_SETTINGS.dailyLimit,
    };
  }
}

/**
 * 解析 Discourse 进度条 / map / 预加载数据，得到本主题总楼层。
 */
function getTopicPostTotal() {
  try {
    const progress = document.querySelector("#topic-progress .numbers");
    if (progress) {
      const nums = (progress.textContent || "").match(/\d+/g);
      if (nums && nums.length >= 2) {
        return Number(nums[nums.length - 1]);
      }
    }

    const timeline = document.querySelector(".timeline-replies");
    if (timeline) {
      const nums = (timeline.textContent || "").match(/\d+/g);
      if (nums && nums.length >= 2) {
        return Number(nums[nums.length - 1]);
      }
      if (nums && nums.length === 1) {
        return Number(nums[0]);
      }
    }

    const mapNum = document.querySelector(
      ".topic-map .number, .map .number, .topic-map__stat-posts .number"
    );
    if (mapNum) {
      const n = Number((mapNum.textContent || "").replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    }

    const pre = document.getElementById("data-preloaded");
    const raw = pre?.getAttribute("data-preloaded");
    if (raw) {
      const bag = JSON.parse(raw);
      for (const key of Object.keys(bag)) {
        try {
          const value = typeof bag[key] === "string" ? JSON.parse(bag[key]) : bag[key];
          if (value && typeof value === "object") {
            if (value.posts_count > 0) {
              return Number(value.posts_count);
            }
            if (value.highest_post_number > 0) {
              return Number(value.highest_post_number);
            }
            if (value.topic?.posts_count > 0) {
              return Number(value.topic.posts_count);
            }
          }
        } catch {
          // ignore malformed preloaded chunk
        }
      }
    }

    let maxPostNumber = 0;
    for (const node of document.querySelectorAll("[data-post-number]")) {
      const n = Number(node.getAttribute("data-post-number"));
      if (Number.isFinite(n) && n > maxPostNumber) {
        maxPostNumber = n;
      }
    }
    if (maxPostNumber > 0) {
      return maxPostNumber;
    }

    const loaded = document.querySelectorAll("article[data-post-id]").length;
    return loaded > 0 ? loaded : null;
  } catch (err) {
    logError("getTopicPostTotal failed:", err);
    return null;
  }
}

function abortScroll() {
  if (scrollAbort) {
    scrollAbort.abort();
    scrollAbort = null;
  }
  scrollInProgress = false;
}

function abortList() {
  if (listAbort) {
    listAbort.abort();
    listAbort = null;
  }
  listInProgress = false;
}

function abortAll() {
  abortScroll();
  abortList();
}

async function sendToBackground(type, payload) {
  try {
    await chrome.runtime.sendMessage(makeMessage(type, payload));
  } catch (err) {
    logError("sendMessage failed:", type, err);
  }
}

function getPageMode() {
  if (isTopicPage(location.href)) {
    return "topic";
  }
  if (isListPage(location.href)) {
    return "list";
  }
  return "unknown";
}

async function handlePageRoute(reason = "init") {
  const url = location.href;
  const mode = getPageMode();
  if (mode === "unknown") {
    removeStatsHud();
    return;
  }
  // 离开详情页时立刻停滚动，避免列表扫描与残留滚动并发
  if (mode !== "topic" && scrollInProgress) {
    abortScroll();
  }
  if (mode === "topic" && listInProgress && reason !== "after-click") {
    return;
  }
  if (scrollInProgress && mode === "topic") {
    return;
  }
  if (listInProgress && mode === "list") {
    return;
  }
  if (url === lastHandledUrl) {
    return;
  }

  lastHandledUrl = url;
  log(`Page route (${reason}):`, mode, url);

  await sendToBackground("EVT_PAGE_READY", { pageMode: mode, url });

  if (!isRunning) {
    removeStatsHud();
    return;
  }

  if (isResting || isWaitingForUnread) {
    await showStatsHud(isResting ? "resting" : "waiting");
    return;
  }

  if (mode === "topic" && !scrollInProgress) {
    scrollTopic();
  } else if (mode === "list" && !listInProgress) {
    scanAndEnterTopic();
  }
}

async function waitForTopicNavigation(scope, fromUrl, maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!isRunning || scope.isAborted()) {
      return false;
    }
    if (location.href !== fromUrl && isTopicPage(location.href)) {
      log("SPA navigated to topic:", location.href);
      return true;
    }
    await scope.delay(randomInt(NAV_WAIT_MIN_MS, NAV_WAIT_MAX_MS));
  }
  return location.href !== fromUrl && isTopicPage(location.href);
}

function installSpaRouteWatcher() {
  let currentUrl = location.href;

  const onRouteMaybeChanged = (reason) => {
    if (location.href === currentUrl) {
      return;
    }
    currentUrl = location.href;
    void handlePageRoute(reason);
  };

  window.addEventListener("popstate", () => onRouteMaybeChanged("popstate"));

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      onRouteMaybeChanged(method);
      return result;
    };
  }

  const schedulePoll = () => {
    setTimeout(() => {
      onRouteMaybeChanged("poll");
      schedulePoll();
    }, randomInt(POLL_MIN_MS, POLL_MAX_MS));
  };
  schedulePoll();
}

function handleStateChanged(payload) {
  isRunning = !!payload.isRunning;
  isResting = !!payload.isResting;
  isWaitingForUnread = !!payload.isWaitingForUnread;
  if (payload.restUntil != null || payload.waitUntil != null) {
    pauseUntil = payload.restUntil || payload.waitUntil || null;
  } else if (!isResting && !isWaitingForUnread) {
    pauseUntil = null;
  }

  if (!isRunning) {
    abortAll();
    isResting = false;
    isWaitingForUnread = false;
    pauseUntil = null;
    removeStatsHud();
    return;
  }
  if (isResting || isWaitingForUnread) {
    abortAll();
    void showStatsHud(isResting ? "resting" : "waiting");
    return;
  }
  if (isTopicPage(location.href) && !scrollInProgress) {
    scrollTopic();
  } else if (isListPage(location.href) && !listInProgress) {
    lastHandledUrl = "";
    scanAndEnterTopic();
  }
}

function getTopicRows() {
  return Array.from(document.querySelectorAll("tr.topic-list-item"));
}

function isPinnedRow(row) {
  if (row.querySelector(".topic-list-thumbtack")) {
    return true;
  }
  return /\bpinned\b|\bglobal-pin\b/.test(row.className);
}

function isTitleBold(row) {
  const link = getTopicLink(row);
  if (!link) {
    return false;
  }
  const fw = window.getComputedStyle(link).fontWeight;
  const n = parseInt(fw, 10);
  return fw === "bold" || n >= 600;
}

function isUnreadRow(row) {
  if (
    row.classList.contains("unseen-topic") ||
    row.classList.contains("new-posts")
  ) {
    return true;
  }
  if (row.classList.contains("visited")) {
    return false;
  }
  // /latest 等：无 visited 时辅以粗体标题，避免误点已读帖
  return isTitleBold(row);
}

function getTopicLink(row) {
  return row.querySelector("a.title") || row.querySelector("td.main-link a");
}

function isAnnouncementRow(row) {
  return (
    row.classList.contains("category-announcement") ||
    !!row.querySelector(".category-announcement")
  );
}

function getTopicIdFromRow(row) {
  const link = getTopicLink(row);
  if (!link) {
    return null;
  }
  const href = link.getAttribute("href") || "";
  const match = href.match(/\/t\/[^/]+\/(\d+)/);
  return match ? match[1] : null;
}

function getTopicTitle(row) {
  const link = getTopicLink(row);
  return link?.textContent?.trim().replace(/\s+/g, " ").slice(0, 48) || "";
}

function getTitleFontWeight(row) {
  const link = getTopicLink(row);
  if (!link) {
    return "-";
  }
  return window.getComputedStyle(link).fontWeight;
}

function getRowFilterStatus(row, visitedIds) {
  if (isPinnedRow(row)) {
    return { status: "skip", reason: "pinned" };
  }
  if (!isUnreadRow(row)) {
    return { status: "skip", reason: "read" };
  }
  const link = getTopicLink(row);
  if (!link) {
    return { status: "skip", reason: "noLink" };
  }
  const topicId = getTopicIdFromRow(row);
  if (!topicId) {
    return { status: "skip", reason: "noHref" };
  }
  if (visitedIds.has(topicId)) {
    return { status: "skip", reason: "visitedIds" };
  }
  if (isAnnouncementRow(row)) {
    return { status: "skip", reason: "announcement" };
  }
  return { status: "candidate", reason: "-" };
}

function buildRowDebugSnapshot(row, index, visitedIds) {
  const { status, reason } = getRowFilterStatus(row, visitedIds);
  const topicId = getTopicIdFromRow(row);

  return {
    "#": index + 1,
    topicId: topicId || "-",
    title: getTopicTitle(row),
    status,
    reason,
    unread: isUnreadRow(row),
    pinned: isPinnedRow(row),
    unseen: row.classList.contains("unseen-topic"),
    newPosts: row.classList.contains("new-posts"),
    visited: row.classList.contains("visited"),
    roundVisited: topicId ? visitedIds.has(topicId) : false,
    announcement: isAnnouncementRow(row),
    fontWeight: getTitleFontWeight(row),
    rowClasses: [...row.classList].join(" "),
  };
}

function logListDebugTable(rows, visitedIds) {
  const snapshots = rows.map((row, index) =>
    buildRowDebugSnapshot(row, index, visitedIds)
  );
  const candidateIds = snapshots
    .filter((item) => item.status === "candidate")
    .map((item) => item.topicId);

  log(`List debug table: ${rows.length} rows, ${candidateIds.length} candidates`);
  console.table(snapshots);
  log("Candidate topicIds:", candidateIds.length ? candidateIds : "(none)");
}

async function scanAndEnterTopic() {
  if (listInProgress || !isRunning || isResting || isWaitingForUnread || !isListPage(location.href)) {
    return;
  }

  listInProgress = true;
  listAbort = createAbortScope();
  const scope = listAbort;

  log("Scanning list for unread topics");
  await showStatsHud("list");

  try {
    const storage = await chrome.storage.local.get([
      "visitedTopicIds",
      "debugListScan",
    ]);
    const visited = new Set((storage.visitedTopicIds || []).map(String));

    let rows = getTopicRows();
    let scannedCount = rows.length;

    if (scannedCount === 0) {
      for (let attempt = 1; attempt <= DOM_RETRY_MAX; attempt++) {
        log(`List DOM not ready, retry ${attempt}/${DOM_RETRY_MAX}`);
        await scope.delay(randomInt(ACTION_DELAY_MIN_MS, ACTION_DELAY_MAX_MS));
        if (!isRunning || scope.isAborted()) {
          return;
        }
        rows = getTopicRows();
        scannedCount = rows.length;
        if (scannedCount > 0) {
          break;
        }
      }
    }

    if (scannedCount === 0) {
      await sendToBackground("EVT_ERROR", {
        code: "DOM_NOT_READY",
        message: "List DOM empty after retries",
        pageMode: "list",
      });
      return;
    }

    if (storage.debugListScan) {
      logListDebugTable(rows, visited);
    }

    const candidates = [];
    const filterStats = {
      pinned: 0,
      read: 0,
      noLink: 0,
      visited: 0,
      noHref: 0,
      announcement: 0,
    };

    for (const row of rows) {
      if (isPinnedRow(row)) {
        filterStats.pinned++;
        continue;
      }
      if (!isUnreadRow(row)) {
        filterStats.read++;
        continue;
      }

      const link = getTopicLink(row);
      if (!link) {
        filterStats.noLink++;
        continue;
      }

      const href = link.getAttribute("href") || "";
      const match = href.match(/\/t\/[^/]+\/(\d+)/);
      if (!match) {
        filterStats.noHref++;
        continue;
      }

      const topicId = match[1];
      if (visited.has(topicId)) {
        filterStats.visited++;
        continue;
      }
      if (isAnnouncementRow(row)) {
        filterStats.announcement++;
        continue;
      }

      candidates.push({
        link,
        topicId,
        topicUrl: new URL(href, location.origin).href,
      });
    }

    log("Scanned:", scannedCount, "candidates:", candidates.length, filterStats);

    if (candidates.length === 0) {
      await sendToBackground("EVT_NO_UNREAD", {
        listUrl: location.href,
        scannedCount,
      });
      return;
    }

    const pick = candidates[randomInt(0, candidates.length - 1)];
    log("Entering topic:", pick.topicId);

    await sendToBackground("EVT_TOPIC_ENTERED", {
      topicId: pick.topicId,
      topicUrl: pick.topicUrl,
    });

    await scope.delay(randomInt(LIST_ENTER_DELAY_MIN_MS, LIST_ENTER_DELAY_MAX_MS));
    if (!isRunning || scope.isAborted()) {
      return;
    }

    const fromUrl = location.href;
    pick.link.click();

    const navigated = await waitForTopicNavigation(scope, fromUrl);
    if (navigated && isRunning && !scope.isAborted()) {
      lastHandledUrl = "";
      await handlePageRoute("after-click");
    }
  } catch (err) {
    logError("scanAndEnterTopic error:", err);
    await sendToBackground("EVT_ERROR", {
      code: "LIST_SCAN_FAILED",
      message: String(err),
      pageMode: "list",
    });
  } finally {
    abortList();
  }
}

function isAtBottom() {
  const { scrollHeight } = document.documentElement;
  return window.innerHeight + window.scrollY >= scrollHeight - BOTTOM_THRESHOLD_PX;
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function getMaxScrollY() {
  return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

function isPageVisible() {
  return document.visibilityState === "visible";
}

/**
 * 遮挡/后台：用 setTimeout 按同一缓动曲线步进，尽量接近前台拟人滚动。
 * 定时器会被节流，但不会像 rAF 那样永久挂起。
 */
async function smoothScrollByTimed(startY, targetY, durationMs, scope) {
  const delta = targetY - startY;
  if (delta <= 0 || durationMs <= 0) {
    return;
  }

  const startTime = performance.now();

  while (isRunning && !scope.isAborted()) {
    const t = Math.min(1, (performance.now() - startTime) / durationMs);
    window.scrollTo(0, startY + delta * easeInOutQuad(t));
    if (t >= 1) {
      return;
    }
    await scope.delay(HIDDEN_SCROLL_FRAME_MS);
  }
}

/**
 * 前台：rAF 平滑滚动。中途若被遮挡（visibility hidden），中止并交由定时器续完。
 */
function smoothScrollByRaf(startY, targetY, durationMs, scope) {
  return new Promise((resolve) => {
    const delta = targetY - startY;
    const startTime = performance.now();
    let rafId = null;
    let settled = false;

    const finish = (completed) => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      resolve({
        completed,
        elapsedMs: performance.now() - startTime,
      });
    };

    const onVisibilityChange = () => {
      if (!isPageVisible()) {
        finish(false);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    const tick = (now) => {
      if (scope.isAborted() || !isRunning) {
        finish(true);
        return;
      }
      if (!isPageVisible()) {
        finish(false);
        return;
      }

      const t = Math.min(1, (now - startTime) / durationMs);
      window.scrollTo(0, startY + delta * easeInOutQuad(t));

      if (t >= 1) {
        finish(true);
        return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
  });
}

async function smoothScrollBy(distancePx, durationMs, scope) {
  const startY = window.scrollY;
  const targetY = Math.min(startY + distancePx, getMaxScrollY());
  const delta = targetY - startY;

  if (delta <= 0 || durationMs <= 0) {
    return;
  }

  if (!isPageVisible()) {
    await smoothScrollByTimed(startY, targetY, durationMs, scope);
    return;
  }

  const { completed, elapsedMs } = await smoothScrollByRaf(
    startY,
    targetY,
    durationMs,
    scope
  );

  if (completed || !isRunning || scope.isAborted()) {
    return;
  }

  const remainDelta = targetY - window.scrollY;
  if (remainDelta <= 0) {
    return;
  }

  const remainMs = Math.max(HIDDEN_SCROLL_FRAME_MS, durationMs - elapsedMs);
  await smoothScrollByTimed(window.scrollY, targetY, remainMs, scope);
}

function isTopicDomReady() {
  return !!(
    document.querySelector("#post_1") ||
    document.querySelector(".topic-post") ||
    document.querySelector("article[data-post-id]") ||
    document.querySelector(".topic-body .cooked")
  );
}

/**
 * Discourse 每层有 .read-state；带 .read 表示该层已读。
 * 只统计本次浏览中「曾见未读 → 后来变已读」的楼层。
 */
function getPostIdFromReadState(el) {
  const article = el.closest("article[data-post-id]");
  if (article?.dataset?.postId) {
    return article.dataset.postId;
  }
  const wrap = el.closest(".topic-post");
  if (!wrap) {
    return null;
  }
  const nested = wrap.querySelector("article[data-post-id]");
  if (nested?.dataset?.postId) {
    return nested.dataset.postId;
  }
  const byId = wrap.id && /^post_(\d+)$/.exec(wrap.id);
  return byId ? byId[1] : null;
}

function createReplyReadTracker() {
  const seenUnreadIds = new Set();
  const newlyReadIds = new Set();
  const alreadyReadIds = new Set();
  let warnedMissingReadState = false;

  function scan() {
    try {
      const nodes = document.querySelectorAll(".read-state");
      if (nodes.length === 0) {
        if (!warnedMissingReadState) {
          warnedMissingReadState = true;
          log("No .read-state markers found; topic read counts stay 0");
        }
        return;
      }
      for (const el of nodes) {
        const id = getPostIdFromReadState(el);
        if (!id) {
          continue;
        }
        if (el.classList.contains("read")) {
          if (seenUnreadIds.has(id)) {
            newlyReadIds.add(id);
          } else {
            alreadyReadIds.add(id);
          }
        } else {
          seenUnreadIds.add(id);
        }
      }
    } catch (err) {
      logError("read-state scan failed:", err);
    }
  }

  function getSnapshot() {
    scan();
    const stillUnread = [...seenUnreadIds].filter((id) => !newlyReadIds.has(id))
      .length;
    return {
      seenUnread: seenUnreadIds.size,
      newlyRead: newlyReadIds.size,
      stillUnread,
      alreadyRead: alreadyReadIds.size,
      currentRead: newlyReadIds.size + alreadyReadIds.size,
      markedTotal: seenUnreadIds.size + alreadyReadIds.size,
    };
  }

  function getNewlyReadCount() {
    return getSnapshot().newlyRead;
  }

  return { scan, getNewlyReadCount, getSnapshot };
}

async function waitForTopicDom(scope) {
  for (let attempt = 1; attempt <= DOM_RETRY_MAX; attempt++) {
    if (isTopicDomReady()) {
      return true;
    }
    log(`Topic DOM not ready, retry ${attempt}/${DOM_RETRY_MAX}`);
    await scope.delay(randomInt(ACTION_DELAY_MIN_MS, ACTION_DELAY_MAX_MS));
    if (!isRunning || scope.isAborted()) {
      return false;
    }
  }
  return isTopicDomReady();
}

async function scrollTopic() {
  if (scrollInProgress || !isRunning || isResting || isWaitingForUnread || !isTopicPage(location.href)) {
    return;
  }

  const topicId = extractTopicId(location.href);
  const topicUrl = location.href;
  if (!topicId) {
    logError("Cannot extract topicId from URL:", topicUrl);
    return;
  }

  scrollInProgress = true;
  scrollAbort = createAbortScope();
  const scope = scrollAbort;

  log("Starting topic scroll:", topicId);

  try {
    const domReady = await waitForTopicDom(scope);
    if (!domReady) {
      logError("Topic DOM not ready after retries");
      abortScroll();
      await sendToBackground("EVT_ERROR", {
        code: "DOM_NOT_READY",
        message: "Topic DOM not ready after retries",
        pageMode: "topic",
      });
      return;
    }

    const scrollCfg = await getSettingsWithDefaults();
    const replyReadTracker = createReplyReadTracker();
    replyReadTracker.scan();
    await refreshHudDailySnapshot();
    let stableBottomCount = 0;
    let lastHeightAtBottom = 0;
    let topicTotalSeen = 0;
    let scrollStepsDone = 0;
    const startedAt = Date.now();
    let timeoutRollDone = false;
    let postsRollDone = false;

    const usePartialRead =
      scrollCfg.partialReadEnabled &&
      randomInt(1, 100) <= scrollCfg.partialReadChance;
    const partialTargetPct = usePartialRead
      ? randomInt(scrollCfg.partialReadMinPct, scrollCfg.partialReadMaxPct)
      : null;
    if (usePartialRead) {
      log("Partial read mode, target depth:", partialTargetPct, "%");
    }

    const resolveTopicTotal = () => {
      const total = getTopicPostTotal();
      if (total != null && total > topicTotalSeen) {
        topicTotalSeen = total;
      }
      return topicTotalSeen > 0 ? topicTotalSeen : total;
    };

    const paintHud = () => {
      const snap = replyReadTracker.getSnapshot();
      updateStatsHud({
        read: snap.currentRead,
        newlyRead: snap.newlyRead,
        total: resolveTopicTotal(),
      });
    };
    paintHud();

    const getTopicTitle = () => {
      try {
        return (document.title || "")
          .replace(/\s*[-|].*$/, "")
          .trim()
          .slice(0, 40);
      } catch {
        return "";
      }
    };

    const finishTopic = async (exitReason) => {
      await scope.delay(
        randomInt(POST_READ_FINAL_DELAY_MIN_MS, POST_READ_FINAL_DELAY_MAX_MS)
      );
      if (!isRunning || scope.isAborted()) {
        return false;
      }
      const snap = replyReadTracker.getSnapshot();
      const topicTotal = resolveTopicTotal();
      paintHud();
      log(
        "本次浏览统计:",
        `topic=${topicId}`,
        `exit=${exitReason}`,
        `未读→已读=${snap.newlyRead}`,
        `当前已读=${snap.currentRead}`,
        `主题总数=${topicTotal ?? "?"}`,
        `曾见未读=${snap.seenUnread}`,
        `仍未读=${snap.stillUnread}`,
        `原本已读=${snap.alreadyRead}`,
        `楼层标记总数=${snap.markedTotal}`
      );
      await sendToBackground("EVT_POST_READ_COMPLETE", {
        topicId,
        topicUrl,
        newlyReadReplies: snap.newlyRead,
        exitReason,
        title: getTopicTitle(),
      });
      abortScroll();
      removeStatsHud();
      return true;
    };

    /**
     * @returns {"early_timeout"|"early_posts"|"partial"|null}
     */
    const evaluateEarlyExit = () => {
      if (scrollCfg.earlyExitEnabled) {
        if (!timeoutRollDone && Date.now() - startedAt >= scrollCfg.earlyExitMaxMs) {
          timeoutRollDone = true;
          if (randomInt(1, 100) <= scrollCfg.earlyExitChance) {
            return "early_timeout";
          }
          log("Timeout early-exit rolled miss, continue");
        }

        const total = resolveTopicTotal();
        if (
          !postsRollDone &&
          scrollStepsDone >= 2 &&
          total != null &&
          total >= scrollCfg.earlyExitMaxPosts
        ) {
          postsRollDone = true;
          if (randomInt(1, 100) <= scrollCfg.earlyExitChance) {
            return "early_posts";
          }
          log("Posts early-exit rolled miss, continue");
        }
      }

      if (usePartialRead && partialTargetPct != null && scrollStepsDone >= 1) {
        const maxY = getMaxScrollY();
        if (maxY <= BOTTOM_THRESHOLD_PX) {
          return "partial";
        }
        const depthPct = (window.scrollY / maxY) * 100;
        if (depthPct >= partialTargetPct) {
          return "partial";
        }
      }

      return null;
    };

    while (isRunning && !scope.isAborted()) {
      replyReadTracker.scan();
      paintHud();

      const earlyReason = evaluateEarlyExit();
      if (earlyReason) {
        log("Leaving topic early:", earlyReason);
        await finishTopic(earlyReason);
        return;
      }

      if (isAtBottom()) {
        const currentHeight = document.documentElement.scrollHeight;

        if (lastHeightAtBottom === 0) {
          lastHeightAtBottom = currentHeight;
          stableBottomCount = 1;
          log("First bottom reached, height:", currentHeight);
        } else if (currentHeight > lastHeightAtBottom) {
          stableBottomCount = 0;
          lastHeightAtBottom = currentHeight;
          log("scrollHeight grew to", currentHeight, ", continuing scroll");
          const step = randomInt(
            scrollCfg.scrollStepMinPx,
            scrollCfg.scrollStepMaxPx
          );
          const duration = randomInt(
            scrollCfg.scrollDurationMinMs,
            scrollCfg.scrollDurationMaxMs
          );
          await smoothScrollBy(step, duration, scope);
          scrollStepsDone++;
        } else {
          stableBottomCount++;
          log("Stable at bottom:", stableBottomCount, "/", STABLE_BOTTOM_COUNT);
        }

        if (stableBottomCount >= STABLE_BOTTOM_COUNT) {
          log("Topic read complete, final delay");
          await finishTopic("complete");
          return;
        }

        await scope.delay(
          randomInt(scrollCfg.scrollPauseMinMs, scrollCfg.scrollPauseMaxMs)
        );
      } else {
        stableBottomCount = 0;
        lastHeightAtBottom = 0;
        const step = randomInt(
          scrollCfg.scrollStepMinPx,
          scrollCfg.scrollStepMaxPx
        );
        const duration = randomInt(
          scrollCfg.scrollDurationMinMs,
          scrollCfg.scrollDurationMaxMs
        );
        log("Scrolling", step, "px over", duration, "ms");
        await smoothScrollBy(step, duration, scope);
        scrollStepsDone++;
        paintHud();
        await scope.delay(
          randomInt(scrollCfg.scrollPauseMinMs, scrollCfg.scrollPauseMaxMs)
        );
      }
    }
  } catch (err) {
    logError("scrollTopic error:", err);
    await sendToBackground("EVT_ERROR", {
      code: "SCROLL_FAILED",
      message: String(err),
      pageMode: "topic",
    });
  } finally {
    if (scrollInProgress) {
      abortScroll();
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== "linuxdo-ext") {
    return;
  }

  if (message.type === "EVT_STATE_CHANGED") {
    handleStateChanged(message.payload || {});
  } else if (message.type === "CMD_ABORT") {
    isRunning = false;
    isResting = false;
    isWaitingForUnread = false;
    pauseUntil = null;
    abortAll();
    removeStatsHud();
    log("Aborted:", message.payload?.reason || "unknown");
  } else if (message.type === "CMD_PAUSE") {
    const until = message.payload?.restUntil || null;
    pauseUntil = until;
    // resting vs waiting 由后续 EVT_* 或 EVT_STATE_CHANGED 细化；先按暂停处理
    if (isWaitingForUnread) {
      isResting = false;
    } else {
      isResting = true;
    }
    abortAll();
    void showStatsHud(isWaitingForUnread ? "waiting" : "resting");
    log("Paused until", until);
  } else if (message.type === "EVT_REST_STARTED") {
    isResting = true;
    isWaitingForUnread = false;
    pauseUntil = message.payload?.restUntil || null;
    abortAll();
    void showStatsHud("resting");
  } else if (message.type === "EVT_IDLE_POLL_STARTED") {
    isWaitingForUnread = true;
    isResting = false;
    pauseUntil = message.payload?.waitUntil || null;
    abortAll();
    void showStatsHud("waiting");
  } else if (message.type === "EVT_IDLE_POLL_ENDED") {
    // 列表即将/已经刷新；由页面重载或 EVT_STATE_CHANGED 触发扫描，避免扫到旧 DOM
    isWaitingForUnread = false;
    isResting = false;
    pauseUntil = null;
    clearHudPauseTimer();
  } else if (message.type === "EVT_REST_ENDED") {
    isResting = false;
    pauseUntil = null;
    clearHudPauseTimer();
    if (!isRunning) {
      removeStatsHud();
      return;
    }
    if (isTopicPage(location.href) && !scrollInProgress) {
      scrollTopic();
    } else if (isListPage(location.href) && !listInProgress) {
      lastHandledUrl = "";
      scanAndEnterTopic();
    }
  }
});

async function init() {
  try {
    const data = await chrome.storage.local.get([
      "isRunning",
      "isResting",
      "isWaitingForUnread",
      "restUntil",
      "waitUntil",
    ]);
    isRunning = !!data.isRunning;
    isResting = !!data.isResting;
    isWaitingForUnread = !!data.isWaitingForUnread;
    pauseUntil = data.restUntil || data.waitUntil || null;
  } catch (err) {
    logError("Failed to read storage:", err);
  }

  installSpaRouteWatcher();
  await handlePageRoute("init");
}

init();
