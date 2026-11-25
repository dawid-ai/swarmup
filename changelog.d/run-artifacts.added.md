- Runs keep what they produce besides commits. A run declares a file with
  `swarmup run artifact PATH --label TEXT`, or writes it into `$SWARMUP_SCRATCH/artifacts/`, and
  swarmupd copies it to `artifacts/<run-id>/` in its state folder with a manifest when the run
  ends, within `swarmupd.artifacts.max_files` (20) and `max_mb` (25), for `keep_days` (30).
- `swarmup review` from a run attaches the run's kept files, `swarmup runs show RUN` lists them,
  and the desktop app shows them in the **Runs** view (**Artifacts**: a gallery of images and a
  list of other files) and in the task panel's **Work** section.
- Rubrics take a new `artifacts` input: the judge gets the kept text files and the names, types
  and sizes of the others.
