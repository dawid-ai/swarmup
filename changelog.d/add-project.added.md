- **Add project in the desktop app.** **Add project**, in the sidebar's new **Projects** list and
  under **Settings > Data roots**, adds an existing repo without a terminal: pick the folder,
  review what SwarmUp found and proposes (name, id prefix, roles, first tasks), and click
  **Create**. Tasks live in the repo or, for a public repo, in a separate private folder. The
  project shows up at once; a folder that already has a data root only joins the list.
- `swarmup adopt --apply --store DIR` keeps the task store in a folder outside the repo and
  writes the root, its code checkout and its merge base to the user config.
- The sidebar lists the loaded projects; a project opens **Tasks** filtered to it.
