#!/usr/bin/env node
// `ops`, the command's name before the SwarmUp rename: an alias of `swarmup` until 0.4. The
// notice goes to stderr, so scripts that parse stdout keep working.
import { OPS_ALIAS_NOTICE } from './alias.js';

process.stderr.write(`${OPS_ALIAS_NOTICE}\n`);
await import('./main.js');
