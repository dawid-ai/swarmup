---
name: release
description: Cut and publish a SwarmUp release (such as 0.3.0-beta.2) from dawid-ai/swarmup, then check the installer and the desktop app's auto-update. Use when Dawid asks for a new version, a release, a beta, or to test updates.
---

# Release SwarmUp

Code, releases and the update feed all live in `dawid-ai/swarmup` (checkout `C:\dev\swarmup`,
branch `main`). A pushed `v*` tag runs `.github/workflows/release.yml`: it checks the tag, runs
CI, builds and smoke-tests the installer, and uploads `SwarmUp-Setup.exe`, its block map and
`latest.yml` to the GitHub Release. Installed apps read `latest.yml` and update.

[RELEASING.md](../../../RELEASING.md) has the steps. This skill adds the rules and the update test.

## Rules

- Publishing needs Dawid's go-ahead each time: the tag push, a release edit, a force-push.
- Nothing public names the old brand (trademark conflict, Dawid, 2026-11-11): not the notes, the
  docs, a file name, a commit message, a tag or a release title. `scripts/check-release.mjs`
  refuses `CHANGELOG.md` and `UPDATES.md` when they name it.
- The task store and internal docs (proposals, launch drafts, research, the 0.2 notes) live in the
  private `dawid-ai/swarmup-store`, never in this repo.
- Don't release while a swarmupd merge runs in `C:\dev\swarmup` (`swarmup runs`).
- Don't tag a commit that has not passed the full suite of step 2.

## Steps

1. On `main`, up to date with `origin/main`: follow steps 1 to 3 of RELEASING.md (set the
   version, fold the changelog, add the `UPDATES.md` entry).
2. Run the full suite, build the installer and smoke-test the packaged app on the release tree.
   Merges run only the checks of what changed (D-0017), so this step is the only place where the
   whole suite runs before users get the code. Run it in `C:\dev\swarmup` after step 1, with no
   changes other than the release edits
   (`git status` lists only `package.json` files, `CHANGELOG.md`, `UPDATES.md` and the removed
   `changelog.d/` fragments):

   ```sh
   pnpm install --frozen-lockfile
   node scripts/check-release.mjs <version>
   pnpm run typecheck
   pnpm run lint
   pnpm test
   node scripts/check-leaks.mjs --deny <your deny file>
   pnpm run dist
   node scripts/desktop-smoke.mjs --packaged
   ```

   The repo uses pnpm, so `pnpm install --frozen-lockfile` is the clean install (the `npm ci`
   equivalent): it fails when `pnpm-lock.yaml` does not match `package.json`. Keep the deny list
   outside the repo; without `--deny` the leak check can't catch org names, logins or machine
   names.

   **Stop rule:** any command that exits non-zero stops the release. Don't commit, tag or push.
   Fix the cause on a branch and merge it, or file a finding and tell Dawid which command failed
   and why, then start again from step 1. A test that fails, then passes when you rerun the whole
   suite, is a flake: file a finding for it, and release only on a full green run.

   Record each command and its result (`pnpm test`: 1234 passed) in the release task with
   `swarmup comment`, or in the message that asks Dawid for the go-ahead.

3. After Dawid asked for the release and step 2 is green: commit `Release <version>`,
   `git tag v<version>`, then `git push origin main v<version>`. If anything but the commit
   itself changed since step 2 (a pull, a merge), run step 2 again first.
4. Watch the run: `gh run list -R dawid-ai/swarmup -L 3`, then
   `gh run watch <id> -R dawid-ai/swarmup --exit-status`. A failed test that passes alone is a
   flake: `gh run rerun <id> -R dawid-ai/swarmup --failed`, and file a finding.
5. Check the assets: `gh release view v<version> -R dawid-ai/swarmup` lists
   `SwarmUp-Setup.exe`, `SwarmUp-Setup.exe.blockmap` and `latest.yml`, and `latest.yml` names
   the new version.
6. swarmup.tech needs no step: its download page asks GitHub for the newest release in the
   browser. Docs changes go live with the daily `pages` run of `dawid-ai/swarmup-web`, or right
   away with `gh workflow run pages -R dawid-ai/swarmup-web`.

## Test the update

The app checks 20 seconds after it starts, then every 30 minutes. **Settings > Updates** checks now.

1. In the installed app, open **Settings > Updates** and check. Expect the new version to
   download, then **Install**. With no live run and the window closed, it installs on its own.
2. After the restart, **Settings > Updates** shows the new version, and `swarmup --version` in a
   new terminal prints it.

The installed app runs swarmupd on `127.0.0.1:4747`. Installing an update stops that swarmupd and
starts the new one. A beta looks for `beta.yml` first and falls back to `latest.yml`, so only
`latest.yml` is needed. The installer is unsigned: SmartScreen asks once (**More info**,
**Run anyway**).
