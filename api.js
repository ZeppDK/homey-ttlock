'use strict';

module.exports = {

  // GET /webhook-url -> { url } (url is null when env.json has no webhook id/secret)
  async getWebhookUrl({ homey }) {
    return { url: await homey.app.getWebhookUrl() };
  },

  // POST /test { username, password, clientId, clientSecret, region, baseUrl } -> { lockCount }
  async testConnection({ homey, body }) {
    return homey.app.testConnection(body || {});
  },

  // POST /logout -> { ok: true }: forgets the stored TTLock session
  async logout({ homey }) {
    homey.app.clearSession();
    return { ok: true };
  },

  // GET /key-fields -> field names (values masked) of the account's eKeys from /v3/key/list (bridge diagnostic)
  async keyFields({ homey }) {
    return homey.app.keyFields();
  },

  // GET /ble-scan -> nearby BLE advertisements (diagnostic: is a lock within Homey's Bluetooth range?)
  async bleScan({ homey, query }) {
    return homey.app.bleScan(query || {});
  },

};
