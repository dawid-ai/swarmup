---
kind: flow
summary: Cutting a release; version bump, changelog fragments, UPDATES entry, tag and the release workflow
covers:
  - RELEASING.md
  - CHANGELOG.md
  - UPDATES.md
  - changelog.d
  - scripts/set-version.mjs
  - scripts/fold-changelog.mjs
  - scripts/check-release.mjs
  - .github/workflows/release.yml
  - .claude/skills/release
links: [tooling, desktop]
verified: 0837bfc6
---

# Release

## Purpose

A release is a pushed version tag; the `release` workflow builds and publishes the Windows
installer, and installed apps update from the GitHub Release.

## How it works

1. `node scripts/set-version.mjs X` writes the version into every package.json, the CLI's
   `version.ts` and swarmupd's version.
2. `node scripts/fold-changelog.mjs X` folds `changelog.d/*.md` fragments into `CHANGELOG.md`.
3. Add a `## vX (date)` entry to `UPDATES.md`, written for users (the updater shows it).
4. `node scripts/check-release.mjs X`, then commit, tag `vX` and push.

## Invariants

- User-visible changes, such as the self-improvement loop (`self-improvement.added.md`), add a
  fragment `changelog.d/<slug>.<added|changed|fixed|removed>.md` instead of editing
  `CHANGELOG.md`, so branches never conflict on it. One fragment may hold
  several bullets for one feature.
- The workflow refuses a tag whose version, changelog heading or UPDATES entry is missing.
