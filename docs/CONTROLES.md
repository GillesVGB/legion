# Controle van de herindeling — 2.5.29

Gecontroleerd op 30 oktober 2026 met Node.js 24.14.0.

## Uitgevoerde controles

- `npm run check`: alle 113 JavaScriptbestanden geldig; configuratie en commando's voor beide guilds gecontroleerd.
- 75 gerichte tests slagen voor de projectindeling, gangpotregels, openstaande betalingen, wachtrijtickets, dashboardweergave, back-ups, geheugencaches, berichtlogs en beveiliging.
- Alle backendmodules kunnen worden geladen zonder de Discordbot te starten. Browserbestanden worden apart gehouden van de Node.js-modules.
- De projectroot en de standaardlocatie van de echte `data/`-map blijven gelijk. Een eigen `DATA_DIR` blijft hetzelfde werken.
- Zeven verplaatste assets zijn inhoudelijk gelijk aan de vorige versie. Binaire afbeeldingen zijn bytegelijk gecontroleerd; bij tekstbestanden zijn Windows-/Unixregeleinden genormaliseerd voor de vergelijking.
- De JavaScriptopmaak voldoet aan de vaste Prettierinstellingen.

## Bestaande testproblemen

De volledige testset was vóór de herindeling al niet volledig groen. Daarom is een nulmeting gemaakt met:

```text
node --test --test-concurrency=4 --test-timeout=15000 --test-force-exit --test-reporter=tap
```

| Resultaat | Voor de herindeling | Na de herindeling |
| --- | ---: | ---: |
| Geslaagd | 312 | 314 |
| Mislukt | 41 | 41 |
| Afgebroken door timeout | 1 | 1 |

De twee extra geslaagde tests controleren de nieuwe projectindeling. De namen van de mislukte en afgebroken tests zijn gelijk gebleven, met alleen de bedoelde wijziging van `.mjs` naar `.js` in bestandsnamen. Er zijn geen nieuwe testfouten toegevoegd.

De bestaande problemen omvatten onder meer verwachtingen van inmiddels verwijderde vrijstellingen en login-/HTTP-tests. Deze herindeling wijzigt die functies en verwachtingen niet. De volledige testset moet dus nog afzonderlijk worden bijgewerkt; dit verslag claimt geen volledig groene testset of live Discordtest.
