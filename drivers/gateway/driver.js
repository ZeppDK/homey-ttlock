'use strict';

const Homey = require('homey');
const { listGateways } = require('../../lib/gateway');
const { login, defaultPollInterval } = require('../../lib/session');

const LIST_CACHE_MS = 60 * 1000;

class GatewayDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getConditionCard('ttlock_gateway_is_online')
      .registerRunListener(async args => args.device.isOnline());
  }

  // gateway/list for all gateway devices; one API call is shared by everything polling within a minute.
  getGateways() {
    if (!this.listCache || Date.now() - this.listCache.at > LIST_CACHE_MS) {
      const promise = listGateways(this.homey.app.client);
      const cache = { at: Date.now(), promise };
      this.listCache = cache;
      promise.catch(() => {
        if (this.listCache === cache) this.listCache = null; // do not cache failures
      });
    }
    return this.listCache.promise;
  }

  login(data) {
    return login(this.homey, data);
  }

  async onPair(session) {
    session.setHandler('login', data => this.login(data));
    session.setHandler('list_devices', async () => {
      const gateways = await listGateways(this.homey.app.client);
      return gateways.map(gateway => ({
        name: gateway.gatewayName || gateway.gatewayMac || String(gateway.gatewayId),
        data: { gatewayId: gateway.gatewayId },
        store: {
          gatewayMac: gateway.gatewayMac,
          gatewayVersion: gateway.gatewayVersion,
        },
        settings: { poll_interval: defaultPollInterval(this.homey) },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async data => {
      await this.login(data);
      await device.setAvailable();
      device.poll().catch(this.error);
      return true;
    });
  }

}

module.exports = GatewayDriver;
