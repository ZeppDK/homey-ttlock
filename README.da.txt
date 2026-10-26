Styr dine TTLock-smartlåse fra Homey. Appen taler med TTLock-skyen, så låsen skal have en TTLock-gateway (eller indbygget WiFi), og Remote Unlock skal være slået til for låsen i TTLock-appen. Du skal bruge en TTLock-udviklerapplikation (client ID og secret), som du indtaster i appens indstillinger.

Låsens tilstand, batteriniveau og gatewayens signalstyrke opdateres med lange mellemrum for at holde sig inden for den gratis API-grænse, og opdateringer i realtid kommer via en webhook, som du registrerer i TTLock Management Center.
