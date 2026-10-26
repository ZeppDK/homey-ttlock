# TTLock Cloud API v3 reference (researched 2026-10-26)

Sources: official docs (static pages under `https://euopen.ttlock.com/documentPages/htmlPages/<file>`, nav manifest `.../pathEng/newMenu.xml`; the SPA URLs return an empty shell to plain fetch) and the doc mirror in jbergler/hass-ttlock (`docs/ttlock-cloud-api`, branch `develop`). UNVERIFIED = not seen in those.

## 1. Onboarding
1. Developer account at https://euopen.ttlock.com → create Application → manual review (days). client_id/client_secret on approved app page. Developer account cannot own locks. No sandbox.
   - Basic tier free: 30,000 API calls/month/application. Beyond that calls fail.
2. Locks must be initialized in the TTLock phone app. End user has a normal TTLock app account.
3. API auth uses the TTLock **app account** username + MD5(password). Never the developer login.
   - Alternative: `POST /v3/user/register` (clientId, clientSecret, username, password=md5, date) creates an app-less user, returns prefixed username.
4. Only top admin (or authorized admin) can manage a lock; other tokens give -2018. `lock/list` returns only locks the account is top admin of; shared eKeys via `key/list`.
5. Callback URL set manually in Management Center, one per application (§10).
6. Base URLs (region-bound, make configurable): EU `https://euapi.ttlock.com`, CN `https://cnapi.ttlock.com`, docs examples `https://api.sciener.com`. Paths `/oauth2/token`, `/v3/...`.

## 2. Auth
`POST {base}/oauth2/token`, form-urlencoded. Password grant (no grant_type): `clientId`, `clientSecret`, `username` (URL-encode @), `password` = 32-char lowercase MD5 hex.
Response: `{"access_token","uid","refresh_token","expires_in":7776000}` (90 days). Refresh: same URL, `grant_type=refresh_token`, `refresh_token`, clientId, clientSecret → new tokens; refresh_token valid 10 years. 10004 = expired/revoked → refresh, then re-login.
Every other call carries `clientId`, `accessToken`, `date` (ms epoch, within 5 min of server, else 80000) as form body (POST) or query (GET). HTTP 200 always; check `errcode != 0`. Write calls return `{"errcode":0,"errmsg":"none error message"}`; read calls return data directly.

## 3. Lock endpoints
- `GET /v3/lock/list` (cloud): pageNo, pageSize (≤1000), optional lockAlias, groupId. Items: lockId, lockName, lockAlias, lockMac, electricQuantity, featureValue (hex string), hasGateway, lockData, groupId, groupName, date.
- `GET /v3/lock/detail` (cloud, admin): + noKeyPwd (super passcode, sensitive), timezoneRawOffset (ms), modelNum, hardwareRevision, firmwareRevision, autoLockTime (s, -1 off), lockSound (0 unknown/1 on/2 off), soundVolume (1-5), privacyLock, tamperAlert, resetButton (0/1/2), openDirection (0/1 left/2 right), passageMode (1 on/2 off), passageModeAutoUnlock (1/2). Cached values. Fields may be absent.
- `GET /v3/lock/queryOpenState` (gateway/WiFi, live): `{"state":0 locked|1 unlocked|2 unknown}`; reflects door sensor if bound.
- `GET /v3/lock/queryElectricQuantity` (gateway, live): `{"electricQuantity":85}`.
- `GET /v3/lock/queryDate` → `{"date":ms}`; adjust via `gateway/adjustLockDatetime` (path UNVERIFIED). Wrong lock time breaks passcodes.
- `POST /v3/lock/unlock`, `POST /v3/lock/lock` (gateway/WiFi): lockId, date. Blocks several seconds. -4043 = "Remote unlock" switch off in the TTLock app (must be toggled in-app over BLE; no API). No returned state → follow with queryOpenState or webhook.
- `POST /v3/lock/setAutoLockTime`: seconds (0/-1 off), type (1 BLE-sync only, 2 via gateway). -4082 bad range.
- `POST /v3/lock/updateSetting`: type 2 privacy, 3 tamper, 4 reset button, 6 sound, 7 open direction, 8 volume, 10 WiFi power saving (BLE only), 11 door-unclosed alarm seconds; value 1 on/2 off (dir 1/2, vol 1-5, seconds 0=off); changeType 1 BLE-sync, 2 gateway.
- `POST /v3/lock/querySetting` (gateway): type 2,3,4,7 → `{"value":n}`.
- Passage mode: `POST /v3/lock/configurePassageMode` (passageMode 1/2, autoUnlock 1/2, type 1/2, cyclicConfig ≤5 × {isAllDay 1/2, startTime min, endTime min, weekDays [1-7]}); `GET /v3/lock/getPassageModeConfiguration`. Gate on featureValue bit 22.
- Working mode: `lock/configWorkingMode`, `lock/getWorkingMode` (paths UNVERIFIED).

### featureValue bitmask (hex string; use BigInt, bits exceed 56)
0 passcode, 1 card, 2 fingerprint, 3 wrist strap, 4 auto-lock configurable, 5 clear passcodes, 6 firmware upgrade, 7 passcode mgmt, 8 lock command, **10 unlock via gateway**, 11 freeze, 12 cyclic passcodes, 13 door sensor, **14 remote-unlock switch configurable**, 15 voice prompts, 16 NB-IoT, 18 query super passcode, 19 hotel card, 20 no clock chip, 22 passage mode, 23 passage auto-lock off, 24 wireless keypad, 28 tamper switch, 29 reset-button switch, 30 privacy switch, 32 deadlock, 34 cyclic card/fp, 35 privacy via app, 36 open direction, 37 finger vein, 41 keyfob, 43 volume/language, 44 QR, 46 passage auto-unlock, 47 add fingerprint via gateway, 50 wireless door sensor, 51 door-unlocked alert, **56 WiFi**, 58 WiFi fixed IP, 70 palm vein, 83 WiFi power-saving range, 84 multi-function keypad.
"Remotely controllable" = (hasGateway==1 OR bit 56) AND remote-unlock switch on (switch state not readable; detect via -4043).

## 4. Gateway endpoints (cloud)
- `GET /v3/gateway/list`: pageNo, pageSize (≤200), orderBy (0/1/2, required). Items: gatewayId, gatewayMac, gatewayName, gatewayVersion (1 G1, 2 G2, 3 G3 wired, 4 G4 4G), networkName, networkMac, lockNum, isOnline (0/1; lags minutes).
- `GET /v3/gateway/detail`: gatewayId.
- `GET /v3/gateway/listLock`: gatewayId → lockId, lockMac, lockName, lockAlias, rssi (> -75 strong, < -85 weak), updateDate. Relations cached ~30 min, RSSI ~10 min.
- `GET /v3/gateway/listByLock`: lockId → gatewayId, gatewayMac, gatewayName, rssi, rssiUpdateDate. Server uses best-RSSI gateway.
- Others exist: delete, rename, transfer, listDevice, uploadDetail, checkUpgrade, isInitSuccess (paths UNVERIFIED).
- Remote ops take seconds; generic `1` on poor signal.

## 5. Lock records
`GET /v3/lockRecord/list`: lockId, pageNo, pageSize (≤200), optional startDate/endDate (ms), uid, recordType, searchStr. Items: recordId, lockId, recordTypeFromLock, recordType, success (0/1), username, keyboardPwd, lockDate (ms), serverDate (ms). Cloud keeps 6 months. Records reach the cloud only via gateway/WiFi or app upload (`POST /v3/lockRecord/upload`).

recordType: Unlocks 1 app, 4 passcode, 7 IC card, 8 fingerprint, 9 wrist strap, 10 mechanical key, 12 gateway, 32 from inside, 46 unlock key, 49 hotel card, 55 remote control, 57 QR, 63 passage auto-unlock, 67 face, 75 app authorization, 76 remote authorization, 84/85 palm vein, 92 admin passcode. Locks 11 app, 33 fingerprint, 34 passcode, 35 IC card, 36 mechanical key, 47 lock key, 61 QR, 69 face, 86 palm vein. Events 29 force applied, 30 door sensor closed, 31 door sensor open, 44 tamper alert, 45 auto lock, 48 system locked (too many bad tries), 51 deleted card tried, 52/53 deadlock, 59 double locked, 60 cancel, 64 door unclosed alarm, 65 failed to unlock, 66 failed to lock, 91 IC card unlock failed (hass-ttlock). Others: 5/6/54 parking, 37 shutter, 42/43 mail, 50 high-temp, 58/62 QR fail, 68/71 face fail, 77-83 dual-auth steps, 88 palm fail.

## 6. Passcodes (keyboardPwd)
- `POST /v3/keyboardPwd/get` (random, cloud-computed, **no gateway**, 6-9 digits): lockId, keyboardPwdType, keyboardPwdName, startDate, endDate → keyboardPwd, keyboardPwdId. Types: 1 one-time (6 h), 2 permanent, 3 period, 4 delete-all (!), 5 weekend, 6 daily, 7 workday, 8-14 Mon..Sun cyclic. Random codes hour-accurate; permanent/period must be used within 24 h of start.
- `POST /v3/keyboardPwd/add` (custom, 4-9 digits, ≤250/lock): lockId, keyboardPwd, keyboardPwdName, keyboardPwdType (2/3), startDate/endDate, addType (1 BLE-sync, **2 via gateway**, 4 WiFi async). -3007 duplicate, -3009 full.
- `POST /v3/keyboardPwd/change`: lockId, keyboardPwdId, optional keyboardPwdName, newKeyboardPwd, startDate, endDate, changeType (1/2). -3008 never-used code can't change.
- `POST /v3/keyboardPwd/delete`: lockId, keyboardPwdId, deleteType (1/2).
- `GET /v3/lock/listKeyboardPwd`: lockId, searchStr, pageNo, pageSize (≤200), orderBy. Items: keyboardPwdId, keyboardPwd, keyboardPwdName, keyboardPwdType, startDate, endDate, sendDate, isCustom, senderUsername.
- Passcode changes do not trigger callbacks.

## 7. eKeys (cloud only)
- `POST /v3/key/send`: lockId, receiverUsername (registered user, or createUser=1), keyName, startDate, endDate, optional remarks, remoteEnable, keyRight → keyId. One eKey per user per lock.
- `POST /v3/key/delete` (keyId) — deleting top admin's own key deletes the lock!
- `POST /v3/key/freeze` / `unfreeze`. keyStatus 110401 normal, 110402 pending, 110405 frozen, 110408 deleted, 110410 reset.
- `GET /v3/key/list`: all eKeys incl. lockData (for BLE SDK), userType 110301 admin/110302 user, remoteEnable. Also key/get, listByLock, update (keyName, remoteEnable), authorize/unauthorize, getUnlockLink.

## 8. IC cards / fingerprints
- Cards: `GET /v3/identityCard/list`; `POST /v3/identityCard/add` or `addForReversedCardNumber` (addType 1/2 — 2 via gateway; start=end=0 permanent); `POST /v3/identityCard/delete` (deleteType 1/2); update, clear, rename.
- Fingerprints: `GET /v3/fingerprint/list`; **add is BLE-only** (bit 47 may allow gateway, UNVERIFIED); `POST /v3/fingerprint/delete` deleteType 2 works via gateway.
- Face, palm vein, QR, remote keyfob, wirelessKeypad families similar.

## 9. Accessories
- Wireless keypad: `GET /v3/wirelessKeypad/listByLock` (lockId) → wirelessKeypadId, Number, Name, Mac, electricQuantity. Bits 24/84.
- Door sensor: `GET /v3/doorSensor/query` (lockId) → doorSensorId, name, electricQuantity, version, mac, number, doorNotClosedWarningTime. `GET /v3/doorSensor/listRecord`. Bits 13/50. queryOpenState reflects it; records 30/31.
- WiFi lock: `GET /v3/wifiLock/detail` → networkName, wifiMac, rssiGrade, isOnline, powerSavingMode. -3035 in power saving.

## 10. Callback / webhook
- Set in Management Center; one URL per app; public **https**, port 80/443, valid cert. No API to register it.
- `POST` form-urlencoded: `notifyType`=1 (lock records), `lockId`, `lockMac`, `records` (JSON array as string), sometimes `admin`. Reply raw body `success`.
- Record: recordType, recordTypeFromLock, success, username, keyboardPwd, lockDate, serverDate, electricQuantity, lockMac.
- Only gateway/WiFi locks push. Also fires for gateway online/offline, WiFi async results, some door states, alarms (payloads UNVERIFIED). Not for passcode/card/fp changes or auto-lock.
- Callbacks go to the app whose token (for the admin account) has the longer validity. Duplicates possible: dedupe on lockId+lockDate+recordType.

## 11. Error codes
1 generic fail (BLE/network, retry) · -3 invalid param · 10000/10001 client id/secret · 10003 token missing · 10004 token invalid/expired · 10007 bad account/password · 10011 bad refresh token · 20002 not admin · 30002 invalid username · 30003 already registered · 30005 password must be md5 · 30006 API limit · 80000 date skew · 80002 bad JSON · 90000 server · -2018 permission denied · -4063 delete/transfer locks first.
Lock: -1003 not exist · -2025 frozen · -4043 not supported (remote-unlock off) · -4056 out of memory · -4082 bad auto-lock.
Gateway: -2012 no gateway · -3002 gateway offline · -3003 gateway busy (retry) · -3034 network not configured · -3035 WiFi power saving · -3036 lock offline · -3037 lock busy (retry) · -4037 no such gateway.
Passcode: -1007 · -2009 · -3006 (6-9 digits) · -3007 duplicate · -3008 · -3009 full. eKey: -1008, -1016, -2019, -2020, -2023, -4064, -1027. Card -1021, fingerprint -1023.

## 12. Limits, units, polling
- 30,000 calls/month on Basic. One lock polled every minute = 43,200/month. Poll slowly; prefer webhook. hass-ttlock polls 15 min + webhook.
- Serialize gateway commands (one at a time per account/gateway); retry -3003/-3037 with backoff; long timeouts (10+ s).
- All times ms epoch. `timezoneRawOffset` is the lock's UTC offset; serverDate most reliable.
- Page sizes ≤200 (records/passcodes/cards/fp/gateways). lockId stable across re-inits. lockAlias = user's name, lockName = factory name. lockData is sensitive.

## 13. Libraries
- jbergler/hass-ttlock (Python, active 2026-10): api.py, models.py (Features, RecordType), coordinator.py, webhook.py. Best cloud reference.
- npm: ttlock-api (erinapp), @knagyorg/ttlock-api, @sgbtz/ttlock-api, @dodi-smart/ttlock-api — small/unofficial; writing a thin fetch client is reasonable.
- briis/ttlock-homey (see homey-sdk3.md) — existing Homey cloud app.
