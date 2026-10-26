'use strict';

const Homey = require('homey');
const { parseDoorSensors } = require('../../lib/accessories');
const { LOGIN_CODES } = require('../../lib/session');

class DoorSensorDevice extends Homey.Device {

  async onInit() {
    this.sensorId = this.getData().doorSensorId;
    this.lockId = this.getStoreValue('lockId');
    this.startPolling(this.getSetting('poll_interval'));
    this.poll().catch(this.error);
  }

  onUninit() {
    this.stopPolling();
  }

  onDeleted() {
    this.stopPolling();
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

  // Contact state from a webhook record (see doorSensorUpdate in lib/records.js; true = open).
  // Without a webhook the contact state of this device never updates: it is not polled. The lock device
  // has its own alarm_contact, which is updated from the same records.
  async applyRecord({ contact }) {
    if (typeof contact === 'boolean') await this.setCapabilityValue('alarm_contact', contact);
  }

  async updateBattery(level) {
    const value = Number(level);
    if (!Number.isFinite(value)) return;
    await this.setCapabilityValue('measure_battery', value);
    await this.setCapabilityValue('alarm_battery', value < 20);
  }

  // Only the battery (and the warning time) is polled.
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await this.homey.app.client.request('GET', '/v3/doorSensor/query', { lockId: this.lockId });
      const sensors = parseDoorSensors(res);
      const sensor = sensors.find(item => String(item.doorSensorId) === String(this.sensorId));
      if (!sensor) {
        this.log('Door sensor not found in doorSensor/query');
        return;
      }
      if (sensor.battery !== null) await this.updateBattery(sensor.battery);
      const warning = sensor.warningTime === undefined || sensor.warningTime === null ? '' : String(sensor.warningTime);
      if (this.getSetting('door_not_closed_warning_time') !== warning) {
        await this.setSettings({ door_not_closed_warning_time: warning });
      }
      await this.setAvailable();
    } catch (err) {
      this.error(err.message);
      if (LOGIN_CODES.includes(err.code)) this.setUnavailable(this.homey.__('device.relogin')).catch(this.error);
    } finally {
      this.polling = false;
    }
  }

}

module.exports = DoorSensorDevice;
