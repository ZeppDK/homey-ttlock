# Fase 4b — lokal Bluetooth-bro til låsen

Dato: 2026-10-27. Research: `docs/research/ttlock-local-ble.md` + bro-rapport (opsummeret her).

## 1. Hvad vi ved om dit setup (verificeret i dag)

| Emne | Fund |
|---|---|
| Lås | SN667_PV53, hw 1.3, fw 6.7.15.240911, BLE-navn `RX-ODS_xxxxxx`, MAC `<lås-mac>` |
| Protokol | `lockVersion` = protocolType 5, protocolVersion 3, scene 2, groupId 10, orgId 40 → **V3**, som alle bro-projekter understøtter |
| Nøgler | `/v3/key/list?sdkVersion=2` returnerer `aesKeyStr`, `adminPwd`, `lockKey`, `lockFlagPos`, `keyboardPwdVersion` til din Application. Din eKey er `userType 110301` (admin). Felterne er obfuskerede (base64 + XOR-tabel), dekodningen er kendt |
| Homey BLE | Homey Pro 2023 hører 27 enheder men ikke låsen → Homey er uden for rækkevidde |
| ESP32 | Du har en klassisk ESP32 (samme type som komponentens forfatter bruger) |
| MQTT | Homey's egen MQTT-broker på `<homey-ip>:1883` accepterer bridge-kontoen. Mosquitto på Unraid bridger alle emner til den. en anden broker på LAN'et afviser den |
| ESPHome | Du har ESPHome-configs i `/mnt/user/appdata/ESPHome` (dashboard-container kører ikke pt.) |
| Home Assistant | HA in a box v3 kører på Unraid (bruges ikke i den anbefalede løsning) |
| Netværk | Gateway'en sidder på et IoT-VLAN, Homey på hoved-LAN'et; der routes imellem |

## 2. Tre muligheder

| | A: ESPHome-komponent på ESP32 (**anbefalet**) | B: Container på Unraid + ESP32 som BT-proxy | C: Node-port + gammel ESP32-gateway |
|---|---|---|---|
| Motor | bazuchan/esphome-ttlock (C++ i ESPHome, aktiv okt. 2026) | roquerodrigo/ttlock-ble (Python 3.14, beta) over bleak-esphome | kind3r/ttlock-sdk-js (død 2021) |
| Ekstra komponenter | Ingen. ESP32'en taler selv med låsen og eksponerer MQTT + REST | Python-container + stock ESPHome bluetooth_proxy | — |
| Features | Lås/lås op, batteri, gennemgangstilstand, status via advertisement | + koder, auto-lock, log, push-events mens forbundet | — |
| Risiko | Ung komponent, én vedligeholder; ESP32 deler radio mellem WiFi og BLE | Du skriver selv REST/MQTT-wrapperen; proxy-connects kan tage 20–40 s | Ikke levedygtig |
| Indsats | Lav | Mellem | — |

Koder, kort, eKeys og hændelses-log bliver under alle omstændigheder i cloud-delen af appen, som i dag. Broen overtager lås/lås op/status/batteri.

## 3. Arkitektur (option A)

```
Lås (BLE) ←→ ESP32 ved døren (ESPHome + ttlock-komponent, WiFi)
                 │ MQTT (retained state, LWT)           │ REST/SSE (valgfri, debug)
                 ▼
         Homey MQTT-broker <homey-ip>:1883  ←bridge→  Mosquitto på Unraid
                 ▼
         Homey-app dk.sepp.ttlock: transport "bridge"
           - kommandoer: publish LOCK/UNLOCK til <prefix>/lock/<navn>/command
           - status: subscribe <prefix>/lock/<navn>/state (LOCKED/UNLOCKED/JAMMED/NONE)
           - batteri: <prefix>/sensor/<navn>_battery/state
           - online: ESP32's LWT-emne (<prefix>/status online/offline)
           - fallback: cloud via gateway når broen er offline eller svarer JAMMED
         Cloud/webhook beholdes til hvem/hvordan (records), koder, kort, eKeys, indstillinger
```

Nøglerne hentes **én gang** via scriptet i trin 1 og lægges i ESPHome `secrets.yaml`. Derefter virker lås/lås op uden internet. Advertisement-status fanger også auto-lock, så bro-tilstanden erstatter timer-tricket fra cloud-delen.

## 4. Trin

| Trin | Indhold | Hvem | Verifikation |
|---|---|---|---|
| 1 | `scripts/bridge-credentials.js`: logger ind med clientId/secret/brugernavn/kodeord (argumenter, intet gemmes), kalder `key/list?sdkVersion=2`, dekoder `adminPwd`/`lockKey` (base64 → "n1,n2,…" → XOR med sidste byte ^ TABLE[n]) og normaliserer `aesKeyStr` (16 bytes, 2-cifret hex), printer en færdig `secrets.yaml`-blok + `lockVersion`. Unit-test på dekoderen med et kendt eksempel fra api2locks.py | Sonnet | `admin_ps` og `unlock_key` er heltal; `aes_key` er 32 hex-tegn |
| 2 | **Passiv måling** før komponenten: ESPHome-YAML med `esp32_ble_tracker` + `on_ble_manufacturer_data_advertise` filtreret på MAC, der logger flags/batteri. Flash ESP32, placér ved døren. Lås/lås op med app, fingeraftryk, tommelgreb og auto-lock, og se om flag-bit 0x01 følger med og hvor hurtigt | Bruger + mig | Tabel over hændelse → latens (sekunder eller "ses ikke") |
| 3 | ESPHome-YAML med `external_components` (bazuchan, kopieret lokalt), `ble_client` på MAC, `lock: platform: ttlock` med nøgler, `protocol_type/version/scene/group_id/org_id` fra lockVersion, `mqtt:` mod Homey-brokeren (bridge-konto, LWT), `web_server:` med auth. Framework `esp-idf`. Test LOCK/UNLOCK via MQTT | Mig | Låsen reagerer på MQTT-kommando inden for få sekunder; state-emnet opdateres |
| 4 | Homey-appen: `lib/bridge/MqttBridge.js` (npm `mqtt`), transport `bridge` i `lib/transport.js`, app-settings (broker host/port/bruger/kodeord, topic-prefix), device-setting `transport` får `bridge` aktiveret, `ttlock_transport`-capability, offline-detektion via LWT, fallback til cloud, auto-lock-timer slås fra når broen leverer status. Tests med fake MQTT-klient | Sonnet | `npm test` + validate grøn; lås op via Homey går over MQTT (ses i ESPHome-log) |
| 5 | Live-måling: 20 oplåsninger, latens bro vs cloud, stabilitet over en uge (ESP32-reconnects, JAMMED-tilfælde). Beslut om `locked` må bruges i sikkerheds-flows | Bruger + mig | Målinger i `docs/bridge-measurements.md` |

Trin 1 og 2 kan køre nu. Trin 3 kræver resultatet af 1; trin 4 kan bygges parallelt med 3 (MQTT-kontrakten er kendt fra ESPHome's `mqtt_lock`).

## 5. ESPHome-skitse (trin 3)

```yaml
esphome: { name: ttlock-hoveddoer }
esp32: { board: esp32dev, framework: { type: esp-idf } }
wifi: { ssid: !secret wifi_ssid, password: !secret wifi_password }
time: [ { platform: sntp } ]
logger: { level: INFO }
web_server: { port: 80, auth: { username: !secret web_user, password: !secret web_password } }
mqtt:
  broker: !secret mqtt_broker
  username: !secret mqtt_user
  password: !secret mqtt_password
  topic_prefix: ttlock/hoveddoer
  discovery: false
external_components:
  - source: { type: local, path: components }   # bazuchan/esphome-ttlock/components kopieret ind
    components: [ ttlock ]
esp32_ble_tracker:
ble_client:
  - mac_address: !secret ttlock_lock_mac
    id: hoveddoer_ble
lock:
  - platform: ttlock
    id: hoveddoer
    name: "Hoveddør"
    ble_client_id: hoveddoer_ble
    aes_key: !secret ttlock_aes_key
    admin_ps: !secret ttlock_admin_ps
    unlock_key: !secret ttlock_unlock_key
    protocol_type: 0x05
    protocol_version: 0x03
    scene: 0x02
    group_id: 10
    org_id: 40
    battery_level: { name: "Hoveddør batteri" }
    passage_mode: { name: "Hoveddør gennemgang" }
```

MQTT-kontrakt (ESPHome-standard): kommando `ttlock/hoveddoer/lock/hoveddoer/command` = `LOCK`|`UNLOCK`; status `ttlock/hoveddoer/lock/hoveddoer/state` = `LOCKED`|`UNLOCKED`|`JAMMED`|`NONE` (NONE ved boot, JAMMED ved fejl); LWT `ttlock/hoveddoer/status` = `online`|`offline`.

## 6. Risici og hvad vi gør ved dem

- **Manuel oplåsning (tommelgreb/nøgle) ses måske aldrig.** Kendt fra én anden låsemodel; firmwaren mærker kun "låst"-enden. Cloud'en ser det heller ikke i dag, så det er ikke en forværring. Trin 2 måler det på din lås.
- **Kommando 0x14 kan give falsk "ulåst".** Komponenten forespørger status efter hvert flag-skift; på én model svarer låsen altid "ulåst". Hvis det sker hos dig, patches komponenten til kun at stole på advertisement-flaget.
- **Én BLE-forbindelse ad gangen.** G2-gateway'en og telefon-appen forbinder også til låsen. Broen bruges som primær, gateway'en som fallback, så sammenstød er sjældne; komponenten melder JAMMED, og appen falder tilbage til cloud.
- **WiFi/BLE-sameksistens på ESP32.** Kan give langsomme connects; `fast_connect: false` og ekstern antenne er modtræk.
- **Nøglerne ligger på ESP32'en.** Alle på LAN'et med MQTT-login kan låse op. Hold bridge-kontoen privat, og overvej ACL i Homey's broker. Nulstilles eKey'en i TTLock-appen, skal nøglerne hentes igen (trin 1).
- **Undokumenteret endpoint.** `sdkVersion=2` på `key/list` er ikke i docs, men virker for din konto i dag. Fallback: `lock/detail` dokumenterer de samme felter.

## 7. Fallback (option B)

Hvis komponenten ikke taler med SN667: stock ESPHome `bluetooth_proxy: { active: true }` på samme ESP32, plus en container på Unraid med Python 3.14, `ttlock-ble` + `bleak-esphome`, der eksponerer MQTT med samme kontrakt som ovenfor. Homey-appen skal så ikke ændres. Indsats: 1–2 dage.
