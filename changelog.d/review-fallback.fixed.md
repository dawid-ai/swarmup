- A provider paused for usage or signed out no longer stops all work: reviews waiting for its
  reviewer stop counting toward `review_backlog`, so new work in the project goes on.
- After `review_fallback_hours` (default 2; `0` turns it off, also in **Settings**), swarmupd
  moves such a review to a reviewer of the author's provider. The `review-fallback` event and the
  verdict both say why, such as `fallback: claude paused until 2026-11-18 17:00 UTC`.
- You get one Inbox note when a usage pause leaves reviews or work waiting, with when it ends and
  your options. `swarmup waits`, `swarmup runs` and the **Agents** view show the stall as one line
  per provider instead of one line per task.
