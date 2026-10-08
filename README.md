# Legion — Discord-bot voor Future RP

Een Nederlandstalige bot met gangwarns, sollicitatietickets, privétickets, een automatische ledenlijst, informatie en games. De bot draait als **Legion#1420** op deze computer. Zie `LIVE-STATUS.md` voor de actuele installatie. Het downloadpakket bevat geen bot-token of database.

## Jouw servers

| Guild | Functies |
| --- | --- |
| `1555685630640652338` | Sollicitaties, gangwarns, informatie en games. Tickets staan uit. |
| `1555726440933363753` | Sollicitaties, gangwarns, informatie, games en tickets. |

Het gecombineerde ticket- en sollicitatiepaneel staat ingesteld op **`1555726441759375398`**, bij de tweede guild. De bot controleert of het kanaal werkelijk bij die guild hoort. Dit paneel wordt bij starten geplaatst of ververst; opnieuw starten maakt geen duplicaat van hetzelfde paneel. In de eerste guild kun je met `/setup paneel:alles` een sollicitatie- en informatiepaneel plaatsen.

Rollen, kanaalinstellingen, warns, coins, spellen en dossiers zijn **per guild gescheiden**. Dezelfde speler kan dus in beide guilds een ander saldo en andere warns hebben. De bestaande rollen en categorieen zijn inmiddels ingevuld in `guilds.json`; de onderstaande installatie-instructies zijn bedoeld voor opnieuw installeren of verhuizen.

## In ongeveer 10 minuten installeren

1. Installeer [Node.js](https://nodejs.org/en/download). Gebruik Node 24 LTS, of minimaal Node 22.13.0. Pak het ZIP-bestand uit.
2. Gebruik je bestaande Legion-applicatie in de [Discord Developer Portal](https://discord.com/developers/applications), of maak een nieuwe applicatie. Open **Bot**, maak/reset het token en kopieer het. Kopieer onder **General Information** ook het **Application ID** als je een nieuwe applicatie gebruikt.
3. Kopieer `.env.example` naar `.env` en vul alleen `DISCORD_TOKEN` en `CLIENT_ID` in. Houd het token lokaal; stuur het niet in Discord of in een chat. Dit pakket bevat geen token.
4. Nodig dezelfde bot uit in **beide guilds**. Kies bij **Installation → Guild Install** de scopes `bot` en `applications.commands`. Geef de bot de onderstaande rechten. Zet onder **Bot → Privileged Gateway Intents** ook **Message Content Intent** en **Server Members Intent** aan: die zijn nodig voor gesprekstranscripts en het aantal leden met de Legion-rol. Deze zijn voor de bestaande Legion-applicatie al geactiveerd.
5. Open een terminal in de map met `package.json` en voer uit:

   ```powershell
   npm ci
   npm run check
   npm run deploy
   npm start
   ```

   `node index.js` werkt pas nadat `npm ci` de dependencies heeft geïnstalleerd. Laat maar één botinstantie tegelijk draaien. Gebruik op Windows een Windows-cloudflared-client in `bin/cloudflared.exe`; de Linux-client is bedoeld voor de hosting.

6. Gebruik als administrator **in elke guild**:

   ```text
   /inrichten leiding:@Legion-Leiding leden:@Legion
   ```

   Kies je echte rollen in Discord. `leden` is optioneel. De bot maakt een privécategorie voor sollicitaties en een privélogkanaal. Alleen in de tweede guild maakt hij ook een ticketcategorie. Hij bewaart de nieuwe ID's in de lokale database; je hoeft die niet achteraf handmatig in te vullen.

7. Het paneel in de tweede guild wordt automatisch geplaatst. Gebruik indien nodig `/setup paneel:alles`. In de eerste guild voer je `/setup paneel:alles kanaal:#solliciteren` uit met je eigen kanaal.

Botrechten: **Kanalen bekijken, Berichten versturen, Berichtgeschiedenis lezen, Links insluiten, Bestanden bijvoegen, Kanalen beheren en Rollen beheren**. Plaats de botrol boven de rollen die hij moet beheren, zeker boven de ledenrol. Administrator is niet nodig voor de bot. Je eigen account moet administrator zijn om `/inrichten` en `/setup` te gebruiken.

`npm run deploy` registreert 18 commands in de eerste guild en 19 in de tweede. Dit vervangt de bestaande guild-commands van deze bot-applicatie. Het script toont ook uitnodigingslinks met de juiste rechten.

## Commands

| Command | Gebruik |
| --- | --- |
| `/help` | Overzicht van de functies in de huidige guild. |
| `/info`, `/regels`, `/rangen` | Informatie, eigen gangregels en rangvolgorde. |
| `/gangwarn geven lid:@lid reden:...` | Leiding geeft een warn; log en DM worden geprobeerd. |
| `/gangwarn bekijken lid:@lid` | Leiding bekijkt de meest recente 15 warns en totaal actieve warns. |
| `/gangwarn intrekken id:... reden:...` | Leiding trekt een warn in; reden en historie blijven opgeslagen. |
| `/mijnwarns` | Lid ziet alleen zijn eigen warns, privé. |
| `/solliciteren` | Open direct een privé ticket met de volledige Legion-template. |
| `/sollicitatiestatus` | Bekijk privé je wachtlijstpositie, gesprekstatus of de beslissing. |
| `/planning datum tijd afspreekpunt` | Leiding plaatst een tekstbericht met vier emoji-reacties in het vaste gangkanaal. |
| `/planning-overzicht` | Bekijk privé de komende activiteiten in de gangserver. |
| `/planning-annuleren id` | Leiding sluit een planning en stopt nieuwe aanwezigheidskeuzes. |
| `/promotie lid rang motivatie` | Stel een hogere gangrang voor; vanaf drie unieke Lead-stemmen beslist de meerderheid. |
| `/missies` | Bekijk drie dagelijkse fun-missies en claim verdiende fictieve coins. |
| `/ticket openen` | Open direct een privéticket, uitsluitend in de tweede guild. |
| `/ticket sluiten` | Sluit het huidige ticket met een bevestiging. |
| `/saldo` | Je fictieve Legion-coins. |
| `/daily` | 250 coins, eenmaal per 24 uur. |
| `/leaderboard` | Top 10 van deze guild. |
| `/blackjack inzet:100` | Blackjack met knoppen. Kies een even inzet. |
| `/blackjack` | Hervat je open spel zonder nieuwe inzet. |
| `/coinflip inzet:100 keuze:kop` | Kop of munt. |
| `/dobbel aantal:2` | Eén tot zes dobbelstenen. |
| `/8ball vraag:...` | Een willekeurig grappig antwoord. |
| `/steenpapier keuze:steen` | Steen, papier, schaar tegen de bot. |
| `/fish` | Vissen: zeldzame vangsten geven meer coins, slechte vangsten kosten coins. |
| `/inrichten` | Administrator kiest leiding- en ledenrol en maakt kanalen. |
| `/setup paneel:alles` | Plaatst/ververst het gecombineerde paneel van deze guild. |

## Hoe de systemen werken

**Gangwarns.** Alleen de ingestelde leidingrollen en Discord-administrators kunnen warns beheren. Met een ingestelde ledenrol kun je alleen leden met die rol waarschuwen. Een gewoon stafflid kan geen administrator of lid met gelijke/hogere rang waarschuwen. Bij drie actieve warns bevat het leidinglog een duidelijke melding. Er volgt geen automatische kick of ban: de leiding beoordeelt de situatie. Als een DM niet kan worden afgeleverd, staat de warn wel opgeslagen en is hij via `/mijnwarns` te zien.

**Sollicitaties.** Eén klik of `/solliciteren` opent direct een privé ticket. De embed bevat jouw volledige template. De sollicitant typt zijn antwoorden in het kanaal; er verschijnen geen formulieren. De minimumleeftijd blijft 16 jaar en wordt door de leiding gecontroleerd. De leiding kan **Gesprek starten**, **Aannemen**, **Afwijzen** of **Sollicitatie sluiten**. Gesprek starten maakt een privé spraakkanaal voor de sollicitant en leiding, met een link in het ticket. Een bestaande gespreksruimte wordt hergebruikt. Bij afhandelen wordt die ruimte verwijderd; het tekstkanaal wordt verwijderd nadat het transcript veilig is opgeslagen. Bij aannemen wordt de ledenrol gegeven. Er kan één open sollicitatie per persoon per guild bestaan. Reeds ingediende sollicitaties behouden hun antwoorden.

**Plaatsen in de community-guild.** De bot telt mensen met rol `1555726440933363759` in guild `1555726440933363753`. Met 0-19 leden is de sollicitatiestatus groen, met 20-24 oranje en vanaf 25 rood. De status en het aantal beschikbare plekken veranderen automatisch bij rolwijzigingen en vertrek. Bij rood worden nieuwe sollicitaties geblokkeerd. Aannemen van een extra lid kan dan ook niet; de leiding krijgt uitleg. De capaciteit geldt voor de community-guild.

**Tickets.** De knop en `/ticket openen` maken direct een privé kanaal, zonder formulier of verplichte vraag vooraf. De aanvrager typt zijn vraag in het kanaal. Alleen de aanvrager, leiding en Discord-administrators hebben toegang. Een persoon kan één open ticket hebben. Na sluiten maakt de bot het transcript en verwijdert daarna het kanaal. Bij een mislukte export blijft het kanaal tijdelijk gesloten totdat het opnieuw proberen slaagt. Een nieuw dossier openen kan maximaal eenmaal per minuut.

**Transcripts, alleen in de community-guild.** Bij sluiten, aannemen of afwijzen gaat een sollicitatietranscript naar `1555746237582409789`. Vraagtranscripts gaan naar `1555747964461260861`. De knop **Transcript bekijken** opent een opgemaakte pagina met zoeken, HTML downloaden en printen/PDF. TXT- en HTML-bestanden blijven ook in Discord beschikbaar. De webinhoud is met AES-256-GCM versleuteld; de sleutel staat alleen in het fragment van de volledige dossierlink. Iedereen met die volledige link kan het gesprek openen: deel hem alleen met bevoegde personen. Er is geen ChatGPT-aanmelding nodig. De viewer toont alleen Legion, zonder persoonlijke naam in het adres of de vormgeving. Bijlagelinks kunnen verlopen.

**Automatische ledenlijst.** Kanaal `1555685633266163795` hoort bij guild `1555685630640652338`. Chef, Sous-Chef, Conseiller, Capitane, Head Killer, Killer, Spécialiste, Membre, Recruter en Hangaround worden in die volgorde getoond. Iedereen staat bij zijn hoogste rang; bots tellen niet mee. Rolwijzigingen, nieuwe leden, vertrek en naamwijzigingen verversen dezelfde berichten. Elke vijf minuten volgt ook een volledige synchronisatie.

**Openbare games.** Alle fun-resultaten, saldo, daily en leaderboard verschijnen in het kanaal. Blackjack is blauw tijdens spelen, groen bij winst, rood bij verlies en geel bij gelijkspel. `/fish` geeft 25 coins voor een gewone vis, 55 voor een ongebruikelijke vangst, 100-150 voor zeldzame vondsten en 500 voor de legendarische trofee. Slechte vangsten kosten 20-100 coins, met maximaal het beschikbare saldo. Games gebruiken uitsluitend fictieve Legion-coins, per guild gescheiden. De algemene wachttijd voor fun-acties is drie seconden.

**Privacy.** Dossierkanalen krijgen expliciete kanaaloverrides. Discord-administrators kunnen privékanalen altijd zien. De algemene logs en transcriptkanalen worden gecontroleerd op toegang voor de leiding, de bot en administrators. Gangwarns in de eerste guild gaan naar het door jou gekozen kanaal `1556778849407213698`; dat kanaal is ook zichtbaar voor Legion-leden. Warns en dossiers staan ook lokaal in de database; geef alleen beheerders toegang tot de hosting en backups.

**Games.** Iedereen begint in elke guild met 1.000 fictieve coins. Er zijn geen betalingen, geldprijzen, transfers of koppelingen met het FiveM-saldo. De standaard maximuminzet is 500. Blackjack gebruikt een geschud deck van 52 kaarten, past op soft 17, betaalt natuurlijke blackjack 3:2 en gewone winst 1:1. Gelijkspel geeft de inzet terug. Splits, verzekering en double down zitten niet in deze versie. Na 10 minuten wordt automatisch gepast. Lopende spellen en inzet blijven bewaard na herstart. Willekeur gebruikt Node's `crypto.randomInt`.

## Aanpassen

- **`content.json`**: naam, kleurenstijl via `.env`, welkomsttekst, gangregels, rangen en 8-ball-antwoorden. De voorbeeldregels zijn eigen Legion-afspraken. Vul actuele officiële Future RP-regels of een link zelf in; deze bot beweert niet dat de voorbeelden officiële serverregels zijn.
- **`.env`**: kleur, drempel voor warns, startcoins, daily, maximale inzet en blackjacktijd.
- **`guilds.json`**: de twee guilds, `ticketsEnabled`, het paneelkanaal en eventuele handmatig ingestelde rol-/kanaal-ID's. Laat de rol-/categorie-/logvelden leeg als je `/inrichten` gebruikt. Niet-lege waarden in dit bestand hebben na herstart voorrang op opgeslagen instellingen.
- **`gameChannelId` per guild**: vul een kanaal-ID in om games en economie tot dat kanaal te beperken.
- **`GAMES_MEMBERS_ONLY=true`**: games/economie alleen voor leden en leiding. Stel dan voor beide guilds ook `memberRoleId` in `guilds.json` in.

Als je de maximuminzet of commandopties wijzigt, voer opnieuw `npm run deploy` uit en herstart de bot. Nieuwe teksten en `.env`-instellingen worden na herstart gebruikt.

## Hosting en bewaren

De bot blijft online zolang `npm start` blijft draaien en de machine verbinding heeft. Voor 24/7 gebruik kun je hem op een Node-host of VPS draaien; je moet daarvoor zelf hosting kiezen. Start één botproces voor dit pakket.

Alle gegevens staan in `data/legion-<guildId>.sqlite`. Stop de bot voordat je een backup van de hele map `data/` maakt, of gebruik SQLite-backuptools. Bewaar die map bij updates of een verhuizing: daarin staan ook automatisch aangemaakte kanaal-ID's en paneelbericht-ID's. `data/` en `.env` horen niet in een openbare repository.

## Problemen oplossen

- **Geen commands zichtbaar:** nodig de bot uit met beide scopes, voer `npm run deploy` uit en controleer Application ID, token en guild-ID's. Sluit en heropen Discord zo nodig.
- **Paneelkanaal hoort bij een andere guild:** controleer `panelChannelId` in `guilds.json`. `/setup` kan expliciet een kanaal in de huidige guild kiezen.
- **Bot mist rechten:** controleer de botrol én kanaal-/categorieoverrides. Voor ledenrollen moet de botrol hoger staan.
- **Logkanaal niet privé:** verwijder toegang voor gewone ledenrollen en individuele niet-staff gebruikers. Gebruik bij voorkeur het automatisch aangemaakte `legion-logs`-kanaal en houd dit zichtbaar voor de leiding en bot.
- **Leidingrol veranderen:** handel eerst open dossiers af. Bestaande archieven houden hun oude kanaaloverrides; pas die zo nodig handmatig aan.
- **SQLite experimental warning:** Node kan dit melden. De lokale checks/tests werken met de gebruikte Node 24-runtime.

## Controle

In de eerste guild, waar geen Discord-transcriptkanaal is ingesteld, bewaart de bot vóór verwijderen een lokale TXT- en HTML-export in `data/transcripts/<guildId>/`. De community-guild gebruikt de twee ingestelde Discord-transcriptkanalen en de privé webviewer.

```powershell
npm run check
npm test
```

Er zijn 52 lokale tests voor onder andere twee guilds, ticketbeperking, stafftoegang, logprivacy, persistente opslag, blackjack, oude sollicitatiegegevens, de nieuwe tickettemplate, visuitbetalingen, rangindeling, veilige webtranscripts, uploadherstel en de capaciteitsgrenzen. Discord-commands, het paneel en de ledenlijst worden live gecontroleerd. Het klikken van een echt Discord-lid is niet geautomatiseerd.

Zie **`IDEEN.md`** voor uitbreidingen. De API-aanpak is gebaseerd op de officiële [Discord-documentatie voor application commands](https://docs.discord.com/developers/docs/interactions/slash-commands), [discord.js](https://discord.js.org/) en [Node SQLite-documentatie](https://nodejs.org/api/sqlite.html).

## Neutrale transcriptviewer

De live bot gebruikt een lokale viewer achter een Cloudflare Quick Tunnel. Die serveert uitsluitend de versleutelde dossiers en de viewerbestanden, geen botinstellingen, tokens of databasebestanden. De willekeurige HTTPS-hostnaam bevat geen persoonlijke naam. Een tunneladres werkt zolang deze computer, de bot en de tunnel draaien. Bij een nieuwe tunnel werkt de bot automatisch de knoppen op bestaande transcriptberichten bij; gebruik dus de nieuwste Discord-knop. Bewaar de map `data/` bij een verhuizing.

Voor een eigen installatie: download [cloudflared van Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/), zet `TRANSCRIPT_VIEWER_MODE=local` en stel `CLOUDFLARED_PATH` in op de executable. `TRANSCRIPT_PORT=8793` is alleen op 127.0.0.1 bereikbaar. Start de bot normaal; hij start en bewaakt de tunnel. De instelling `files` bewaart alleen de Discord-bestanden. Voor een vast adres en 24/7 bereikbaarheid kun je later een eigen domein en beheerde tunnel gebruiken.

Ticketnamen gebruiken de Discord-gebruikersnaam: `sollicitatie-gebruikersnaam`, `vraag-gebruikersnaam` en `gesprek-gebruikersnaam`. De interne dossiercodes blijven alleen voor opslag en betrouwbare knoppen bestaan. Bestaande open botkanalen worden bij opstart bijgewerkt.

Bij een tunnelstoring bewaart de bot het volledige transcript alvast lokaal. Zodra de verbinding terug is, verschijnen de bestanden en knop in Discord en wordt het kanaal verwijderd. Verwijder ticketkanalen niet zelf voordat de export is opgeslagen: Discord kan hun berichtgeschiedenis daarna niet teruggeven.

## Legion-dashboard en persoonlijke invites

Gebruik `/dashboard` als leiding om het dashboard te openen. Je kunt beide beschikbare guilds selecteren en tickets, sollicitaties, transcripts, warns, leden, coins, informatie en instellingen beheren. De inlogknop is privé, eenmalig en twee minuten geldig; de sessie duurt dertig minuten. Ieder verzoek controleert de actuele Discord-leidingrechten voor die guild.

Het dashboard staat op dezelfde neutrale HTTPS-origin als de transcriptviewer. Er is geen ChatGPT-aanmelding of OAuth-clientsecret nodig. De dashboardinstellingen worden per guild in SQLite bewaard. Games blijven openbaar in Discord.

Aannemen stuurt automatisch een groene DM met een gebruikersgebonden, eenmalige uitnodiging naar de gangserver `1555685630640652338`. De link vervalt na joinen en uiterlijk na 24 uur. De bot controleert bij Discord dat alleen de beoogde gebruiker de invite kan accepteren. Geblokkeerde DM’s worden zichtbaar in het dashboard. De sollicitant kan `/uitnodiging` gebruiken; leiding kan opnieuw sturen.

Ticket- en sollicitatie-embeds volgen automatisch groen, oranje of rood van de sollicitatiestatus. Definitief aangenomen is groen; afgewezen of gesloten is rood.

Voor verhuizen naar FPS.ms of andere Linux x64-bot-hosting: gebruik **Legion-FPS-ms.zip** en lees [HOSTING.md](HOSTING.md). Dit pakket heeft `index.js` rechtstreeks in de hoofdmap en een Linux-tunnelclient. Maak `.env` van `.env.hosting.example` en neem de volledige `data/`-map mee. Het algemene ZIP-bestand bevat code en instructies, geen private instellingen of databases.
