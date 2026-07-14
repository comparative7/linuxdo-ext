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
  earlyExitEnabled: true,
  earlyExitMaxPosts: 80,
  earlyExitMaxMs: 180000,
  earlyExitChance: 70,
  partialReadEnabled: true,
  partialReadChance: 35,
  partialReadMinPct: 40,
  partialReadMaxPct: 70,
  hudEnabled: true,
  hudShowTitle: true,
  hudShowStatus: true,
  hudShowDaily: true,
  hudShowTopic: true,
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
  earlyExitMaxPosts: { min: 20, max: 500 },
  earlyExitMaxMs: { min: 60000, max: 900000 },
  earlyExitChance: { min: 0, max: 100 },
  partialReadChance: { min: 0, max: 100 },
  partialReadMinPct: { min: 20, max: 90 },
  partialReadMaxPct: { min: 30, max: 95 },
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

function clampBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === 1 || value === "1") {
    return true;
  }
  if (value === "false" || value === 0 || value === "0") {
    return false;
  }
  return fallback;
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
    earlyExitEnabled: clampBool(
      raw.earlyExitEnabled,
      DEFAULT_SETTINGS.earlyExitEnabled
    ),
    earlyExitMaxPosts: clampSettingValue(
      "earlyExitMaxPosts",
      raw.earlyExitMaxPosts ?? DEFAULT_SETTINGS.earlyExitMaxPosts
    ),
    earlyExitMaxMs: clampSettingValue(
      "earlyExitMaxMs",
      raw.earlyExitMaxMs ?? DEFAULT_SETTINGS.earlyExitMaxMs
    ),
    earlyExitChance: clampSettingValue(
      "earlyExitChance",
      raw.earlyExitChance ?? DEFAULT_SETTINGS.earlyExitChance
    ),
    partialReadEnabled: clampBool(
      raw.partialReadEnabled,
      DEFAULT_SETTINGS.partialReadEnabled
    ),
    partialReadChance: clampSettingValue(
      "partialReadChance",
      raw.partialReadChance ?? DEFAULT_SETTINGS.partialReadChance
    ),
    partialReadMinPct: clampSettingValue(
      "partialReadMinPct",
      raw.partialReadMinPct ?? DEFAULT_SETTINGS.partialReadMinPct
    ),
    partialReadMaxPct: clampSettingValue(
      "partialReadMaxPct",
      raw.partialReadMaxPct ?? DEFAULT_SETTINGS.partialReadMaxPct
    ),
    hudEnabled: clampBool(raw.hudEnabled, DEFAULT_SETTINGS.hudEnabled),
    hudShowTitle: clampBool(raw.hudShowTitle, DEFAULT_SETTINGS.hudShowTitle),
    hudShowStatus: clampBool(raw.hudShowStatus, DEFAULT_SETTINGS.hudShowStatus),
    hudShowDaily: clampBool(raw.hudShowDaily, DEFAULT_SETTINGS.hudShowDaily),
    hudShowTopic: clampBool(raw.hudShowTopic, DEFAULT_SETTINGS.hudShowTopic),
  };

  normalizeRange("scrollStepMinPx", "scrollStepMaxPx", settings);
  normalizeRange("scrollPauseMinMs", "scrollPauseMaxMs", settings);
  normalizeRange("scrollDurationMinMs", "scrollDurationMaxMs", settings);
  normalizeRange("partialReadMinPct", "partialReadMaxPct", settings);

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

const BROWSE_HISTORY_MAX = 50;

async function ensureBrowseHistory() {
  const today = todayDateKey();
  const data = await chrome.storage.local.get("browseHistory");
  let history = data.browseHistory;
  if (!history || history.date !== today || !Array.isArray(history.items)) {
    history = { date: today, items: [] };
    await chrome.storage.local.set({ browseHistory: history });
  }
  return history;
}

async function appendBrowseHistory(entry) {
  const history = await ensureBrowseHistory();
  const item = {
    topicId: String(entry.topicId || ""),
    title: String(entry.title || "").slice(0, 40),
    url: String(entry.url || ""),
    at: Number(entry.at) || Date.now(),
    newlyReadReplies: Math.max(0, Math.floor(Number(entry.newlyReadReplies) || 0)),
    exitReason: String(entry.exitReason || "complete"),
  };
  const items = [item, ...history.items].slice(0, BROWSE_HISTORY_MAX);
  const updated = { date: history.date, items };
  await chrome.storage.local.set({ browseHistory: updated });
  return updated;
}

async function clearBrowseHistory() {
  const today = todayDateKey();
  const updated = { date: today, items: [] };
  await chrome.storage.local.set({ browseHistory: updated });
  return updated;
}

const BADGE_COLORS = {
  idle: "#9e9e9e",
  running: "#2e7d32",
  resting: "#e65100",
  waiting: "#1565c0",
  full: "#c62828",
};

/**
 * 工具栏徽章文案：数字或短状态字；>99 显示 99+。
 */
function formatBadgeText(state, dailyStats, settings) {
  const count = dailyStats?.count || 0;
  const limit = settings?.dailyLimit ?? DEFAULT_SETTINGS.dailyLimit;
  const countText = count > 99 ? "99+" : String(count);

  if (!state?.isRunning) {
    if (count >= limit && count > 0) {
      return { text: "满", color: BADGE_COLORS.full };
    }
    return { text: countText === "0" ? "" : countText, color: BADGE_COLORS.idle };
  }
  if (state.isResting) {
    return { text: "休", color: BADGE_COLORS.resting };
  }
  if (state.isWaitingForUnread) {
    return { text: "等", color: BADGE_COLORS.waiting };
  }
  if (count >= limit) {
    return { text: "满", color: BADGE_COLORS.full };
  }
  return { text: countText, color: BADGE_COLORS.running };
}

async function updateActionBadge(state, dailyStats, settings) {
  try {
    const resolvedState = state || (await getStateForBadge());
    const resolvedStats = dailyStats || (await ensureDailyStats());
    const resolvedSettings = settings || (await getSettingsWithDefaults());
    const { text, color } = formatBadgeText(
      resolvedState,
      resolvedStats,
      resolvedSettings
    );
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (err) {
    logError("updateActionBadge failed:", err);
  }
}

/** Background 专属 getState 不可用时的轻量兜底（content 不会调徽章）。 */
async function getStateForBadge() {
  const data = await chrome.storage.local.get([
    "isRunning",
    "isResting",
    "isWaitingForUnread",
  ]);
  return {
    isRunning: !!data.isRunning,
    isResting: !!data.isResting,
    isWaitingForUnread: !!data.isWaitingForUnread,
  };
}
