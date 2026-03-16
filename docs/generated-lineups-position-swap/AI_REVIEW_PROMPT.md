# AI Review Prompt

Du granskar exportdata i `docs/generated-lineups`. Fokusera på resultaten i exporten, inte på implementationskoden.

## Mål
- Bedöm om viktningen och normalized scoring verkar robusta och rimliga över hela exporten.
- Hitta tydliga fel, återkommande fairnessproblem och omotiverade skillnader mellan `legacy` och `normalized`.

## Arbetsordning
1. Börja med `summary.json` och notera dimensioner som sticker ut genom:
   - `flaggedExportCount > 0`
   - `validationFailureCount > 0`
   - icke-tomma `uniqueFlags`
   - hög `maxMinuteSpread` eller `maxBenchSpread`
2. Öppna `index.json` och välj en fast granskningsmatris:
   - 2 extrema scenarion med flest flaggade seeds, högst spreads eller tydligast avvikande aggregate-värden
   - 2 mer typiska eller medianlika scenarion utan flaggor eller valideringsfel
   - 2 kohortjämförelser där du håller så mycket som möjligt konstant men byter en dimension, till exempel formation, spelarantal eller antal byten
3. För varje valt scenario, läs `scenarios/<scenario-id>/manifest.json` och minst 2 `seed-<seed>.json`:
   - ett seed som verkar värst eller mest extremt
   - ett seed som verkar mer typiskt för samma scenario
4. Verifiera alltid mot scenarioets `config` i `index.json` eller `manifest.json`, inte bara mot scenario-id:t.

## Bedömningsregler
- Alla `validationFailureCount > 0` eller misslyckade `validations` är kritiska fynd.
- Alla icke-tomma `flags` är värdiga att kommentera, även om valideringarna passerar.
- Scenarion som ligger på eller nära högsta observerade `totalMinuteSpread` eller `benchMinuteSpread` ska granskas som hög prioritet.
- Bedöm korrekthet mot spelform, total speltid, bänktid, rotationsbredd och målvaktslåsning i scenarioets config.
- Använd dessa standardtrösklar om inte scenarioets regler tydligt motiverar något annat:
  - `totalMinuteSpread <= config.chunkMinutes` är normalt; `> config.chunkMinutes` ska kommenteras; `> 2 * config.chunkMinutes` är ett allvarligt fairnessproblem
  - `benchMinuteSpread <= config.chunkMinutes` är normalt; `> config.chunkMinutes` ska kommenteras; `> 2 * config.chunkMinutes` är ett allvarligt bänkproblem
  - ett problem är återkommande om samma typ av obalans eller flagga syns i minst 2 seeds för samma scenario eller om `aggregate.flaggedSeedCount >= 2`
- Jämför `normalized` mot `legacy` så här:
  - önskat: `normalized` minskar minutspridning, bänkspridning eller flaggor utan att skapa nya regelbrott
  - neutralt: skillnader under `0.5 * config.chunkMinutes` i spreads är små om `flags` och `validations` i övrigt är likvärdiga
  - varningsflagga: `normalized` ökar spridning, skapar smalare rotation, ger sämre bänkfördelning eller introducerar nya flaggor
- Om signalerna pekar åt olika håll, använd denna prioriteringsordning:
  1. inga nya valideringsfel
  2. färre eller mildare flaggor
  3. lägre `totalMinuteSpread`
  4. lägre `benchMinuteSpread`
  5. jämnare `playerMetrics` och bredare rotation

## Viktiga fält
- `scoreBreakdown.normalized`
- `scoreBreakdown.legacy`
- `derivedMetrics.totalMinuteSpread`
- `derivedMetrics.benchMinuteSpread`
- `derivedMetrics.playerMetrics`
- `validations`
- `flags`
- `aggregate.flaggedSeedCount`
- `aggregate.maxMinuteSpread`
- `aggregate.maxBenchSpread`
- `config.playerCount`
- `config.periodMinutes`
- `config.formation`
- `config.substitutionsPerPeriod`
- `config.goalkeeperMode`

## Önskat svar
1. En kort slutsats om viktningen verkar rimlig, delvis rimlig eller inte rimlig.
2. De tydligaste problemen, alltid med scenario-id, seed och konkreta evidensvärden.
3. Vad som ser stabilt ut över många scenarion eller kohorter.
4. Konkreta förslag på vilka penalties eller vikter som bör justeras, och varför.
5. Om inga tydliga problem hittas, säg det explicit och namnge vilka kontroller som passerade.
