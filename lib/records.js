'use strict';

const { formatDateTime } = require('./time');

// recordType -> what happened (docs/research/ttlock-cloud-api.md section 5).
// action: 'unlock' | 'lock' | 'event'. 45 (auto lock) counts as a lock.
const u = (method, description) => ({ action: 'unlock', method, description });
const l = (method, description) => ({ action: 'lock', method, description });
const e = (method, description) => ({ action: 'event', method, description });

const RECORDS = {
  // Unlocks
  1: u('app', 'Unlocked with app'),
  4: u('passcode', 'Unlocked with passcode'),
  7: u('card', 'Unlocked with IC card'),
  8: u('fingerprint', 'Unlocked with fingerprint'),
  9: u('wrist_strap', 'Unlocked with wrist strap'),
  10: u('key', 'Unlocked with mechanical key'),
  12: u('gateway', 'Unlocked via gateway'),
  32: u('inside', 'Unlocked from inside'),
  46: u('key', 'Unlocked with unlock key'),
  49: u('card', 'Unlocked with hotel card'),
  55: u('remote', 'Unlocked with remote control'),
  57: u('qr', 'Unlocked with QR code'),
  63: u('auto', 'Passage mode auto-unlock'),
  67: u('face', 'Unlocked with face'),
  75: u('app', 'Unlocked with app authorization'),
  76: u('remote', 'Unlocked with remote authorization'),
  84: u('palm', 'Unlocked with palm vein'),
  85: u('palm', 'Unlocked with palm vein'),
  92: u('passcode', 'Unlocked with admin passcode'),
  // Locks
  11: l('app', 'Locked with app'),
  33: l('fingerprint', 'Locked with fingerprint'),
  34: l('passcode', 'Locked with passcode'),
  35: l('card', 'Locked with IC card'),
  36: l('key', 'Locked with mechanical key'),
  45: l('auto', 'Auto lock'),
  47: l('key', 'Locked with lock key'),
  61: l('qr', 'Locked with QR code'),
  69: l('face', 'Locked with face'),
  86: l('palm', 'Locked with palm vein'),
  // Events
  5: e('parking', 'Parking lock event'),
  6: e('parking', 'Parking lock event'),
  29: e('lock', 'Force applied to lock'),
  30: e('door_sensor', 'Door closed'),
  31: e('door_sensor', 'Door opened'),
  37: e('shutter', 'Shutter event'),
  42: e('mail', 'Mail event'),
  43: e('mail', 'Mail event'),
  44: e('tamper', 'Tamper alert'),
  48: e('lock', 'System locked (too many wrong attempts)'),
  50: e('lock', 'High temperature alarm'),
  51: e('card', 'Deleted IC card used'),
  52: e('lock', 'Deadlock event'),
  53: e('lock', 'Deadlock event'),
  54: e('parking', 'Parking lock event'),
  58: e('qr', 'QR code unlock failed'),
  59: e('lock', 'Double locked'),
  60: e('lock', 'Cancelled'),
  62: e('qr', 'QR code lock failed'),
  64: e('door_sensor', 'Door not closed alarm'),
  65: e('lock', 'Failed to unlock'),
  66: e('lock', 'Failed to lock'),
  68: e('face', 'Face unlock failed'),
  71: e('face', 'Face lock failed'),
  88: e('palm', 'Palm vein failed'),
  91: e('card', 'IC card unlock failed'),
};
for (let type = 77; type <= 83; type++) RECORDS[type] = e('dual_auth', 'Dual authentication step');

function describeRecord(recordType) {
  return RECORDS[Number(recordType)] || { action: 'event', method: 'unknown', description: `Unknown record type ${recordType}` };
}

// Webhook body (object or form-encoded string) -> { lockId, records[] } or null.
// `records` is a JSON string inside the form body.
function parseCallback(body) {
  let data = body;
  if (typeof data === 'string') data = Object.fromEntries(new URLSearchParams(data));
  if (!data || typeof data !== 'object' || data.lockId === undefined) return null;

  let records = data.records;
  try {
    if (typeof records === 'string') records = JSON.parse(records);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(records)) return null;
  return { lockId: String(data.lockId), records };
}

// Values of the ttlock_last_method capability and the flow dropdowns. Anything else becomes 'unknown'.
const METHODS = [
  'app', 'passcode', 'card', 'fingerprint', 'key', 'remote', 'auto', 'gateway', 'inside', 'qr', 'face', 'palm', 'wrist_strap', 'unknown',
];

function normalizeMethod(method) {
  return METHODS.includes(method) ? method : 'unknown';
}

// recordTypes that are failed attempts even when `success` is missing (docs section 5).
const FAILED_TYPES = [58, 65, 68, 88, 91];

// UNVERIFIED: success=0 is assumed to mean a failed attempt for every record type.
function recordFailed(record) {
  const { success } = record;
  return success !== undefined && success !== null && success !== '' && Number(success) === 0;
}

function isFailedAttempt(record) {
  return recordFailed(record) || FAILED_TYPES.includes(Number(record.recordType));
}

// Time of the record as 'YYYY-MM-DD HH:mm:ss'. With a timezone the lock's own clock (lockDate) is
// shown in it; without one serverDate is preferred. Either one falls back to the other.
// serverDate is preferred: the lock's own clock drifts (seen 2 minutes ahead on a real lock).
function recordTime(record, tz) {
  const ms = Number(record.serverDate) || Number(record.lockDate);
  return formatDateTime(ms, tz);
}

// Everything the flow triggers and capabilities need from one record.
function recordToTokens(record, info, tz) {
  const recordType = Number(record.recordType);
  return {
    method: normalizeMethod(info.method),
    user: String(record.username || ''),
    credential: String(record.keyboardPwd || ''),
    time: recordTime(record, tz),
    description: info.description,
    record_type: Number.isFinite(recordType) ? recordType : 0,
    success: !recordFailed(record),
  };
}

// Tokens declared by each trigger card in drivers/lock/driver.flow.compose.json.
const TRIGGER_TOKENS = {
  ttlock_unlocked: ['method', 'user', 'credential', 'time', 'description'],
  ttlock_locked: ['method', 'user', 'credential', 'time', 'description'],
  ttlock_auto_locked: ['time'],
  ttlock_failed_attempt: ['method', 'description'],
  ttlock_system_locked: [],
  ttlock_tamper: [],
  ttlock_door_opened: [],
  ttlock_door_closed: [],
  ttlock_door_left_open: [],
  ttlock_event: ['record_type', 'description', 'method', 'user', 'success', 'time'],
};

function tokensForTrigger(cardId, tokens) {
  const out = {};
  for (const name of TRIGGER_TOKENS[cardId] || []) out[name] = tokens[name];
  return out;
}

// Trigger cards to fire for a record, most specific first, ttlock_event always last.
function recordTriggers(record, info) {
  const type = Number(record.recordType);
  const ids = [];
  if (isFailedAttempt(record)) {
    ids.push('ttlock_failed_attempt');
  } else if (info.action === 'unlock') {
    ids.push('ttlock_unlocked');
  } else if (info.action === 'lock') {
    ids.push('ttlock_locked'); // auto locks fire this too (method 'auto') plus their own card
    if (type === 45) ids.push('ttlock_auto_locked');
  }
  if (type === 48) ids.push('ttlock_system_locked');
  if (type === 44) ids.push('ttlock_tamper');
  if (type === 31) ids.push('ttlock_door_opened');
  if (type === 30) ids.push('ttlock_door_closed');
  if (type === 64) ids.push('ttlock_door_left_open');
  ids.push('ttlock_event');
  return ids;
}

// Run listener of the unlocked/locked triggers: dropdown 'any' or the method of the record.
function methodMatches(argMethod, stateMethod) {
  return argMethod === 'any' || argMethod === stateMethod;
}

// What a record means for a door sensor device: { contact } (alarm_contact: true = open) for the door
// records 31 (opened) and 30 (closed), null for everything else. The record's electricQuantity is not
// forwarded: it is not documented whose battery it is (the lock's is assumed), so the sensor battery
// comes from the poll only.
function doorSensorUpdate(record) {
  const type = Number(record && record.recordType);
  if (type === 31) return { contact: true };
  if (type === 30) return { contact: false };
  return null;
}

// Most recent first, distinct, at most `limit` names (device store `known_users`).
function addKnownUser(list, name, limit = 50) {
  const user = String(name || '').trim();
  if (!user) return list;
  return [user, ...list.filter(item => item !== user)].slice(0, limit);
}

module.exports = {
  describeRecord,
  parseCallback,
  METHODS,
  FAILED_TYPES,
  normalizeMethod,
  recordFailed,
  isFailedAttempt,
  recordTime,
  recordToTokens,
  tokensForTrigger,
  recordTriggers,
  methodMatches,
  doorSensorUpdate,
  addKnownUser,
};
