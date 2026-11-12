- After a merge that changes a lockfile, swarmupd installs optional platform packages that
  `npm install` left out of the checkout's `node_modules` (such as
  `lightningcss-win32-x64-msvc`), so the build after the merge no longer fails on a missing
  native binary.
