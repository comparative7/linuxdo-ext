/**
 * LinuxDo Auto-Browser — Shared utilities
 * Loaded by content scripts and background (importScripts).
 */

const LOG_PREFIX = "[LinuxDo-Bot]";
const LINUXDO_HOME_URL = "https://linux.do";

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

const DEFAULT_SETTINGS = {
  dailyLimit: 100,
  restBatchSize: 10,
  restMinutes: 15,
  scrollStepMinPx: 50,
  scrollStepMaxPx: 200,
  scrollPauseMinMs: 500,
  scrollPauseMaxMs: 2000,
  scrollDurationMinMs: 400,
  scrollDurationMaxMs: 1400,
};

const SETTINGS_LIMITS = {
  dailyLimit: { min: 1, max: 500 },
  restBatchSize: { min: 1, max: 50 },
  restMinutes: { min: 1, max: 120 },
  scrollStepMinPx: { min: 10, max: 500 },
  scrollStepMaxPx: { min: 10, max: 800 },
  scrollPauseMinMs: { min: 100, max: 10000 },
  scrollPauseMaxMs: { min: 100, max: 30000 },
  scrollDurationMinMs: { min: 100, max: 5000 },
  scrollDurationMaxMs: { min: 100, max: 10000 },
};

function normalizeRange(minKey, maxKey, settings) {
  let min = settings[minKey];
  let max = settings[maxKey];
  if (min > max) {
    [min, max] = [max, min];
  }
  settings[minKey] = min;
  settings[maxKey] = max;
}

function todayDateKey() {
  return new Date().toLocaleDateString("sv-SE");
}

function clampSettingValue(key, value) {
  const limits = SETTINGS_LIMITS[key];
  const fallback = DEFAULT_SETTINGS[key];
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(limits.max, Math.max(limits.min, n));
}

function normalizeSettings(raw = {}) {
  const settings = {
    dailyLimit: clampSettingValue(
      "dailyLimit",
      raw.dailyLimit ?? DEFAULT_SETTINGS.dailyLimit
    ),
    restBatchSize: clampSettingValue(
      "restBatchSize",
      raw.restBatchSize ?? DEFAULT_SETTINGS.restBatchSize
    ),
    restMinutes: clampSettingValue(
      "restMinutes",
      raw.restMinutes ?? DEFAULT_SETTINGS.restMinutes
    ),
    scrollStepMinPx: clampSettingValue(
      "scrollStepMinPx",
      raw.scrollStepMinPx ?? DEFAULT_SETTINGS.scrollStepMinPx
    ),
    scrollStepMaxPx: clampSettingValue(
      "scrollStepMaxPx",
      raw.scrollStepMaxPx ?? DEFAULT_SETTINGS.scrollStepMaxPx
    ),
    scrollPauseMinMs: clampSettingValue(
      "scrollPauseMinMs",
      raw.scrollPauseMinMs ?? DEFAULT_SETTINGS.scrollPauseMinMs
    ),
    scrollPauseMaxMs: clampSettingValue(
      "scrollPauseMaxMs",
      raw.scrollPauseMaxMs ?? DEFAULT_SETTINGS.scrollPauseMaxMs
    ),
    scrollDurationMinMs: clampSettingValue(
      "scrollDurationMinMs",
      raw.scrollDurationMinMs ?? DEFAULT_SETTINGS.scrollDurationMinMs
    ),
    scrollDurationMaxMs: clampSettingValue(
      "scrollDurationMaxMs",
      raw.scrollDurationMaxMs ?? DEFAULT_SETTINGS.scrollDurationMaxMs
    ),
  };

  normalizeRange("scrollStepMinPx", "scrollStepMaxPx", settings);
  normalizeRange("scrollPauseMinMs", "scrollPauseMaxMs", settings);
  normalizeRange("scrollDurationMinMs", "scrollDurationMaxMs", settings);

  return settings;
}

async function getSettingsWithDefaults() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return normalizeSettings(data);
}

async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set(normalized);
  return normalized;
}

async function ensureDailyStats() {
  const today = todayDateKey();
  const data = await chrome.storage.local.get("dailyStats");
  let stats = data.dailyStats;
  if (!stats || stats.date !== today) {
    stats = { date: today, count: 0, replyCount: 0 };
    await chrome.storage.local.set({ dailyStats: stats });
    return stats;
  }
  if (stats.replyCount == null) {
    stats = { date: stats.date, count: stats.count || 0, replyCount: 0 };
    await chrome.storage.local.set({ dailyStats: stats });
  }
  return stats;
}

async function incrementDailyStats(newlyReadReplies = 0) {
  const stats = await ensureDailyStats();
  const delta = Math.max(0, Math.floor(Number(newlyReadReplies) || 0));
  const updated = {
    date: stats.date,
    count: stats.count + 1,
    replyCount: (stats.replyCount || 0) + delta,
  };
  await chrome.storage.local.set({ dailyStats: updated });
  return updated;
}
