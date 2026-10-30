# Levelsysteem

De code staat in `src/modules/leveling/`: `index.js` handelt berichten en commando's af, `voice.js` meet aanwezigheid en `profiles.js` bewaart en leest XP. De tabel `member_levels` staat in de bestaande SQLite-database van iedere guild.

## Voortgang

Bericht-XP en spraak-XP tellen samen voor één level. De minimale totale XP voor level L is `100 * L * L`. Een nieuw profiel begint op level 0. Level 1 vereist 100 XP, level 2 vereist 400 XP en level 3 vereist 900 XP.

- `/level` toont je eigen profiel; `/level lid:@naam` toont een ander huidig lid.
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

Uitschakelen bewaart de voortgang. Het systeem kent geen historische XP toe voor berichten of spraak van vóór de update. Bestaande databases en back-ups blijven op dezelfde plaats; alleen een nieuwe tabel wordt toegevoegd.
