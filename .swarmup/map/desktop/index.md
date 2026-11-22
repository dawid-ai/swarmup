---
kind: area
summary: 'The Electron app: main process, tray and service control, updates, Add project, installer build'
covers:
  - packages/desktop/package.json
  - packages/desktop/tsconfig.json
  - packages/desktop/electron-builder.yml
  - packages/desktop/build
  - packages/desktop/scripts
  - packages/desktop/src
  - packages/desktop/test
links: [ui, replay, /supervisor]
verified: 0837bfc6
---

# Desktop app

## Purpose

The control room on top of swarmupd: inbox, board, task threads with criteria and briefs, runs,
schedules, chat, knowledge, the project map, scores, benchmarks, definitions, replay, and a
tray icon that starts and stops swarmupd.

## How it works

- `src/main.ts` is the Electron main process: one window loading `ui/index.html` with
  `contextIsolation` and `preload.cts`, the tray, and swarmupd started from the app's files.
- `allow.ts` is the allowlist of API calls the page may make through the main process; a new
  swarmupd endpoint the UI calls (criteria, criteria check and judge, brief, scores, map, defs,
  bench, proposals, `improve` and a task's review artifact) needs a line here.
- `service.ts` (tray, background service), `updates.ts` (Manual or Auto updates from GitHub
  Releases via `electron-updater`), `add-project.ts`, `voice.ts`, `models.ts`, and the save
  helpers (`images.ts`, `gifs.ts`, `videos.ts`) are pure modules, tested without Electron.
- `scripts/package.mjs` and `electron-builder.yml` build the Windows installer;
  `build/*.ps1` and `installer.nsh` add the PATH entry and shortcuts; `extraResources` also
  ships `packages/core/templates` as `resources/templates`.
- `main.ts`'s screenshot mode renders the views in `SWARMUP_VIEWS`, Map, Bench and
  `settings:definitions` among the defaults.

## Invariants

- Logic that can be tested without Electron lives outside `main.ts`.
- The page names files it saves; names are checked strictly before any write.

## Gotchas

- `scripts/desktop-smoke.mjs` renders every view against a scratch root; CI runs it under xvfb.
