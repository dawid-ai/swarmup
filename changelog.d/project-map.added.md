- Project map: `swarmup map` finds, shows and checks linked Markdown nodes in `.swarmup/map/` that
  say what each part of a project is for. Task runs get the root summary and the nodes that match
  the task in their prompt, and are asked to keep the nodes true; `swarmup map check` can gate
  merges. See `docs/map.md`.
