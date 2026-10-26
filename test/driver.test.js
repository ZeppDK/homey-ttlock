'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { Device: class {}, Driver: class {}, App: class {} };
  return originalLoad.call(this, request, ...rest);
};
const LockDriver = require('../drivers/lock/driver');
Module._load = originalLoad;

const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drivers', 'lock', 'driver.flow.compose.json'), 'utf8'));

// Driver with a fake flow manager that remembers which cards got run/autocomplete listeners.
function makeDriver() {
  const registered = { run: new Map(), autocomplete: new Map() };
  const card = id => ({
    registerRunListener: fn => registered.run.set(id, fn),
    registerArgumentAutocompleteListener: (arg, fn) => registered.autocomplete.set(`${id}.${arg}`, fn),
  });
  const driver = Object.create(LockDriver.prototype);
  driver.homey = {
    app: { client: { request: async () => ({ keyboardPwd: '123456', keyboardPwdId: 1 }) } },
    flow: { getDeviceTriggerCard: card, getConditionCard: card, getActionCard: card },
  };
  return { driver, registered };
}

test('driver registers a run listener for every action and condition, and for the method triggers', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  for (const type of ['conditions', 'actions']) {
    for (const cardDef of flow[type]) assert.ok(registered.run.has(cardDef.id), `${type}: ${cardDef.id}`);
  }
  assert.ok(registered.run.has('ttlock_unlocked'));
  assert.ok(registered.run.has('ttlock_locked'));
});

test('every autocomplete arg in the flow JSON has a listener and vice versa', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  const declared = [];
  for (const type of ['conditions', 'actions']) {
    for (const cardDef of flow[type]) {
      for (const arg of cardDef.args || []) if (arg.type === 'autocomplete') declared.push(`${cardDef.id}.${arg.name}`);
    }
  }
  assert.deepStrictEqual([...registered.autocomplete.keys()].sort(), declared.sort());
});

test('trigger run listener matches the method dropdown', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  const run = registered.run.get('ttlock_unlocked');
  assert.strictEqual(await run({ method: 'any' }, { method: 'card' }), true);
  assert.strictEqual(await run({ method: 'card' }, { method: 'card' }), true);
  assert.strictEqual(await run({ method: 'app' }, { method: 'card' }), false);
});

test('action run listener passes args, lock id and context to the handler and clears the list cache', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  let invalidated = 0;
  const device = {
    lockId: 5,
    actionContext: () => ({ now: 1000, tz: 'UTC', features: null, remote: true }),
    invalidateLists: () => { invalidated++; },
    handleError: () => {},
  };
  const tokens = await registered.run.get('ttlock_passcode_onetime')({ device, name: 'Guest' });
  assert.deepStrictEqual(tokens, { passcode: '123456', passcode_id: 1 });
  assert.strictEqual(invalidated, 1);
  await assert.rejects(registered.run.get('ttlock_passcode_delete')({ device }), /Choose a passcode/);
  assert.strictEqual(invalidated, 2);
});

test('conditions evaluate against the device', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  const caps = { ttlock_last_method: 'card', ttlock_last_user: 'Anna', measure_battery: 18 };
  const device = {
    isOnline: () => true,
    getCapabilityValue: id => caps[id],
    getStoreValue: () => ['Anna', 'Bo'],
    getList: async () => [{ keyboardPwdId: 7 }],
  };
  assert.strictEqual(await registered.run.get('ttlock_is_online')({ device }), true);
  assert.strictEqual(await registered.run.get('ttlock_last_method_is')({ device, method: 'card' }), true);
  assert.strictEqual(await registered.run.get('ttlock_last_method_is')({ device, method: 'app' }), false);
  assert.strictEqual(await registered.run.get('ttlock_last_user_is')({ device, user: { id: 'anna', name: 'anna' } }), true);
  assert.strictEqual(await registered.run.get('ttlock_last_user_is')({ device, user: { id: 'Bo', name: 'Bo' } }), false);
  assert.strictEqual(await registered.run.get('ttlock_passcode_exists')({ device, passcode: { id: 7 } }), true);
  assert.strictEqual(await registered.run.get('ttlock_passcode_exists')({ device, passcode: { id: 8 } }), false);
  assert.strictEqual(await registered.run.get('ttlock_battery_below')({ device, level: 20 }), true);
  assert.strictEqual(await registered.run.get('ttlock_battery_below')({ device, level: 18 }), false);
  caps.measure_battery = null;
  assert.strictEqual(await registered.run.get('ttlock_battery_below')({ device, level: 20 }), false);

  const users = await registered.autocomplete.get('ttlock_last_user_is.user')('an', { device });
  assert.deepStrictEqual(users.map(u => u.name), ['an', 'Anna']);
  const codes = await registered.autocomplete.get('ttlock_passcode_exists.passcode')('', { device });
  assert.strictEqual(codes.length, 1);
});

// ---- phase 3 ----------------------------------------------------------------------------------

test('setting actions re-read lock/detail after writing, the clock action does not', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  const requests = [];
  driver.homey.app.client.request = async (method, urlPath, params) => { requests.push([method, urlPath, params]); return {}; };
  let refreshed = 0;
  const device = {
    lockId: 5,
    actionContext: () => ({ now: 1000, tz: 'UTC', features: null, remote: true }),
    invalidateLists: () => {},
    handleError: () => {},
    refreshDetail: async () => { refreshed++; },
  };
  await registered.run.get('ttlock_set_autolock')({ device, seconds: 10 });
  await registered.run.get('ttlock_set_sound')({ device, state: 'on' });
  await registered.run.get('ttlock_set_volume')({ device, volume: 2 });
  await registered.run.get('ttlock_set_privacy')({ device, state: 'off' });
  await registered.run.get('ttlock_set_passage_mode')({ device, mode: 'on' });
  await registered.run.get('ttlock_set_passage_schedule')({
    device, day_1: true, start_time: '08:00', end_time: '09:00',
  });
  assert.strictEqual(refreshed, 6);
  await registered.run.get('ttlock_sync_clock')({ device });
  assert.strictEqual(refreshed, 6);
  assert.deepStrictEqual(requests.map(r => r[1]), [
    '/v3/lock/setAutoLockTime',
    '/v3/lock/updateSetting',
    '/v3/lock/updateSetting',
    '/v3/lock/updateSetting',
    '/v3/lock/getPassageModeConfiguration',
    '/v3/lock/configurePassageMode',
    '/v3/lock/configurePassageMode',
    '/v3/lock/updateDate',
  ]);
});

test('a failing setting action reports the error to the device and rethrows, without re-reading the detail', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  driver.homey.app.client.request = async () => { throw Object.assign(new Error('The gateway is busy'), { code: -3003 }); };
  const errors = [];
  let refreshed = 0;
  const device = {
    lockId: 5,
    actionContext: () => ({ now: 1000, remote: true }),
    invalidateLists: () => {},
    handleError: err => errors.push(err.message),
    refreshDetail: async () => { refreshed++; },
  };
  await assert.rejects(registered.run.get('ttlock_set_autolock')({ device, seconds: 10 }), /gateway is busy/);
  assert.deepStrictEqual(errors, ['The gateway is busy']);
  assert.strictEqual(refreshed, 0);
});

test('passage mode condition follows the capability', async () => {
  const { driver, registered } = makeDriver();
  await driver.onInit();
  const caps = { ttlock_passage_mode: true };
  const device = { getCapabilityValue: id => caps[id] };
  assert.strictEqual(await registered.run.get('ttlock_passage_mode_is')({ device }), true);
  caps.ttlock_passage_mode = false;
  assert.strictEqual(await registered.run.get('ttlock_passage_mode_is')({ device }), false);
  caps.ttlock_passage_mode = null;
  assert.strictEqual(await registered.run.get('ttlock_passage_mode_is')({ device }), false);
});

test('flow JSON declares the phase 3 cards and every arg of the set actions is used by the handlers', () => {
  const byId = type => Object.fromEntries(flow[type].map(card => [card.id, card]));
  const actionsById = byId('actions');
  for (const id of [
    'ttlock_set_autolock', 'ttlock_set_passage_mode', 'ttlock_set_passage_schedule', 'ttlock_set_sound',
    'ttlock_set_volume', 'ttlock_set_privacy', 'ttlock_sync_clock',
  ]) assert.ok(actionsById[id], id);
  assert.ok(byId('triggers').ttlock_passage_mode_on);
  assert.ok(byId('triggers').ttlock_passage_mode_off);
  assert.ok(byId('conditions').ttlock_passage_mode_is);
  const schedule = actionsById.ttlock_set_passage_schedule;
  assert.deepStrictEqual(schedule.args.filter(a => a.type === 'checkbox' && a.name.startsWith('day_')).map(a => a.name),
    ['day_1', 'day_2', 'day_3', 'day_4', 'day_5', 'day_6', 'day_7']);
  assert.deepStrictEqual(actionsById.ttlock_set_passage_mode.args[0].values.map(v => v.id), ['on', 'off']);
  assert.deepStrictEqual(actionsById.ttlock_set_sound.args[0].values.map(v => v.id), ['on', 'off']);
  assert.deepStrictEqual(actionsById.ttlock_set_privacy.args[0].values.map(v => v.id), ['on', 'off']);
  assert.strictEqual(actionsById.ttlock_set_autolock.args[0].max, 1800);
  assert.strictEqual(actionsById.ttlock_set_volume.args[0].min, 1);
  assert.strictEqual(actionsById.ttlock_set_volume.args[0].max, 5);
});
