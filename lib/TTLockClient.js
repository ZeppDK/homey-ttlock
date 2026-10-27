'use strict';

const crypto = require('crypto');
const Queue = require('./queue');

const BASE_URLS = {
  eu: 'https://euapi.ttlock.com',
  cn: 'https://cnapi.ttlock.com',
};

// Calls that go through the gateway to the lock. The gateway handles one
// command at a time, so these are serialized in a single queue.
const GATEWAY_PATHS = new Set([
  '/v3/lock/lock',
  '/v3/lock/unlock',
  '/v3/lock/queryOpenState',
  '/v3/lock/queryElectricQuantity',
  '/v3/lock/setAutoLockTime',
  '/v3/lock/updateSetting',
  '/v3/lock/configurePassageMode',
  '/v3/lock/updateDate', // accepted by the cloud, see syncClock in lib/actions.js
  // Passcode/card/fingerprint writes with addType/deleteType/changeType 2 (via gateway).
  '/v3/keyboardPwd/add',
  '/v3/keyboardPwd/change',
  '/v3/keyboardPwd/delete',
  '/v3/identityCard/add',
  '/v3/identityCard/delete',
  '/v3/fingerprint/delete',
]);

const BUSY_CODES = [-3003, -3037]; // gateway busy / lock busy: retry with backoff
const RETRY_DELAYS_MS = [3000, 6000, 12000];

// Known error codes -> user-facing text (docs/research/ttlock-cloud-api.md section 11).
const KNOWN_ERRORS = {
  10000: 'Invalid clientId. Check the app settings',
  10001: 'Invalid clientSecret. Check the app settings',
  10004: 'TTLock session expired. Repair the device to log in again',
  10007: 'Wrong TTLock username or password',
  10011: 'TTLock session expired. Repair the device to log in again',
  30006: 'TTLock API call limit reached',
  80000: 'Homey clock differs too much from the TTLock server',
  '-2012': 'The lock has no gateway',
  '-2018': 'Permission denied. Only the lock admin account can do this',
  '-3002': 'The gateway is offline',
  '-3003': 'The gateway is busy',
  '-3036': 'The lock is offline (out of gateway range)',
  '-3037': 'The lock is busy',
  '-4043': 'Enable Remote Unlock in the TTLock app',
};

class TTLockError extends Error {

  constructor(code, serverMessage) {
    super(KNOWN_ERRORS[code] || serverMessage || `TTLock error ${code}`);
    this.name = 'TTLockError';
    this.code = code;
    this.serverMessage = serverMessage;
  }

}

function resolveBaseUrl(region, customUrl) {
  if (region === 'custom') {
    const url = String(customUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new TTLockError('config', 'Enter a valid base URL (https://...) in the app settings');
    return url;
  }
  return BASE_URLS[region] || BASE_URLS.eu;
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

class TTLockClient {

  // store: { get(), set(session) }   getConfig(): { clientId, clientSecret, region, baseUrl } (baseUrl = custom URL)
  constructor({
    store, getConfig, onCall = () => {}, fetchFn = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    retryDelays = RETRY_DELAYS_MS, timeoutMs = 30000,
  }) {
    this.store = store;
    this.getConfig = getConfig;
    this.onCall = onCall;
    this.fetch = fetchFn;
    this.sleep = sleep;
    this.retryDelays = retryDelays;
    this.timeoutMs = timeoutMs;
    this.queue = new Queue();
    this._refreshing = null;
  }

  _config() {
    const config = this.getConfig();
    if (!config.clientId || !config.clientSecret) {
      throw new TTLockError('config', 'Fill in clientId and clientSecret in the app settings first');
    }
    return { clientId: config.clientId, clientSecret: config.clientSecret, base: resolveBaseUrl(config.region, config.baseUrl) };
  }

  // One HTTP call. GET params go in the query string, POST params in a form body.
  async _fetchJson(method, url, params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    const init = { method, signal: AbortSignal.timeout(this.timeoutMs) };
    if (method === 'GET') {
      url = `${url}?${search}`;
    } else {
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      init.body = search.toString();
    }

    this.onCall();
    let res;
    let text;
    try {
      res = await this.fetch(url, init);
      text = await res.text();
    } catch (err) {
      throw new TTLockError('network', `Could not reach the TTLock cloud: ${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new TTLockError('bad_response', `Unexpected response from TTLock (HTTP ${res.status})`);
    }
    if (data && data.errcode !== undefined && Number(data.errcode) !== 0) {
      throw new TTLockError(Number(data.errcode), data.errmsg || data.description);
    }
    return data;
  }

  async _saveTokens(data, previous = {}) {
    const session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || previous.refreshToken,
      uid: data.uid !== undefined ? data.uid : previous.uid,
      expiresAt: Date.now() + (Number(data.expires_in) || 0) * 1000,
    };
    await this.store.set(session);
    return session;
  }

  async login(username, password) {
    const { clientId, clientSecret, base } = this._config();
    const data = await this._fetchJson('POST', `${base}/oauth2/token`, {
      clientId, clientSecret, username, password: md5(password),
    });
    return this._saveTokens(data);
  }

  // Concurrent callers share one refresh.
  refresh() {
    if (!this._refreshing) {
      this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  async _doRefresh() {
    const { clientId, clientSecret, base } = this._config();
    const session = await this.store.get();
    if (!session || !session.refreshToken) throw new TTLockError('not_logged_in', 'Not logged in to TTLock. Repair the device to log in');
    const data = await this._fetchJson('POST', `${base}/oauth2/token`, {
      clientId, clientSecret, grant_type: 'refresh_token', refresh_token: session.refreshToken,
    });
    return this._saveTokens(data, session);
  }

  // All locks of the account, paged (docs: pageSize <= 1000, we use 100).
  async listLocks() {
    const locks = [];
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const res = await this.request('GET', '/v3/lock/list', { pageNo, pageSize: 100 });
      const items = Array.isArray(res) ? res : (res.list || []); // verified: items under `list`
      locks.push(...items);
      if (items.length < 100) break;
    }
    return locks;
  }

  request(method, path, params = {}) {
    const call = () => this._call(method, path, params);
    return GATEWAY_PATHS.has(path) ? this.queue.add(call) : call();
  }

  async _call(method, path, params) {
    const { clientId, base } = this._config();
    const url = `${base}${path}`;
    let refreshed = false;
    let retries = 0;
    for (;;) {
      const session = await this.store.get();
      if (!session || !session.accessToken) throw new TTLockError('not_logged_in', 'Not logged in to TTLock. Repair the device to log in');
      try {
        return await this._fetchJson(method, url, {
          ...params, clientId, accessToken: session.accessToken, date: Date.now(),
        });
      } catch (err) {
        if (err.code === 10004 && !refreshed) {
          refreshed = true;
          await this.refresh();
        } else if (BUSY_CODES.includes(err.code) && retries < this.retryDelays.length) {
          await this.sleep(this.retryDelays[retries++]);
        } else {
          throw err;
        }
      }
    }
  }

}

module.exports = { TTLockClient, TTLockError, resolveBaseUrl, md5 };
