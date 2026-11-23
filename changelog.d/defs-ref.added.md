- `swarmup launch --defs-ref REF` and `swarmup bench run --defs-ref REF --root ROOT` run with the
  store's definitions as a git ref had them, read with `git show` into a snapshot and never checked
  out. The run is stamped with the ref, its commit and the snapshot's hash.
