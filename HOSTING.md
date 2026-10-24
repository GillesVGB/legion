# Bakarov op Bot-Hosting.net

**Update 2.5.5:** de gangpot sluit voortaan vrijdag om 23:59 Belgische tijd. De open termijn van zaterdag 24 oktober wordt bij de eerste start direct afgesloten en verwerkt. De twee gangpotwarns die Fronzy die dag gaf, worden alleen ingetrokken als de hostingdatabase precies twee actieve gangpotwarns van zijn account vindt; anders laat de bot ze staan en meldt hij dat in de console. De bot maakt ook **Waarschuwing 1** en **Waarschuwing 2** aan en synchroniseert die met het actieve aantal warns. De bot heeft hiervoor **Rollen beheren** nodig en zijn hoogste rol moet boven beide rollen staan. Herstart de hosting met Git auto-pull aan en behoud de bestaande `data/`-map.

**Update 2.3.0:** nieuwe gangleden zijn vrijgesteld in hun instapweek en betalen vanaf de volgende volledige termijn. Behoud de bestaande `data/`-map; de eerste betaalplicht wordt daarin blijvend opgeslagen. Bij de eerste synchronisatie worden alleen aantoonbare automatische gangpotwarns uit een instapweek gecorrigeerd. Herstart na het ophalen van de update om deze regel op de hosting toe te passen.

## Discord-inloggen instellen — 2.2.0

1. Open in Discord Developer Portal de applicatie met dezelfde `CLIENT_ID` als de bot, ga naar **OAuth2** en haal daar de **Client Secret** op. Dit is een ander geheim dan het bot-token.
2. Zet die privé in je hostingvariabelen of bestaande `.env`: `DISCORD_CLIENT_SECRET=...`. Zet de echte waarde nooit in GitHub of in de voorbeeldbestanden. Is een secret gedeeld, reset die dan eerst in Developer Portal.
3. Voeg bij **OAuth2 → Redirects** exact toe: `https://wlll36f6gd.apps.bot-hosting.cloud/api/dashboard/oauth/callback` en sla op.
4. Haal de nieuwste code op en herstart de hosting. Open het dashboard en klik **Inloggen met Discord**. Je hebt de ingestelde Legion Lead-rol nodig, ook wanneer je Administrator hebt. Test met het juiste Discord-account.

De callback wordt automatisch opgebouwd uit het vaste dashboardadres. Bij een andere deployment registreer je het adres uit `DASHBOARD_PUBLIC_URL` met `/api/dashboard/oauth/callback` erachter. Gebruik voor OAuth een vast HTTPS-adres; een wisselend tunneladres moet telkens opnieuw worden geregistreerd. De login-knop gaat naar het vaste adres, ook wanneer je eerst een alias bezoekt. Bestaande `.env`, databases en bot-token blijven behouden. Zonder Client Secret start de bot gewoon en blijft `/dashboard` voor Lead beschikbaar.


**Update 2.1.1:** het automatische overzicht is nu wekelijks, iedere zondag om 09:00 Belgische tijd over zondag t/m zaterdag. Maandcijfers worden alleen op aanvraag getoond. Haal de nieuwste code op en herstart de hosting; behoud `.env` en de volledige bestaande `data/`-map.

**Update 2.1.0:** behoud de bestaande `data/`-map en laat Git auto-pull de update ophalen bij een herstart. De bot controleert na starten automatisch eerdere warns tegenover al goedgekeurde afmeldingen; dit gebeurt op de hostingdatabase. Een lokaal uitgevoerde test wijzigt geen hostingwarns. De automatische overzichten volgen vanaf 2.1.1 het wekelijkse schema hierboven.

Voor de update naar Bakarov: haal de nieuwste code van `main` op en herstart één botinstantie. De opstartprocedure maakt eerst een gegevensback-up als automatische back-ups aanstaan. Behoud `.env` en de volledige `data/`-map, inclusief de bestanden met hun bestaande `legion-`-naam. Het logo staat in `src/branding-assets/`; neem die map ook mee als je handmatig uploadt. Het changelogbericht verschijnt eenmalig in het ingestelde updatekanaal.

Gebruik **Bakarov-FPS-ms.zip** voor FPS.ms of een vergelijkbare Linux x64-host. Het dashboard, de bot en de transcriptviewer starten samen. Het pakket bevat de officiële Cloudflare-client voor neutrale HTTPS-adressen; er staat geen bot-token of privé database in het codepakket.

## Bot-Hosting.net via GitHub

Voor de huidige Bakarov-deployment staat het vaste HTTPS-adres `https://wlll36f6gd.apps.bot-hosting.cloud` in `hosting.json`. Zodra de hosting `SERVER_PORT=25237` meegeeft, start het dashboard rechtstreeks op `0.0.0.0:25237`. Er wordt dan geen cloudflared gestart. Je hoeft hiervoor geen nieuwe `.env` te maken of token te veranderen.

Bij een andere deployment zet je `DASHBOARD_PUBLIC_URL` op het nieuwe HTTPS-basisadres uit Domains. De bot gebruikt de toegewezen `SERVER_PORT`, ook als `.env` nog `TRANSCRIPT_PORT=8793` bevat. De hosting verzorgt TLS; alle private dashboardacties behouden hun beveiligde cookie, leidingcontrole en CSRF-controle. De vaste hosting-URL wordt ook gebruikt voor nieuwe en bestaande transcriptknoppen.

1. Gebruik repository `https://github.com/GillesVGB/legion`, branch **main**, en zet **Git auto-pull** aan voor updates bij een herstart.
2. Kies runtime **Node.js 24** en **Entry File / STARTUP_FILE: index.js**.
3. Laat de standaard startopdracht dependencies installeren. Als je zelf een startopdracht instelt, gebruik `npm ci --omit=dev && exec node index.js` vanuit de hoofdmap van de deployment.
4. Stel je actuele `DISCORD_TOKEN` en `CLIENT_ID=1556774794358169652` in via het paneel of een private `.env`. Het dashboard gebruikt automatisch `bin/cloudflared`; `TRANSCRIPT_VIEWER_MODE=local` geeft ook webtranscripts. Zet geen tokens of databases in GitHub.
5. Behoud de hele bestaande `data/`-map en stop de lokale bot voordat je de hosting start. Herstart de hosting om de laatste commit op te halen. Wacht op **beide guilds gereed** en **Bakarov dashboard bereikbaar**; gebruik daarna `/dashboard`.

De standaard Node.js-startup leest `package.json` voor dependencies. Zie de officiële [installatiehandleiding](https://bot-hosting.net/docs/guides/set-up-a-deployment), [Git auto-pull](https://bot-hosting.net/changelog) en [startopdracht-documentatie](https://bot-hosting.net/api).

## Installeren

1. Stop de oude bot voordat je de nieuwe instantie start.
2. Kies **Node.js 24** en **Main file: index.js**. Op FPS.ms zet je **User uploaded files** aan.
3. Upload en pak `Bakarov-FPS-ms.zip` uit in `/home/container`. Controleer dat **index.js** en **package.json** rechtstreeks in die map staan, samen met `src/`, `bin/` en `guilds.json`. Ze mogen niet in een extra bovenliggende map staan.
4. Maak `.env` van `.env.hosting.example` en vul je actuele `DISCORD_TOKEN` in. De Application-ID staat al ingevuld. Deel `.env` niet en zet hem niet in Git.
5. Neem de **hele bestaande data-map** mee. De twee `legion-<guildId>.sqlite`-databases bewaren coins, warns, dossiers, dashboardinstellingen, transcripts, sleutels en aanname-DM’s. Stop de oude bot voor de definitieve kopie of gebruik een consistente SQLite-backup. Kopieer een actieve database niet zonder zijn nog aanwezige WAL/journal.
6. FPS.ms installeert de dependencies automatisch. Bij een eigen host voer je `npm ci --omit=dev` uit en start je met `npm start`.
7. Start de server. De console moet `Bakarov is online` en **beide guilds gereed** tonen. Het neutrale webadres volgt zodra de HTTPS-verbinding bereikbaar is.
8. Registreer bij een nieuwe installatie of gewijzigde commands eenmaal `npm run deploy`. In dit project zijn de commands al op de bestaande Discord-applicatie geregistreerd.

De bot moet **Server Members Intent** en **Message Content Intent** hebben. De leidingrollen en kanalen staan in `guilds.json`. Die bestaande waarden zijn voor de twee Bakarov-guilds ingevuld.

## Dashboard

**Update 1.7.0:** herstart met Git auto-pull om afmeldingen, gangpotvrijstellingen, herinneringen, het vangstenboek, botstatus en nieuwe dashboardinstellingen te laden. Neem geen lege data-map over je bestaande `data/` heen; schema 11 wordt automatisch gemigreerd. Het afmeldpaneel met twee knoppen staat in `1555685636017758248`. Lead beoordeelt aanvragen in het bestaande privé leidinglog. Een rode planningreactie is pas geldig na goedkeuring. Solliciteren en tickets openen werken uitsluitend in de communityserver.

De bot plaatst één changelogbericht voor deze versie in `1558496003726774432`. Botlogs gaan naar `1555685637129109586`. Het dashboard heeft nieuwe pagina's **Afmeldingen**, **Botstatus**, **Vangstenboek** en **Modules instellen**. Daar kun je gangpotbedragen, deadline, DM-tijden, Lead-meldingen, planning, vischallenges en overige bedrijfsinstellingen wijzigen. Standaard gaan ledenherinneringen donderdag/vrijdag om 18:00 en het Lead-overzicht vrijdag om 20:00 uit, in Belgische tijd. Betaalde en vrijgestelde leden worden overgeslagen.

**Update 1.6.2 — Gangpot:** de termijn loopt zaterdag–zaterdag, met als eerste deadline zaterdag 17 oktober 2026 om 23:59 Belgische tijd. Alleen leden met rol `1555685630640652347` moeten $25.000 betalen en `/gangpot betaling` doen. Lead `1555685630707769382` kiest ✅ Goedkeuren of ❌ Afkeuren in `1558238040932225034` of het dashboard. In `1555685634515927050` staat alleen informatie; in `1558420548000813126` worden het bevestigde totaal en de lijst met betaalde leden bijgewerkt. Zonder volledige goedkeuring vóór zaterdag 23:59 volgt één gangwarn, ook bij wachten op controle. Een later vinkje verwijdert die warn niet. De update zet bestaande open zondagtermijnen, meldingen en betalingen automatisch over. Bewaar je `data/` en `.env`.

Na deze update kan de leiding `/gangpot refresh` doen om de bestaande berichten direct bij te werken. `/gangpot betaling-verwijderen gebruiker:@lid` trekt de betalingen en open meldingen van die gebruiker voor de huidige week in; `termijn` en `reden` zijn optioneel. Het saldo wordt aangepast en de historie blijft bewaard. Een oude goedkeurknop kan de verwijderde betaling niet terugboeken. Ook eerdere correcties uit oudere versies worden bij de datamigratie zichtbaar als ingetrokken betaalmeldingen. Nieuwe subcommands worden bij starten automatisch geregistreerd.

Het dashboard start ook als `TRANSCRIPT_VIEWER_MODE=files` of `remote` staat. Die instelling bepaalt alleen hoe transcripts worden bewaard. Zonder expliciet `CLOUDFLARED_PATH` zoekt de bot automatisch de meegeleverde client in `bin/` en daarna in PATH. Op Linux maakt `index.js` de client uitvoerbaar.

Gebruik **/dashboard** in Discord met een leidingrol of als administrator. De bot geeft een privé inlogknop die twee minuten geldig is en één keer werkt. Het dashboard controleert bij ieder verzoek of je nog leiding bent in de geselecteerde guild. Je sessie duurt dertig minuten.

De pagina’s zijn Overzicht, Tickets, Sollicitaties, Transcripts, Gangwarns, Leden & rangen, Games & coins, Informatie, Instellingen en Activiteit. Sluiten, aannemen en afwijzen vereisen bevestiging. De volledige sollicitatietemplate blijft in het Discord-kanaal; er worden geen intakeformulieren toegevoegd.

De ledenlijst gebruikt dezelfde opgeslagen Discord-berichten bij iedere update en herstart. Als die bericht-ID’s ontbreken, zoekt de bot zijn bestaande ledenlijst terug. Eigen dubbele ledenlijsten worden samengevoegd; andere berichten blijven staan.

Als een bestaande sollicitatie na een verhuizing geen dossier in de database heeft, kan de bot het open dossier terugvinden via zijn oorspronkelijke privé kanaal, eigenaar en eigen knoppen. Een afgehandeld dossier wordt nooit heropend. Coins, warns en oude transcripts vereisen nog steeds de bestaande `data/`-map.

Ticket- en sollicitatie-embeds volgen de ledenstand: **groen** bij 0–19, **oranje** bij 20–24 en **rood** vanaf 25. Een aangenomen dossier en de aanname-DM zijn groen; afgewezen of gesloten dossiers zijn rood.

Ook bij **25/25** en de rode status blijft solliciteren mogelijk. Het paneel, de bevestiging en het sollicitatieticket melden dat het bekijken van de sollicitatie langer kan duren. Aannemen van een nieuw ganglid wacht op een vrije plaats; de sollicitatie blijft intussen open. De wachttijdmelding in bestaande open tickets verdwijnt automatisch zodra er weer plaats is.

## Back-ups, herinneringen en ledenoverzicht

Vanaf versie 1.8.0 maakt `index.js` bij een nieuwe versie een privé-back-up **voordat de bot de gegevens migreert**. Elke SQLite-database wordt consistent gekopieerd, inclusief gecommitteerde WAL-gegevens, en gecontroleerd. Bestaande back-ups worden niet opnieuw meegekopieerd. `.env`, tijdelijke SQLite-journals en symbolische links worden overgeslagen. De back-ups staan in **`data/backups/`** en gaan niet mee naar GitHub of de openbare codepakketten. Bij een gewone herstart van dezelfde versie volgt geen nieuwe automatische back-up.

Standaard worden de vijf nieuwste back-ups bewaard. In het dashboard van de hoofdserver, bij **Modules instellen**, kun je automatische back-ups in- of uitschakelen en 1 tot 30 kopieën laten bewaren. Een administrator kan daar **Nu back-up maken** kiezen. Handmatig vóór een code-update: `npm run backup`. Bij een mislukte verplichte back-up stopt de opstart vóór de migratie; controleer vrije schijfruimte en schrijfrechten. Een kopie op dezelfde hosting is geen externe disaster recovery: download zo nodig een eigen kopie via je hostingpaneel.

Herstellen: stop eerst de bot en bewaar de huidige data-map apart. Kopieer de bestanden uit de gekozen back-upmap, zonder `manifest.json`, naar een lege data-map. Start daarna de bot met de passende of nieuwere code. Bewaar je eigen `.env` apart. Wis of overschrijf geen gegevens terwijl de bot draait.

De activiteitencheck stuurt standaard **één DM-herinnering, 60 minuten vóór de deadline**, aan opgenomen leden zonder vinkje en zonder goedgekeurde langere afwezigheid. Bij korte checks komt deze niet eerder dan één minuut na het plaatsen. Het tijdstip (1 tot 10.080 minuten vooraf) en aan/uit zijn instelbaar bij Modules instellen. Een reactie, goedgekeurde afwezigheid, annulering of verstreken deadline stopt een nog wachtende herinnering. Een geblokkeerde DM wordt niet eindeloos herhaald.

**`/lidinfo lid:@lid`** toont uitsluitend aan de leiding de recente check-ins, afmeldingen en gangwarns van één lid. Hetzelfde overzicht open je met **Overzicht** bij Leden in het dashboard. Gegevens blijven per guild gescheiden.

Vaste Discord-berichten worden voortaan alleen aangepast wanneer de inhoud verandert. Achtergrondtaken worden afzonderlijk herhaald bij fouten; een fout in planning of een dossier stopt de andere modules niet. `/botstatus` toont ook deze fouten. `npm run check` controleert naast de configuratie ook de syntax van alle JavaScript-bestanden.

## Planning, promoties, wachtlijst en fun-missies

**Planning:** in de gangserver `1555685630640652338` gebruikt de leiding bijvoorbeeld `/planning datum:12-10-2026 tijd:20:30 afspreekpunt:Bakarov HQ`. De bot plaatst uitsluitend in kanaal `1555685633266163793` een gewoon tekstbericht, zonder embed of knoppen. Het bericht bevat datum, Belgische tijd, afspreekpunt en de voorbereiding: volledig geheald, voertuig afgetankt, repairkits en benodigde spullen mee, op tijd aanwezig en duidelijke communicatie.

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

De opstartregel toont de botversie en of het dashboard via **hostingadres** of **tunnel** draait. Bij directe hosting hoort `Bakarov dashboard luistert op hostingpoort 25237` te verschijnen en daarna `Bakarov dashboard bereikbaar`. Een ontbrekend antwoord op de poort wijst op een fout port/bind-adres; controleer de Domains-pagina en SERVER_PORT.

Als je een tunnel gebruikt: de bot probeert standaard IPv4 met protocol `auto` (QUIC, met fallback naar HTTP/2). Hij toont aparte DNS-, netwerk- en certificaatfouten, controleert de bereikbaarheid ook nadat hij online is en herstelt na een storing. Cloudflare vereist uitgaand UDP of TCP op poort 7844. Als de hosting beide blokkeert, gebruik het vaste HTTPS-adres via `DASHBOARD_PUBLIC_URL`. [Cloudflare-verbindingsproblemen](https://developers.cloudflare.com/tunnel/troubleshooting/).

- `Cannot find module /home/container/index.js`: het pakket is niet in de hoofdmap uitgepakt of Main file klopt niet.
- Discord `401` of `TokenInvalid`: vervang alleen het private bot-token in `.env` en herstart.
- `cloudflared ENOENT`: controleer `CLOUDFLARED_PATH=./bin/cloudflared` en of de binary aanwezig is. De bootstrap maakt hem op Linux uitvoerbaar.
- Geen dashboardlink: controleer het consolebericht `Bakarov dashboard bereikbaar`. `/dashboard` geeft bij ontbrekende of ongeschikte cloudflared een concrete fout. De bot probeert een verbroken tunnel automatisch opnieuw.
- `Cannot find package discord.js`: voer in de map met `package.json` eerst `npm ci` uit en start daarna met `npm start`.
- Fouten `10062` of `40060`, of wisselende reacties: controleer of maar één botinstantie met dit token draait. Stop de lokale bot als je de hosting gebruikt.
- Een FPS.ms Error Event zonder Node.js-stacktrace: controleer eerst de hostingserver; dit is een fout van het paneel/hostingsysteem.

De meegeleverde binary is voor **Linux x64**. Voor Windows of ARM kies je de bijpassende officiële [cloudflared-download](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) en stel je het executable-pad in `.env` in.

## Leesbare botlogs

Vanaf 1.8.1 hebben Discord-logs Nederlandse titels en duidelijke velden. Verwijderde berichten tonen de beschikbare tekst en bijlagen; wijzigingen tonen vóór en na. Dit werkt voor nieuwe gebeurtenissen. Eerder verwijderde berichten kunnen niet achteraf worden opgehaald. Niet-gecachete inhoud wordt als niet beschikbaar aangegeven. Vanaf 1.8.2 gaat ook berichtinhoud naar het ingestelde botlogkanaal, in de hoofdserver `1555685637129109586`. Wachtende logs volgen die bestemming eveneens. In het dashboard staan de details onder Activiteit. Lange logs worden verdeeld over meerdere berichten; de verzendvoortgang blijft bij herstarts bewaard.
