- The **Runs** view has the same **Range** buttons as **Replay** in its header: **Day** (the
  default), **Week**, **30 days**, **90 days** and **Custom** with **From** and **to** dates. The
  list, the filter counts and the run, token and error stats cover the runs that were running in
  the range; **Live now** still counts every live run. `GET /api/runs?limit=` takes `start` and
  `end` ISO times for the range.
