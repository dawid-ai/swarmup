---
kind: component
summary: Replay; animated scenes of a root's timeline, with GIF, MP4 and still exports
covers:
  - packages/desktop/ui/src/replay
  - packages/desktop/ui/src/lib/replay.ts
  - packages/desktop/ui/src/lib/record.ts
  - packages/desktop/ui/src/lib/gif.ts
  - packages/desktop/ui/src/lib/png.ts
  - packages/desktop/ui/src/views/Replay.tsx
  - scripts/replay-stills.mjs
  - scripts/replay-stills-main.mjs
  - scripts/record-check.mjs
  - scripts/gif-check.mjs
links: [ui, /core/search, /supervisor/stats]
---

# Replay

## Purpose

Plays back what happened in a root or project: agents' lanes, work spans, review rounds, waits,
decisions and learn notes, from the core timeline (`timeline.ts`).

## How it works

- `replay/` holds the scene components; `lib/replay.ts` turns timeline data into frames.
- Record exports MP4 (`lib/record.ts`, saved by the main process's `videos.ts`) and GIF
  (`lib/gif.ts` with `gifenc`, saved by `gifs.ts`); `png.ts` writes stills.
- `scripts/replay-stills.mjs` renders stills offscreen; `record-check.mjs` and `gif-check.mjs`
  check exports (`pnpm run check:record`, `pnpm run check:gif`).

## Invariants

- Replay only reads; it never writes to a root.
