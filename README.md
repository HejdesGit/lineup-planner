# lineup-planner

`lineup-planner` ar en statisk React-app for att planera 7v7-uppstallningar, malvakter och byten over tre perioder.

Appen ar byggd for att snabbt ta fram ett spelbart matchschema dar speltid, banktid och roller fordels rimligt over laget. Resultatet kan justeras manuellt i UI:t och delas vidare via lank eller WhatsApp.

## Funktioner

- Genererar uppstallning for 3 perioder med valbart matchformat: `3 x 15` eller `3 x 20` minuter.
- Stod for formationerna `2-3-1` och `3-2-1`.
- Planerar `2`, `3` eller `4` byten per period beroende pa matchformat.
- Later dig lasa malvakt per period eller lata appen valja automatiskt.
- Visar spelartid, banktid, malvaktsperioder och roller per spelare.
- Stodjer manuella justeringar via drag-and-drop pa formationsbradet.
- Kan dela den aktuella uppstallningen via URL och WhatsApp.
- Fungerar som statisk site och kan hostas pa GitHub Pages.

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

Forhandsgranska produktionsbygget lokalt:

```bash
npm run preview
```

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
