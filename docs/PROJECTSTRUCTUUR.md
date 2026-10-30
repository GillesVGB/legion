# Projectstructuur

## Waar staat wat?

```text
index.js                 Opstarten, omgeving laden en back-up vóór een update
src/
  app/                   Discord-client, events, onderhoud en geheugenbeheer
  commands/              Slashcommando's, registratie en botstatus
  config/                Configuratie laden en module-instellingen valideren
  data/                  SQLite-opslag, back-ups en opslagonderhoud
  common/                Gedeelde foutafhandeling, locks en Discordhulpfuncties
  logging/               Auditlog, berichtlogs en veilige logweergave
  dashboard/             Dashboardserver, Discord-login, instellingen en public/
  releases/              Versienotities en aankondigingen
  ui/                    Discordberichten, branding en afbeeldingen
  modules/
    absence/             Langere afmeldingen en planningafmeldingen
    applications/        Sollicitatietemplate, status, toelating en ledenlimiet
    check-ins/           Activiteitenchecks en herstel van reacties
    games/               Blackjack, vissen, coins en missies
    gangpot/             Betalingen, voorraad, herinneringen en betaalregels
    leveling/            Bericht-XP, actieve spraaktijd, levels en ranglijsten
    members/             Ledenlijst, promoties, ranggeschiedenis en ledenoverzicht
    moderation/          Beveiliging, warnrollen en bezwaren
    planning/            Activiteiten, aanmeldingen en reacties
    reports/             Week- en maandoverzichten
    tickets/             Tickets, wachtrij, gesprekskanalen en afhandeling
    transcripts/         Export, versleuteling en transcriptviewer met public/
scripts/                 Lokale controles, commandoregistratie en back-upscript
tests/                   Regressietests met aparte voorbeeldgegevens
docs/                    Uitleg voor onderhoud
data/                    Werkelijke privégegevens van de draaiende bot
```

`src/data/` bevat **programmacode**. De `data/`-map in de hoofdmap bevat **echte databases, back-ups en transcripts**. Die runtimegegevens staan niet in Git. De ingestelde `DATA_DIR` en bestaande databasebestandsnamen blijven hetzelfde.

De hosting start nog steeds met `node index.js` of `npm start`. De bestanden `.env`, `guilds.json`, `content.json` en `hosting.json` in de hoofdmap bepalen de omgeving en serverinstellingen.

## Een onderdeel aanpassen

1. Zoek de functie in `src/modules/`. Daar staat de logica van het onderdeel.
2. Een slashcommando toevoegen of wijzigen gebeurt in `src/commands/definitions.js`. De afhandeling staat bij de betreffende module; `src/app/bot.js` verbindt Discord-events met die functies.
3. Databasewijzigingen horen in `src/data/store.js`. Behoud bestaande gegevens en gebruik de back-up vóór opstarten.
4. Discordweergave staat in `src/ui/messages.js` of bij de module. Dashboardbestanden staan in `src/dashboard/public/` en transcriptbestanden in `src/modules/transcripts/public/`.
5. Pas de relevante tests aan en voer `npm run check` en de bijbehorende tests uit.
6. Verhoog de versie in `package.json` en `package-lock.json` en beschrijf de wijziging in `src/releases/notes.json`.

## Stijl

- Twee spaties inspringen, enkele aanhalingstekens en puntkomma's.
- Eén duidelijke verantwoordelijkheid per functie en module.
- Benoem wat de code doet. Gebruik opmerkingen voor de reden achter een keuze.
- Houd zichtbare Discordteksten Nederlands en technische bestandsnamen consistent.
- Zet tokens uitsluitend in de lokale omgeving. Commit geen databases, uploads of herstelbestanden.

De broncode gebruikt de opmaakinstellingen uit `.prettierrc.json`. Prettier is alleen een lokaal hulpmiddel; de hosting heeft geen extra runtimepakket nodig.

Lokaal opmaken:

```text
npx prettier@3.6.2 --write "src/**/*.js" "scripts/**/*.js" "tests/**/*.js" index.js
```

De controles van deze herindeling en bekende bestaande testproblemen staan in [Controles](CONTROLES.md).
