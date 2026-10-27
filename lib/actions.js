'use strict';

// Flow action handlers. Pure functions: (client, lockId, args, opts) -> tokens, so they can be tested
// with a fake client. opts: { now (ms), tz (Homey timezone), features (decoded featureValue or
// null when unknown), remote (false when the lock has no gateway), detail (cached lock/detail or null) }.
//
// All cloud calls go through client.request. Gateway-bound writes use addType/deleteType/changeType 2.

const { describeRecord, recordFailed, recordTime } = require('./records');
const { toEpoch, optionalEpoch, parseTime } = require('./time');
const {
  SETTINGS, writeFor, passageScheduleWrite, normalizePassageConfig,
} = require('./settingsMap');

const HOUR_MS = 60 * 60 * 1000;
const ONE_TIME_MS = 6 * HOUR_MS; // one-time passcodes are valid 6 hours (docs section 6)
const PAGE_SIZE = 200;
const VIA_GATEWAY = 2;

const FEATURE_ERRORS = {
  passcode: 'This lock does not support passcodes',
  card: 'This lock does not support IC cards',
  fingerprint: 'This lock does not support fingerprints',
  autolock: 'This lock does not support changing the auto-lock time',
  passage_mode: 'This lock does not support passage mode',
  sound: 'This lock does not support turning the sound on or off',
  volume: 'This lock does not support changing the volume',
  privacy: 'This lock does not support the privacy lock',
  tamper: 'This lock does not support the tamper alert setting',
};
const NO_GATEWAY_ERROR = 'This lock has no gateway, so it cannot be controlled from Homey.';

function withDefaults(opts) {
  return { now: Date.now(), tz: undefined, features: null, remote: true, ...opts };
}

// Throws a clear error when the lock lacks the feature (only when the features are known) or has no gateway.
function guard(o, feature, gateway = false) {
  if (feature && o.features && o.features[feature] === false) throw new Error(FEATURE_ERRORS[feature]);
  if (gateway && o.remote === false) throw new Error(NO_GATEWAY_ERROR);
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function validCode(code) {
  const value = text(code);
  if (!/^\d{4,9}$/.test(value)) throw new Error('The passcode must be 4 to 9 digits');
  return value;
}

function chosenId(choice, what) {
  const id = choice && (choice.id !== undefined ? choice.id : choice);
  if (id === undefined || id === null || id === '' || typeof id === 'object') throw new Error(`Choose a ${what} first`);
  return id;
}

function period(args, o) {
  const start = toEpoch(args.start_date, args.start_time, o.tz);
  const end = toEpoch(args.end_date, args.end_time, o.tz);
  if (end <= start) throw new Error('The end must be after the start');
  return { start, end };
}

// keyboardPwd/get answers with keyboardPwd + keyboardPwdId (verified); add is assumed to return keyboardPwdId too (UNVERIFIED).
function passcodeTokens(res, code) {
  return {
    passcode: text(res.keyboardPwd !== undefined ? res.keyboardPwd : code),
    passcode_id: Number(res.keyboardPwdId) || 0,
  };
}

// Paged GET returning every item. Accepts { list: [...] } or a bare array.
async function listAll(client, path, params) {
  const items = [];
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const res = await client.request('GET', path, { ...params, pageNo, pageSize: PAGE_SIZE });
    const page = Array.isArray(res) ? res : ((res && res.list) || []);
    items.push(...page);
    if (page.length < PAGE_SIZE || (res && res.pages && pageNo >= res.pages)) break;
  }
  return items;
}

const listPasscodes = (client, lockId) => listAll(client, '/v3/lock/listKeyboardPwd', { lockId });
// UNVERIFIED: params (lockId, pageNo, pageSize) and item fields cardId/cardNumber/cardName of identityCard/list.
const listCards = (client, lockId) => listAll(client, '/v3/identityCard/list', { lockId });
// UNVERIFIED: params and item fields fingerprintId/fingerprintNumber/fingerprintName of fingerprint/list.
const listFingerprints = (client, lockId) => listAll(client, '/v3/fingerprint/list', { lockId });
// UNVERIFIED: response shape and item fields keyId/keyName/username/keyStatus of key/listByLock.
const listEkeys = (client, lockId) => listAll(client, '/v3/key/listByLock', { lockId });

const LISTS = {
  passcodes: listPasscodes, cards: listCards, fingerprints: listFingerprints, ekeys: listEkeys,
};

// ---- autocomplete choices -------------------------------------------------------------------

function matches(query, ...fields) {
  const needle = text(query).toLowerCase();
  return !needle || fields.some(field => text(field).toLowerCase().includes(needle));
}

const PASSCODE_TYPES = {
  1: 'one-time', 2: 'permanent', 3: 'period', 4: 'delete code',
};

function passcodeChoices(list, query) {
  return list
    .filter(item => matches(query, item.keyboardPwdName, item.keyboardPwd))
    .map(item => ({
      name: text(item.keyboardPwdName) || text(item.keyboardPwd),
      description: `Code ${text(item.keyboardPwd)}, ${PASSCODE_TYPES[item.keyboardPwdType] || 'cyclic'}`,
      id: item.keyboardPwdId,
    }));
}

function cardChoices(list, query) {
  return list
    .filter(item => matches(query, item.cardName, item.cardNumber))
    .map(item => ({
      name: text(item.cardName) || text(item.cardNumber),
      description: `Card ${text(item.cardNumber)}`,
      id: item.cardId,
    }));
}

function fingerprintChoices(list, query) {
  return list
    .filter(item => matches(query, item.fingerprintName, item.fingerprintNumber))
    .map(item => ({
      name: text(item.fingerprintName) || text(item.fingerprintNumber),
      description: `Fingerprint ${text(item.fingerprintNumber)}`.trim(),
      id: item.fingerprintId,
    }));
}

const KEY_STATUS = {
  110401: 'normal', 110402: 'pending', 110405: 'frozen', 110408: 'deleted', 110410: 'reset',
};

function ekeyChoices(list, query) {
  return list
    .filter(item => matches(query, item.keyName, item.username))
    .map(item => ({
      name: text(item.keyName) || text(item.username),
      description: [text(item.username), KEY_STATUS[item.keyStatus]].filter(Boolean).join(', '),
      id: item.keyId,
    }));
}

// Known usernames containing the query, plus the typed query itself so new names work.
function userChoices(known, query) {
  const typed = text(query);
  const choices = known.filter(name => matches(typed, name)).map(name => ({ name, id: name }));
  if (typed && !known.includes(typed)) choices.unshift({ name: typed, id: typed });
  return choices;
}

// ---- passcodes ------------------------------------------------------------------------------

async function passcodeOnetime(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passcode');
  const res = await client.request('POST', '/v3/keyboardPwd/get', {
    lockId, keyboardPwdType: 1, keyboardPwdName: text(args.name), startDate: o.now, endDate: o.now + ONE_TIME_MS,
  });
  return passcodeTokens(res);
}

async function passcodePeriod(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passcode');
  const { start, end } = period(args, o);
  const res = await client.request('POST', '/v3/keyboardPwd/get', {
    lockId, keyboardPwdType: 3, keyboardPwdName: text(args.name), startDate: start, endDate: end,
  });
  return passcodeTokens(res);
}

async function passcodePermanent(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passcode');
  const name = text(args.name);
  if (text(args.code)) {
    guard(o, 'passcode', true); // custom codes are written to the lock through the gateway
    const code = validCode(args.code);
    // UNVERIFIED: startDate now / endDate 0 for a permanent custom code (docs only say "startDate/endDate").
    const res = await client.request('POST', '/v3/keyboardPwd/add', {
      lockId, keyboardPwd: code, keyboardPwdName: name, keyboardPwdType: 2, startDate: o.now, endDate: 0, addType: VIA_GATEWAY,
    });
    return passcodeTokens(res, code);
  }
  // UNVERIFIED: whether endDate 0 is accepted for a permanent random code. Fallback if it is
  // rejected: endDate = o.now + 20 * 365 * 24 * HOUR_MS.
  const res = await client.request('POST', '/v3/keyboardPwd/get', {
    lockId, keyboardPwdType: 2, keyboardPwdName: name, startDate: o.now, endDate: 0,
  });
  return passcodeTokens(res);
}

async function passcodeCustomPeriod(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passcode', true);
  const code = validCode(args.code);
  const { start, end } = period(args, o);
  const res = await client.request('POST', '/v3/keyboardPwd/add', {
    lockId, keyboardPwd: code, keyboardPwdName: text(args.name), keyboardPwdType: 3, startDate: start, endDate: end, addType: VIA_GATEWAY,
  });
  return passcodeTokens(res, code);
}

async function passcodeDelete(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passcode', true);
  await client.request('POST', '/v3/keyboardPwd/delete', {
    lockId, keyboardPwdId: chosenId(args.passcode, 'passcode'), deleteType: VIA_GATEWAY,
  });
  return {};
}

async function passcodeSetEnd(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passcode', true);
  const id = chosenId(args.passcode, 'passcode');
  const end = toEpoch(args.end_date, args.end_time, o.tz);
  // The change call needs the start date too: take it from the current list (fresh, not the flow's stale copy).
  const existing = (await listPasscodes(client, lockId)).find(item => String(item.keyboardPwdId) === String(id));
  if (!existing) throw new Error('That passcode no longer exists');
  const start = Number(existing.startDate) || o.now; // UNVERIFIED: permanent codes (startDate 0) get start = now
  if (end <= start) throw new Error('The end must be after the start');
  await client.request('POST', '/v3/keyboardPwd/change', {
    lockId, keyboardPwdId: id, startDate: start, endDate: end, changeType: VIA_GATEWAY,
  });
  return {};
}

// UNVERIFIED: type 4 ("delete") is documented as "delete-all"; assumed to create a special code that
// wipes all passcodes when entered on the keypad, and that the call needs startDate/endDate (now .. +24 h).
async function passcodeClearAll(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passcode');
  if (args.confirm !== true) throw new Error('Tick "I understand" to confirm deleting all passcodes');
  const res = await client.request('POST', '/v3/keyboardPwd/get', {
    lockId, keyboardPwdType: 4, keyboardPwdName: 'Delete all passcodes', startDate: o.now, endDate: o.now + 24 * HOUR_MS,
  });
  return passcodeTokens(res);
}

// ---- IC cards and fingerprints --------------------------------------------------------------

async function cardAdd(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'card', true);
  const cardNumber = text(args.card_number);
  if (!cardNumber) throw new Error('Enter the card number');
  const end = optionalEpoch(args.end_date, args.end_time, o.tz, '23:59');
  if (end && end <= o.now) throw new Error('The end must be in the future');
  // The docs say start = end = 0 is permanent; with an end date the card is valid from now.
  // UNVERIFIED: the identityCard/add params (cardNumber, cardName, startDate, endDate, addType).
  await client.request('POST', '/v3/identityCard/add', {
    lockId, cardNumber, cardName: text(args.name), startDate: end ? o.now : 0, endDate: end, addType: VIA_GATEWAY,
  });
  return {};
}

async function cardDelete(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'card', true);
  // UNVERIFIED: the id parameter is named cardId.
  await client.request('POST', '/v3/identityCard/delete', {
    lockId, cardId: chosenId(args.card, 'card'), deleteType: VIA_GATEWAY,
  });
  return {};
}

async function fingerprintDelete(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'fingerprint', true);
  // UNVERIFIED: the id parameter is named fingerprintId.
  await client.request('POST', '/v3/fingerprint/delete', {
    lockId, fingerprintId: chosenId(args.fingerprint, 'fingerprint'), deleteType: VIA_GATEWAY,
  });
  return {};
}

// ---- eKeys (cloud only, no gateway needed) --------------------------------------------------

async function ekeySend(client, lockId, args, opts) {
  const o = withDefaults(opts);
  const username = text(args.username);
  if (!username) throw new Error('Enter the TTLock username of the receiver');
  const start = optionalEpoch(args.start_date, args.start_time, o.tz, '00:00');
  const end = optionalEpoch(args.end_date, args.end_time, o.tz, '23:59');
  if (end && end <= start) throw new Error('The end must be after the start');
  // UNVERIFIED: startDate = endDate = 0 means a permanent eKey.
  const res = await client.request('POST', '/v3/key/send', {
    lockId,
    receiverUsername: username,
    keyName: text(args.name) || username,
    startDate: start,
    endDate: end,
    remoteEnable: args.remote ? 1 : 2,
  });
  return { key_id: Number(res.keyId) || 0 };
}

async function ekeyFreeze(client, lockId, args) {
  await client.request('POST', '/v3/key/freeze', { keyId: chosenId(args.ekey, 'eKey') });
  return {};
}

async function ekeyUnfreeze(client, lockId, args) {
  await client.request('POST', '/v3/key/unfreeze', { keyId: chosenId(args.ekey, 'eKey') });
  return {};
}

// ---- records --------------------------------------------------------------------------------

// Token `events`: one line per record, newest first: "time  description - user".
async function recentEvents(client, lockId, args, opts) {
  const o = withDefaults(opts);
  const count = Math.min(20, Math.max(1, Math.round(Number(args.count)) || 5));
  const res = await client.request('GET', '/v3/lockRecord/list', { lockId, pageNo: 1, pageSize: count });
  const items = Array.isArray(res) ? res : ((res && res.list) || []);
  const lines = items
    .slice(0, count)
    .sort((a, b) => (Number(b.lockDate) || 0) - (Number(a.lockDate) || 0))
    .map(record => {
      const info = describeRecord(record.recordType);
      const failed = recordFailed(record) ? ' (failed)' : '';
      const user = text(record.username);
      return `${recordTime(record, o.tz)}  ${info.description}${failed}${user ? ` - ${user}` : ''}`;
    });
  return { events: lines.join('\n') };
}

// ---- lock settings (auto-lock, passage mode, sound, volume, privacy, tamper) ----------------------

// Writes one setting capability through the gateway; used by the capability listeners and the flow
// actions. The caller re-reads lock/detail afterwards to confirm. A passage mode toggle first reads the
// current configuration so the schedule and auto-unlock stay as they are (opts.detail is the fallback
// for autoUnlock).
async function setLockSetting(client, lockId, capabilityId, value, opts) {
  const o = withDefaults(opts);
  const setting = SETTINGS[capabilityId];
  if (!setting) throw new Error(`Unknown setting ${capabilityId}`);
  guard(o, setting.feature, true);
  let current;
  if (capabilityId === 'ttlock_passage_mode') {
    const config = await client.request('GET', '/v3/lock/getPassageModeConfiguration', { lockId });
    current = normalizePassageConfig(config, o.detail);
  }
  const { method, path: urlPath, params } = writeFor(capabilityId, value, current);
  await client.request(method, urlPath, { lockId, ...params });
  return {};
}

const setAutolock = (client, lockId, args, opts) => setLockSetting(client, lockId, 'ttlock_autolock_time', args.seconds, opts);
const setPassageMode = (client, lockId, args, opts) => setLockSetting(client, lockId, 'ttlock_passage_mode', args.mode, opts);
const setSound = (client, lockId, args, opts) => setLockSetting(client, lockId, 'ttlock_lock_sound', args.state, opts);
const setVolume = (client, lockId, args, opts) => setLockSetting(client, lockId, 'ttlock_sound_volume', args.volume, opts);
const setPrivacy = (client, lockId, args, opts) => setLockSetting(client, lockId, 'ttlock_privacy_lock', args.state, opts);

// The day_1..day_7 checkboxes (Monday..Sunday) -> the ticked weekdays as numbers 1..7.
function weekDays(args) {
  const days = [1, 2, 3, 4, 5, 6, 7].filter(day => args[`day_${day}`] === true);
  if (!days.length) throw new Error('Choose at least one weekday');
  return days;
}

function minutesOfDay(timeText) {
  const { hour, minute } = parseTime(timeText);
  return hour * 60 + minute;
}

async function setPassageSchedule(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, 'passage_mode', true);
  const startMinutes = minutesOfDay(args.start_time);
  const endMinutes = minutesOfDay(args.end_time);
  if (endMinutes <= startMinutes) throw new Error('The end must be after the start');
  const { method, path: urlPath, params } = passageScheduleWrite({
    weekDays: weekDays(args), startMinutes, endMinutes, autoUnlock: args.auto_unlock === true,
  });
  await client.request(method, urlPath, { lockId, ...params });
  return {};
}

// POST /v3/lock/updateDate {lockId, date} is accepted by the cloud (errcode 0, verified on a real lock 2026-10-27).
// The docs only name gateway/adjustLockDatetime, so whether the lock clock actually moved is UNVERIFIED.
async function syncClock(client, lockId, args, opts) {
  const o = withDefaults(opts);
  guard(o, null, true);
  try {
    await client.request('POST', '/v3/lock/updateDate', { lockId, date: o.now });
  } catch (err) {
    const wrapped = new Error(`Could not set the lock clock: ${err.message}`);
    wrapped.code = err.code;
    throw wrapped;
  }
  return {};
}

module.exports = {
  LISTS,
  listPasscodes,
  passcodeChoices,
  cardChoices,
  fingerprintChoices,
  ekeyChoices,
  userChoices,
  passcodeOnetime,
  passcodePeriod,
  passcodePermanent,
  passcodeCustomPeriod,
  passcodeDelete,
  passcodeSetEnd,
  passcodeClearAll,
  cardAdd,
  cardDelete,
  fingerprintDelete,
  ekeySend,
  ekeyFreeze,
  ekeyUnfreeze,
  recentEvents,
  setLockSetting,
  setAutolock,
  setPassageMode,
  setPassageSchedule,
  setSound,
  setVolume,
  setPrivacy,
  syncClock,
};
