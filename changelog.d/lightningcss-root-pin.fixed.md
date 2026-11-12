- `npm install` in an engine checkout no longer rewrites `package-lock.json` without the root
  `lightningcss-*` platform packages, and no longer deletes the installed `lightningcss` binary:
  `lightningcss` is now a root dev dependency, pinned to the version `@tailwindcss/node` needs.
