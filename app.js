'use strict';

const Homey = require('homey');
const { TTLockClient } = require('./lib/TTLockClient');
const { countApiCall } = require('./lib/apiCalls');
const { parseCallback, doorSensorUpdate } = require('./lib/records');

const SESSION_KEY = 'ttlock_session'; // never shown on the settings page
const SEEN_LIMIT = 50;

class TTLockApp extends Homey.App {

  async onInit() {
    this.client = this.createClient({
      get: () => this.homey.settings.get(SESSION_KEY),
      set: session => this.homey.settings.set(SESSION_KEY, session),
    });
    this.seenKeys = [];
    await this.initWebhook();
    this.log('TTLock app started');
  }

  // Settings written by the settings page.
  getConfig() {
    const settings = this.homey.settings;
    return {
      clientId: settings.get('ttlock_client_id'),
      clientSecret: settings.get('ttlock_client_secret'),
      region: settings.get('ttlock_region') || 'eu',
      baseUrl: settings.get('ttlock_base_url'),
    };
  }

  createClient(store, getConfig = () => this.getConfig()) {
    return new TTLockClient({
      store,
      getConfig,
      onCall: () => countApiCall(this.homey.settings),
      sleep: ms => new Promise(resolve => this.homey.setTimeout(resolve, ms)),
    });
  }

  // "Test connection" button: logs in with a throw-away session so the real one is untouched.
  async testConnection({
    username, password, clientId, clientSecret, region, baseUrl,
  }) {
    let session = null;
    const client = this.createClient(
      { get: () => session, set: value => { session = value; } },
      () => ({
        clientId, clientSecret, region, baseUrl,
      }),
    );
    await client.login(username, password);
    const locks = await client.listLocks();
    return { lockCount: locks.length };
  }

  webhookConfigured() {
    return Boolean(Homey.env && Homey.env.WEBHOOK_ID && Homey.env.WEBHOOK_SECRET);
  }

  async getWebhookUrl() {
    if (!this.webhookConfigured()) return null;
    const homeyId = await this.homey.cloud.getHomeyId();
    return `https://webhooks.athom.com/webhook/${Homey.env.WEBHOOK_ID}?homey=${homeyId}`;
  }

  async initWebhook() {
    if (!this.webhookConfigured()) {
      this.log('WEBHOOK_ID/WEBHOOK_SECRET missing in env.json, webhook disabled (polling only)');
      return;
    }
    this.webhook = await this.homey.cloud.createWebhook(Homey.env.WEBHOOK_ID, Homey.env.WEBHOOK_SECRET, {});
    // TTLock documents a reply body "success", which the Athom relay does not let us send; records still arrive (verified).
    this.webhook.on('message', args => this.onWebhook(args).catch(this.error));
    this.log('Webhook registered');
  }

  // Returns true the first time a record is seen (TTLock can deliver duplicates).
  isNewRecord(lockId, record) {
    const key = `${lockId}|${record.lockDate}|${record.recordType}`;
    if (this.seenKeys.includes(key)) return false;
    this.seenKeys.push(key);
    if (this.seenKeys.length > SEEN_LIMIT) this.seenKeys.shift();
    return true;
  }

  // The door sensor device that belongs to this lock (store.lockId), if one was paired.
  findDoorSensor(lockId) {
    return this.homey.drivers.getDriver('door_sensor').getDevices()
      .find(d => String(d.getStoreValue('lockId')) === String(lockId));
  }

  async onWebhook({ body }) {
    const callback = parseCallback(body);
    if (!callback) {
      this.log('Webhook ignored: no lock records in body');
      return;
    }
    const device = this.homey.drivers.getDriver('lock').getDevices()
      .find(d => String(d.getData().lockId) === callback.lockId);
    const doorSensor = this.findDoorSensor(callback.lockId);
    if (!device && !doorSensor) {
      this.log(`Webhook for unknown lockId ${callback.lockId}`);
      return;
    }
    const fresh = callback.records
      .filter(record => this.isNewRecord(callback.lockId, record))
      .sort((a, b) => Number(a.lockDate) - Number(b.lockDate));
    for (const record of fresh) {
      this.log(`Webhook record ${record.recordType} for lock ${callback.lockId}`);
      if (device) await device.applyRecord(record);
      const update = doorSensor && doorSensorUpdate(record);
      if (update) await doorSensor.applyRecord(update).catch(this.error); // never blocks the lock's own records
    }
  }

  // "Clear session" button of the settings page: the next login (pairing or repair) creates a new one.
  clearSession() {
    this.homey.settings.unset(SESSION_KEY);
  }

  // Diagnostic for the local-bridge work: which fields does /v3/key/list return for this account?
  // Values are masked (type + length only) so no lock keys leave the Homey.
  async keyFields() {
    const res = await this.client.request('GET', '/v3/key/list', { pageNo: 1, pageSize: 20, sdkVersion: 2 });
    const items = Array.isArray(res) ? res : (res.list || []);
    const mask = value => (value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]))
      : `${typeof value}(${String(value).length})`);
    // lockVersion (protocol type/version, scene, group, org) is not secret and is needed to pick a bridge.
    return {
      envelope: Object.keys(res),
      count: items.length,
      keys: items.map(item => ({ ...mask(item), lockVersion: item.lockVersion, userType: item.userType, lockFlagPos: item.lockFlagPos, keyboardPwdVersion: item.keyboardPwdVersion })),
    };
  }

  // Diagnostic for the settings page / API: which BLE devices does the Homey hear, and how strongly?
  // query.service: optional service UUID filter (TTLock locks advertise 1910); query.timeout: scan ms.
  async bleScan({ service, timeout } = {}) {
    const filter = service ? [String(service)] : [];
    const ms = Number(timeout) || undefined;
    const advertisements = await this.homey.ble.discover(filter, ms);
    return advertisements.map(ad => ({
      address: ad.address,
      uuid: ad.uuid,
      localName: ad.localName,
      rssi: ad.rssi,
      serviceUuids: ad.serviceUuids,
      manufacturerData: ad.manufacturerData ? Buffer.from(ad.manufacturerData).toString('hex') : undefined,
      connectable: ad.connectable,
    })).sort((a, b) => b.rssi - a.rssi);
  }

}

module.exports = TTLockApp;
