/**
 * LinuxDo Auto-Browser — Shared utilities
 * Loaded by content scripts and background (importScripts).
 */

const LOG_PREFIX = "[LinuxDo-Bot]";

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logError(...args) {
  console.error(LOG_PREFIX, ...args);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(minMs = 3000, maxMs = 8000) {
  return new Promise((resolve) => {
    setTimeout(resolve, randomInt(minMs, maxMs));
  });
}

function createAbortScope() {
  const timers = new Set();
  let aborted = false;

  function abort() {
    aborted = true;
    for (const id of timers) {
      clearTimeout(id);
    }
    timers.clear();
  }

  function schedule(fn, ms) {
    if (aborted) {
      return null;
    }
    const id = setTimeout(() => {
      timers.delete(id);
      if (!aborted) {
        fn();
      }
    }, ms);
    timers.add(id);
    return id;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      if (aborted) {
        resolve();
        return;
      }
      schedule(resolve, ms);
    });
  }

  function isAborted() {
    return aborted;
  }

  return { schedule, delay, abort, isAborted };
}

function makeMessage(type, payload = {}) {
  return {
    source: "linuxdo-ext",
    version: 1,
    type,
    payload,
    timestamp: Date.now(),
  };
}

function isLinuxDoUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "linux.do";
  } catch {
    return false;
  }
}

function isTopicPage(url) {
  if (!isLinuxDoUrl(url)) {
    return false;
  }
  return /^\/t\/[^/]+\/\d+/.test(new URL(url).pathname);
}

function isListPage(url) {
  return isLinuxDoUrl(url) && !isTopicPage(url);
}

function extractTopicId(url) {
  try {
    const match = new URL(url).pathname.match(/\/t\/[^/]+\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
