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
  getTimeSlot
} from './astro_engine.js';

const BADGE_ALARM = 'lunar_badge_refresh';
const CHECKPOINT_PREFIX = 'checkpoint_';
const REMINDER_PREFIX = 'reminder_';
const ACTIVE_ALARM_BADGE_COLOR = '#E65100';

const DEFAULT_SETTINGS = {
  birthDate: null,
  birthTime: null,
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

  return {
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

  const now = new Date();
  const summary = getCalendarDayLunarSummary(now, now);
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
    changes.builtinLang ||
    changes.dictionaryMode ||
    changes.customDictionary ||
    changes.activeAlarm
  ) {
    await updateBadge();
  }
  if (changes.reminders || changes.notifications) {
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
