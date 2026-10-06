# Legion op Discord-bot-hosting

Gebruik **Legion-FPS-ms.zip** voor FPS.ms of een vergelijkbare Linux x64-host. Het dashboard, de bot en de transcriptviewer starten samen. Het pakket bevat de officiële Cloudflare-client voor neutrale HTTPS-adressen; er staat geen bot-token of privé database in het codepakket.

## Installeren

1. Stop de oude bot voordat je de nieuwe instantie start.
2. Kies **Node.js 24** en **Main file: index.js**. Op FPS.ms zet je **User uploaded files** aan.
3. Upload en pak `Legion-FPS-ms.zip` uit in `/home/container`. Controleer dat **index.js** en **package.json** rechtstreeks in die map staan, samen met `src/`, `bin/` en `guilds.json`. Ze mogen niet in een extra bovenliggende map staan.
4. Maak `.env` van `.env.hosting.example` en vul je actuele `DISCORD_TOKEN` in. De Application-ID staat al ingevuld. Deel `.env` niet en zet hem niet in Git.
5. Neem de **hele bestaande data-map** mee. De twee `legion-<guildId>.sqlite`-databases bewaren coins, warns, dossiers, dashboardinstellingen, transcripts, sleutels en aanname-DM’s. Stop de oude bot voor de definitieve kopie of gebruik een consistente SQLite-backup. Kopieer een actieve database niet zonder zijn nog aanwezige WAL/journal.
6. FPS.ms installeert de dependencies automatisch. Bij een eigen host voer je `npm ci --omit=dev` uit en start je met `npm start`.
7. Start de server. De console moet `Legion is online` en **beide guilds gereed** tonen. Het neutrale webadres volgt zodra de HTTPS-verbinding bereikbaar is.
8. Registreer bij een nieuwe installatie of gewijzigde commands eenmaal `npm run deploy`. In dit project zijn de commands al op de bestaande Discord-applicatie geregistreerd.

De bot moet **Server Members Intent** en **Message Content Intent** hebben. De leidingrollen en kanalen staan in `guilds.json`. Die bestaande waarden zijn voor de twee Legion-guilds ingevuld.

## Dashboard

Gebruik **/dashboard** in Discord met een leidingrol of als administrator. De bot geeft een privé inlogknop die twee minuten geldig is en één keer werkt. Het dashboard controleert bij ieder verzoek of je nog leiding bent in de geselecteerde guild. Je sessie duurt dertig minuten.

De pagina’s zijn Overzicht, Tickets, Sollicitaties, Transcripts, Gangwarns, Leden & rangen, Games & coins, Informatie, Instellingen en Activiteit. Sluiten, aannemen en afwijzen vereisen bevestiging. De volledige sollicitatietemplate blijft in het Discord-kanaal; er worden geen intakeformulieren toegevoegd.

Ticket- en sollicitatie-embeds volgen de ledenstand: **groen** bij 0–19, **oranje** bij 20–24 en **rood** vanaf 25. Een aangenomen dossier en de aanname-DM zijn groen; afgewezen of gesloten dossiers zijn rood.

## Persoonlijke uitnodigingen

Bij aannemen krijgt de sollicitant een DM naar de gangserver **1555685630640652338**. De uitnodiging gebruikt Discord `target_user_ids`, uitsluitend met zijn gebruikers-ID, en `max_uses: 1`. De bot controleert de toegestane gebruiker na het maken van de invite. Zonder bevestigde beperking wordt geen uitnodiging verstuurd.

De link vervalt na het joinen en uiterlijk na 24 uur. Bij het joinen krijgt het lid de ingestelde gangledenrol. Mensen die al in de gangserver staan krijgen een aanname-DM met een gewone serverlink.

DM’s en invites staan in een verzendwachtrij in SQLite. Een herstart behoudt de openstaande berichten en voorkomt dubbele verzending. Als iemand DM’s blokkeert, toont het dashboard **DM geblokkeerd**. De leiding kan opnieuw sturen; de sollicitant kan zijn eigen invite ook ophalen met **/uitnodiging**. Het verwijderen van zijn aangenomen ledenrol trekt een nog openstaande uitnodiging in.

## Na een herstart of verhuizing

Een Cloudflare Quick Tunnel krijgt een nieuw willekeurig adres. De bot werkt de bestaande Discord-transcriptknoppen automatisch bij. Gebruik daarom de nieuwste knop en open het dashboard opnieuw via **/dashboard**. Er hoeft geen Windows-pad of persoonlijke domeinnaam te worden gebruikt.

De host moet uitgaande HTTPS- en Cloudflare Tunnel-verbindingen toestaan en child-processen kunnen starten. Voor een vast adres kun je later een eigen domein met een beheerde tunnel instellen; de normale installatie gebruikt de neutrale tijdelijke tunnel.

Bewaar `data/` op een **persistente schijf/volume** en maak regelmatig backups. Het dashboard kan je host niet herstellen als de hostingserver zelf uit staat. Het gratis FPS.ms-plan moet iedere 24 uur worden verlengd: [FPS.ms-informatie](https://fps.ms/free-discord-bot-hosting/).

## Als starten mislukt

- `Cannot find module /home/container/index.js`: het pakket is niet in de hoofdmap uitgepakt of Main file klopt niet.
- Discord `401` of `TokenInvalid`: vervang alleen het private bot-token in `.env` en herstart.
- `cloudflared ENOENT`: controleer `CLOUDFLARED_PATH=./bin/cloudflared` en of de binary aanwezig is. De bootstrap maakt hem op Linux uitvoerbaar.
- Geen dashboardlink: wacht op het consolebericht dat de transcriptviewer bereikbaar is. De bot probeert een verbroken tunnel automatisch opnieuw.
- Een FPS.ms Error Event zonder Node.js-stacktrace: controleer eerst de hostingserver; dit is een fout van het paneel/hostingsysteem.

De meegeleverde binary is voor **Linux x64**. Voor Windows of ARM kies je de bijpassende officiële [cloudflared-download](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) en stel je het executable-pad in `.env` in.
