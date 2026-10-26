Control your TTLock smart locks from Homey. The app talks to the TTLock cloud, so the lock needs a TTLock gateway (or built-in WiFi) and Remote Unlock must be switched on for the lock in the TTLock app. You need a TTLock developer application (client ID and secret) which you enter in the app settings.

Locked state, battery level and gateway signal strength are refreshed at a slow interval to stay within the free API limit, and real-time updates arrive through a webhook that you register in the TTLock Management Center.
