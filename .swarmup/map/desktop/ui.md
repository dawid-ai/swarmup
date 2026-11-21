---
kind: component
summary: The React renderer (Vite, Tailwind); views, shared UI pieces and lib helpers over swarmupd's API
covers:
  - packages/desktop/ui/index.html
  - packages/desktop/ui/tsconfig.json
  - packages/desktop/ui/vite.config.ts
  - packages/desktop/ui/src/App.tsx
  - packages/desktop/ui/src/main.tsx
  - packages/desktop/ui/src/api.ts
  - packages/desktop/ui/src/types.ts
  - packages/desktop/ui/src/components.tsx
  - packages/desktop/ui/src/ErrorBoundary.tsx
  - packages/desktop/ui/src/index.css
  - packages/desktop/ui/src/gifenc.d.ts
  - packages/desktop/ui/src/assets
  - packages/desktop/ui/src/views
  - packages/desktop/ui/src/ui
  - packages/desktop/ui/src/lib
links: [index, replay]
---

# Desktop UI

## Purpose

What the person sees: one React app with a view per area.

## How it works

- `App.tsx` routes between `views/*.tsx`: Inbox, Board, List, TaskPanel, Chat, Runs, Agents,
  Schedules, Repeating, Channels, Decisions, Findings, Knowledge, Search, Activity, Reports, Bench,
  Replay, Settings, Setup, AddProject, NewTask and Standups.
- `api.ts` holds the hooks and calls to swarmupd through the main process; `types.ts` the shapes.
- `ui/*.tsx` are shared pieces (markdown, diff, pickers, filters, palette, triage, voice);
  `lib/*.ts` are pure helpers (formatting, threads, filters, keys, markdown, history).
- `assets/brand/` holds the tiles and status icons.

## Invariants

- Markdown is sanitized (DOMPurify) before it renders.
- Typecheck with `tsc -p packages/desktop/ui/tsconfig.json` (part of `pnpm run typecheck`).
