import {
  BUILTIN_DICTIONARIES,
  detectDefaultLang,
  getBuiltinDictionary,
  deepMergeDictionary
} from './dictionary_default.js';
import {
  PHASE_COLORS,
  getCalendarDayLunarSummary,
  computePersonalState,
  findNextDateForLunarDay,
  getTimeSlot,
  setObserverCoords
} from './astro_engine.js';

const BADGE_ALARM = 'lunar_badge_refresh';
const CHECKPOINT_PREFIX = 'checkpoint_';
const REMINDER_PREFIX = 'reminder_';
const ACTIVE_ALARM_BADGE_COLOR = '#E65100';
let lastToolbarIconElongStep = null;

function buildMoonToolbarImageData(size, elongDeg) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cx = size * 0.42;
  const cy = size * 0.42;
  const R = size * 0.37;

  const elongRad = ((((Number(elongDeg) || 0) % 360) + 360) % 360) * (Math.PI / 180);
  const sx = Math.sin(elongRad);
  const sz = -Math.cos(elongRad);

  const softWidth = 0.16;
  const halfSoft = softWidth * 0.5;
  const aaWidth = 1.15 / R;

  for (let py = 0; py < size; py++) {
    const ny = (py + 0.5 - cy) / R;
    const ny2 = ny * ny;
    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5 - cx) / R;
      const r2 = nx * nx + ny2;
      const r = Math.sqrt(r2);
      if (r > 1 + aaWidth) continue;

      const edgeAlpha = r <= 1 - aaWidth
        ? 1
        : Math.max(0, Math.min(1, (1 + aaWidth - r) / (2 * aaWidth)));

      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, r2)));
      const dot = nx * sx + nz * sz;
      const t = Math.max(0, Math.min(1, (dot + halfSoft) / softWidth));
      const lit = t * t * (3 - 2 * t);

      // Subtle cool rim on night side so New Moon and crescent edge stay crisp on dark toolbars
      const rim = r >= 0.84 ? Math.min(1, (r - 0.84) / 0.16) * 0.45 : 0;
      const nightR = 20 + rim * (92 - 20);
      const nightG = 25 + rim * (106 - 25);
      const nightB = 38 + rim * (142 - 38);

      const idx = (py * size + px) * 4;
      data[idx] = Math.round(nightR + lit * (234 - nightR));
      data[idx + 1] = Math.round(nightG + lit * (179 - nightG));
      data[idx + 2] = Math.round(nightB + lit * (46 - nightB));
      data[idx + 3] = Math.round(edgeAlpha * 255);
    }
  }

  return new ImageData(data, size, size);
}

async function syncToolbarMoonIcon(elongDeg) {
  if (!chrome?.action || typeof chrome.action.setIcon !== 'function') return;
  const norm = (((Number(elongDeg) || 0) % 360) + 360) % 360;
  const step = Math.round(norm / 2);
  if (step === lastToolbarIconElongStep) return;

  try {
    await chrome.action.setIcon({
      imageData: {
        16: buildMoonToolbarImageData(16, norm),
        32: buildMoonToolbarImageData(32, norm),
        48: buildMoonToolbarImageData(48, norm)
      }
    });
    lastToolbarIconElongStep = step;
  } catch {
    // Fallback silently to manifest default icons if setIcon fails
  }
}

const DEFAULT_SETTINGS = {
  birthDate: null,
  birthTime: null,
  observerLat: null,
  observerLon: null,
  builtinLang: null,
  dictionaryMode: 'default',
  customDictionary: null,
  reminders: [],
  notifications: {
    morningEnabled: true,
    dayEnabled: true,
    eveningEnabled: true,
    alarmPushEnabled: true,
    morning: '08:30',
    day: '13:30',
    evening: '20:30'
  },
  selectedVoiceURI: '',
  pendingAutoplay: null,
  activeAlarm: null
};

async function getState() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const rawNotifs = data.notifications || {};
  const legacyCheckpoints =
    typeof rawNotifs.checkpointsEnabled === 'boolean'
      ? rawNotifs.checkpointsEnabled
      : typeof rawNotifs.enabled === 'boolean'
      ? rawNotifs.enabled
      : true;

  const morningEnabled =
    typeof rawNotifs.morningEnabled === 'boolean'
      ? rawNotifs.morningEnabled
      : legacyCheckpoints;
  const dayEnabled =
    typeof rawNotifs.dayEnabled === 'boolean'
      ? rawNotifs.dayEnabled
      : legacyCheckpoints;
  const eveningEnabled =
    typeof rawNotifs.eveningEnabled === 'boolean'
      ? rawNotifs.eveningEnabled
      : legacyCheckpoints;
  const alarmPushEnabled =
    typeof rawNotifs.alarmPushEnabled === 'boolean'
      ? rawNotifs.alarmPushEnabled
      : DEFAULT_SETTINGS.notifications.alarmPushEnabled;

  const builtinLang = BUILTIN_DICTIONARIES[data.builtinLang]
    ? data.builtinLang
    : detectDefaultLang();

  const state = {
    ...DEFAULT_SETTINGS,
    ...data,
    builtinLang,
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      ...rawNotifs,
      morningEnabled,
      dayEnabled,
      eveningEnabled,
      alarmPushEnabled
    },
    reminders: Array.isArray(data.reminders) ? data.reminders : [],
    activeAlarm: data.activeAlarm || null
  };
  setObserverCoords(state.observerLat, state.observerLon);
  return state;
}

function getActiveDictionary(state) {
  const baseDict = getBuiltinDictionary(state.builtinLang);
  if (state.dictionaryMode === 'custom' && state.customDictionary) {
    return deepMergeDictionary(baseDict, state.customDictionary);
  }
  return baseDict;
}

function getLocalizedZodiacSign(dict, canonicalSign) {
  return dict.zodiac_names?.[canonicalSign] || canonicalSign;
}

async function updateBadge() {
  const state = await getState();
  const dict = getActiveDictionary(state);
  const baseDict = getBuiltinDictionary(state.builtinLang);
  const labels = { ...baseDict.ui_labels, ...(dict.ui_labels || {}) };

  const now = new Date();
  const summary = getCalendarDayLunarSummary(now, now);
  await syncToolbarMoonIcon(summary.phaseInfo.elong);

  if (state.activeAlarm) {
    await chrome.action.setBadgeText({ text: '🔔' });
    await chrome.action.setBadgeBackgroundColor({ color: ACTIVE_ALARM_BADGE_COLOR });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    }
    const alarmDesc = state.activeAlarm.text ? `: ${state.activeAlarm.text}` : '';
    await chrome.action.setTitle({ title: `${labels.app_title} — ${labels.hero_alarm_title}${alarmDesc}` });
    return;
  }

  const badgeText = String(summary.activeLunarDay);
  const signLabel = getLocalizedZodiacSign(dict, summary.phaseInfo.zodiacSign);

  let bgColor = PHASE_COLORS.neutral;
  let titlePrefix = `${summary.activeLunarDay} ${labels.lunar_day_short} · ${signLabel}`;

  if (state.birthDate) {
    const personal = computePersonalState(state.birthDate, now, now, state.birthTime);
    if (personal) {
      bgColor = personal.headerColor;
      const phaseTitle = dict.phases[personal.phaseKey]?.badge || personal.phaseKey;
      titlePrefix = `${summary.activeLunarDay} ${labels.lunar_day_short} · ${phaseTitle}`;
    }
  }

  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setBadgeBackgroundColor({ color: bgColor });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  }
  await chrome.action.setTitle({ title: `${labels.app_title} — ${titlePrefix}` });
}

function computeNextCheckpointTime(hhmm) {
  const [hh, mm] = (hhmm || '08:30').split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 8, mm || 30, 0, 0);
  if (target.getTime() <= now.getTime() + 5000) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

async function syncAlarms() {
  const state = await getState();
  await chrome.alarms.clearAll();

  // Periodic badge refresh every 15 minutes
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 15 });

  // Daily checkpoint alarms (controlled independently per time slot)
  for (const slot of ['morning', 'day', 'evening']) {
    const slotEnabled = state.notifications[`${slot}Enabled`];
    const timeStr = state.notifications[slot];
    if (slotEnabled && timeStr) {
      chrome.alarms.create(`${CHECKPOINT_PREFIX}${slot}`, {
        when: computeNextCheckpointTime(timeStr),
        periodInMinutes: 24 * 60
      });
    }
  }

  // Lunar reminder alarms ALWAYS schedule when enabled (even if alarmPushEnabled is false)
  const nowMs = Date.now();
  let changed = false;
  const updatedReminders = state.reminders.map(rem => {
    if (!rem.enabled) return rem;

    let triggerAt = rem.nextTriggerAt;
    if (!triggerAt || triggerAt <= nowMs) {
      if (rem.mode === 'lunar' && rem.repeatMonthly) {
        const nextDate = findNextDateForLunarDay(rem.lunarDay, new Date(nowMs + 60000));
        triggerAt = nextDate.getTime();
        changed = true;
      } else {
        return rem;
      }
    }

    if (triggerAt > nowMs) {
      chrome.alarms.create(`${REMINDER_PREFIX}${rem.id}`, { when: triggerAt });
    }
    return { ...rem, nextTriggerAt: triggerAt };
  });

  if (changed) {
    await chrome.storage.local.set({ reminders: updatedReminders });
  }
}

async function showCheckpointNotification(slot) {
  const state = await getState();
  const now = new Date();
  const activeSlot = slot || getTimeSlot(now);
  if (!state.notifications[`${activeSlot}Enabled`]) return;

  const dict = getActiveDictionary(state);
  const baseDict = getBuiltinDictionary(state.builtinLang);
  const labels = { ...baseDict.ui_labels, ...(dict.ui_labels || {}) };
  const summary = getCalendarDayLunarSummary(now, now);
  const signLabel = getLocalizedZodiacSign(dict, summary.phaseInfo.zodiacSign);

  let title = `${labels.app_title} · ${summary.activeLunarDay} ${labels.lunar_day_short}`;
  let message = `${signLabel} · ${summary.phaseInfo.illuminationExact.toFixed(1)}%`;

  if (state.birthDate) {
    const personal = computePersonalState(state.birthDate, now, now, state.birthTime);
    if (personal) {
      const phaseObj = dict.phases[personal.phaseKey];
      const rawTip = dict.lifestyle_tips[personal.phaseKey]?.[activeSlot];
      const dateSeed = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      let tip = '';
      if (Array.isArray(rawTip) && rawTip.length) {
        const seedStr = `${dateSeed}|${personal.phaseKey}|${activeSlot}|tip`;
        let h = 2166136261;
        for (let i = 0; i < seedStr.length; i++) {
          h ^= seedStr.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        tip = rawTip[(h >>> 0) % rawTip.length];
      } else if (typeof rawTip === 'string') {
        tip = rawTip;
      }
      const roleTone = dict.role_tone?.[personal.roleKey]?.[personal.phaseKey] || '';
      title = `${labels.app_title} · ${phaseObj.badge} (${summary.activeLunarDay} ${labels.lunar_day_short})`;
      message = [phaseObj.title + '.', roleTone, tip].filter(Boolean).join(' ').trim();
    }
  }

  const notifId = `checkpoint:${activeSlot}:${Date.now()}`;
  await chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2
  });
}

async function handleReminderAlarm(reminderId) {
  const state = await getState();
  const dict = getActiveDictionary(state);
  const rem = state.reminders.find(r => r.id === reminderId);
  if (!rem || !rem.enabled) return;

  // Always activate alarm state in storage regardless of alarmPushEnabled
  const activeAlarm = {
    id: rem.id,
    text: rem.text || dict.ui_labels.reminder_prefix_tts,
    lunarDay: rem.lunarDay,
    triggeredAt: Date.now()
  };

  const nowMs = Date.now();
  const updated = state.reminders.map(item => {
    if (item.id !== rem.id) return item;
    if (item.mode === 'lunar' && item.repeatMonthly) {
      const nextDate = findNextDateForLunarDay(item.lunarDay, new Date(nowMs + 3600000 * 6));
      chrome.alarms.create(`${REMINDER_PREFIX}${item.id}`, { when: nextDate.getTime() });
      return { ...item, nextTriggerAt: nextDate.getTime() };
    }
    return { ...item, enabled: false };
  });

  await chrome.storage.local.set({
    activeAlarm,
    reminders: updated
  });
  await updateBadge();

  if (state.notifications.alarmPushEnabled) {
    const title = `${dict.ui_labels.app_title} · ${rem.lunarDay} ${dict.ui_labels.lunar_day_short}`;
    const message = rem.text || dict.ui_labels.reminder_prefix_tts;
    const notifId = `reminder:${rem.id}:${Date.now()}`;

    await chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2
    });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['builtinLang']);
  if (!existing.builtinLang || !BUILTIN_DICTIONARIES[existing.builtinLang]) {
    await chrome.storage.local.set({ builtinLang: detectDefaultLang() });
  }
  await updateBadge();
  await syncAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await updateBadge();
  await syncAlarms();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (
    changes.birthDate ||
    changes.birthTime ||
    changes.observerLat ||
    changes.observerLon ||
    changes.builtinLang ||
    changes.dictionaryMode ||
    changes.customDictionary ||
    changes.activeAlarm
  ) {
    await updateBadge();
  }
  if (changes.reminders || changes.notifications || changes.observerLat || changes.observerLon) {
    await syncAlarms();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BADGE_ALARM) {
    await updateBadge();
    return;
  }
  if (alarm.name.startsWith(CHECKPOINT_PREFIX)) {
    const slot = alarm.name.slice(CHECKPOINT_PREFIX.length);
    await showCheckpointNotification(slot);
    await updateBadge();
    return;
  }
  if (alarm.name.startsWith(REMINDER_PREFIX)) {
    const remId = alarm.name.slice(REMINDER_PREFIX.length);
    await handleReminderAlarm(remId);
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const parts = notificationId.split(':');
  const kind = parts[0];
  let payload = { type: 'briefing', createdAt: Date.now() };

  if (kind === 'reminder') {
    const remId = parts[1];
    const state = await getState();
    const rem = state.reminders.find(r => r.id === remId);
    payload = {
      type: 'reminder',
      reminderId: remId,
      text: rem ? rem.text : (state.activeAlarm?.text || ''),
      createdAt: Date.now()
    };
  }

  await chrome.storage.local.set({ pendingAutoplay: payload });
  await chrome.notifications.clear(notificationId);

  try {
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      return;
    }
  } catch (_) {
    // Fallback to opening popup.html in a tab when openPopup() cannot attach to a window
  }

  await chrome.tabs.create({
    url: chrome.runtime.getURL('popup.html?autoplay=1')
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SYNC_NOW') {
    Promise.all([updateBadge(), syncAlarms()])
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err?.message }));
    return true;
  }
  return false;
});
