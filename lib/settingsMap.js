'use strict';

// Lock settings exposed as capabilities: which featureValue flag gates them (a key of FEATURE_BITS in
// lib/features.js), which field of GET /v3/lock/detail holds the current value and how it is written.
// Pure data plus two functions, so the device and the flow actions share one source of truth.
//
// Writes always go through the gateway (type/changeType 2). Values in the detail are cached by TTLock,
// so callers re-read the detail after a write.

const VIA_GATEWAY = 2;
const AUTOLOCK_MAX = 1800;
const VOLUME_MIN = 1;
const VOLUME_MAX = 5;

// detail 1 = on, 2 = off (0 / missing = unknown)
const onOff = value => {
  const number = Number(value);
  if (number === 1) return true;
  if (number === 2) return false;
  return undefined;
};

const SETTINGS = {
  ttlock_autolock_time: {
    feature: 'autolock',
    detail: 'autoLockTime',
    // seconds; the docs say -1 means off
    fromDetail: value => {
      const seconds = Number(value);
      if (!Number.isFinite(seconds)) return undefined;
      return seconds < 0 ? 0 : seconds;
    },
  },
  ttlock_passage_mode: {
    feature: 'passage_mode',
    detail: 'passageMode',
    fromDetail: onOff,
  },
  ttlock_lock_sound: {
    feature: 'sound',
    detail: 'lockSound',
    fromDetail: onOff,
    updateType: 6,
  },
  ttlock_sound_volume: {
    feature: 'volume',
    detail: 'soundVolume',
    fromDetail: value => {
      const volume = Number(value);
      return Number.isInteger(volume) && volume >= VOLUME_MIN && volume <= VOLUME_MAX ? volume : undefined;
    },
    updateType: 8,
  },
  ttlock_privacy_lock: {
    feature: 'privacy',
    detail: 'privacyLock',
    fromDetail: onOff,
    updateType: 2,
  },
  ttlock_tamper_alert: {
    feature: 'tamper',
    detail: 'tamperAlert',
    // UNVERIFIED: tamperAlert is documented without its value encoding; assumed 1 on / 2 off like the other switches.
    fromDetail: onOff,
    updateType: 3,
  },
};

// Detail object -> { capabilityId: value } for every setting the detail contains a usable value for.
// Not filtered by the lock's features: the device only sets capabilities it has.
function detailToCapabilities(detail) {
  const values = {};
  if (!detail || typeof detail !== 'object') return values;
  for (const [id, setting] of Object.entries(SETTINGS)) {
    if (detail[setting.detail] === undefined || detail[setting.detail] === null) continue;
    const value = setting.fromDetail(detail[setting.detail]);
    if (value !== undefined) values[id] = value;
  }
  return values;
}

// Model, firmware and hardware for the read-only device settings (all strings, '' when missing).
function detailInfo(detail) {
  const d = detail || {};
  const text = value => (value === undefined || value === null ? '' : String(value));
  return { model: text(d.modelNum), firmware: text(d.firmwareRevision), hardware: text(d.hardwareRevision) };
}

// Current passage mode configuration from GET /v3/lock/getPassageModeConfiguration.
// UNVERIFIED: the docs list no response fields; accepts passageMode, autoUnlock and cyclicConfig (array or JSON string),
// falls back to the lock detail's passageModeAutoUnlock. autoUnlock is 1 (on) or 2 (off, also the default).
function normalizePassageConfig(res, detail) {
  const config = res && typeof res === 'object' ? res : {};
  let autoUnlock = onOff(config.autoUnlock);
  if (autoUnlock === undefined) autoUnlock = onOff(detail && detail.passageModeAutoUnlock);
  let cyclicConfig = config.cyclicConfig;
  if (typeof cyclicConfig === 'string') {
    try {
      cyclicConfig = JSON.parse(cyclicConfig);
    } catch (err) {
      cyclicConfig = [];
    }
  }
  return {
    autoUnlock: autoUnlock === true ? 1 : 2,
    cyclicConfig: Array.isArray(cyclicConfig) ? cyclicConfig : [],
  };
}

function flag(value) {
  if (value === true || value === 1 || value === 'on' || value === '1') return 1;
  if (value === false || value === 2 || value === 'off' || value === '2') return 2;
  throw new Error(`Invalid on/off value "${value}"`);
}

// What to send to change a setting capability. `lockId` is not included: callers send { lockId, ...params }.
// current: { autoUnlock, cyclicConfig } of the passage mode (see normalizePassageConfig), which a passage
// mode toggle keeps as it is. UNVERIFIED: cyclicConfig is sent as a JSON string in the form body.
function writeFor(capabilityId, value, current) {
  const setting = SETTINGS[capabilityId];
  if (!setting) throw new Error(`Unknown setting ${capabilityId}`);

  if (capabilityId === 'ttlock_autolock_time') {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > AUTOLOCK_MAX) {
      throw new Error(`Auto-lock time must be a whole number of seconds from 0 to ${AUTOLOCK_MAX}`);
    }
    return { method: 'POST', path: '/v3/lock/setAutoLockTime', params: { seconds, type: VIA_GATEWAY } };
  }

  if (capabilityId === 'ttlock_passage_mode') {
    const keep = current || {};
    return {
      method: 'POST',
      path: '/v3/lock/configurePassageMode',
      params: {
        passageMode: flag(value),
        autoUnlock: keep.autoUnlock === 1 ? 1 : 2,
        type: VIA_GATEWAY,
        cyclicConfig: JSON.stringify(Array.isArray(keep.cyclicConfig) ? keep.cyclicConfig : []),
      },
    };
  }

  let settingValue;
  if (capabilityId === 'ttlock_sound_volume') {
    settingValue = Number(value);
    if (!Number.isInteger(settingValue) || settingValue < VOLUME_MIN || settingValue > VOLUME_MAX) {
      throw new Error(`The volume must be a whole number from ${VOLUME_MIN} to ${VOLUME_MAX}`);
    }
  } else {
    settingValue = flag(value);
  }
  return {
    method: 'POST',
    path: '/v3/lock/updateSetting',
    params: { type: setting.updateType, value: settingValue, changeType: VIA_GATEWAY },
  };
}

// Passage mode with a weekly schedule: one cyclic entry from start to end (minutes after midnight) on the given
// weekdays. weekDays 1..7: UNVERIFIED which day is 1, Monday is assumed.
function passageScheduleWrite({ weekDays, startMinutes, endMinutes, autoUnlock }) {
  return {
    method: 'POST',
    path: '/v3/lock/configurePassageMode',
    params: {
      passageMode: 1,
      autoUnlock: autoUnlock ? 1 : 2,
      type: VIA_GATEWAY,
      cyclicConfig: JSON.stringify([{
        isAllDay: 2, startTime: startMinutes, endTime: endMinutes, weekDays,
      }]),
    },
  };
}

module.exports = {
  SETTINGS, detailToCapabilities, detailInfo, normalizePassageConfig, writeFor, passageScheduleWrite,
};
