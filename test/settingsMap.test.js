'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  SETTINGS, detailToCapabilities, detailInfo, normalizePassageConfig, writeFor, passageScheduleWrite,
} = require('../lib/settingsMap');
const { FEATURE_BITS } = require('../lib/features');

test('every setting is gated by a known feature bit and has a detail field', () => {
  assert.deepStrictEqual(Object.fromEntries(Object.entries(SETTINGS).map(([id, s]) => [id, FEATURE_BITS[s.feature]])), {
    ttlock_autolock_time: 4,
    ttlock_passage_mode: 22,
    ttlock_lock_sound: 15,
    ttlock_sound_volume: 43,
    ttlock_privacy_lock: 30,
    ttlock_tamper_alert: 28,
  });
  for (const setting of Object.values(SETTINGS)) assert.ok(setting.detail);
});

test('detailToCapabilities: converts every detail field', () => {
  assert.deepStrictEqual(detailToCapabilities({
    autoLockTime: 30, passageMode: 1, lockSound: 1, soundVolume: 4, privacyLock: 2, tamperAlert: 1,
  }), {
    ttlock_autolock_time: 30,
    ttlock_passage_mode: true,
    ttlock_lock_sound: true,
    ttlock_sound_volume: 4,
    ttlock_privacy_lock: false,
    ttlock_tamper_alert: true,
  });
});

test('detailToCapabilities: autoLockTime -1 is 0 (off), 2 means off, unknown or missing values are skipped', () => {
  assert.strictEqual(detailToCapabilities({ autoLockTime: -1 }).ttlock_autolock_time, 0);
  assert.strictEqual(detailToCapabilities({ autoLockTime: '15' }).ttlock_autolock_time, 15);
  assert.strictEqual(detailToCapabilities({ passageMode: 2 }).ttlock_passage_mode, false);
  assert.deepStrictEqual(detailToCapabilities({ lockSound: 0 }), {}); // 0 = unknown
  assert.deepStrictEqual(detailToCapabilities({ soundVolume: 0 }), {});
  assert.deepStrictEqual(detailToCapabilities({ soundVolume: 9 }), {});
  assert.deepStrictEqual(detailToCapabilities({ privacyLock: null, tamperAlert: undefined }), {});
  assert.deepStrictEqual(detailToCapabilities({ autoLockTime: 'x' }), {});
  assert.deepStrictEqual(detailToCapabilities({}), {});
  assert.deepStrictEqual(detailToCapabilities(null), {});
  assert.deepStrictEqual(detailToCapabilities('nope'), {});
});

test('detailInfo: model, firmware and hardware as strings', () => {
  assert.deepStrictEqual(detailInfo({ modelNum: 'M1', firmwareRevision: '2.1', hardwareRevision: 3 }), {
    model: 'M1', firmware: '2.1', hardware: '3',
  });
  assert.deepStrictEqual(detailInfo(null), { model: '', firmware: '', hardware: '' });
});

test('writeFor auto-lock: seconds with type 2, 0 is off, out of range is rejected', () => {
  assert.deepStrictEqual(writeFor('ttlock_autolock_time', 30), {
    method: 'POST', path: '/v3/lock/setAutoLockTime', params: { seconds: 30, type: 2 },
  });
  assert.strictEqual(writeFor('ttlock_autolock_time', 0).params.seconds, 0);
  assert.strictEqual(writeFor('ttlock_autolock_time', '1800').params.seconds, 1800);
  for (const bad of [-1, 1801, 1.5, 'x', undefined]) assert.throws(() => writeFor('ttlock_autolock_time', bad), /Auto-lock time/, String(bad));
});

test('writeFor updateSetting: sound 6, volume 8, privacy 2, tamper 3 with changeType 2', () => {
  assert.deepStrictEqual(writeFor('ttlock_lock_sound', true).params, { type: 6, value: 1, changeType: 2 });
  assert.deepStrictEqual(writeFor('ttlock_lock_sound', false).params, { type: 6, value: 2, changeType: 2 });
  assert.deepStrictEqual(writeFor('ttlock_sound_volume', 5).params, { type: 8, value: 5, changeType: 2 });
  assert.deepStrictEqual(writeFor('ttlock_privacy_lock', 'on').params, { type: 2, value: 1, changeType: 2 });
  assert.deepStrictEqual(writeFor('ttlock_tamper_alert', 'off').params, { type: 3, value: 2, changeType: 2 });
  for (const id of ['ttlock_lock_sound', 'ttlock_sound_volume', 'ttlock_privacy_lock', 'ttlock_tamper_alert']) {
    const call = writeFor(id, id === 'ttlock_sound_volume' ? 2 : true);
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.path, '/v3/lock/updateSetting');
  }
});

test('writeFor: invalid volume and on/off values are rejected, unknown capabilities too', () => {
  for (const bad of [0, 6, 2.5, 'loud']) assert.throws(() => writeFor('ttlock_sound_volume', bad), /volume/, String(bad));
  assert.throws(() => writeFor('ttlock_lock_sound', 'maybe'), /on\/off/);
  assert.throws(() => writeFor('ttlock_lock_sound', undefined), /on\/off/);
  assert.throws(() => writeFor('locked', true), /Unknown setting/);
});

test('writeFor passage mode: 1 on / 2 off, keeps autoUnlock and the cyclic config, JSON-encodes it', () => {
  const cyclic = [{ isAllDay: 2, startTime: 480, endTime: 960, weekDays: [1, 2] }];
  assert.deepStrictEqual(writeFor('ttlock_passage_mode', true, { autoUnlock: 1, cyclicConfig: cyclic }), {
    method: 'POST',
    path: '/v3/lock/configurePassageMode',
    params: {
      passageMode: 1, autoUnlock: 1, type: 2, cyclicConfig: JSON.stringify(cyclic),
    },
  });
  const off = writeFor('ttlock_passage_mode', false, { autoUnlock: 2, cyclicConfig: [] });
  assert.strictEqual(off.params.passageMode, 2);
  assert.strictEqual(off.params.autoUnlock, 2);
  assert.strictEqual(off.params.cyclicConfig, '[]');
  // no current config: auto-unlock off, empty schedule
  const bare = writeFor('ttlock_passage_mode', 'on');
  assert.deepStrictEqual(bare.params, {
    passageMode: 1, autoUnlock: 2, type: 2, cyclicConfig: '[]',
  });
});

test('normalizePassageConfig: accepts the documented field names, a JSON string, and the detail as fallback', () => {
  assert.deepStrictEqual(normalizePassageConfig({ passageMode: 1, autoUnlock: 1, cyclicConfig: [{ weekDays: [1] }] }), {
    autoUnlock: 1, cyclicConfig: [{ weekDays: [1] }],
  });
  assert.deepStrictEqual(normalizePassageConfig({ autoUnlock: 2, cyclicConfig: '[{"weekDays":[3]}]' }), {
    autoUnlock: 2, cyclicConfig: [{ weekDays: [3] }],
  });
  assert.deepStrictEqual(normalizePassageConfig({ cyclicConfig: 'not json' }, { passageModeAutoUnlock: 1 }), { autoUnlock: 1, cyclicConfig: [] });
  assert.deepStrictEqual(normalizePassageConfig({ autoUnlock: 2 }, { passageModeAutoUnlock: 1 }).autoUnlock, 2);
  assert.deepStrictEqual(normalizePassageConfig(null), { autoUnlock: 2, cyclicConfig: [] });
  assert.deepStrictEqual(normalizePassageConfig(undefined, undefined), { autoUnlock: 2, cyclicConfig: [] });
});

test('passageScheduleWrite: passage mode on with one cyclic entry', () => {
  const call = passageScheduleWrite({
    weekDays: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 1020, autoUnlock: true,
  });
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.path, '/v3/lock/configurePassageMode');
  assert.deepStrictEqual({ ...call.params, cyclicConfig: JSON.parse(call.params.cyclicConfig) }, {
    passageMode: 1,
    autoUnlock: 1,
    type: 2,
    cyclicConfig: [{
      isAllDay: 2, startTime: 480, endTime: 1020, weekDays: [1, 2, 3, 4, 5],
    }],
  });
  assert.strictEqual(passageScheduleWrite({
    weekDays: [7], startMinutes: 0, endMinutes: 60, autoUnlock: false,
  }).params.autoUnlock, 2);
});
