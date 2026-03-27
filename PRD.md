# PRD: Backlog för 7v7-planeraren

## Bakgrund
Det här verktyget är en 7v7-planerare för barn runt 10 år. Verktyget ska hjälpa tränare att skapa matchplaner som stödjer:

- jämn speltid
- pedagogisk rotation
- tydlig kommunikation till tränare och föräldrar
- stöd för Stockholms- och Enskede-liknande utbildningsprinciper

## Produktmål

- Gör rättvisa och rotation enklare att uppnå i en enskild match.
- Minska risken för långa bänkperioder och svårtolkad speltid.
- Stöd tränare i att rotera målvakt över säsong utan att låsa flödet.
- Behåll verktyget lättviktigt, utan konto- eller backendkrav i v1.

## Principer och riktlinjer

- 7v7 för barn ska främja delaktighet, lärande och mycket speltid.
- Målvaktstid räknas som riktig speltid och måste kommuniceras tydligt.
- När chunk-granularitet gör exakt lik speltid omöjlig får produkten ge en mjuk tie-break-fördel till spelare med målvaktstid, så länge det inte tydligt försämrar vanlig fairness eller rotation.
- Barn bör prova olika roller över tid.
- Kortare bytesfönster är ofta bättre vid större trupper.
- MV-säsongsvyn är ett stöd för utbildningsmål, inte ett tvingande regelkrav i produkten.

## Statusöversikt

Statusvärden uppdateras manuellt i dokumentet:
`Not started`, `In progress`, `Blocked`, `Done`.

| ID | Initiativ | Prioritet | Status |
| --- | --- | --- | --- |
| B1 | Chunk-storleksrekommendation | P1 | Done |
| B2 | Tydligare MV-tid i spelartidsöversikten | P1 | Done |
| B3 | Normalisera scoring-vikter per truppstorlek | P2 | Done |
| B4 | Dynamiskt antal optimeringsförsök | P2 | Done |
| B5 | Säsongsvy för MV-rotation | P3 | Done |

## Prioriterad backlog

### B1 / P1: Chunk-storleksrekommendation
ID: B1  
Prioritet: P1  
Status: Done

#### Mål
Hjälp tränare att välja kortare bytesfönster när truppstorleken gör väntetiden lång för barnen.

#### Varför
Vid större trupper kan långa bytesfönster leda till långa pass på bänken. En mjuk rekommendation förbättrar beslutsstödet utan att begränsa tränaren.

#### Omfattning
Lägg till en icke-blockerande hint i UI nära valet av chunk-/bytesfönster.

Regel för visning i v1:

- visa rekommendationen när antal spelare är `>= 10`
- visa rekommendationen när valt bytesfönster är `>= 10`

Notering:
Detta är en avsiktligt enkel första heuristik i v1. Mer avancerade regler för uppskattad väntetid utvärderas senare och ingår inte i denna backloggpunkt.
Gränsen 10/10 är vald för att hålla regeln lätt att förstå i UI och enkel att testa i v1, inte för att representera en exakt modell av upplevd väntetid i alla truppstorlekar.

#### Acceptance criteria

- Hinten visas automatiskt baserat på nuvarande formulärdata.
- Hinten blockerar inte generering av uppställning.
- Texten uttrycker en rekommendation, inte ett fel.
- Ingen förändring görs i befintligt URL-share-format.

#### Beroenden / risker
Detta är en ren UX-förbättring utan algoritmändring.

### B2 / P1: Tydligare MV-tid i spelartidsöversikten
ID: B2  
Prioritet: P1  
Status: Done

#### Mål
Gör målvaktsminuter explicita så att total speltid blir lättare att förstå och lita på.

#### Varför
Föräldrar och tränare kan annars tolka total speltid som ojämn när delar av tiden varit i mål.

#### Omfattning
Uppdatera spelarsummering och detaljvy så att följande visas:

- MV-minuter
- utespelarminuter
- totalminuter

Beslut i v1:

- MV-minuter ska beräknas i UI från befintlig data
- ingen ny publik typ eller nytt fält i `PlayerSummary` ska införas för detta
- beräkningen ska bygga på befintliga `goalkeeperPeriods` och `periodMinutes`

#### Acceptance criteria

- En spelare med en hel målvaktsperiod får en numerisk uppdelning som `MV: 20 min + Utespelare: 20 min = 40 min totalt`.
- Detaljvyn ska alltid kunna visa full uppdelning mellan MV, utespelare och total.
- Summary-vyn får antingen visa `MV: 0 min` eller dölja MV-raden när värdet är 0, så länge totalen fortfarande är tydlig.
- Befintliga total- och bänkminuter förblir internt konsistenta.
- När exakt lik totalspeltid inte går att nå på grund av chunkindelningen får spelare med målvaktstid prioriteras till den högre möjliga minutnivån före rena utespelare, men bara som mjuk tie-break.

#### Beroenden / risker
Kräver att målvaktsminuter härleds från befintlig period- och chunkdata. Ingen ny persistens krävs.

Notering efter implementation:

- Fairness-regeln för målvakt påverkar inte publika typer.
- `targets` kan fortsatt tolkas som neutral totalfördelning, medan scheduler och live-omplanering får använda separata fairness-targets internt.
- Regeln är medvetet begränsad till fall där chunkstrukturen gör den stabil; i större trupper får inte målvaktsbias skapa sämre fragmentering eller rotationskvalitet.

### B3 / P2: Normalisera scoring-vikter per truppstorlek
ID: B3  
Prioritet: P2  
Status: Done

#### Mål
Gör scoring av kandidatscheman mer konsekvent mellan trupper på 8 till 12 spelare.

#### Varför
Per-spelare-aggregat växer med truppstorleken och kan annars få större relativ påverkan än avsett.

#### Omfattning
Uppdatera scheduler scoring så att per-spelare-aggregat normaliseras med `playerCount`.

Normalisering ska tillämpas på:

- `repeatPenalty`
- `periodStartPenalty`
- `fragmentedMinutesPenalty`
- `groupBreadthPenalty`
- `consecutiveBenchPenalty`
- `targetPenalty`

Normalisering ska inte tillämpas på:

- `minuteSpreadPenalty`
- `benchSpreadPenalty`
- `periodStartVariationPenalty`

Kalibrering i v1:

- normalisering får inte införas som en isolerad division utan samtidig omviktning av relativa multiplikatorer
- implementeringen ska uttryckligen jämföra scorer före och efter ändringen för trupper på 8, 10 och 12 spelare
- målet är att minska truppstorleksberoende utan att spread-penalties helt dominerar eller att rotationssignaler försvinner
- exakt omviktning fastställs i implementationen genom regressionsdriven kalibrering, inte genom att bevara gamla vikter blint
- om kalibreringen inte ger neutralt eller bättre utfall för de definierade regressionsfallen ska ändringen inte lanseras i v1, och befintlig scoring ska behållas

#### Acceptance criteria

- PRD:n skiljer tydligt på per-spelare-aggregat och spridningsbaserade penalties.
- Syftet är konsekvent beteende mellan truppstorlekar, inte en ny fairness-modell.
- Implementationen verifierar att rotations- och fragmenteringssignaler fortfarande påverkar vinnande plan efter normalisering.
- Implementationen har en tydlig fallback: om kalibreringen misslyckas behålls nuvarande scoring i stället för en halvjusterad normalisering.

#### Beroenden / risker
Beteende kan skifta mellan seeds. Implementationen ska säkra detta med regressionsfall och viktkalibrering efter normalisering.

Notering efter implementation:

- fragmenteringsnormaliseringen inkluderar en size-aware allowance som kompenserar för strukturellt extra bänk-/övergångsbelastning i större trupper
- vid 9 spelare, 20-minutersperioder och 10-minuters chunks kan ett minutspridningsgolv på ett helt chunk vara oundvikligt och ska inte i sig tolkas som ett separat schedulerfel

### B4 / P2: Dynamiskt antal optimeringsförsök
ID: B4  
Prioritet: P2  
Status: Done

#### Mål
Förbättra planens kvalitet när sökrymden växer med fler spelare och fler chunks.

#### Varför
Ett statiskt antal försök riskerar att bli onödigt lågt i mer komplexa scenarier.

#### Omfattning
Ersätt fast defaultvärde för `attempts` med en formel som tar hänsyn till trupp och antal chunks.

Formel i v1:

- `attempts = max(72, players.length * totalChunks * 2)`

#### Acceptance criteria

- Default förblir 72 i enklare scenarier.
- Större scenarier får automatiskt fler försök.
- Ingen ny användarinställning läggs till i v1.
- Implementationen testas tillsammans med B3 eftersom fler försök kan förstärka effekten av en ändrad scoringmodell.

#### Beroenden / risker
Detta är en robusthetsförbättring, inte ett löfte om ett visst fairness-utfall.

### B5 / P3: Säsongsvy för MV-rotation
ID: B5  
Prioritet: P3  
Status: Done

#### Mål
Påminn tränare om vilka barn som ännu inte har provat att stå i mål över tid.

#### Varför
Verktyget planerar en enskild match. Ett lättviktigt säsongsperspektiv kan stödja bättre målvaktsrotation utan att införa tung produktkomplexitet.

#### Omfattning
V1 ska vara lokal och frivillig:

- lokal lagring i samma webbläsare via `localStorage`
- inget konto
- ingen backend
- ingen inkludering i share-URL

Produktbeteende i v1:

- funktionen är valfri och icke-blockerande
- tränaren kan manuellt nollställa säsongshistoriken
- UI visar en enkel påminnelse, till exempel `Har inte stått i mål ännu`

Dataschema i v1:

- historiken matchas på spelarnamn, inte interna spelar-ID:n
- `localStorage` ska lagra en lista med spelarnamn som har stått i mål under säsongen
- historiken behöver inte lagra datum, motstånd eller seed i v1
- aktuell påminnelse byggs genom att jämföra nuvarande trupps namn mot den sparade namnlistan

Regler i v1:

- namnmatchning är exakt efter normaliserad trimning och gemener
- om ett namn stavas annorlunda mellan matcher behandlas det som en ny spelare
- spelare som inte finns i aktuell trupp ska inte visas i påminnelselistan men får ligga kvar i sparad historik tills tränaren återställer säsongen
- om `localStorage` inte är tillgängligt eller kastar fel ska funktionen tyst degradera och resten av matchplaneringen fortsätta fungera utan säsongshistorik

#### Acceptance criteria

- Historiken ligger kvar mellan besök i samma webbläsare.
- En resetfunktion rensar historiken.
- Matchplanering fungerar fullt ut även utan att funktionen används.
- Påminnelselistan baseras på aktuella spelarnamn i formuläret, inte på tidigare genererade interna ID:n.
- Om `localStorage` är blockerat, otillgängligt eller fullt visas ingen blockerande felbild och planeringen fortsätter utan sparad historik.

#### Beroenden / risker
Funktionen ska definieras som ett lättviktigt planeringsstöd, inte som en regelmotor.

## Viktiga gränssnitt och beslut

- Ingen backend, inga konton och inga lagprofiler ingår i denna iteration.
- Ingen ändring görs i befintligt share-URL-schema för någon av de fem backloggpunkterna.
- MV-rotationshistorik använder endast `localStorage` i v1.
- MV-rotationshistorik identifierar spelare via normaliserade namn i v1, inte via interna genererade ID:n.
- Inga nya obligatoriska formulärfält ska läggas till.
- Ingen checkbox-baserad uppgiftsstyrning används i PRD:n. Framdrift spåras endast via statusfält.
- Scheduler-ändringar ska i första hand vara interna.
- MV-minutvisning ska i v1 beräknas i UI och ska inte kräva ändring av publika typer.

## Testplan

- 10 eller fler spelare tillsammans med 10-minuterschunks visar rekommendationstext.
- 8 eller 9 spelare med kortare chunks visar inte rekommendationstext.
- En spelare med en målvaktsperiod visar korrekt uppdelning mellan MV, utespelare och total.
- En spelare utan målvaktsperiod får en konsekvent presentation enligt valt UI-beteende: antingen `MV: 0 min` eller dold MV-rad i summary, men full uppdelning ska kunna visas i detaljvy.
- Normalisering av scoring bryter inte befintliga fairness- och rotationsinvarianter.
- Normalisering och dynamiskt antal försök testas tillsammans i minst ett scenario per truppstorlek 8, 10 och 12 spelare.
- Efter normalisering kvarstår mätbar påverkan från repeat/fragmentation/group-breadth i vinnande planer.
- Större sökrymder använder automatiskt fler optimeringsförsök.
- MV-säsongspåminnelsen ligger kvar efter omladdning och kan återställas.
- MV-säsongspåminnelsen använder namnmatchning och fungerar även när interna spelar-ID:n genereras om.
- MV-säsongspåminnelsen degraderar korrekt när `localStorage` inte går att läsa eller skriva.
- Ingen förändring bryter delning av uppställning eller befintligt genereringsflöde.
- Statusfält i `PRD.md` kan uppdateras manuellt utan att dokumentstrukturen behöver ändras.

## Ej i scope nu

- konto/login
- molnsynk
- lagprofiler
- delningsbar MV-säsongshistorik
- tvingande regelmotor som blockerar tränarens val
- checkbox-subtasks eller projektstyrning utanför enkel status
- omdesign av hela scheduler-strategin utöver de två avgränsade interna ändringarna

## Mätbara utfall

- Färre frågor om varför total speltid ser ojämn ut när MV förekommer.
- Fler planer skapas med kortare bytesfönster vid större trupper.
- Färre tydliga kvalitetsfall där stora trupper beter sig annorlunda än små av rent scoring-skäl.
- MV-säsongsvyn används som stöd utan att öka komplexiteten i matchplaneringen.
- Framdrift i backloggen går att läsa direkt i PRD:n genom statusfält och statusöversikt.
