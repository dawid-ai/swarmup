import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface LockEntry {
  version?: string;
  peer?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));

const manifest = read('package.json') as { devDependencies: Record<string, string> };
const lock = read('package-lock.json') as { packages: Record<string, LockEntry> };

// npm 11 flags the platform packages of a hoisted lightningcss as `peer` when the only root-level
// edges to it are transitive (@tailwindcss/node) and an optional peer (vitest's vite). A saving
// `npm install` then drops those lockfile entries and deletes the installed binary (AO-0254).
// The root devDependency gives lightningcss a direct edge, which keeps the entries.
describe('root lightningcss in package-lock.json', () => {
  it('is pinned in the root manifest to the version @tailwindcss/node needs', () => {
    const wanted = lock.packages['node_modules/@tailwindcss/node']?.dependencies?.lightningcss;
    expect(wanted).toBeDefined();
    expect(manifest.devDependencies.lightningcss).toBe(wanted);
    expect(lock.packages['node_modules/lightningcss']?.version).toBe(wanted);
  });

  it('keeps every platform package, none flagged as a peer', () => {
    const platforms = Object.keys(
      lock.packages['node_modules/lightningcss']?.optionalDependencies ?? {},
    );
    expect(platforms).toContain('lightningcss-win32-x64-msvc');
    for (const name of platforms) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, name).toBeDefined();
      expect(entry?.peer, name).toBeUndefined();
    }
  });
});
