'use strict';

// Gateway data from the cloud. Pure functions, no Homey dependencies.

const { asList } = require('./accessories');

const PAGE_SIZE = 200;

// 1 G1, 2 G2, 3 G3 (wired), 4 G4 (4G); '' for anything else (docs/research/ttlock-cloud-api.md section 4).
function versionName(gatewayVersion) {
  const version = Number(gatewayVersion);
  return Number.isInteger(version) && version >= 1 && version <= 4 ? `G${version}` : '';
}

// All gateways of the account (GET /v3/gateway/list: pageSize <= 200, orderBy 0/1/2 is required).
async function listGateways(client) {
  const gateways = [];
  for (let pageNo = 1; pageNo <= 5; pageNo++) {
    const res = await client.request('GET', '/v3/gateway/list', { pageNo, pageSize: PAGE_SIZE, orderBy: 0 });
    const items = asList(res);
    gateways.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return gateways;
}

// List item with the fields of gateway/detail on top.
// gateway/detail uses the list-item field names (verified on a real G2: isOnline, lockNum, gatewayVersion).
function mergeGateway(item, detail) {
  const merged = { ...item };
  if (detail && typeof detail === 'object') {
    for (const [key, value] of Object.entries(detail)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
  }
  return merged;
}

// What the device shows. offline is null when the cloud did not say (isOnline missing): keep the old state.
function gatewayStatus(gateway) {
  const hasOnline = gateway.isOnline !== undefined && gateway.isOnline !== null && gateway.isOnline !== '';
  const lockCount = Number(gateway.lockNum);
  return {
    offline: hasOnline ? Number(gateway.isOnline) === 0 : null,
    lockCount: Number.isFinite(lockCount) ? lockCount : null,
    version: versionName(gateway.gatewayVersion),
    mac: String(gateway.gatewayMac || ''),
    networkName: String(gateway.networkName || ''),
  };
}

// Which trigger to fire when offline flips: 'offline', 'online' or null. An unknown previous
// state (first poll) never fires.
function gatewayFlip(previousOffline, offline) {
  if (typeof previousOffline !== 'boolean' || typeof offline !== 'boolean' || previousOffline === offline) return null;
  return offline ? 'offline' : 'online';
}

module.exports = {
  versionName, listGateways, mergeGateway, gatewayStatus, gatewayFlip,
};
