'use strict';

// Shared by the drivers: login during pairing and repair, and the error codes that mean "log in again".

const LOGIN_CODES = [10003, 10004, 10011, 'not_logged_in'];

// Logs in with the TTLock app account; clientId/secret come from the app settings.
async function login(homey, { username, password }) {
  const config = homey.app.getConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error(homey.__('pair.missing_credentials'));
  }
  await homey.app.client.login(username, password);
  return true;
}

// Poll interval (minutes) newly paired devices start with.
function defaultPollInterval(homey) {
  return Math.max(5, Number(homey.settings.get('ttlock_poll_interval')) || 15);
}

module.exports = { LOGIN_CODES, login, defaultPollInterval };
