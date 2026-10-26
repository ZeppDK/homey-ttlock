'use strict';

// Gateway and door sensor drivers/devices, and the app's webhook routing to the door sensor.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { Device: class {}, Driver: class {}, App: class {} };
  return originalLoad.call(this, request, ...rest);
};
const GatewayDevice = require('../drivers/gateway/device');
const GatewayDriver = require('../drivers/gateway/driver');
const DoorSensorDevice = require('../drivers/door_sensor/device');
const DoorSensorDriver = require('../drivers/door_sensor/driver');
const TTLockApp = require('../app');
Module._load = originalLoad;

const bit = n => (1n << BigInt(n)).toString(16);

// A device without the Homey runtime: capabilities, store and settings in plain objects.
function fakeDevice(DeviceClass, { caps = [], store = {}, settings = {} } = {}) {
  const device = Object.create(DeviceClass.prototype);
  const capabilities = new Map(caps.map(id => [id, null]));
  const state = {
    capabilities, store, settings, fired: [], availability: [], calls: [],
  };
  Object.assign(device, {
    state,
    error: () => {},
    log: () => {},
    getAvailable: () => true,
    getCapabilityValue: id => capabilities.get(id),
    setCapabilityValue: async (id, value) => {
      if (!capabilities.has(id)) throw new Error(`no capability ${id}`);
      capabilities.set(id, value);
    },
    getStoreValue: key => store[key],
    getSetting: key => settings[key],
    getSettings: () => ({ ...settings }),
    setSettings: async values => { Object.assign(settings, values); },
    setAvailable: async () => { state.availability.push('available'); },
    setUnavailable: async message => { state.availability.push(`unavailable: ${message}`); },
    homey: {
      __: key => key,
      flow: { getDeviceTriggerCard: id => ({ trigger: async (dev, tokens, st) => { state.fired.push({ id, tokens, st }); } }) },
      app: { client: { request: async (method, path, params) => { state.calls.push({ method, path, params }); return device.answer(method, path, params); } } },
    },
    answer: () => ({}),
  });
  return device;
}

// ---- gateway --------------------------------------------------------------------------------

const GATEWAY_CAPS = ['alarm_generic', 'ttlock_lock_count', 'ttlock_gateway_version'];

function fakeGateway(item, store = { gatewayMac: 'AA:BB', gatewayVersion: 2 }) {
  const device = fakeDevice(GatewayDevice, { caps: GATEWAY_CAPS, store, settings: { poll_interval: 15 } });
  device.gatewayId = 11;
  device.driver = { getGateways: async () => [item] };
  return device;
}

test('gateway poll: offline alarm, lock count, version and info labels', async () => {
  const device = fakeGateway({
    gatewayId: 11, isOnline: 1, lockNum: 2, gatewayVersion: 3, gatewayMac: 'AA:BB:CC', networkName: 'home',
  });
  await device.poll();
  const { capabilities, settings } = device.state;
  assert.strictEqual(capabilities.get('alarm_generic'), false);
  assert.strictEqual(capabilities.get('ttlock_lock_count'), 2);
  assert.strictEqual(capabilities.get('ttlock_gateway_version'), 'G3');
  assert.deepStrictEqual([settings.gateway_mac, settings.network_name, settings.version], ['AA:BB:CC', 'home', 'G3']);
  assert.deepStrictEqual(device.state.calls, [{ method: 'GET', path: '/v3/gateway/detail', params: { gatewayId: 11 } }]);
  assert.deepStrictEqual(device.state.fired, []); // first reading never fires
  assert.deepStrictEqual(device.state.availability, ['available']);
});

test('gateway offline and online triggers fire once per flip', async () => {
  const item = { gatewayId: 11, isOnline: 1 };
  const device = fakeGateway(item);
  await device.poll();
  item.isOnline = 0;
  await device.poll();
  await device.poll();
  assert.deepStrictEqual(device.state.fired.map(f => f.id), ['ttlock_gateway_offline']);
  assert.strictEqual(device.state.capabilities.get('alarm_generic'), true);
  assert.strictEqual(device.isOnline(), false);
  item.isOnline = 1;
  await device.poll();
  await device.poll();
  assert.deepStrictEqual(device.state.fired.map(f => f.id), ['ttlock_gateway_offline', 'ttlock_gateway_online']);
  assert.strictEqual(device.isOnline(), true);
});

test('gateway detail overrides the list item; a failing detail keeps the list data', async () => {
  const device = fakeGateway({ gatewayId: 11, isOnline: 1, lockNum: 1 });
  device.answer = () => ({ isOnline: 0, lockNum: 4 });
  await device.poll();
  assert.strictEqual(device.state.capabilities.get('alarm_generic'), true);
  assert.strictEqual(device.state.capabilities.get('ttlock_lock_count'), 4);

  const other = fakeGateway({ gatewayId: 11, isOnline: 1, lockNum: 1 });
  other.answer = () => { throw new Error('detail down'); };
  await other.poll();
  assert.strictEqual(other.state.capabilities.get('alarm_generic'), false);
  assert.strictEqual(other.state.capabilities.get('ttlock_lock_count'), 1);
});

test('gateway: missing isOnline leaves the alarm alone, unknown version falls back to the paired one', async () => {
  const device = fakeGateway({ gatewayId: 11 });
  await device.poll();
  assert.strictEqual(device.state.capabilities.get('alarm_generic'), null);
  assert.strictEqual(device.isOnline(), true);
  assert.strictEqual(device.state.settings.version, 'G2'); // from store.gatewayVersion
});

test('gateway: a login error makes the device unavailable, other errors do not', async () => {
  const device = fakeGateway({});
  device.driver = { getGateways: async () => { throw Object.assign(new Error('expired'), { code: 10004 }); } };
  await device.poll();
  assert.strictEqual(device.state.availability[0], 'unavailable: device.relogin');
  const other = fakeGateway({});
  other.driver = { getGateways: async () => { throw new Error('network'); } };
  await other.poll();
  assert.deepStrictEqual(other.state.availability, []);
});

test('gateway driver: one shared gateway/list call per minute, failures are not cached', async () => {
  const driver = Object.create(GatewayDriver.prototype);
  let calls = 0;
  let fail = true;
  driver.homey = {
    app: {
      client: {
        request: async () => {
          calls++;
          if (fail) throw new Error('boom');
          return { list: [{ gatewayId: 1 }] };
        },
      },
    },
  };
  await assert.rejects(driver.getGateways(), /boom/);
  await new Promise(resolve => setImmediate(resolve));
  fail = false;
  await Promise.all([driver.getGateways(), driver.getGateways(), driver.getGateways()]);
  assert.strictEqual(calls, 2);
});

test('gateway driver pairing lists gateways with name, data and store', async () => {
  const driver = Object.create(GatewayDriver.prototype);
  driver.homey = {
    settings: { get: () => 20 },
    app: {
      client: { request: async () => [{ gatewayId: 1, gatewayName: 'Hall', gatewayMac: 'AA', gatewayVersion: 2 }] },
    },
  };
  const handlers = {};
  await driver.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });
  assert.deepStrictEqual(await handlers.list_devices(), [{
    name: 'Hall', data: { gatewayId: 1 }, store: { gatewayMac: 'AA', gatewayVersion: 2 }, settings: { poll_interval: 20 },
  }]);
});

test('gateway online condition uses the device', async () => {
  const driver = Object.create(GatewayDriver.prototype);
  const run = {};
  driver.homey = { flow: { getConditionCard: id => ({ registerRunListener: fn => { run[id] = fn; } }) } };
  await driver.onInit();
  assert.strictEqual(await run.ttlock_gateway_is_online({ device: { isOnline: () => false } }), false);
  assert.strictEqual(await run.ttlock_gateway_is_online({ device: { isOnline: () => true } }), true);
});

// ---- door sensor ----------------------------------------------------------------------------

function fakeSensor() {
  const device = fakeDevice(DoorSensorDevice, {
    caps: ['alarm_contact', 'measure_battery', 'alarm_battery'],
    store: { lockId: 5 },
    settings: { poll_interval: 15, door_not_closed_warning_time: '' },
  });
  device.sensorId = 70;
  device.lockId = 5;
  return device;
}

test('door sensor applyRecord sets alarm_contact (true = open)', async () => {
  const device = fakeSensor();
  await device.applyRecord({ contact: true });
  assert.strictEqual(device.state.capabilities.get('alarm_contact'), true);
  await device.applyRecord({ contact: false });
  assert.strictEqual(device.state.capabilities.get('alarm_contact'), false);
  await device.applyRecord({});
  assert.strictEqual(device.state.capabilities.get('alarm_contact'), false);
});

test('door sensor poll: battery and warning time of its own sensor only', async () => {
  const device = fakeSensor();
  device.answer = () => ({
    list: [
      { doorSensorId: 99, electricQuantity: 10, doorNotClosedWarningTime: 5 },
      { doorSensorId: 70, electricQuantity: 15, doorNotClosedWarningTime: 30 },
    ],
  });
  await device.poll();
  assert.deepStrictEqual(device.state.calls, [{ method: 'GET', path: '/v3/doorSensor/query', params: { lockId: 5 } }]);
  assert.strictEqual(device.state.capabilities.get('measure_battery'), 15);
  assert.strictEqual(device.state.capabilities.get('alarm_battery'), true);
  assert.strictEqual(device.state.settings.door_not_closed_warning_time, '30');
  assert.strictEqual(device.state.capabilities.get('alarm_contact'), null); // never polled
  device.answer = () => ({ list: [{ doorSensorId: 70, electricQuantity: 90 }] });
  await device.poll();
  assert.strictEqual(device.state.capabilities.get('alarm_battery'), false);
  assert.strictEqual(device.state.settings.door_not_closed_warning_time, '');
});

test('door sensor poll: login errors make it unavailable, a missing sensor changes nothing', async () => {
  const device = fakeSensor();
  device.answer = () => ({ list: [] });
  await device.poll();
  assert.strictEqual(device.state.capabilities.get('measure_battery'), null);
  device.answer = () => { throw Object.assign(new Error('expired'), { code: 10004 }); };
  await device.poll();
  assert.strictEqual(device.state.availability[0], 'unavailable: device.relogin');
});

test('door sensor pairing: one device per sensor of locks that have one, named after the lock', async () => {
  const driver = Object.create(DoorSensorDriver.prototype);
  driver.error = () => {};
  driver.homey = {
    __: (key, tokens) => `${key}:${tokens.lock}`,
    settings: { get: () => undefined },
    app: {
      client: {
        listLocks: async () => [
          { lockId: 1, lockAlias: 'Front door', featureValue: bit(13) },
          { lockId: 2, lockName: 'Shed', featureValue: '15' },
          { lockId: 3, lockName: 'M123', featureValue: bit(50) },
        ],
        request: async (method, path, params) => ({ list: [{ doorSensorId: params.lockId * 100, electricQuantity: 50 }] }),
      },
    },
  };
  const handlers = {};
  await driver.onPair({ setHandler: (name, fn) => { handlers[name] = fn; } });
  assert.deepStrictEqual(await handlers.list_devices(), [
    {
      name: 'pair.door_sensor_name:Front door', data: { doorSensorId: 100 }, store: { lockId: 1 }, settings: { poll_interval: 15 },
    },
    {
      name: 'pair.door_sensor_name:M123', data: { doorSensorId: 300 }, store: { lockId: 3 }, settings: { poll_interval: 15 },
    },
  ]);
});

// ---- app webhook routing --------------------------------------------------------------------

function fakeApp({ lockDevice, sensor }) {
  const app = Object.create(TTLockApp.prototype);
  app.seenKeys = [];
  app.log = () => {};
  app.error = () => {};
  app.homey = {
    drivers: {
      getDriver: id => ({ getDevices: () => (id === 'lock' ? [lockDevice].filter(Boolean) : [sensor].filter(Boolean)) }),
    },
  };
  return app;
}

const webhookBody = (lockId, records) => new URLSearchParams({ notifyType: '1', lockId: String(lockId), records: JSON.stringify(records) }).toString();

function recorder(extra = {}) {
  const applied = [];
  return { applied, applyRecord: async record => { applied.push(record); }, ...extra };
}

test('webhook: door records go to the lock and to the door sensor of that lock', async () => {
  const lockDevice = recorder({ getData: () => ({ lockId: 5 }) });
  const sensor = recorder({ getStoreValue: () => 5 });
  const app = fakeApp({ lockDevice, sensor });
  await app.onWebhook({
    body: webhookBody(5, [
      { recordType: 31, lockDate: 1000, electricQuantity: 80 },
      { recordType: 4, lockDate: 2000 },
      { recordType: 30, lockDate: 3000 },
    ]),
  });
  assert.deepStrictEqual(lockDevice.applied.map(r => r.recordType), [31, 4, 30]);
  assert.deepStrictEqual(sensor.applied, [{ contact: true }, { contact: false }]);
});

test('webhook: records for another lock do not reach the door sensor; duplicates are applied once', async () => {
  const lockDevice = recorder({ getData: () => ({ lockId: 5 }) });
  const sensor = recorder({ getStoreValue: () => 6 });
  const app = fakeApp({ lockDevice, sensor });
  const body = webhookBody(5, [{ recordType: 31, lockDate: 1000 }]);
  await app.onWebhook({ body });
  await app.onWebhook({ body });
  assert.deepStrictEqual(sensor.applied, []);
  assert.strictEqual(lockDevice.applied.length, 1);
});

test('webhook: a door sensor without a lock device still gets the door state', async () => {
  const sensor = recorder({ getStoreValue: () => 5 });
  const app = fakeApp({ lockDevice: null, sensor });
  await app.onWebhook({ body: webhookBody(5, [{ recordType: 31, lockDate: 1000 }]) });
  assert.deepStrictEqual(sensor.applied, [{ contact: true }]);
  const nobody = fakeApp({ lockDevice: null, sensor: null });
  await nobody.onWebhook({ body: webhookBody(9, [{ recordType: 31, lockDate: 1000 }]) }); // no throw
});

test('webhook: a failing door sensor does not stop the lock records', async () => {
  const lockDevice = recorder({ getData: () => ({ lockId: 5 }) });
  const sensor = { getStoreValue: () => 5, applyRecord: async () => { throw new Error('boom'); } };
  const app = fakeApp({ lockDevice, sensor });
  await app.onWebhook({ body: webhookBody(5, [{ recordType: 31, lockDate: 1000 }, { recordType: 4, lockDate: 2000 }]) });
  assert.deepStrictEqual(lockDevice.applied.map(r => r.recordType), [31, 4]);
});

test('findDoorSensor matches the store lockId', () => {
  const sensor = { getStoreValue: key => (key === 'lockId' ? 5 : undefined) };
  const app = fakeApp({ lockDevice: null, sensor });
  assert.strictEqual(app.findDoorSensor('5'), sensor);
  assert.strictEqual(app.findDoorSensor(6), undefined);
});

test('clearSession forgets the stored session', () => {
  const app = Object.create(TTLockApp.prototype);
  const unset = [];
  app.homey = { settings: { unset: key => unset.push(key) } };
  app.clearSession();
  assert.deepStrictEqual(unset, ['ttlock_session']);
});
