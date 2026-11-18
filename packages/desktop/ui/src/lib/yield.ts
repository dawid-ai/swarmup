/**
 * A pause for long export loops. Rasterizing a frame awaits only promises that can resolve
 * without returning to the event loop, so a loop of them never lets the page paint or React
 * commit: the progress bar would stay at 0 until the file is done. Call the returned function
 * once per frame; about every `everyMs` it waits for a macrotask, which gives the browser a
 * chance to render, and otherwise it resolves at once.
 */
export function paintBreaks(
  everyMs = 50,
  now: () => number = () => performance.now(),
): () => Promise<void> {
  let last = now();
  return async () => {
    if (now() - last < everyMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = now();
  };
}
