/**
 * How long a test waits for something opsd does in the background before it fails. A hang
 * guard, not a speed limit: most waits end in well under a second alone, but the full suite on
 * Windows runs git-heavy files side by side, and 10 s waits ran out there (AO-0189).
 */
export const WAIT_MS = 30_000;

/** Waits until `cond` is true, checking every 50 ms; throws once `ms` ran out. */
export async function until(cond: () => boolean, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
