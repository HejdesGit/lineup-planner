# Manuell QA-checklista

Den har checklistan ar avsedd for en kort release- eller regressionskontroll i UI:t.

## Forberedelse

- Starta appen lokalt med `npm run dev`.
- Anvand desktopvy for huvudfloden och mobilvy for en snabb responsivitetskontroll.
- Bekrafta att appen laddar utan synliga fel och att en uppstallning kan genereras.

## Basflode

- Fyll i en giltig spelarlista och generera en uppstallning.
- Bekrafta att matchoversikt, periodkort och speltidskort visas.
- Bekrafta att drag-and-drop eller manuella lasningar fortfarande fungerar utan att planen bryts.

## Fairness och malvakt

- Testa ett fall med `10` spelare, `3 x 20`, formation `2-3-1` och `3 byten`.
- Bekrafta att spelare med malvaktsperiod far den hogre mojliga totalminuten nar exakt jamn speltid inte gar att na.
- Testa ett kontrollfall med `9` spelare i samma installning.
- Bekrafta att alla spelare far samma totalminuter nar exakt jamn fordelning ar mojlig.

## Matchlage och live

- Starta period 1 och bekrafta att klocka, aktuellt byteblock och nasta byten uppdateras.
- Markera en aktiv spelare som `Tillfalligt ute` och bekrafta att ersattare kan valjas.
- Bekrafta live-bytet och kontrollera att periodplan, bank och speltidskort raknas om direkt.
- Satt tillbaka spelaren och bekrafta att fairnessen aterstalls rimligt i resten av planen.

## Slutkontroll

- Bekrafta att `Speltid per spelare` inte visar uppenbart orimliga minuter eller banktider.
- Bekrafta att inga fel syns i webblasarkonsolen.
- Dokumentera eventuella avvikelser med scenario, forvantat beteende och faktiskt utfall.
