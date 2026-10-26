'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  decodeFeatures, featureList, capabilitiesFor, hasDoorSensor, hasKeypad, OPTIONAL_CAPABILITIES, CAPABILITY_OPTIONS,
} = require('../lib/features');

test('decodes low and high bits with BigInt', () => {
  // bits 0, 2, 4 = 0x15; bit 56 = 0x100000000000000 (above 2^53, needs BigInt)
  const f = decodeFeatures('100000000000015');
  assert.strictEqual(f.passcode, true);
  assert.strictEqual(f.card, false);
  assert.strictEqual(f.fingerprint, true);
  assert.strictEqual(f.autolock, true);
  assert.strictEqual(f.wifi, true);
  assert.strictEqual(f.gateway_unlock, false);
});

test('bit 56 (wifi) and bit 43 (volume)', () => {
  const wifi = decodeFeatures('100000000000000');
  assert.strictEqual(wifi.wifi, true);
  assert.strictEqual(wifi.passcode, false);
  assert.strictEqual(decodeFeatures((1n << 43n).toString(16)).volume, true);
});

test('each documented bit maps to its own flag', () => {
  const bits = {
    passcode: 0, card: 1, fingerprint: 2, autolock: 4, gateway_unlock: 10, door_sensor: 13, remote_switch: 14,
    sound: 15, passage_mode: 22, keypad: 24, tamper: 28, privacy: 30, volume: 43, door_sensor_wireless: 50, wifi: 56, keypad_multi: 84,
  };
  for (const [name, bit] of Object.entries(bits)) {
    const f = decodeFeatures((1n << BigInt(bit)).toString(16));
    assert.strictEqual(f[name], true, name);
    assert.strictEqual(Object.values(f).filter(Boolean).length, 1, name);
  }
});

test('empty, missing, 0x-prefixed and garbage input', () => {
  assert.ok(Object.values(decodeFeatures('')).every(v => v === false));
  assert.ok(Object.values(decodeFeatures(undefined)).every(v => v === false));
  assert.ok(Object.values(decodeFeatures('not hex')).every(v => v === false));
  assert.strictEqual(decodeFeatures('0x1').passcode, true);
});

test('featureList', () => {
  assert.strictEqual(featureList(decodeFeatures('15')), 'passcode, fingerprint, autolock');
  assert.strictEqual(featureList(decodeFeatures('0')), 'none known');
});

test('capabilitiesFor: alarm_contact only with a door sensor', () => {
  const without = capabilitiesFor(decodeFeatures('5')); // passcode, fingerprint
  assert.ok(!without.includes('alarm_contact'));
  const withSensor = capabilitiesFor(decodeFeatures((1n << 13n).toString(16)));
  assert.ok(withSensor.includes('alarm_contact'));
  assert.deepStrictEqual(withSensor.filter(id => id !== 'alarm_contact'), without);
});

test('capabilitiesFor: always includes the base set, tamper and system-locked alarms and the last_* sensors', () => {
  for (const features of [decodeFeatures(''), decodeFeatures('ffffffffffffffff'), null]) {
    const caps = capabilitiesFor(features);
    for (const id of [
      'locked', 'measure_battery', 'alarm_battery', 'measure_signal_strength', 'alarm_tamper', 'alarm_generic',
      'ttlock_last_user', 'ttlock_last_method', 'ttlock_last_event_time',
    ]) {
      assert.ok(caps.includes(id), id);
    }
  }
});

test('capabilitiesFor: every optional capability is gated (never in the always set)', () => {
  const base = capabilitiesFor(decodeFeatures(''));
  for (const id of OPTIONAL_CAPABILITIES) assert.ok(!base.includes(id), id);
});

const SETTINGS_BY_BIT = {
  ttlock_autolock_time: 4,
  ttlock_passage_mode: 22,
  ttlock_lock_sound: 15,
  ttlock_sound_volume: 43,
  ttlock_privacy_lock: 30,
  ttlock_tamper_alert: 28,
};
const bitFeatures = bit => decodeFeatures((1n << BigInt(bit)).toString(16));

test('capabilitiesFor: each settings capability appears only with its own feature bit', () => {
  const base = capabilitiesFor(decodeFeatures(''));
  for (const [id, bit] of Object.entries(SETTINGS_BY_BIT)) {
    assert.ok(!base.includes(id), `${id} without features`);
    const caps = capabilitiesFor(bitFeatures(bit));
    assert.ok(caps.includes(id), `${id} with bit ${bit}`);
    assert.deepStrictEqual(caps.filter(c => c !== id), base, `${id} adds nothing else`);
  }
  const all = capabilitiesFor(decodeFeatures('ffffffffffffffffffffff'));
  for (const id of Object.keys(SETTINGS_BY_BIT)) assert.ok(all.includes(id), id);
});

test('capabilitiesFor: door sensor bits 13 and 50, keypad bits 24 and 84', () => {
  for (const bit of [13, 50]) assert.ok(capabilitiesFor(bitFeatures(bit)).includes('alarm_contact'), `bit ${bit}`);
  for (const bit of [24, 84]) {
    const caps = capabilitiesFor(bitFeatures(bit));
    assert.ok(caps.includes('measure_battery.keypad'), `bit ${bit}`);
    assert.ok(!caps.includes('alarm_contact'));
  }
  assert.ok(!capabilitiesFor(decodeFeatures('')).includes('measure_battery.keypad'));
  assert.strictEqual(hasDoorSensor(bitFeatures(50)), true);
  assert.strictEqual(hasDoorSensor(bitFeatures(24)), false);
  assert.strictEqual(hasKeypad(bitFeatures(84)), true);
  assert.strictEqual(hasKeypad(null), false);
});

test('every optional capability is gated and capabilitiesFor(null) only returns the base set', () => {
  for (const id of [...Object.keys(SETTINGS_BY_BIT), 'alarm_contact', 'measure_battery.keypad']) {
    assert.ok(OPTIONAL_CAPABILITIES.includes(id), id);
  }
  assert.deepStrictEqual(capabilitiesFor(null), capabilitiesFor(decodeFeatures('')));
  assert.strictEqual(CAPABILITY_OPTIONS['measure_battery.keypad'].title.en, 'Keypad battery');
  assert.ok(CAPABILITY_OPTIONS['measure_battery.keypad'].title.da);
});
