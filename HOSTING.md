# Legion op Bot-Hosting.net

Gebruik **Legion-FPS-ms.zip** voor FPS.ms of een vergelijkbare Linux x64-host. Het dashboard, de bot en de transcriptviewer starten samen. Het pakket bevat de officiële Cloudflare-client voor neutrale HTTPS-adressen; er staat geen bot-token of privé database in het codepakket.

## Bot-Hosting.net via GitHub

Voor de huidige Legion-deployment staat het vaste HTTPS-adres `https://wlll36f6gd.apps.bot-hosting.cloud` in `hosting.json`. Zodra de hosting `SERVER_PORT=25237` meegeeft, start het dashboard rechtstreeks op `0.0.0.0:25237`. Er wordt dan geen cloudflared gestart. Je hoeft hiervoor geen nieuwe `.env` te maken of token te veranderen.

Bij een andere deployment zet je `DASHBOARD_PUBLIC_URL` op het nieuwe HTTPS-basisadres uit Domains. De bot gebruikt de toegewezen `SERVER_PORT`, ook als `.env` nog `TRANSCRIPT_PORT=8793` bevat. De hosting verzorgt TLS; alle private dashboardacties behouden hun beveiligde cookie, leidingcontrole en CSRF-controle. De vaste hosting-URL wordt ook gebruikt voor nieuwe en bestaande transcriptknoppen.

1. Gebruik repository `https://github.com/GillesVGB/legion`, branch **main**, en zet **Git auto-pull** aan voor updates bij een herstart.
2. Kies runtime **Node.js 24** en **Entry File / STARTUP_FILE: index.js**.
3. Laat de standaard startopdracht dependencies installeren. Als je zelf een startopdracht instelt, gebruik `npm ci --omit=dev && exec node index.js` vanuit de hoofdmap van de deployment.
4. Stel je actuele `DISCORD_TOKEN` en `CLIENT_ID=1556774794358169652` in via het paneel of een private `.env`. Het dashboard gebruikt automatisch `bin/cloudflared`; `TRANSCRIPT_VIEWER_MODE=local` geeft ook webtranscripts. Zet geen tokens of databases in GitHub.
5. Behoud de hele bestaande `data/`-map en stop de lokale bot voordat je de hosting start. Herstart de hosting om de laatste commit op te halen. Wacht op **beide guilds gereed** en **Legion dashboard bereikbaar**; gebruik daarna `/dashboard`.

De standaard Node.js-startup leest `package.json` voor dependencies. Zie de officiële [installatiehandleiding](https://bot-hosting.net/docs/guides/set-up-a-deployment), [Git auto-pull](https://bot-hosting.net/changelog) en [startopdracht-documentatie](https://bot-hosting.net/api).

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

**Update 1.6.0 — Gangpot:** na een herstart registreert de bot automatisch `/gangpot` in de hoofdserver. Leden doen `/gangpot betaling`; de Lead-rol `1555685630707769382` controleert met ✅ Goedkeuren of ❌ Afkeuren in `1558238040932225034` of via het dashboard. De weekbijdrage is $25.000. De eerste deadline is zondag 11 oktober 2026 om 23:59 Belgische tijd, daarna iedere zondag. Zonder volledige Lead-goedkeuring op tijd volgt automatisch één gangwarn per termijn, ook als een melding nog op controle wacht. Een later vinkje verwijdert die warn niet. Het bevestigde saldo wordt in `1555685634515927050` aangepast. Bewaar je bestaande `data/`; meldingen, betalingen en warns worden automatisch gemigreerd en blijven bij restarts bewaard.

Het dashboard start ook als `TRANSCRIPT_VIEWER_MODE=files` of `remote` staat. Die instelling bepaalt alleen hoe transcripts worden bewaard. Zonder expliciet `CLOUDFLARED_PATH` zoekt de bot automatisch de meegeleverde client in `bin/` en daarna in PATH. Op Linux maakt `index.js` de client uitvoerbaar.

Gebruik **/dashboard** in Discord met een leidingrol of als administrator. De bot geeft een privé inlogknop die twee minuten geldig is en één keer werkt. Het dashboard controleert bij ieder verzoek of je nog leiding bent in de geselecteerde guild. Je sessie duurt dertig minuten.

De pagina’s zijn Overzicht, Tickets, Sollicitaties, Transcripts, Gangwarns, Leden & rangen, Games & coins, Informatie, Instellingen en Activiteit. Sluiten, aannemen en afwijzen vereisen bevestiging. De volledige sollicitatietemplate blijft in het Discord-kanaal; er worden geen intakeformulieren toegevoegd.

De ledenlijst gebruikt dezelfde opgeslagen Discord-berichten bij iedere update en herstart. Als die bericht-ID’s ontbreken, zoekt de bot zijn bestaande ledenlijst terug. Eigen dubbele ledenlijsten worden samengevoegd; andere berichten blijven staan.

Als een bestaande sollicitatie na een verhuizing geen dossier in de database heeft, kan de bot het open dossier terugvinden via zijn oorspronkelijke privé kanaal, eigenaar en eigen knoppen. Een afgehandeld dossier wordt nooit heropend. Coins, warns en oude transcripts vereisen nog steeds de bestaande `data/`-map.

Ticket- en sollicitatie-embeds volgen de ledenstand: **groen** bij 0–19, **oranje** bij 20–24 en **rood** vanaf 25. Een aangenomen dossier en de aanname-DM zijn groen; afgewezen of gesloten dossiers zijn rood.

Ook bij **25/25** en de rode status blijft solliciteren mogelijk. Het paneel, de bevestiging en het sollicitatieticket melden dat het bekijken van de sollicitatie langer kan duren. Aannemen van een nieuw ganglid wacht op een vrije plaats; de sollicitatie blijft intussen open. De wachttijdmelding in bestaande open tickets verdwijnt automatisch zodra er weer plaats is.

## Planning, promoties, wachtlijst en fun-missies

**Planning:** in de gangserver `1555685630640652338` gebruikt de leiding bijvoorbeeld `/planning datum:12-10-2026 tijd:20:30 afspreekpunt:Legion HQ`. De bot plaatst uitsluitend in kanaal `1555685633266163793` een gewoon tekstbericht, zonder embed of knoppen. Het bericht bevat datum, Belgische tijd, afspreekpunt en de voorbereiding: volledig geheald, voertuig afgetankt, repairkits en benodigde spullen mee, op tijd aanwezig en duidelijke communicatie.

Bij `datum` kun je ook **deze avond** of **morgenavond** invullen of uit de suggesties kiezen. De bot rekent met de kalenderdatum in **Europe/Brussels**, ook rond middernacht, zomer- en wintertijd. `tijd` blijft de opgegeven starttijd bepalen. Een tijdstip dat deze avond al voorbij is wordt niet automatisch naar morgen verplaatst; de bot vraagt dan een toekomstig tijdstip te kiezen.

Het planningbericht toont bij die keuzes **Deze avond (DD/MM/JJJJ)** of **Morgenavond (DD/MM/JJJJ)**. Bij een zelf ingevoerde datum staat alleen de datum. Het gekozen label en de concrete datum blijven bewaard bij reacties en herstarts.

De bot voegt zelf vier reacties toe: **🟢 Ik ben erbij**, **🕒 Ik ben later**, **🔴 Ik ben er niet bij** en **🟠 Ik weet het nog niet zeker**. Leden klikken op een reactie; wisselen vervangt hun keuze. De keuze en aantallen worden in SQLite opgeslagen. Na een herstart controleert de bot ook de echte Discord-reacties. Bij meerdere tegenstrijdige reacties uit een offline periode wordt een eerder opgeslagen keuze behouden; zonder eerdere keuze worden de tegenstrijdige reacties verwijderd, zodat het lid opnieuw één keuze kan maken. De bot heeft **Reacties toevoegen**, **Berichten beheren** en **Berichtgeschiedenis lezen** nodig. Planning is niet beschikbaar in de community-server.

**Promoties:** `/promotie lid rang motivatie` is alleen in de gangserver beschikbaar. Leden kunnen zichzelf voorstellen; de leiding kan ook anderen voorstellen. Met **Goedkeuren** of **Afkeuren** stemmen minimaal **drie verschillende mensen met Lead-rol `1555685630707769382`**. Iedereen heeft één stem en kan die wijzigen zolang de stemming open is. Zodra er minstens drie geldige stemmen zijn, wint de meerderheid: **2 voor / 1 tegen** keurt goed; **1 voor / 2 tegen** keurt af. Bij gelijkstand blijft de stemming open. Administrators zonder Lead-rol en bots kunnen niet stemmen. De maker mag met de Lead-rol ook één stem uitbrengen, maar kan nooit alleen beslissen.

Stemmen blijven in SQLite bewaard bij een herstart. Vóór de beslissing controleert de bot opnieuw of stemmers nog de Lead-rol hebben. Een goedgekeurde uitslag wordt bij een tijdelijke Discord-storing automatisch uitgevoerd zodra dat weer kan. Zonder drie geldige stemmen wordt geen gangrang gewijzigd. Een open promotievoorstel per lid voorkomt dubbele aanvragen.

Alleen de gekozen hogere gangrang en de te vervangen gangrangen moeten onder de botrol staan. Een hoge, andere rol zoals `+` blokkeert de gangpromotie niet. De bot wijzigt uitsluitend afzonderlijke gangrollen, zodat andere en beheerde rollen behouden blijven. Bij ontbrekende rechten vermeldt de bot specifiek welke gangrol of permissie nog moet worden aangepast.

**Wachtlijst:** `/sollicitatiestatus` en de statusknop in het sollicitatieticket geven uitsluitend aan de sollicitant en leiding inzicht in de eigen status. Binnenkomstvolgorde wordt berekend over open sollicitaties en verandert wanneer dossiers worden afgehandeld. Een gepland gesprek wordt apart vermeld. De leiding bepaalt de beoordelingsvolgorde. Bij een volle gang blijft aanmelden mogelijk met de melding dat bekijken langer kan duren.

**Fun-missies:** `/missies` is een publieke gamefunctie in beide guilds. Vijf keer vissen geeft **175** extra coins, een afgerond blackjackspel **200**, en een geclaimde daily **100**. Voortgang telt alleen echte, succesvolle botacties. Beloningen kunnen uitsluitend door de speler zelf en één keer per missie per dag worden geclaimd. Nieuwe missies starten om **00:00 Belgische tijd**, ook bij zomer- en wintertijd. Coins zijn fictieve Discord-punten.

Het dashboard heeft nieuwe pagina’s **Planning** en **Promotievoorstellen**; Games & coins toont de missies. Promotievoorstellen toont de stemtelling en gebruikt dezelfde Lead-stemregels als Discord. Nieuwe slashcommands worden na een codewijziging automatisch per guild geregistreerd bij het opstarten. De database wordt zonder dataverlies uitgebreid naar schema 8. Bestaande open voorstellen krijgen na de update de nieuwe stemuitleg. Houd de hele `data/`-map bij updates en verhuizingen.

## Persoonlijke uitnodigingen

Bij aannemen krijgt de sollicitant een DM naar de gangserver **1555685630640652338**. De uitnodiging gebruikt Discord `target_user_ids`, uitsluitend met zijn gebruikers-ID, en `max_uses: 1`. De bot controleert de toegestane gebruiker na het maken van de invite. Zonder bevestigde beperking wordt geen uitnodiging verstuurd.

De link vervalt na het joinen en uiterlijk na 24 uur. Bij het joinen krijgt het lid de ingestelde gangledenrol. Mensen die al in de gangserver staan krijgen een aanname-DM met een gewone serverlink.

DM’s en invites staan in een verzendwachtrij in SQLite. Een herstart behoudt de openstaande berichten en voorkomt dubbele verzending. Als iemand DM’s blokkeert, toont het dashboard **DM geblokkeerd**. De leiding kan opnieuw sturen; de sollicitant kan zijn eigen invite ook ophalen met **/uitnodiging**. Het verwijderen van zijn aangenomen ledenrol trekt een nog openstaande uitnodiging in.

## Na een herstart of verhuizing

Een Cloudflare Quick Tunnel krijgt een nieuw willekeurig adres. De bot werkt de bestaande Discord-transcriptknoppen automatisch bij. Gebruik daarom de nieuwste knop en open het dashboard opnieuw via **/dashboard**. Er hoeft geen Windows-pad of persoonlijke domeinnaam te worden gebruikt.

De host moet uitgaande HTTPS- en Cloudflare Tunnel-verbindingen toestaan en child-processen kunnen starten. Voor een vast adres kun je later een eigen domein met een beheerde tunnel instellen; de normale installatie gebruikt de neutrale tijdelijke tunnel.

Bewaar `data/` op een **persistente schijf/volume** en maak regelmatig backups. Het dashboard kan je host niet herstellen als de hostingserver zelf uit staat. Het gratis FPS.ms-plan moet iedere 24 uur worden verlengd: [FPS.ms-informatie](https://fps.ms/free-discord-bot-hosting/).

## Als starten mislukt

De opstartregel toont de botversie en of het dashboard via **hostingadres** of **tunnel** draait. Bij directe hosting hoort `Legion dashboard luistert op hostingpoort 25237` te verschijnen en daarna `Legion dashboard bereikbaar`. Een ontbrekend antwoord op de poort wijst op een fout port/bind-adres; controleer de Domains-pagina en SERVER_PORT.

Als je een tunnel gebruikt: de bot probeert standaard IPv4 met protocol `auto` (QUIC, met fallback naar HTTP/2). Hij toont aparte DNS-, netwerk- en certificaatfouten, controleert de bereikbaarheid ook nadat hij online is en herstelt na een storing. Cloudflare vereist uitgaand UDP of TCP op poort 7844. Als de hosting beide blokkeert, gebruik het vaste HTTPS-adres via `DASHBOARD_PUBLIC_URL`. [Cloudflare-verbindingsproblemen](https://developers.cloudflare.com/tunnel/troubleshooting/).

- `Cannot find module /home/container/index.js`: het pakket is niet in de hoofdmap uitgepakt of Main file klopt niet.
- Discord `401` of `TokenInvalid`: vervang alleen het private bot-token in `.env` en herstart.
- `cloudflared ENOENT`: controleer `CLOUDFLARED_PATH=./bin/cloudflared` en of de binary aanwezig is. De bootstrap maakt hem op Linux uitvoerbaar.
- Geen dashboardlink: controleer het consolebericht `Legion dashboard bereikbaar`. `/dashboard` geeft bij ontbrekende of ongeschikte cloudflared een concrete fout. De bot probeert een verbroken tunnel automatisch opnieuw.
- `Cannot find package discord.js`: voer in de map met `package.json` eerst `npm ci` uit en start daarna met `npm start`.
- Fouten `10062` of `40060`, of wisselende reacties: controleer of maar één botinstantie met dit token draait. Stop de lokale bot als je de hosting gebruikt.
- Een FPS.ms Error Event zonder Node.js-stacktrace: controleer eerst de hostingserver; dit is een fout van het paneel/hostingsysteem.

De meegeleverde binary is voor **Linux x64**. Voor Windows of ARM kies je de bijpassende officiële [cloudflared-download](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) en stel je het executable-pad in `.env` in.
