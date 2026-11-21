---
kind: module
summary: Search over tasks, threads, notes, posts and votes; the activity feed and the replay timeline
covers:
  - packages/core/src/search.ts
  - packages/core/src/search-index.ts
  - packages/core/src/activity.ts
  - packages/core/src/timeline.ts
links: [workspace, /desktop/replay]
---

# Search, activity and timeline

## Purpose

Read models over every root for the desktop's search bar, activity view and replay.

## How it works

- `search.ts` parses queries: all words must match; `agent:`, `status:`, `project:`, `type:`,
  `priority:`, `root:`, `is:open|closed` and `in:tasks|notes|posts|votes` narrow it.
- `search-index.ts` keeps parsed, lowercased documents in one cache with a byte budget and reads
  only files whose stamps changed; a request has a fixed work budget and may return partial.
- `activity.ts` lists every event and channel post newest first with cursor paging, backed by
  `.ops/activity.json` that is rebuilt from the files when stale.
- `timeline.ts` builds lanes, work spans, review rounds, waits and runs for replay scenes.

## Invariants

- The files stay the source of truth; every index is a rebuildable cache.
