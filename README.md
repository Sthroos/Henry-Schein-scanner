# Henry Schein Barcode Bestellen

Browserextensie (Chrome/Edge + Firefox 151+) die barcodes van een Opticon OPN-2001
pocket memory scanner uitleest via Web Serial en automatisch toevoegt aan het
winkelmandje op henryschein.nl, via de eigen ingelogde sessie van de gebruiker.

**Status: lokale ontwikkeling.** Nog geen publieke store-listing.

## Mapstructuur

```
shared/           Alle logica en assets, identiek voor Chrome en Firefox
  background.js     Achtergrondproces: henryschein.nl-tab, naam/prijs opzoeken, toevoegen aan mandje
  content-panel.js  Overlay op henryschein.nl (Chrome én Firefox): Web Serial (OPN-2001) + wachtrij
  content-panel.css Opmaak van de overlay
  icon-*.png
firefox/manifest.json   Firefox-specifiek (background.scripts)
chrome/manifest.json    Chrome/Edge-specifiek (service_worker)
build.sh                Bouwt dist/chrome en dist/firefox uit shared/ + manifest
release.sh              Versie bumpen, bouwen, naar GitHub pushen, (later) store-publicatie
STORE_LISTING.md         Kant-en-klare teksten voor als er wél gepubliceerd wordt
.env.example             Store-credentials-sjabloon, nu leeg/ongebruikt
```

## Lokaal bouwen en testen

```bash
./build.sh
```

**Chrome/Edge:** `chrome://extensions` → Ontwikkelaarsmodus aan → "Uitgepakte extensie
laden" → `dist/chrome`.

**Firefox (155+):** `about:debugging#/runtime/this-firefox` → "Tijdelijke add-on
laden" → `dist/firefox/manifest.json`. Verdwijnt bij herstart van Firefox.

## Releasen (naar GitHub, nog geen store)

```bash
./release.sh 1.0.1 "Omschrijving van de wijziging"
```

Bouwt, commit, en pusht naar `main`. Chrome/Edge-publicatie via API wordt automatisch
overgeslagen zolang `.env` niet is aangemaakt (zie `.env.example`). Firefox blijft
altijd een handmatige upload op addons.mozilla.org, ook later.

## Nog niet geverifieerd

- OPN-2001 wake-retry (5s na TEMPORARY_ERROR) niet tegen het fysieke apparaat getest.
- Volledige geautomatiseerde batch (meerdere artikelen na elkaar, met redirect-afhandeling
  tussen elk artikel) nog niet end-to-end getest.
