/**
 * LinuxDo Auto-Browser — Content Script
 * 列表页：扫描未读帖并点击进入；详情页：拟人滚动。
 */

const DELAY_MIN_MS = 3000;
const DELAY_MAX_MS = 8000;
const BOTTOM_THRESHOLD_PX = 50;
const STABLE_BOTTOM_COUNT = 3;
const DOM_RETRY_MAX = 3;
const POLL_MIN_MS = 800;
const POLL_MAX_MS = 2000;
const NAV_WAIT_MIN_MS = 800;
const NAV_WAIT_MAX_MS = 2000;

let isRunning = false;
let isResting = false;
let scrollAbort = null;
let scrollInProgress = false;
let listAbort = null;
let listInProgress = false;
let lastHandledUrl = "";

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
    return;
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

  if (!isRunning || isResting) {
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
  if (!isRunning) {
    abortAll();
    isResting = false;
    return;
  }
  if (isResting) {
    abortAll();
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
  if (listInProgress || !isRunning || isResting || !isListPage(location.href)) {
    return;
  }

  listInProgress = true;
  listAbort = createAbortScope();
  const scope = listAbort;

  log("Scanning list for unread topics");

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
        await scope.delay(randomInt(DELAY_MIN_MS, DELAY_MAX_MS));
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

    await scope.delay(randomInt(DELAY_MIN_MS, DELAY_MAX_MS));
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

function smoothScrollBy(distancePx, durationMs, scope) {
  return new Promise((resolve) => {
    const startY = window.scrollY;
    const targetY = Math.min(startY + distancePx, getMaxScrollY());
    const delta = targetY - startY;

    if (delta <= 0 || durationMs <= 0) {
      resolve();
      return;
    }

    const startTime = performance.now();
    let rafId = null;

    const tick = (now) => {
      if (scope.isAborted() || !isRunning) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        resolve();
        return;
      }

      const t = Math.min(1, (now - startTime) / durationMs);
      window.scrollTo(0, startY + delta * easeInOutQuad(t));

      if (t >= 1) {
        resolve();
        return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
  });
}

function isTopicDomReady() {
  return !!(
    document.querySelector("#post_1") ||
    document.querySelector(".topic-post") ||
    document.querySelector("article[data-post-id]") ||
    document.querySelector(".topic-body .cooked")
  );
}

async function waitForTopicDom(scope) {
  for (let attempt = 1; attempt <= DOM_RETRY_MAX; attempt++) {
    if (isTopicDomReady()) {
      return true;
    }
    log(`Topic DOM not ready, retry ${attempt}/${DOM_RETRY_MAX}`);
    await scope.delay(randomInt(DELAY_MIN_MS, DELAY_MAX_MS));
    if (!isRunning || scope.isAborted()) {
      return false;
    }
  }
  return isTopicDomReady();
}

async function scrollTopic() {
  if (scrollInProgress || !isRunning || isResting || !isTopicPage(location.href)) {
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
    let stableBottomCount = 0;
    let lastHeightAtBottom = 0;

    while (isRunning && !scope.isAborted()) {
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
        } else {
          stableBottomCount++;
          log("Stable at bottom:", stableBottomCount, "/", STABLE_BOTTOM_COUNT);
        }

        if (stableBottomCount >= STABLE_BOTTOM_COUNT) {
          log("Topic read complete, final delay");
          await scope.delay(randomInt(DELAY_MIN_MS, DELAY_MAX_MS));
          if (!isRunning || scope.isAborted()) {
            break;
          }
          await sendToBackground("EVT_POST_READ_COMPLETE", { topicId, topicUrl });
          abortScroll();
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
    abortAll();
    log("Aborted:", message.payload?.reason || "unknown");
  } else if (message.type === "CMD_PAUSE") {
    isResting = true;
    abortAll();
    log("Paused for rest until", message.payload?.restUntil);
  } else if (message.type === "EVT_REST_ENDED") {
    isResting = false;
    if (!isRunning) {
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
    const data = await chrome.storage.local.get(["isRunning", "isResting"]);
    isRunning = !!data.isRunning;
    isResting = !!data.isResting;
  } catch (err) {
    logError("Failed to read storage:", err);
  }

  installSpaRouteWatcher();
  await handlePageRoute("init");
}

init();
