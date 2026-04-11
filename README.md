# lineup-planner

`lineup-planner` ar en statisk React-app for att planera 7v7-uppstallningar, malvakter och byten over tre perioder.

Appen ar byggd for att snabbt ta fram ett spelbart matchschema dar speltid, banktid och roller fordels rimligt over laget. Resultatet kan justeras manuellt i UI:t och delas vidare via lank eller WhatsApp.

## Funktioner

- Genererar uppstallning for 3 perioder med valbart matchformat: `3 x 15`, `3 x 20` eller `3 x 25` minuter.
- Stod for formationerna `2-3-1` och `3-2-1`.
- Planerar `2`, `3`, `4` eller `5` byten per period beroende pa matchformat.
- Later dig lasa malvakt per period eller lata appen valja automatiskt.
- Visar spelartid, banktid, malvaktsperioder och roller per spelare.
- Stodjer manuella justeringar via drag-and-drop pa formationsbradet.
- Kan dela den aktuella uppstallningen via URL och WhatsApp.
- Fungerar som statisk site och kan hostas pa GitHub Pages.

## Fairness och malvakt

- Malvaktstid raknas som riktig speltid.
- Appen forsoker fortfarande ge jamn total speltid och rimlig bankfordelning over hela laget.
- Nar chunk-/bytesfonstren gor perfekt lik speltid omojlig kan appen ge en mjuk fordel till spelare som star i mal, sa att de hellre hamnar i den hogre mojliga minutnivan an i den lagre.
- Den regeln ar en tie-break, inte en hard prioritering: den ska inte vinna om den tydligt forsamrar vanlig fairness eller rotation.
- I dagens implementation anvands den bara i de mindre truppfallen dar den losar ett verkligt avrundningsproblem utan att skapa samre fragmentering i storre trupper.

## Hur den fungerar

1. Fyll i en spelarlista, en spelare per rad eller separerad med komma.
2. Valj matchformat, formation och antal byten.
3. Valj malvakter manuellt eller lamna perioderna pa `Auto`.
4. Generera uppstallningen.
5. Justera vid behov direkt i bradet och dela resultatet.

Appen kraver minst `8` unika spelare for att skapa ett matchschema.

## Lokal utveckling

Krav:

- Node.js 22 eller senare rekommenderas
- npm

Installera och starta:

```bash
npm install
npm run dev
```

Bygg for produktion:

```bash
npm run build
```

Kor tester:

```bash
npm test
```

Kor scenarior for live-handelser:

```bash
npm run scenarios:live
```

Forhandsgranska produktionsbygget lokalt:

```bash
npm run preview
```

## Scenario-simulering

For en kort manuell UI-verifiering finns en separat checklista i `docs/manual-qa-checklist.md`.

Skriptet `npm run scenarios:live` kor ett fast set realistiska matchsituationer for live-flodet `Tillfalligt ute`.

Det gor fyra saker i ett steg:

- simulerar flera vanliga matchsituationer
- kor lokal validering av minuter, banktid, fairness-targets och chunk-splits
- skriver en JSON-artefakt for vidare automation
- skriver en Markdown-rapport som ar forberedd for AI-granskning

Artefakter sparas har:

- `output/scenarios/live/latest.json`
- `output/scenarios/live/latest.md`

Du kan valja en annan output-katalog:

```bash
npm run scenarios:live -- --output-dir /tmp/eik-scenarios
```

### Vad scenarierna testar

Skriptet kor ett kuraterat set av matchfall, till exempel:

- en spelare blir tillfalligt ute mitt i perioden
- en spelare blir tillfalligt ute och kommer tillbaka snabbt
- ersattaren blir ocksa tillfalligt ute
- en handelse sent i ett byteblock
- en handelse precis fore periodbyte
- en situation med mycket fa tillgangliga avbytare

### Hur man laser resultatet

Terminalen visar `PASS` eller `WARN` per scenario.

- `PASS` betyder att scenariot gick igenom bade hard validering och den lokala rimlighetskontrollen
- `WARN` betyder att harda invariants fortfarande haller, men att scenariot ser mindre snyggt ut enligt lokal heuristik

Kommandot returnerar felkod bara om harda invariants bryts.

### Hur man anvander rapporten for AI-validering

Det enklaste ar att oppna `output/scenarios/live/latest.md` och ga till sektionen `Forberedd AI-prompt` under det scenario du vill granska.

1. Kopiera prompten.
2. Klistra in den i ChatGPT eller annan modell.
3. Be modellen svara punkt for punkt pa checklistan.

Exempel:

```text
Granska detta scenario.
Svara pa varje checklistpunkt separat.
Markera varje punkt som Pass, Fail eller Unclear.
Avsluta med:
- overgripande bedomning
- misstankta problem
- konkreta forbattringsforslag
```

Om du vill bygga automation senare kan du i stallet lasa `output/scenarios/live/latest.json` och skicka `scenarios[].ai.input.prompt` eller hela `scenarios[].ai.input` till ett API.

## Teknikstack

- React 19
- TypeScript
- Vite
- Tailwind CSS
- `@dnd-kit` for drag-and-drop
- Vitest + Testing Library

## Projektstruktur

```text
src/App.tsx              Huvud-UI och anvandarflode
src/lib/scheduler.ts     Generering av matchschema och byten
src/lib/planOverrides.ts Manuella justeringar av lineup och byteplan
src/lib/share.ts         Delningslankar och serialisering av state
src/lib/types.ts         Delade typer och formationsdefinitioner
```

## GitHub Pages

Repot ar konfigurerat for deploy till GitHub Pages via GitHub Actions.

1. Ga till repository `Settings > Pages`.
2. Satt `Source` till `GitHub Actions`.
3. Pusha till `main`, eller kor workflowen manuellt under `Actions`.

Workflowen finns i `.github/workflows/deploy.yml` och publicerar innehallet i `dist/`.

`vite.config.ts` satter automatiskt korrekt `base`-path pa GitHub Actions:

- `https://<user>.github.io/<repo>/` for vanliga repos
- `https://<user>.github.io/` om repot heter `<user>.github.io`

For det har repot blir den publicerade adressen:

- `https://hejdesgit.github.io/lineup-planner/`

## Status

Projektet ar byggt som en klientrenderad app utan backend eller databas. All logik kor i webblasaren, vilket gor den enkel att deploya som statisk site.
