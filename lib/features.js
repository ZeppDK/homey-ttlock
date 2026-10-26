'use strict';

const { SETTINGS } = require('./settingsMap');

// Bit positions in the TTLock featureValue bitmask (docs/research/ttlock-cloud-api.md section 3).
const FEATURE_BITS = {
  passcode: 0,
  card: 1,
  fingerprint: 2,
  autolock: 4,
  gateway_unlock: 10,
  door_sensor: 13,
  remote_switch: 14,
  sound: 15,
  passage_mode: 22,
  keypad: 24,
  tamper: 28,
  privacy: 30,
  volume: 43,
  door_sensor_wireless: 50,
  wifi: 56,
  keypad_multi: 84,
};

// featureValue is a hex string whose bits go beyond 53, so BigInt is required.
function decodeFeatures(featureValue) {
  let value = 0n;
  try {
    const hex = String(featureValue || '').trim().replace(/^0x/i, '');
    if (hex) value = BigInt(`0x${hex}`);
  } catch (err) {
    value = 0n; // not a hex string: treat as "no features known"
  }
  const features = {};
  for (const [name, bit] of Object.entries(FEATURE_BITS)) {
    features[name] = ((value >> BigInt(bit)) & 1n) === 1n;
  }
  return features;
}

// "passcode, card, autolock" for the read-only device setting.
function featureList(features) {
  const names = Object.keys(features).filter(name => features[name]);
  return names.length ? names.join(', ') : 'none known';
}

// Capabilities every lock gets, and those that only some locks get.
// alarm_tamper and alarm_generic are always on: records 44 and 48 can come from any lock.
const ALWAYS_CAPABILITIES = [
  'locked',
  'measure_battery',
  'alarm_battery',
  'measure_signal_strength',
  'alarm_tamper',
  'alarm_generic',
  'ttlock_last_user',
  'ttlock_last_method',
  'ttlock_last_event_time',
];

// Optional capability -> feature names of which at least one must be set (bits 13/50 door sensor, 24/84 keypad).
const GATED_CAPABILITIES = {
  alarm_contact: ['door_sensor', 'door_sensor_wireless'],
  ...Object.fromEntries(Object.entries(SETTINGS).map(([id, setting]) => [id, [setting.feature]])),
  'measure_battery.keypad': ['keypad', 'keypad_multi'],
};
const OPTIONAL_CAPABILITIES = Object.keys(GATED_CAPABILITIES);

// Options for gated sub-capabilities, set when the capability is added (a sub-capability has no title of its own).
const CAPABILITY_OPTIONS = {
  'measure_battery.keypad': { title: { en: 'Keypad battery', da: 'Tastaturbatteri' } },
};

const hasAny = (features, names) => Boolean(features) && names.some(name => features[name]);

const hasDoorSensor = features => hasAny(features, GATED_CAPABILITIES.alarm_contact);
const hasKeypad = features => hasAny(features, GATED_CAPABILITIES['measure_battery.keypad']);

// Capabilities the device should have for these decoded features.
function capabilitiesFor(features) {
  const wanted = [...ALWAYS_CAPABILITIES];
  for (const [id, names] of Object.entries(GATED_CAPABILITIES)) {
    if (hasAny(features, names)) wanted.push(id);
  }
  return wanted;
}

module.exports = {
  FEATURE_BITS,
  OPTIONAL_CAPABILITIES,
  CAPABILITY_OPTIONS,
  decodeFeatures,
  featureList,
  capabilitiesFor,
  hasDoorSensor,
  hasKeypad,
};
