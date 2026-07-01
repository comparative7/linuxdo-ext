/**
 * LinuxDo Auto-Browser — Content Script
 * 列表页：扫描未读帖并点击进入；详情页：拟人滚动。
 */

const SCROLL_MIN_PX = 300;
const SCROLL_MAX_PX = 800;
const DELAY_MIN_MS = 3000;
const DELAY_MAX_MS = 8000;
const BOTTOM_THRESHOLD_PX = 50;
const STABLE_BOTTOM_COUNT = 3;
const DOM_RETRY_MAX = 3;

let isRunning = false;
let scrollAbort = null;
let scrollInProgress = false;
let listAbort = null;
let listInProgress = false;

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

function handleStateChanged(payload) {
  isRunning = !!payload.isRunning;
  if (!isRunning) {
    abortAll();
    return;
  }
  if (isTopicPage(location.href) && !scrollInProgress) {
    scrollTopic();
  } else if (isListPage(location.href) && !listInProgress) {
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

function isUnreadRow(row) {
  return (
    row.classList.contains("unseen-topic") ||
    row.classList.contains("new-posts")
  );
}

function isTitleBold(row) {
  const title = row.querySelector("a.title, td.main-link a");
  if (!title) {
    return false;
  }
  const weight = window.getComputedStyle(title).fontWeight;
  return weight === "bold" || Number.parseInt(weight, 10) >= 700;
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

async function scanAndEnterTopic() {
  if (listInProgress || !isRunning || !isListPage(location.href)) {
    return;
  }

  listInProgress = true;
  listAbort = createAbortScope();
  const scope = listAbort;

  log("Scanning list for unread topics");

  try {
    const storage = await chrome.storage.local.get(["visitedTopicIds"]);
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

    const candidates = [];

    for (const row of rows) {
      if (isPinnedRow(row)) {
        continue;
      }
      if (!isUnreadRow(row)) {
        continue;
      }
      if (!isTitleBold(row)) {
        continue;
      }

      const link = getTopicLink(row);
      if (!link) {
        continue;
      }

      const href = link.getAttribute("href") || "";
      const match = href.match(/\/t\/[^/]+\/(\d+)/);
      if (!match) {
        continue;
      }

      const topicId = match[1];
      if (visited.has(topicId)) {
        continue;
      }
      if (isAnnouncementRow(row)) {
        continue;
      }

      candidates.push({
        link,
        topicId,
        topicUrl: new URL(href, location.origin).href,
      });
    }

    log("Scanned:", scannedCount, "candidates:", candidates.length);

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

    pick.link.click();
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

function isTopicDomReady() {
  return !!(
    document.querySelector("#post_1") ||
    document.querySelector(".topic-post")
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
  if (scrollInProgress || !isRunning || !isTopicPage(location.href)) {
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
      history.back();
      await sendToBackground("EVT_ERROR", {
        code: "DOM_NOT_READY",
        message: "Topic DOM not ready after retries",
        pageMode: "topic",
      });
      return;
    }

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
          window.scrollBy({
            top: randomInt(100, 200),
            behavior: "smooth",
          });
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
      } else {
        stableBottomCount = 0;
        lastHeightAtBottom = 0;
        const step = randomInt(SCROLL_MIN_PX, SCROLL_MAX_PX);
        log("Scrolling", step, "px");
        window.scrollBy({ top: step, behavior: "smooth" });
      }

      await scope.delay(randomInt(DELAY_MIN_MS, DELAY_MAX_MS));
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
    abortAll();
    log("Aborted:", message.payload?.reason || "unknown");
  }
});

async function init() {
  try {
    const data = await chrome.storage.local.get(["isRunning"]);
    isRunning = !!data.isRunning;
  } catch (err) {
    logError("Failed to read storage:", err);
  }

  if (isTopicPage(location.href)) {
    log("Topic page ready:", location.href);
    await sendToBackground("EVT_PAGE_READY", {
      pageMode: "topic",
      url: location.href,
    });
    if (isRunning) {
      scrollTopic();
    }
    return;
  }

  if (isListPage(location.href)) {
    log("List page ready:", location.href);
    await sendToBackground("EVT_PAGE_READY", {
      pageMode: "list",
      url: location.href,
    });
    if (isRunning) {
      scanAndEnterTopic();
    }
  }
}

init();
