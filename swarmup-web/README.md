# swarmup-web: the swarmup.tech website

Everything the website owns lives in this folder. It ships on its own schedule: a change here
goes live without an app release.

## What is where

| Path                 | What it is                                                                      |
| -------------------- | ------------------------------------------------------------------------------- |
| `pages/home.html`    | The home page body. The build wraps it in the header and footer.                |
| `pages/founder.html` | The founder page body: who builds SwarmUp, and how to work with him.            |
| `pages/install.md`   | The install guide, written in Markdown.                                         |
| `assets/site.css`    | The theme for every page, the docs included: paper, ink and one acid accent.    |
| `assets/site.js`     | Steps the home page schematic through its stages, and fades sections in.        |
| `assets/logo.svg`    | The mark in the header (four squares: you, two AI providers, the orchestrator). |
| `assets/favicon.svg` | The browser tab icon.                                                           |
| `assets/og.png`      | The 1200 x 630 card a shared link shows: the headline and the receipt.          |
| `schematic.mjs`      | Draws the schematic SVG in `pages/home.html` from node and line lists.          |
| `build.mjs`          | Builds the site into `dist/site`: pages, download page, docs, changelog, 404.   |
| `publish.mjs`        | Builds the site from the public files and pushes it to `dawid-ai/swarmup-web`.  |

Some pages come from files the rest of the repository shares, so they never drift apart:

- `README.md` and `docs/*.md` become the docs under `/docs`.
- `UPDATES.md` becomes the changelog page.
- `docs/media/` holds the screenshots the home page shows.
- The download page reads the newest release of `dawid-ai/swarmup` from GitHub.

## Numbers on the pages

The receipt and the ticker on the home page, its 56:1 ratio, and the figures on the founder page
come from SwarmUp's own queue: `swarmup report --days 30` and `swarmup wrapped --days 30`. They
are typed into the pages, not read at build time. When you refresh them, change the home page,
the founder page and the date range together, and render `assets/og.png` again, because the card
shows the same receipt.

## Change the site

1. Edit the files above. To change the schematic, edit the lists in `schematic.mjs`, then run
   `npm run web:schematic`; the tests fail when the page and the lists disagree.
2. Preview: run `npm run site` in the repository root, then open `dist/site/index.html`.
3. Publish: merge the change into `v2`. swarmupd runs `npm run web:publish` after each merge. To
   publish right away, run `npm run web:publish` yourself.

`npm run web:publish` builds from the committed files only, without anything marked
`export-ignore` in `.gitattributes` (the task store, `docs/proposals/`, `docs/launch/`). It
commits to its checkout of `dawid-ai/swarmup-web` (`out/swarmup-web/`) only when the site changed,
then pushes. GitHub Pages serves that repository at `swarmup.tech`. Never edit
`out/swarmup-web/` by hand: the next publish replaces it.
