'use strict';

// Seam between the device and the way commands reach the lock. Only the cloud
// transport exists in phase 1; BLE and the local bridge plug in here later.
function cloudTransport(client) {
  return {
    name: 'cloud',
    lock: lockId => client.request('POST', '/v3/lock/lock', { lockId }),
    unlock: lockId => client.request('POST', '/v3/lock/unlock', { lockId }),
    // 0 locked, 1 unlocked, 2 unknown
    queryState: async lockId => (await client.request('GET', '/v3/lock/queryOpenState', { lockId })).state,
  };
}

// setting: 'auto' | 'cloud'. 'auto' will prefer BLE/bridge once they exist.
function getTransport(client, setting) {
  return cloudTransport(client);
}

module.exports = { getTransport };
