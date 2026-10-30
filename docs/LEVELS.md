# Levelsysteem

De code staat in `src/modules/leveling/`: `index.js` handelt berichten en commando's af, `voice.js` meet aanwezigheid, `profiles.js` bewaart en leest XP, `cards.js` tekent PNG-kaarten en `notifications.js` verstuurt levelmeldingen. De tabellen `member_levels` en `level_up_notices` staan in de bestaande SQLite-database van iedere guild.

## Voortgang

Bericht-XP en spraak-XP tellen samen voor één level. De minimale totale XP voor level L is `100 * L * L`. Een nieuw profiel begint op level 0. Level 1 vereist 100 XP, level 2 vereist 400 XP en level 3 vereist 900 XP.

- `/level` toont je eigen profiel met een PNG-rankkaart; `/level lid:@naam` toont een ander huidig lid. De kaart bevat avatar, naam, level, positie, totale XP, de voortgang binnen dit level en resterende XP. Bericht- en spraakdetails staan ook als leesbare embedtekst bij de afbeelding.
- `/levels` toont de top tien huidige leden. Bots en vertrokken leden worden overgeslagen.
- **Dashboard → Levels** toont de top 25, inclusief de verdeling tussen bericht- en spraak-XP.

De commando's zijn voor iedereen zichtbaar en werken in beide servers. Iedere server heeft eigen XP. Gangrangen, promoties, financiële gegevens en fun-coins staan hier los van. Er worden geen levelrollen toegekend.

## Berichten

Standaard: 15 XP per geldig bericht, minimaal vijf tekens met letters of cijfers, maximaal één beloning per 60 seconden. Hetzelfde genormaliseerde bericht binnen tien minuten geeft geen nieuwe XP. De cooldown blijft na een herstart gelden.

Bots, webhooks, systeemmeldingen, alleen links/emoji's, geregistreerde tickets en hun threads, privéthreads en ingestelde log-/transcriptkanalen tellen niet mee. De beveiligingscontrole loopt vóór de XP-toekenning; afgekeurde berichten worden niet beloond. De XP-administratie bewaart een hash voor herhalingscontrole, geen kopie van de berichttekst.

## Spraak

Standaard: 5 XP per actieve minuut met minstens twee geldige deelnemers in hetzelfde gewone spraakkanaal. AFK- en stagekanalen tellen niet mee. Bots, deafened deelnemers en onderdrukte deelnemers tellen niet mee; self-mute en server-mute sluiten standaard ook uit. Mutecontrole kan via het dashboard worden uitgezet. Het minimum aantal deelnemers geldt voor de deelnemers die na deze controles overblijven.

De bot meet **aanwezigheid en Discordstatus**, niet of iemand daadwerkelijk praat. Audio wordt niet beluisterd of opgenomen. Metingen lopen iedere vijftien seconden en bij een wijziging van de stemstatus. XP-fracties blijven bewaard, zodat korte meetrondes niet steeds worden afgerond naar nul. Deelminuten tellen mee. Bij een kanaal-/deelnemerswissel kan een fractie van een seconde vervallen.

Na een herstart of disconnect begint een nieuwe meting; offline tijd telt niet mee. Een vertraagde meetronde telt maximaal zestig seconden. Wijzigingen in spraakinstellingen beginnen een nieuwe meting en boeken geen tijd onder de oude instelling achteraf bij.

## Instellingen

Onder **Modules instellen → Levels & XP** staan, afzonderlijk per guild:

- Levels aan/uit; bericht-XP en spraak-XP afzonderlijk aan/uit.
- XP per bericht, cooldown en minimale tekstlengte.
- XP per spraakminuut, minimum actieve deelnemers en mutecontrole.
- Maximaal twintig genegeerde kanaal- of categorie-ID's, gescheiden door komma's. Een genegeerde categorie sluit ook haar kanalen uit.
- Afbeeldingen bij een level omhoog aan/uit en een optioneel meldingskanaal-ID. Leeg gebruikt het kanaal van de verdiende XP; voor spraak is dit de tekstchat van het betrokken spraakkanaal, ook als het lid dat kanaal net verliet.

Uitschakelen bewaart de voortgang. Het systeem kent geen historische XP toe voor berichten of spraak van vóór de update. Bestaande databases en back-ups blijven op dezelfde plaats.

## Kaarten en verzending

Bij een levelovergang wordt binnen dezelfde XP-transactie een melding opgeslagen met de bereikte XP-stand. Er is maximaal één melding per lid en bereikt level. Bestaande levels leveren geen meldingen achteraf op. Bij een sprong over meerdere levels verschijnt één kaart voor het hoogste bereikte level. Nieuwe berichtmeldingen worden direct verwerkt; spraakmeldingen binnen de normale meetronde van vijftien seconden. Iedere ronde verwerkt maximaal drie meldingen per server; resterende meldingen komen de volgende ronde aan bod.

Een verbindings- of rechtenfout bewaart de melding voor een volgende poging, met een wachttijd van vijftien seconden oplopend tot tien minuten. Herstarts behouden de wachtrij. Na een mogelijk onderbroken verzending zoekt de bot in maximaal duizend recente berichten naar zijn eigen unieke melding, naast Discord-noncecontrole. Een teruggevonden melding wordt niet opnieuw gestuurd. Als die historie niet meer beschikbaar is, kan de bot een eerdere verzending niet met zekerheid herkennen. Bij uitschakelen worden wachtende meldingen overgeslagen, zodat opnieuw inschakelen geen inhaalronde veroorzaakt.

Een eigen kanaal moet in dezelfde server staan. Nodige rechten: Kanaal bekijken, Berichten versturen, Links insluiten, Bestanden bijvoegen en Berichtgeschiedenis lezen; voor een thread ook Berichten in threads versturen. Onbereikbare kanalen of ontbrekende rechten worden in de hostingconsole vermeld. Een vertrokken lid ontvangt geen melding.

De PNG-renderer gebruikt `@resvg/resvg-js` met meegeleverde Barlow-lettertypen onder de SIL Open Font License. Voer bij installatie `npm install` of `npm ci` uit op het doelsysteem, met optionele platformpakketten ingeschakeld. Afbeeldingen worden in het geheugen gemaakt en niet op schijf bewaard. Er rendert hoogstens één kaart tegelijk met maximaal vier actieve/wachtende opdrachten samen. Avatar-PNG's worden uitsluitend van Discord-CDN-hostnamen opgehaald, met maximaal drie seconden, 300 kB en 256 × 256 pixels. Bij een fout verschijnen initialen.
