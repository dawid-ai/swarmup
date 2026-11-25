// Download of a file a run kept (W4). Kept apart from main.ts so it can be tested without
// Electron. The page names only the run and the kept file's name; both are checked strictly, so
// the request reaches no other route than `GET /api/runs/<run>/artifacts/<name>`, and swarmupd
// looks the name up in the run's manifest. The person picks where the file goes in a system
// dialog; the page never names a path on disk.

/** A run id as swarmupd names its kept folders. */
const RUN = /^[0-9A-Za-z]{1,64}$/;
/** A kept file's name as swarmupd makes it (`safeName`): one segment, no folders. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,127}$/;

/** The kept file the page asks for, checked; throws on anything else. */
export function artifactRequest(run: unknown, name: unknown): { run: string; name: string } {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('bad run id');
  if (typeof name !== 'string' || !NAME.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    throw new Error('bad artifact name');
  }
  return { run, name };
}

/** The API path that serves the kept file's bytes. */
export function artifactPath(req: { run: string; name: string }): string {
  return `/api/runs/${req.run}/artifacts/${encodeURIComponent(req.name)}`;
}
