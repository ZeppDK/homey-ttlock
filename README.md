# TTLock for Homey

A [Homey](https://homey.app) (SDK v3) app for [TTLock](https://www.ttlock.com) smart locks. It talks to the TTLock cloud through a TTLock gateway (or a WiFi lock) and gives you the lock, the gateway and the door sensor as Homey devices, with 45 flow cards covering passcodes, IC cards, fingerprints, eKeys, lock settings and events.

A local Bluetooth bridge (an ESP32 at the door, no cloud at runtime) is in progress; see [PLAN-4b.md](PLAN-4b.md).

> Built for personal use and tested against one lock (SN667, firmware 6.7.x) and one G2 gateway. It is published to the Homey App Store **test channel** only: install it from <https://homey.app/a/dk.sepp.ttlock/test/>, or with the Homey CLI as described below.

## Features

**Devices**

| Device | What you get |
|---|---|
| Lock | Lock / unlock, locked state, battery, gateway signal strength, tamper alarm, door contact (locks with a door sensor), "system locked" alarm, last user, last method, last event time, auto-lock time, passage mode, lock sound, sound volume, privacy lock, tamper alert switch, keypad battery (locks with a wireless keypad) |
| Gateway | Online/offline, number of locks, gateway generation (G1–G4) |
| Door sensor | Door open/closed, battery |

Capabilities are added per lock based on its `featureValue`, so a lock without a door sensor does not show a door contact.

**Flow cards**

- *Triggers (16):* Unlocked / Locked (with method filter and tokens for method, user, credential and time), Auto-locked, Failed unlock attempt, System locked after too many attempts, Tamper alert, Door opened / closed, Door left open alarm, Any lock event (raw record), Lock went offline / came online, Passage mode turned on / off, Gateway went offline / came online.
- *Conditions (7):* Lock is reachable, Last method is …, Last user is … (autocomplete), Passcode exists (autocomplete), Battery is below …, Passage mode is on, Gateway is online.
- *Actions (22):* Create one-time / timed / permanent / custom passcode (the new code is returned as a flow token), Delete passcode, Change end of passcode, Delete all passcodes, Add / delete IC card, Delete fingerprint, Send / freeze / unfreeze eKey, Refresh lock status, Get recent events (as text), Set auto-lock time, Set passage mode (with weekly schedule), Set lock sound / volume, Set privacy lock, Sync lock clock.

**Under the hood**

- Password-grant login with MD5 as the TTLock API requires, token refresh, and `errcode` mapping to readable messages.
- One queue for gateway-bound calls (TTLock gateways execute one command at a time) with back-off on "gateway busy".
- Real-time events through a Homey cloud webhook registered as the TTLock callback URL, plus slow polling (15 min default) to stay inside the free tier of 30,000 calls per month. The settings page shows the month's call count.
- TTLock sends no callback for auto-lock, so the app re-queries the lock state once the auto-lock time has passed.
- English and Danish.

## Requirements

- Homey Pro (tested on Homey Pro 2023, firmware 13.x). Homey Cloud is not supported (the app uses a settings page).
- A TTLock lock paired in the TTLock app, with **Remote Unlock** switched on in the lock's settings (this can only be done in the phone app, within Bluetooth range).
- A TTLock gateway (G2/G3/G4) or a WiFi lock.
- A TTLock Open Platform account at <https://euopen.ttlock.com> (EU) with an approved **Application** (approval takes a few days). You need its client ID and client secret.
- Node.js 22+ and the Homey CLI (`npm i -g homey`) on your computer to install the app.

## Installation

```bash
git clone https://github.com/ZeppDK/homey-ttlock.git
cd homey-ttlock
npm install
homey login
homey select
homey app install
```

Use `homey app install`, not `homey app run`: the webhook does not work in the Docker-based run mode.

### Optional: real-time events via webhook

1. Create a webhook at <https://tools.developer.homey.app/webhooks> and choose **Query Parameter** as the matching strategy.
2. Copy `env.example.json` to `env.json`, fill in `WEBHOOK_ID` and `WEBHOOK_SECRET`, and run `homey app install` again.
3. Open the app settings in Homey. The webhook URL shown there (it ends in `?homey=<your Homey ID>`) goes into the **Callback URL** field of your Application in the TTLock Management Center. Without the `?homey=` part TTLock's URL test fails with HTTP 400.

Without a webhook the app still works through polling, but events such as "unlocked by fingerprint" only arrive at the next poll.

## Setup in Homey

1. Apps → TTLock → Configure. Enter the client ID and client secret, choose the region (Europe for `euapi.ttlock.com`), and save.
2. Press **Test connection** with your TTLock **app** account (the one you log in to on the phone, which owns the lock; not the developer account). It should report the number of locks. Phone-number accounts work with the country code, e.g. `+4512345678`.
3. Devices → Add → TTLock → Lock, log in with the same account, pick the lock. Add the Gateway and, if your lock has one, the Door sensor the same way.

Error messages you may see: *Enable Remote Unlock in the TTLock app* (-4043), *Permission denied* (-2018, the account is not the lock's admin), *The gateway is busy* (-3003, retried automatically).

## Repository layout

```
app.js, api.js            app: webhook, diagnostics (GET /ble-scan, GET /key-fields)
lib/TTLockClient.js       cloud client (auth, queue, retries, error table)
lib/features.js           featureValue bitmask → capabilities
lib/records.js            recordType → state, tokens, door-sensor routing
lib/actions.js            flow action handlers (passcodes, cards, eKeys, settings)
lib/settingsMap.js        lock settings ↔ capabilities
lib/bridgeKeys.js         decoding of the BLE keys for the local bridge
drivers/lock|gateway|door_sensor
scripts/bridge-credentials.js   fetch + decode BLE keys → ESPHome secrets.yaml block
esphome/                  ESPHome configs for the local bridge (phase 4b)
docs/research/            API and SDK research the app is built on
PLAN.md, PLAN-4b.md       plans and decisions
test/                     unit tests (node --test)
```

## Development

```bash
npm test                              # 186 unit tests, no network needed
homey app validate --level publish
```

Everything that could not be confirmed against the official documentation is marked `// UNVERIFIED:` in the code. Items verified on a real lock are noted as such.

## Local Bluetooth bridge (phase 4b, work in progress)

TTLock gateways have no local API (a full port scan shows nothing open), but the lock itself can be controlled over Bluetooth with keys fetched once from the cloud. The plan is an ESP32 next to the door running the [bazuchan/esphome-ttlock](https://github.com/bazuchan/esphome-ttlock) component and publishing to MQTT, with the cloud as fallback. Current state:

- `npm run bridge-credentials` fetches the lock's BLE keys from the cloud and prints an ESPHome `secrets.yaml` block. Credentials are prompted for, never passed on the command line or stored.
- `esphome/ttlock-measure.yaml` is a passive listener that logs the lock's advertisement flags over MQTT, used to measure how reliably lock state can be observed before building on it.

## Acknowledgements

- [briis/ttlock-homey](https://github.com/briis/ttlock-homey) for the OAuth client pattern and the record-type map.
- [jbergler/hass-ttlock](https://github.com/jbergler/hass-ttlock) for the cloud API reference and webhook handling.
- [bazuchan/esphome-ttlock](https://github.com/bazuchan/esphome-ttlock), [roquerodrigo/ttlock-ble](https://github.com/roquerodrigo/ttlock-ble) and [n8henrie/ttlock-rs](https://github.com/n8henrie/ttlock-rs) for the BLE protocol work.

## License

[MIT](LICENSE).

## Disclaimer

This is an unofficial integration and is not affiliated with TTLock, Sciener or Athom. A smart lock controls access to your home; the lock state reported here is "last known" and should not be the only thing a security automation relies on.
