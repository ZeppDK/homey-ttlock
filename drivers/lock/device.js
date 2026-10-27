'use strict';

const Homey = require('homey');
const { getTransport } = require('../../lib/transport');
const {
  decodeFeatures, featureList, capabilitiesFor, hasKeypad, OPTIONAL_CAPABILITIES, CAPABILITY_OPTIONS,
} = require('../../lib/features');
const { SETTINGS, detailToCapabilities, detailInfo } = require('../../lib/settingsMap');
const { keypadBattery } = require('../../lib/accessories');
const { formatDateTime } = require('../../lib/time');
const { LOGIN_CODES } = require('../../lib/session');
const {
  describeRecord, recordFailed, recordToTokens, recordTriggers, tokensForTrigger, addKnownUser,
} = require('../../lib/records');
const { LISTS, setLockSetting } = require('../../lib/actions');

const OFFLINE_CODES = [-3002, -3036, -2012]; // gateway offline, lock offline, no gateway
const DEFAULT_TAMPER_RESET_SECONDS = 60;
const AUTOLOCK_CHECK_DELAY_SECONDS = 5; // margin after the auto-lock time before querying the state
const LIST_CACHE_MS = 60 * 1000;

class LockDevice extends Homey.Device {

  async onInit() {
    this.lockId = this.getData().lockId;
    this.reachable = true; // flips on offline/online errors, fires the ttlock_offline/online triggers once per change
    this.listCache = {};
    await this.syncCapabilities();
    this.registerCapabilityListener('locked', value => this.setLocked(value));
    await this.updateInfoSettings();
    this.startPolling(this.getSetting('poll_interval'));
    this.poll().catch(this.error);
  }

  onUninit() {
    this.stopPolling();
    this.clearTamperTimer();
    this.clearAutolockTimer();
  }

  onDeleted() {
    this.stopPolling();
    this.clearTamperTimer();
    this.clearAutolockTimer();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      if (!(newSettings.poll_interval >= 5)) throw new Error('Poll interval must be at least 5 minutes');
      this.startPolling(newSettings.poll_interval);
    }
  }

  startPolling(minutes) {
    this.stopPolling();
    const interval = Math.max(5, Number(minutes) || 15) * 60 * 1000;
    this.pollTimer = this.homey.setInterval(() => this.poll().catch(this.error), interval);
  }

  stopPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  tamperResetMs() {
    const seconds = Number(this.getSetting('reset_tamper_seconds'));
    return (seconds > 0 ? seconds : DEFAULT_TAMPER_RESET_SECONDS) * 1000;
  }

  clearTamperTimer() {
    if (this.tamperTimer) this.homey.clearTimeout(this.tamperTimer);
    this.tamperTimer = null;
  }

  clearAutolockTimer() {
    if (this.autolockTimer) this.homey.clearTimeout(this.autolockTimer);
    this.autolockTimer = null;
  }

  // TTLock sends no callback for auto-lock, so after an unlock the state is queried again
  // once the auto-lock time has passed (verified on a real lock: locked stayed false otherwise).
  scheduleAutolockCheck() {
    const seconds = Number(this.getCapabilityValue('ttlock_autolock_time'));
    if (!(seconds > 0) || this.hasNoRemoteAccess()) return;
    this.clearAutolockTimer();
    this.autolockTimer = this.homey.setTimeout(() => {
      this.autolockTimer = null;
      this.refreshState().catch(err => this.handleError(err));
    }, (seconds + AUTOLOCK_CHECK_DELAY_SECONDS) * 1000);
  }

  // Homey timezone for local times and date args; undefined when the clock API is missing.
  timezone() {
    const { clock } = this.homey;
    return clock && clock.getTimezone ? clock.getTimezone() : undefined;
  }

  transport() {
    return getTransport(this.homey.app.client, this.getSetting('transport'));
  }

  // Remotely controllable = gateway present or a WiFi lock (docs section 3).
  hasNoRemoteAccess() {
    const noGateway = Number(this.getStoreValue('hasGateway')) === 0;
    return noGateway && !decodeFeatures(this.getStoreValue('featureValue')).wifi;
  }

  // Adds the capabilities this lock should have and removes optional ones it lacks (featureValue may change).
  async syncCapabilities() {
    const wanted = capabilitiesFor(decodeFeatures(this.getStoreValue('featureValue')));
    for (const id of wanted) {
      if (this.hasCapability(id)) continue;
      await this.addCapability(id);
      if (CAPABILITY_OPTIONS[id]) await this.setCapabilityOptions(id, CAPABILITY_OPTIONS[id]);
    }
    for (const id of OPTIONAL_CAPABILITIES) {
      if (!wanted.includes(id) && this.hasCapability(id)) await this.removeCapability(id);
    }
    this.registerSettingListeners();
  }

  // The setable settings capabilities write to the lock; registered once per capability the lock has.
  registerSettingListeners() {
    this.settingListeners = this.settingListeners || new Set();
    for (const id of Object.keys(SETTINGS)) {
      if (!this.hasCapability(id) || this.settingListeners.has(id)) continue;
      this.settingListeners.add(id);
      this.registerCapabilityListener(id, value => this.writeSetting(id, value));
    }
  }

  // Writes a setting through the gateway, then re-reads lock/detail so the capability shows what the cloud has.
  // UNVERIFIED: the detail values are cached by TTLock; if the cache lags, the capability briefly shows the old value.
  async writeSetting(capabilityId, value) {
    try {
      await setLockSetting(this.homey.app.client, this.lockId, capabilityId, value, this.actionContext());
    } catch (err) {
      this.handleError(err);
      throw err;
    }
    await this.refreshDetail().catch(err => this.handleError(err));
  }

  // Sets a capability only when the lock has it (alarm_contact is feature-gated).
  async setCap(id, value) {
    if (this.hasCapability(id)) await this.setCapabilityValue(id, value);
  }

  async updateInfoSettings() {
    const info = {
      lock_id: String(this.lockId),
      lock_mac: String(this.getStoreValue('lockMac') || ''),
      lock_name: String(this.getStoreValue('lockName') || ''),
      features: featureList(decodeFeatures(this.getStoreValue('featureValue'))),
    };
    const current = this.getSettings();
    if (Object.keys(info).some(key => current[key] !== info[key])) await this.setSettings(info);
  }

  // Marks the device unavailable for offline/login problems; every error is logged.
  handleError(err) {
    this.error(err.message);
    if (OFFLINE_CODES.includes(err.code)) {
      this.markOffline(err.message);
    } else if (LOGIN_CODES.includes(err.code)) {
      this.setUnavailable(this.homey.__('device.relogin')).catch(this.error);
    }
  }

  markOffline(reason) {
    this.setUnavailable(reason).catch(this.error);
    if (this.reachable) {
      this.reachable = false;
      this.fireTrigger('ttlock_offline', { reason }).catch(this.error);
    }
  }

  async markOnline() {
    await this.setAvailable();
    if (!this.reachable) {
      this.reachable = true;
      await this.fireTrigger('ttlock_online', { reason: this.homey.__('device.reachable_again') });
    }
  }

  // Fires a device trigger card; a failing flow never breaks the caller.
  async fireTrigger(id, tokens, state = {}) {
    try {
      await this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, state);
    } catch (err) {
      this.error(`Trigger ${id} failed: ${err.message}`);
    }
  }

  // Passcodes, cards, fingerprints and eKeys of this lock, cached for a minute (autocomplete asks often).
  getList(kind) {
    const hit = this.listCache[kind];
    if (!hit || Date.now() - hit.at > LIST_CACHE_MS) {
      const entry = { at: Date.now(), promise: LISTS[kind](this.homey.app.client, this.lockId) };
      this.listCache[kind] = entry;
      entry.promise.catch(() => {
        if (this.listCache[kind] === entry) delete this.listCache[kind]; // do not cache failures
      });
    }
    return this.listCache[kind].promise;
  }

  invalidateLists() {
    this.listCache = {};
  }

  // Options for the lib/actions.js handlers.
  actionContext() {
    const featureValue = this.getStoreValue('featureValue');
    return {
      now: Date.now(),
      tz: this.timezone(),
      features: featureValue ? decodeFeatures(featureValue) : null,
      remote: !this.hasNoRemoteAccess(),
      detail: this.detail || null,
    };
  }

  isOnline() {
    return this.getAvailable() && !this.hasNoRemoteAccess();
  }

  async setLocked(value) {
    if (this.hasNoRemoteAccess()) throw new Error(this.homey.__('device.no_gateway'));
    const transport = this.transport();
    try {
      await (value ? transport.lock(this.lockId) : transport.unlock(this.lockId));
    } catch (err) {
      this.handleError(err);
      throw err;
    }
    await this.refreshState().catch(err => this.handleError(err));
    if (!value) this.scheduleAutolockCheck();
  }

  // queryOpenState: 0 locked, 1 unlocked, 2 unknown (leave the current value)
  async refreshState() {
    const state = Number(await this.transport().queryState(this.lockId));
    if (state === 0) await this.setCapabilityValue('locked', true);
    if (state === 1) await this.setCapabilityValue('locked', false);
  }

  async updateBattery(level) {
    const value = Number(level);
    if (!Number.isFinite(value)) return;
    await this.setCapabilityValue('measure_battery', value);
    await this.setCapabilityValue('alarm_battery', value < 20);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.refreshFromList();
      // Both are plain cloud reads that do not need the gateway; a failure must not stop the rest of the poll.
      await this.refreshDetail().catch(err => this.error(`lock/detail failed: ${err.message}`));
      await this.refreshKeypad().catch(err => this.error(`wirelessKeypad/listByLock failed: ${err.message}`));
      if (this.hasNoRemoteAccess()) {
        await this.setUnavailable(this.homey.__('device.no_gateway'));
        return;
      }
      await this.refreshSignal();
      if (this.getSetting('poll_state')) await this.refreshState();
      await this.markOnline();
    } catch (err) {
      this.handleError(err);
    } finally {
      this.polling = false;
    }
  }

  // Battery (and gateway/feature info) from the lock/list the driver shares between devices.
  async refreshFromList() {
    const locks = await this.driver.getLocks();
    const lock = locks.find(item => String(item.lockId) === String(this.lockId));
    if (!lock) {
      this.log('Lock not found in lock/list');
      return;
    }
    await this.updateBattery(lock.electricQuantity);
    let featuresChanged = false;
    for (const key of ['hasGateway', 'featureValue']) {
      if (lock[key] !== undefined && lock[key] !== this.getStoreValue(key)) {
        await this.setStoreValue(key, lock[key]);
        if (key === 'featureValue') featuresChanged = true;
      }
    }
    if (featuresChanged) await this.syncCapabilities();
    await this.updateInfoSettings();
  }

  // Lock settings (cached by TTLock) from lock/detail, one call per poll.
  async refreshDetail() {
    const detail = await this.homey.app.client.request('GET', '/v3/lock/detail', { lockId: this.lockId });
    await this.applyDetail(detail);
  }

  async applyDetail(detail) {
    this.detail = detail;
    for (const [id, value] of Object.entries(detailToCapabilities(detail))) {
      if (!this.hasCapability(id)) continue;
      const previous = this.getCapabilityValue(id);
      await this.setCapabilityValue(id, value);
      if (id === 'ttlock_passage_mode' && typeof previous === 'boolean' && previous !== value) {
        await this.fireTrigger(value ? 'ttlock_passage_mode_on' : 'ttlock_passage_mode_off', {});
      }
    }
    const info = { ...detailInfo(detail), last_detail_sync: formatDateTime(Date.now(), this.timezone()) };
    const current = this.getSettings();
    if (Object.keys(info).some(key => current[key] !== info[key])) await this.setSettings(info);
  }

  // Battery of the first wireless keypad (locks with feature bit 24 or 84).
  async refreshKeypad() {
    if (!hasKeypad(decodeFeatures(this.getStoreValue('featureValue'))) || !this.hasCapability('measure_battery.keypad')) return;
    const res = await this.homey.app.client.request('GET', '/v3/wirelessKeypad/listByLock', { lockId: this.lockId });
    const level = keypadBattery(res);
    if (level !== null) await this.setCapabilityValue('measure_battery.keypad', level);
  }

  async refreshSignal() {
    const res = await this.homey.app.client.request('GET', '/v3/gateway/listByLock', { lockId: this.lockId });
    // verified on a real lock: { list: [...] }. A bare array or a single object are also accepted.
    const items = Array.isArray(res) ? res : (res.list || [res]);
    const rssi = items.map(item => Number(item.rssi)).filter(Number.isFinite);
    if (rssi.length) await this.setCapabilityValue('measure_signal_strength', Math.max(...rssi));
  }

  // Called by the app for every new webhook record of this lock.
  async applyRecord(record) {
    const info = describeRecord(record.recordType);
    const type = Number(record.recordType);
    const tokens = recordToTokens(record, info, this.timezone());

    if (!recordFailed(record)) {
      if (info.action === 'unlock') {
        await this.setCapabilityValue('locked', false);
        await this.setCap('alarm_generic', false); // "system locked" ends with the next successful unlock
        this.scheduleAutolockCheck();
      }
      if (info.action === 'lock') await this.setCapabilityValue('locked', true);
      if (info.action !== 'event') {
        await this.setCap('ttlock_last_user', tokens.user);
        await this.setCap('ttlock_last_method', tokens.method);
      }
    }
    if (tokens.time) await this.setCap('ttlock_last_event_time', tokens.time);

    if (type === 44) {
      await this.setCap('alarm_tamper', true);
      this.clearTamperTimer();
      this.tamperTimer = this.homey.setTimeout(() => this.setCap('alarm_tamper', false).catch(this.error), this.tamperResetMs());
    }
    if (type === 48) await this.setCap('alarm_generic', true);
    if (type === 31) await this.setCap('alarm_contact', true); // true = open
    if (type === 30) await this.setCap('alarm_contact', false);

    if (record.electricQuantity !== undefined) await this.updateBattery(record.electricQuantity);

    if (tokens.user) {
      const known = this.getStoreValue('known_users') || [];
      const updated = addKnownUser(known, tokens.user);
      if (updated.join('\n') !== known.join('\n')) await this.setStoreValue('known_users', updated);
    }
    await this.setStoreValue('last_record', { ...record, ...info });

    for (const id of recordTriggers(record, info)) {
      await this.fireTrigger(id, tokensForTrigger(id, tokens), { method: tokens.method });
    }
  }

}

module.exports = LockDevice;
