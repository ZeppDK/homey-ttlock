"""Lytter på ttlock/measure/# på Homey's MQTT-broker og skriver hver besked med lokal tid.
Brug: .venv/Scripts/python.exe mqtt-listen.py [sekunder]  (default: kør indtil Ctrl+C)
Login læses fra secrets.yaml (mqtt_user / mqtt_password)."""
import sys, time, re, pathlib
import paho.mqtt.client as mqtt

secrets = pathlib.Path(__file__).with_name("secrets.yaml").read_text(encoding="utf-8")
def secret(key):
    m = re.search(rf'^{key}:\s*"?([^"\n]*)"?\s*$', secrets, re.M)
    return m.group(1) if m else None

BROKER, PORT = "192.168.3.78", 1883
duration = float(sys.argv[1]) if len(sys.argv) > 1 else None
log = pathlib.Path(__file__).with_name("measure.log")

def on_connect(client, userdata, flags, reason_code, properties=None):
    print(f"connected rc={reason_code}; subscribing ttlock/measure/#", flush=True)
    client.subscribe("ttlock/measure/#")

def on_message(client, userdata, msg):
    line = f"{time.strftime('%H:%M:%S')} {msg.topic} {msg.payload.decode(errors='replace')}"
    print(line, flush=True)
    with log.open("a", encoding="utf-8") as f:
        f.write(line + "\n")

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ttlock-measure-listen")
client.username_pw_set(secret("mqtt_user"), secret("mqtt_password"))
client.on_connect = on_connect
client.on_message = on_message
client.connect(BROKER, PORT, 60)
if duration:
    client.loop_start(); time.sleep(duration); client.loop_stop()
else:
    client.loop_forever()
