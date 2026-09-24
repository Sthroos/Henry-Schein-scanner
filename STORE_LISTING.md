# Store-listing tekst — kant-en-klaar om te plakken bij het indienen

## Naam
Henry Schein Barcode Bestellen

## Korte omschrijving (max ~132 tekens, Chrome Web Store)
Scan artikelen met een OPN-2001 barcodescanner en voeg ze automatisch toe aan je Henry Schein-winkelmandje.

## Uitgebreide omschrijving
Deze extensie leest barcodes uit van een Opticon OPN-2001 pocket memory scanner (via USB/Web Serial)
en voegt de gescande artikelnummers automatisch toe aan het winkelmandje op henryschein.nl, met behoud
van je eigen ingelogde sessie. Bedoeld voor huisartsenpraktijken en andere Henry Schein-klanten die
regelmatig dezelfde verbruiksartikelen (verband, naalden, catheters, ECG-plakkers, etc.) bestellen.

Werking: klik op het extensie-icoon, lees de scanner uit, controleer/pas de aantallen aan, en klik op
de knop om de artikelen automatisch aan het winkelmandje toe te voegen. Er wordt niets buiten je eigen
browser en henryschein.nl verzonden.

## Single purpose (verplicht veld Chrome Web Store)
Barcodes van een aangesloten Opticon OPN-2001 scanner uitlezen en de gescande artikelen toevoegen aan
het winkelmandje op henryschein.nl.

## Rechtvaardiging per permissie
- **host_permissions (https://www.henryschein.nl/*)** — nodig om de bestaande "snel bestellen"-functie
  op die pagina aan te roepen (dezelfde functie die de website zelf gebruikt als je handmatig een
  artikelnummer intypt), met behoud van de sessie van de ingelogde gebruiker.
- **scripting** — nodig om de barcode + het aantal in het bestaande invoerveld van henryschein.nl te
  zetten en de bestaande "toevoegen aan mandje"-knop van de site aan te roepen.
- **tabs** — nodig om te bepalen of er al een henryschein.nl-tabblad open is (anders wordt er één
  geopend) en om te wachten tot de pagina klaar is voordat het volgende artikel wordt toegevoegd.
- **sidePanel / sidebar_action** — toont de scaninterface (wachtrij, aantallen, verstuurknop) in een
  persistent zijpaneel naast de browser.

## Privacybeleid (korte tekst — host dit ergens en plak de URL in het formulier)
Deze extensie verzamelt, bewaart of verzendt geen persoonsgegevens. Gescande barcodes en aantallen
blijven lokaal in de browser totdat de gebruiker ze zelf naar henryschein.nl verstuurt via de eigen,
al ingelogde sessie van de gebruiker op die site. Er wordt geen data gedeeld met derden en er zijn
geen externe servers van de ontwikkelaar bij betrokken.

## Categorie
Productiviteit / Shopping

## Opmerking voor jezelf
Chrome Web Store vraagt bij host_permissions op een specifiek domein meestal om een link naar een
privacyverklaring, ook als er niets wordt verzameld — de tekst hierboven volstaat, gewoon als losse
pagina hosten (bv. een subpagina op hpnova.nl of een publieke Gist) en die URL invullen.
