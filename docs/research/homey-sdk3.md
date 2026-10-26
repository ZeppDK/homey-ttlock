# Homey SDK v3 reference for a TTLock app (researched 2026-10-26)

Sources: apps.developer.homey.app, apps-sdk-v3.developer.homey.app, athombv/node-homey-lib, node-homey-oauth2app README, Homey community, GitHub. UNVERIFIED marked.

## 0. Existing TTLock Homey app
- **https://github.com/briis/ttlock-homey** (MIT, created 2026-07-26, v1.1.1, app id `com.briis.ttlock`, SDK3, platforms local+cloud, compatibility >=12.2.0). Cloud-only via `https://euapi.ttlock.com` + webhook; requires gateway. App Store listing UNVERIFIED.
- Structure: flat `app.json` (no .homeycompose). Files: app.js, api.js, lib/TTLockOAuth2Client.js, lib/TTLockOAuth2Token.js, lib/TTLockWebhookEvents.js, drivers/lock/{driver,device}.js, settings/index.html.
- Capabilities: locked, measure_battery, alarm_battery, measure_signal_strength + custom autolock_enabled, lock_sound_enabled, passage_mode_enabled (read-only), last_operator, last_trigger. No custom flow cards.
- Pairing: login_credentials → list_devices → add_devices; repair reuses login_credentials.
- OAuth: extends homey-oauth2app OAuth2Client: `TOKEN_URL = https://euapi.ttlock.com/oauth2/token`, `AUTHORIZATION_URL = null`; overrides onGetTokenByCredentials (password grant, md5), onRefreshToken, onRequestQuery (injects clientId, accessToken, date), onHandleResult (throw on errcode). clientId/secret from app settings page (homey.settings).
- Gateway queue: single promise queue for lock/unlock/state (gateway returns busy on parallel calls).
- Endpoints used: /v3/lock/list, detail, queryOpenState, lock, unlock, /v3/gateway/listByLock, setAutoLockTime, updateSetting (type 6).
- Polling every 5 min + webhook. lib/TTLockWebhookEvents.js maps recordType → action/description (ported from hass-ttlock).
- Forum workarounds: Device Capabilities AVD + HTTP flows; TTLock2MQTT (MatterVN) + MQTT Hub; Simpled G6 Matter hub (buggy).

## 1. App skeleton, CLI, platforms
- Layout: `.homeycompose/app.json`, `.homeycompose/{capabilities,flow/{triggers,conditions,actions}}/*.json`; `drivers/<id>/{driver.js,device.js,driver.compose.json,driver.settings.compose.json,driver.flow.compose.json,assets/{icon.svg,images/*}}`; `assets/{icon.svg,images/{small,large,xlarge}.png}`; `locales/en.json`; `settings/index.html`; `api.js`; `env.json`; `README.txt`; `.homeychangelog.json`. `/app.json` is generated — never hand-edit.
- Classes: Homey.App (`this.homey.app`), Homey.Driver (pairing, flow cards), Homey.Device.
- Device class `lock` (with `locked`, `lock_mode`).
- driver.compose.json: name, class, capabilities, capabilitiesOptions, images, platforms, connectivity (cloud/lan/ble/...), pair, repair, energy (`batteries: ["OTHER"]`), settings.
- Manifest: id, version, compatibility (>=5.0.0; briis >=12.2.0), sdk 3, name/description (i18n), category, permissions, images, author.name, brandColor (mandatory), platforms, tags, bugs, source, homepage, support.
- Runtime: Homey v12.9+ runs Node 22. Pure-JS packages only; native addons discouraged.
- CLI: `npm i -g homey`; `homey login`, `homey select`, `homey app create`, `homey app driver create`, `homey app flow create`, `homey app driver flow`, `homey app run` (Docker; `--remote`, `--network host`, `--clean`), `homey app install` (stays installed; needed for webhook tests), `homey app validate --level debug|publish|verified`, `homey app publish`, `homey app version patch --changelog.en "..."`, `homey app review`, `homey app translate`. Docker required for run/build on Pro 2023+.
- Platforms: Local (Pro, Pro mini, self-hosted) = everything. Homey Cloud/Bridge: no LAN, no homey:manager:api, no app-to-app, no custom app settings page, SDK3 only; BLE/OAuth/webhooks OK; no mutable global state; use this.homey.setTimeout/setInterval; onUninit; `.catch(this.error)` on all promises. Publishing for cloud needs Verified Developer and brand backing.

## 2. Capabilities for a lock (built-in, free flow cards)
| Capability | Type | Free flow cards |
|---|---|---|
| locked | boolean get/set, toggle | triggers locked_true/false; condition; actions Lock/Unlock |
| lock_mode | enum always_locked/always_unlocked/locked_until_unlock | trigger changed; condition; action |
| measure_battery | number 0-100, insights | value-change triggers |
| alarm_battery | boolean read-only | triggers true/false; condition |
| alarm_tamper | boolean read-only | triggers; condition |
| alarm_contact | boolean read-only (true = open) | triggers; condition |
| alarm_generic | boolean read-only | triggers; condition |
| measure_signal_strength | number | (briis uses for gateway RSSI) |
- `registerCapabilityListener('locked', async v => ...)` for Homey-initiated changes; `setCapabilityValue` to push state; throw on failure. `setUnavailable(msg)`/`setAvailable()` for offline (blocks flow actions).
- Custom capabilities: `.homeycompose/capabilities/<id>.json`: type (boolean/number/string/enum), title, getable, setable, uiComponent (toggle/slider/picker/sensor), icon, insights, uiQuickAction, min/max/step/decimals/units, enum values. Declare explicit flow cards for custom capabilities (auto cards UNVERIFIED). capabilitiesOptions per driver. Icons in `assets/capabilities/*.svg`.

## 3. Flow cards
- App-level: `.homeycompose/flow/{triggers,conditions,actions}/<id>.json`. Device-scoped: `drivers/<id>/driver.flow.compose.json` (`triggers/conditions/actions` arrays with `$filter`, e.g. `"class=lock"` or `"driver_id=lock"`), or app-level card with arg `{"type":"device","name":"device","filter":"driver_id=lock"}`.
- Card JSON: title, hint, titleFormatted (`[[arg]]`), args, tokens (triggers). Conditions invert with `!{{is|isn't}}`.
- Arg types: text, number (min/max/step), range, date (dd-mm-yyyy), time (HH:mm), dropdown (values [{id,title}]), multiselect, checkbox, color, autocomplete, device; top-level droptoken. `"required": false` for optional; `"duration": true` on actions.
- Autocomplete: `card.registerArgumentAutocompleteListener('arg', async (query, args) => [{name, description, id/data, icon|image}])` — filter on query yourself.
- Tokens on triggers: `"tokens":[{"name","type":"string|number|boolean|image","title","example"}]`; fire with `driver.getDeviceTriggerCard(id).trigger(device, tokens, state)` or `homey.flow.getTriggerCard(id).trigger(tokens, state)`. Global tokens: `homey.flow.createToken(id, {type,title})`. Action cards can return tokens (Advanced Flow only).
- Run listeners: `homey.flow.getActionCard('id').registerRunListener(async (args, state) => ...)`; conditions return boolean; triggers with args need a run listener returning match boolean (e.g. `args.method === state.method`).
- Style: short titles, no device names, no When/And/Then, titleFormatted for args, hint when unclear, translate all or none.

## 4. Settings
- App settings page: `settings/index.html` + `<script src="/homey.js" data-origin="settings">`, `onHomeyReady(Homey)`, `Homey.ready()`; `Homey.get/set/unset`, `Homey.on('settings.set')`, `Homey.api('GET','/path',null,cb)` → api.js routes declared in manifest; `Homey.alert/confirm/popup/openURL`. Backend: `this.homey.settings.get/set/unset/on('set')`. Not allowed on Homey Cloud.
- Device settings: `driver.settings.compose.json`; types text, password, textarea, number, checkbox, dropdown, group (children), label. Each needs id, type, label, value; hint, highlight optional. Reserved prefixes homey:, zw_, zb_, energy_. `async onSettings({oldSettings,newSettings,changedKeys})` — throw to reject. `setSettings()` does not fire onSettings.
- Storage: `device.data` immutable id (use lockId); `getStoreValue/setStoreValue` hidden persistence (tokens); settings = user-visible. homey-oauth2app stores tokens itself. `env.json` (uppercase keys, gitignored, bundled on publish) → `Homey.env.X` for WEBHOOK_ID/SECRET. `/userdata/` is publicly reachable over HTTP — no secrets.

## 5. Cloud webhooks and polling
- `homey.cloud.createWebhook(id, secret, data)` → CloudWebhook; `webhook.on('message', ({headers, query, body}) => ...)`; `webhook.unregister()`. Create at https://tools.developer.homey.app/webhooks → WEBHOOK_ID/SECRET in env.json.
- URL: `https://webhooks.athom.com/webhook/<WEBHOOK_ID>?homey=<HOMEY_ID>` (`await homey.cloud.getHomeyId()`). Route by `?homey=` then by lockId. TTLock POSTs form-encoded; `body.records` is a JSON string (parse with querystring.parse if body is a string).
- Webhooks don't work under `homey app run` in Docker (briis) — use `homey app install`.
- Limits undocumented (UNVERIFIED). Works on Cloud. Direct inbound HTTP to Homey is not possible without the Athom relay.
- Polling: `this.homey.setInterval` (auto-cleared on uninit). Serialize gateway calls. Poll + webhook; poll-only fallback.

## 6. BLE (ManagerBLE, `this.homey.ble`)
- Permission `homey:wireless:ble`; driver connectivity `ble`.
- API: `ble.discover([serviceUuids])` → BleAdvertisement[] (uuid, localName, serviceUuids, serviceData, manufacturerData, rssi, connectable, address); `ble.find(uuid)`; `ble.subscribeToAdvertisements(uuid, {rateLimitMs}, cb)` needs `hasFeature('ble-advertisements')` (Pro Early 2023+, Pro mini, Self-Hosted); `advertisement.connect()` → BlePeripheral: `discoverServices()`, `getService(uuid)`, `discoverAllServicesAndCharacteristics()`, `read/write(serviceUuid, charUuid[, buffer])`, `disconnect()`, disconnect event. Service `discoverCharacteristics([uuids])`. Characteristic `read()`, `write(data)`, `subscribeToNotifications(cb)`, `unsubscribeFromNotifications()`.
- Pitfalls: some peripherals allow one connection; since Homey 6.0 no auto-disconnect after idle — disconnect yourself; disconnect event may lag; handles/included services unsupported; connection may be refused if "in use by another app". MTU / write-without-response behaviour undocumented (UNVERIFIED). Range limited to Homey's location.
- Debug: BLE Developer Tool in Homey Developer Portal.

## 7. Network / local
- Outbound HTTP/WebSocket/TCP to LAN and internet needs no permission. Raw `net`/`dgram` work on Pro in practice (UNVERIFIED), not on Cloud.
- Discovery (`homey app discovery create`: mdns_sd, ssdp, mac) preferred over asking for an IP; guidelines reject IP prompts where discovery is possible.
- Permissions list: homey:wireless:ble, homey:wireless:433/868/ir, homey:wireless:nfc, homey:manager:api (avoid), geolocation, ledring, speech-output, homey:app:<id>.

## 8. Libraries
- homey-oauth2app: OAuth2App (static OAUTH2_CLIENT, OAUTH2_DRIVERS, OAUTH2_MULTI_SESSION), OAuth2Client (API_URL, TOKEN_URL, AUTHORIZATION_URL, SCOPES, TOKEN; get/post/put/delete; `on...` hooks), OAuth2Driver, OAuth2Device (`this.oAuth2Client`), OAuth2Token. Works for TTLock password grant as briis proves. Alternative: plain fetch client + device store.
- eslint-config-athom. md5 via Node `crypto`. `Date.now()` must be within 5 min of TTLock server.

## 9. App Store publishing
- `homey app validate --level publish` → `homey app publish` → Draft at tools.developer.homey.app → certification (≤2 weeks) → Test channel → Live.
- Images: app 250x175, 500x350, 1000x700 (small+large mandatory, lively/lifestyle, no logos); driver 75x75, 500x500, 1000x1000 on white; icons SVG 960x960 transparent, no gradients, each driver its own icon.
- README.txt: 1-2 plain paragraphs, no markdown/URLs. brandColor mandatory. Changelog via `.homeychangelog.json`. Name ≤4 words, brand name, no "Homey". English required; translate fully or not at all. Only needed permissions. Apps free. Avoid duplicates (briis exists → collaborate or justify). Never commit env.json. Verified Developer needed for Cloud.
