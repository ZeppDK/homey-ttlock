'use strict';

const Homey = require('homey');
const {
  mergeGateway, gatewayStatus, gatewayFlip, versionName,
} = require('../../lib/gateway');
const { LOGIN_CODES } = require('../../lib/session');

class GatewayDevice extends Homey.Device {

  async onInit() {
    this.gatewayId = this.getData().gatewayId;
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

  // The "is online" flow condition: unknown (not polled yet) counts as online.
  isOnline() {
    return this.getAvailable() && this.getCapabilityValue('alarm_generic') !== true;
  }

  // Fires a device trigger card; a failing flow never breaks the caller.
  async fireTrigger(id, tokens = {}) {
    try {
      await this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens, {});
    } catch (err) {
      this.error(`Trigger ${id} failed: ${err.message}`);
    }
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.refresh();
      await this.setAvailable();
    } catch (err) {
      this.error(err.message);
      if (LOGIN_CODES.includes(err.code)) this.setUnavailable(this.homey.__('device.relogin')).catch(this.error);
    } finally {
      this.polling = false;
    }
  }

  // The list is shared between gateway devices; gateway/detail adds this gateway's own fields.
  async refresh() {
    const gateways = await this.driver.getGateways();
    const item = gateways.find(gateway => String(gateway.gatewayId) === String(this.gatewayId));
    if (!item) {
      this.log('Gateway not found in gateway/list');
      return;
    }
    let detail = null;
    try {
      detail = await this.homey.app.client.request('GET', '/v3/gateway/detail', { gatewayId: this.gatewayId });
    } catch (err) {
      if (LOGIN_CODES.includes(err.code)) throw err;
      this.error(`gateway/detail failed: ${err.message}`);
    }
    await this.applyStatus(gatewayStatus(mergeGateway(item, detail)));
  }

  async applyStatus(status) {
    if (status.offline !== null) {
      const previous = this.getCapabilityValue('alarm_generic');
      await this.setCapabilityValue('alarm_generic', status.offline);
      const flip = gatewayFlip(previous, status.offline);
      if (flip) await this.fireTrigger(`ttlock_gateway_${flip}`);
    }
    if (status.lockCount !== null) await this.setCapabilityValue('ttlock_lock_count', status.lockCount);
    if (status.version) await this.setCapabilityValue('ttlock_gateway_version', status.version);

    const info = {
      gateway_mac: status.mac || String(this.getStoreValue('gatewayMac') || ''),
      network_name: status.networkName,
      version: status.version || versionName(this.getStoreValue('gatewayVersion')),
    };
    const current = this.getSettings();
    if (Object.keys(info).some(key => current[key] !== info[key])) await this.setSettings(info);
  }

}

module.exports = GatewayDevice;
