'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The Homey runtime is not installed in node_modules: stub the `homey` module with a minimal Device base.
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { Device: class {}, Driver: class {}, App: class {} };
  return originalLoad.call(this, request, ...rest);
};
const LockDevice = require('../drivers/lock/device');
Module._load = originalLoad;

const DOOR_SENSOR = (1n << 13n).toString(16);
const LOCK_DATE = Date.UTC(2026, 9, 26, 12, 30, 15);

// A LockDevice without the Homey runtime: capabilities and store in plain objects, triggers and timers recorded.
function makeDevice({ featureValue = '15', capabilities, settings: initialSettings = {} } = {}) {
  const device = Object.create(LockDevice.prototype);
  const caps = new Map((capabilities || [
    'locked', 'measure_battery', 'alarm_battery', 'measure_signal_strength', 'alarm_tamper', 'alarm_generic',
    'ttlock_last_user', 'ttlock_last_method', 'ttlock_last_event_time',
  ]).map(id => [id, null]));
  const store = { featureValue, hasGateway: 1 };
  const fired = [];
  const timers = [];
  const availability = [];
  const settings = { reset_tamper_seconds: 60, ...initialSettings };
  const listeners = new Map();
  const options = new Map();
  const calls = [];
  Object.assign(device, {
    settings,
    listeners,
    options,
    calls,
    caps,
    store,
    fired,
    timers,
    availability,
    reachable: true,
    listCache: {},
    lockId: 5,
    error: () => {},
    log: () => {},
    answer: () => ({}), // tests replace this to script the cloud
    getData: () => ({ lockId: 5 }),
    hasCapability: id => caps.has(id),
    addCapability: async id => { caps.set(id, null); },
    removeCapability: async id => { caps.delete(id); },
    getCapabilityValue: id => caps.get(id),
    setCapabilityValue: async (id, value) => {
      if (!caps.has(id)) throw new Error(`no capability ${id}`);
      caps.set(id, value);
    },
    getStoreValue: key => store[key],
    setStoreValue: async (key, value) => { store[key] = value; },
    getSetting: key => settings[key],
    getSettings: () => ({ ...settings }),
    setSettings: async values => { Object.assign(settings, values); },
    setCapabilityOptions: async (id, value) => { options.set(id, value); },
    registerCapabilityListener: (id, fn) => { listeners.set(id, fn); },
    setUnavailable: async message => { availability.push(['unavailable', message]); },
    setAvailable: async () => { availability.push(['available']); },
    homey: {
      app: { client: { request: async (method, path, params) => { calls.push({ method, path, params }); return device.answer(method, path, params); } } },
      __: key => key,
      clock: { getTimezone: () => 'Europe/Copenhagen' },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => {},
      flow: {
        getDeviceTriggerCard: id => ({ trigger: async (dev, tokens, state) => { fired.push({ id, tokens, state }); } }),
      },
    },
  });
  return device;
}

const ids = device => device.fired.map(f => f.id);

test('unlock record: locked state, last_* sensors, known user, triggers with tokens', async () => {
  const device = makeDevice();
  await device.applyRecord({
    recordType: 4, success: 1, username: 'Sepp', keyboardPwd: '123456', lockDate: LOCK_DATE, electricQuantity: 15,
  });
  assert.strictEqual(device.caps.get('locked'), false);
  assert.strictEqual(device.caps.get('ttlock_last_user'), 'Sepp');
  assert.strictEqual(device.caps.get('ttlock_last_method'), 'passcode');
  assert.strictEqual(device.caps.get('ttlock_last_event_time'), '2026-10-26 13:30:15');
  assert.strictEqual(device.caps.get('measure_battery'), 15);
  assert.strictEqual(device.caps.get('alarm_battery'), true);
  assert.deepStrictEqual(device.store.known_users, ['Sepp']);
  assert.strictEqual(device.store.last_record.recordType, 4);
  assert.deepStrictEqual(ids(device), ['ttlock_unlocked', 'ttlock_event']);
  const unlocked = device.fired[0];
  assert.deepStrictEqual(unlocked.state, { method: 'passcode' });
  assert.deepStrictEqual(unlocked.tokens, {
    method: 'passcode', user: 'Sepp', credential: '123456', time: '2026-10-26 13:30:15', description: 'Unlocked with passcode',
  });
});

test('lock and auto-lock records', async () => {
  const device = makeDevice();
  await device.applyRecord({ recordType: 45, lockDate: LOCK_DATE });
  assert.strictEqual(device.caps.get('locked'), true);
  assert.strictEqual(device.caps.get('ttlock_last_method'), 'auto');
  assert.strictEqual(device.caps.get('ttlock_last_user'), '');
  assert.deepStrictEqual(ids(device), ['ttlock_locked', 'ttlock_auto_locked', 'ttlock_event']);
});

test('failed attempt does not change state or last user', async () => {
  const device = makeDevice();
  device.caps.set('locked', true);
  await device.applyRecord({ recordType: 4, success: 0, username: 'Intruder', lockDate: LOCK_DATE });
  assert.strictEqual(device.caps.get('locked'), true);
  assert.strictEqual(device.caps.get('ttlock_last_user'), null);
  assert.deepStrictEqual(ids(device), ['ttlock_failed_attempt', 'ttlock_event']);
  assert.strictEqual(device.fired[1].tokens.success, false);
});

test('tamper sets alarm_tamper and clears it after 60 s', async () => {
  const device = makeDevice();
  await device.applyRecord({ recordType: 44, lockDate: LOCK_DATE });
  assert.strictEqual(device.caps.get('alarm_tamper'), true);
  assert.strictEqual(device.timers.length, 1);
  assert.strictEqual(device.timers[0].ms, 60000);
  assert.deepStrictEqual(ids(device), ['ttlock_tamper', 'ttlock_event']);
  await device.timers[0].fn();
  assert.strictEqual(device.caps.get('alarm_tamper'), false);
});

test('system locked sets alarm_generic until the next successful unlock', async () => {
  const device = makeDevice();
  await device.applyRecord({ recordType: 48, lockDate: LOCK_DATE });
  assert.strictEqual(device.caps.get('alarm_generic'), true);
  assert.ok(ids(device).includes('ttlock_system_locked'));
  await device.applyRecord({ recordType: 4, success: 0, lockDate: LOCK_DATE });
  assert.strictEqual(device.caps.get('alarm_generic'), true);
  await device.applyRecord({ recordType: 1, success: 1, lockDate: LOCK_DATE });
  assert.strictEqual(device.caps.get('alarm_generic'), false);
});

test('door sensor records only touch alarm_contact when the lock has it', async () => {
  const without = makeDevice();
  await without.applyRecord({ recordType: 31, lockDate: LOCK_DATE }); // no throw, no capability
  assert.ok(!without.caps.has('alarm_contact'));
  assert.deepStrictEqual(ids(without), ['ttlock_door_opened', 'ttlock_event']);

  const withSensor = makeDevice({ featureValue: DOOR_SENSOR });
  await withSensor.syncCapabilities();
  assert.ok(withSensor.caps.has('alarm_contact'));
  await withSensor.applyRecord({ recordType: 31, lockDate: LOCK_DATE });
  assert.strictEqual(withSensor.caps.get('alarm_contact'), true);
  await withSensor.applyRecord({ recordType: 30, lockDate: LOCK_DATE });
  assert.strictEqual(withSensor.caps.get('alarm_contact'), false);
});

test('door left open and unknown records fire their cards', async () => {
  const device = makeDevice();
  await device.applyRecord({ recordType: 64, lockDate: LOCK_DATE });
  await device.applyRecord({ recordType: 9999, lockDate: LOCK_DATE });
  assert.deepStrictEqual(ids(device), ['ttlock_door_left_open', 'ttlock_event', 'ttlock_event']);
  assert.strictEqual(device.fired[2].tokens.method, 'unknown');
});

test('syncCapabilities adds missing base capabilities and removes alarm_contact when the sensor is gone', async () => {
  const device = makeDevice({ capabilities: ['locked', 'measure_battery', 'alarm_contact'] });
  await device.syncCapabilities();
  assert.ok(device.caps.has('ttlock_last_user'));
  assert.ok(device.caps.has('alarm_tamper'));
  assert.ok(!device.caps.has('alarm_contact'));
  device.store.featureValue = DOOR_SENSOR;
  await device.syncCapabilities();
  assert.ok(device.caps.has('alarm_contact'));
});

test('known users: distinct, most recent first, capped at 50', async () => {
  const device = makeDevice();
  for (let i = 0; i < 55; i++) await device.applyRecord({ recordType: 1, success: 1, username: `user${i}`, lockDate: LOCK_DATE });
  await device.applyRecord({ recordType: 1, success: 1, username: 'user30', lockDate: LOCK_DATE });
  assert.strictEqual(device.store.known_users.length, 50);
  assert.strictEqual(device.store.known_users[0], 'user30');
  assert.strictEqual(new Set(device.store.known_users).size, 50);
});

test('offline/online triggers fire once per change', async () => {
  const device = makeDevice();
  device.handleError(Object.assign(new Error('The gateway is offline'), { code: -3002 }));
  device.handleError(Object.assign(new Error('The lock is offline'), { code: -3036 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(device.fired.map(f => [f.id, f.tokens]), [['ttlock_offline', { reason: 'The gateway is offline' }]]);
  await device.markOnline();
  await device.markOnline();
  assert.deepStrictEqual(ids(device), ['ttlock_offline', 'ttlock_online']);
  assert.strictEqual(device.fired[1].tokens.reason, 'device.reachable_again');
  assert.deepStrictEqual(device.availability.map(a => a[0]), ['unavailable', 'unavailable', 'available', 'available']);
});

test('login errors make the device unavailable without an offline trigger', async () => {
  const device = makeDevice();
  device.handleError(Object.assign(new Error('expired'), { code: 10004 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(device.fired, []);
  assert.strictEqual(device.availability[0][0], 'unavailable');
});

test('actionContext and isOnline', () => {
  const device = makeDevice({ featureValue: '15' });
  device.getAvailable = () => true;
  const ctx = device.actionContext();
  assert.strictEqual(ctx.tz, 'Europe/Copenhagen');
  assert.strictEqual(ctx.features.passcode, true);
  assert.strictEqual(ctx.features.card, false);
  assert.strictEqual(ctx.remote, true);
  assert.strictEqual(device.isOnline(), true);
  device.store.hasGateway = 0;
  assert.strictEqual(device.isOnline(), false);
  assert.strictEqual(device.actionContext().remote, false);
  device.store.featureValue = '';
  assert.strictEqual(device.actionContext().features, null);
});

test('getList caches for a minute, does not cache failures, invalidateLists clears', async () => {
  const device = makeDevice();
  let calls = 0;
  let fail = true;
  device.homey.app = {
    client: {
      request: async () => {
        calls++;
        if (fail) throw new Error('boom');
        return { list: [{ keyboardPwdId: calls }] };
      },
    },
  };
  await assert.rejects(device.getList('passcodes'), /boom/);
  await new Promise(resolve => setImmediate(resolve));
  fail = false;
  await device.getList('passcodes');
  await device.getList('passcodes');
  assert.strictEqual(calls, 2); // failure not cached, success cached
  device.invalidateLists();
  await device.getList('passcodes');
  assert.strictEqual(calls, 3);
});

// ---- phase 3: settings capabilities, detail, keypad -------------------------------------------

const bit = n => (1n << BigInt(n)).toString(16);
const ALL_SETTINGS_FEATURES = [4, 15, 22, 28, 30, 43].reduce((sum, n) => sum | (1n << BigInt(n)), 0n).toString(16);
const SETTING_CAPS = [
  'ttlock_autolock_time', 'ttlock_passage_mode', 'ttlock_lock_sound', 'ttlock_sound_volume', 'ttlock_privacy_lock', 'ttlock_tamper_alert',
];

test('tamper auto-clear uses the reset_tamper_seconds setting', async () => {
  const device = makeDevice({ settings: { reset_tamper_seconds: 90 } });
  await device.applyRecord({ recordType: 44, lockDate: LOCK_DATE });
  assert.strictEqual(device.timers[0].ms, 90000);
  device.settings.reset_tamper_seconds = 0; // invalid: falls back to the default
  await device.applyRecord({ recordType: 44, lockDate: LOCK_DATE });
  assert.strictEqual(device.timers[1].ms, 60000);
});

test('syncCapabilities adds the settings capabilities the features allow, registers one listener each', async () => {
  const device = makeDevice({ featureValue: ALL_SETTINGS_FEATURES });
  await device.syncCapabilities();
  for (const id of SETTING_CAPS) {
    assert.ok(device.caps.has(id), id);
    assert.ok(device.listeners.has(id), `listener ${id}`);
  }
  assert.ok(!device.caps.has('measure_battery.keypad'));
  const first = device.listeners.get('ttlock_lock_sound');
  await device.syncCapabilities();
  assert.strictEqual(device.listeners.get('ttlock_lock_sound'), first); // not registered twice

  device.store.featureValue = '15'; // autolock only
  await device.syncCapabilities();
  assert.deepStrictEqual(SETTING_CAPS.filter(id => device.caps.has(id)), ['ttlock_autolock_time']);
});

test('keypad capability is added with a title when the lock has bit 24 or 84', async () => {
  for (const n of [24, 84]) {
    const device = makeDevice({ featureValue: bit(n) });
    await device.syncCapabilities();
    assert.ok(device.caps.has('measure_battery.keypad'), `bit ${n}`);
    assert.strictEqual(device.options.get('measure_battery.keypad').title.en, 'Keypad battery');
  }
});

const DETAIL = {
  autoLockTime: -1, passageMode: 2, lockSound: 1, soundVolume: 3, privacyLock: 2, tamperAlert: 1,
  modelNum: 'SN-1', firmwareRevision: '1.2.3', hardwareRevision: '1.0',
};

test('applyDetail sets the capabilities the lock has, the info labels and caches the detail', async () => {
  const device = makeDevice({ featureValue: ALL_SETTINGS_FEATURES });
  await device.syncCapabilities();
  await device.applyDetail(DETAIL);
  assert.strictEqual(device.caps.get('ttlock_autolock_time'), 0);
  assert.strictEqual(device.caps.get('ttlock_passage_mode'), false);
  assert.strictEqual(device.caps.get('ttlock_lock_sound'), true);
  assert.strictEqual(device.caps.get('ttlock_sound_volume'), 3);
  assert.strictEqual(device.caps.get('ttlock_privacy_lock'), false);
  assert.strictEqual(device.caps.get('ttlock_tamper_alert'), true);
  assert.strictEqual(device.settings.model, 'SN-1');
  assert.strictEqual(device.settings.firmware, '1.2.3');
  assert.strictEqual(device.settings.hardware, '1.0');
  assert.match(device.settings.last_detail_sync, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.strictEqual(device.actionContext().detail, DETAIL);
  assert.deepStrictEqual(device.fired, []); // first reading: no passage mode trigger
});

test('applyDetail skips capabilities the lock does not have', async () => {
  const device = makeDevice({ featureValue: '15' }); // autolock only
  await device.syncCapabilities();
  await device.applyDetail(DETAIL);
  assert.strictEqual(device.caps.get('ttlock_autolock_time'), 0);
  assert.ok(!device.caps.has('ttlock_lock_sound'));
});

test('passage mode triggers fire when the detail shows a change, not on the first reading or without change', async () => {
  const device = makeDevice({ featureValue: bit(22) });
  await device.syncCapabilities();
  await device.applyDetail({ passageMode: 2 });
  await device.applyDetail({ passageMode: 2 });
  assert.deepStrictEqual(ids(device), []);
  await device.applyDetail({ passageMode: 1 });
  await device.applyDetail({ passageMode: 1 });
  await device.applyDetail({ passageMode: 2 });
  assert.deepStrictEqual(ids(device), ['ttlock_passage_mode_on', 'ttlock_passage_mode_off']);
  assert.strictEqual(device.caps.get('ttlock_passage_mode'), false);
});

test('writing a setting capability calls the cloud, then re-reads the detail', async () => {
  const device = makeDevice({ featureValue: ALL_SETTINGS_FEATURES });
  device.getAvailable = () => true;
  await device.syncCapabilities();
  device.answer = (method, path) => (path === '/v3/lock/detail' ? { lockSound: 2 } : { errcode: 0 });
  await device.listeners.get('ttlock_lock_sound')(false);
  assert.deepStrictEqual(device.calls, [
    { method: 'POST', path: '/v3/lock/updateSetting', params: { lockId: 5, type: 6, value: 2, changeType: 2 } },
    { method: 'GET', path: '/v3/lock/detail', params: { lockId: 5 } },
  ]);
  assert.strictEqual(device.caps.get('ttlock_lock_sound'), false);
});

test('writing a setting fails clearly without a gateway and reports cloud errors', async () => {
  const device = makeDevice({ featureValue: ALL_SETTINGS_FEATURES });
  await device.syncCapabilities();
  device.store.hasGateway = 0;
  await assert.rejects(device.listeners.get('ttlock_sound_volume')(4), /no gateway/);
  assert.strictEqual(device.calls.length, 0);

  device.store.hasGateway = 1;
  device.answer = () => { throw Object.assign(new Error('The gateway is offline'), { code: -3002 }); };
  await assert.rejects(device.listeners.get('ttlock_sound_volume')(4), /gateway is offline/);
  assert.strictEqual(device.availability[0][0], 'unavailable');
});

test('keypad battery: first keypad of wirelessKeypad/listByLock, only for locks with a keypad', async () => {
  const device = makeDevice({ featureValue: bit(24) });
  await device.syncCapabilities();
  device.answer = () => ({ list: [{ wirelessKeypadId: 1, electricQuantity: 64 }, { wirelessKeypadId: 2, electricQuantity: 10 }] });
  await device.refreshKeypad();
  assert.strictEqual(device.caps.get('measure_battery.keypad'), 64);
  assert.deepStrictEqual(device.calls, [{ method: 'GET', path: '/v3/wirelessKeypad/listByLock', params: { lockId: 5 } }]);

  const plain = makeDevice({ featureValue: '15' });
  await plain.syncCapabilities();
  await plain.refreshKeypad();
  assert.strictEqual(plain.calls.length, 0);
});

test('poll reads the list, detail and keypad; a failing detail does not stop the rest', async () => {
  const device = makeDevice({ featureValue: ALL_SETTINGS_FEATURES });
  device.getAvailable = () => true;
  await device.syncCapabilities();
  device.driver = { getLocks: async () => [{ lockId: 5, electricQuantity: 70 }] };
  device.answer = (method, path) => {
    if (path === '/v3/lock/detail') return { autoLockTime: 15 };
    if (path === '/v3/gateway/listByLock') return [{ rssi: -70 }];
    return {};
  };
  await device.poll();
  assert.strictEqual(device.caps.get('ttlock_autolock_time'), 15);
  assert.strictEqual(device.caps.get('measure_battery'), 70);
  assert.strictEqual(device.caps.get('measure_signal_strength'), -70);
  assert.deepStrictEqual(device.calls.map(c => c.path), ['/v3/lock/detail', '/v3/gateway/listByLock']);

  device.calls.length = 0;
  device.answer = (method, path) => {
    if (path === '/v3/lock/detail') throw new Error('boom');
    if (path === '/v3/gateway/listByLock') return [{ rssi: -60 }];
    return {};
  };
  await device.poll();
  assert.strictEqual(device.caps.get('measure_signal_strength'), -60);
});

test('unlock schedules a state query after the auto-lock time (no callback exists for auto-lock)', async () => {
  const device = makeDevice({
    capabilities: ['locked', 'measure_battery', 'alarm_battery', 'alarm_generic', 'ttlock_last_user', 'ttlock_last_method', 'ttlock_last_event_time', 'ttlock_autolock_time'],
  });
  device.caps.set('ttlock_autolock_time', 60);
  device.answer = (method, path) => (path === '/v3/lock/queryOpenState' ? { state: 0 } : {});
  await device.applyRecord({ recordType: 1, success: 1, username: 'Sepp', lockDate: LOCK_DATE });
  assert.strictEqual(device.caps.get('locked'), false);
  assert.strictEqual(device.timers.length, 1);
  assert.strictEqual(device.timers[0].ms, 65000);
  device.timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(device.caps.get('locked'), true);
  assert.ok(device.calls.some(call => call.path === '/v3/lock/queryOpenState'));
});

test('no auto-lock timer when auto-lock is off', async () => {
  const device = makeDevice({
    capabilities: ['locked', 'alarm_generic', 'ttlock_last_user', 'ttlock_last_method', 'ttlock_last_event_time', 'ttlock_autolock_time'],
  });
  device.caps.set('ttlock_autolock_time', 0);
  await device.applyRecord({ recordType: 1, success: 1, username: 'Sepp', lockDate: LOCK_DATE });
  assert.strictEqual(device.timers.length, 0);
});
