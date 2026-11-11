#!/usr/bin/env node
// `opsd`, the daemon's name before the SwarmUp rename: an alias of `swarmupd` until 0.4. The
// notice goes to stderr, so scripts that parse stdout keep working.
process.stderr.write('`opsd` is now `swarmupd`; the `opsd` alias goes away in 0.4.\n');
await import('./main.js');
