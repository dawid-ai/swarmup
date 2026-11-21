// opsd.log moves to opsd.1.log at a swarmupd start once it is past its size limit.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateLog } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('opsd.log rotation', () => {
  it('moves the log past its limit to opsd.1.log, replacing the older one, and leaves a small one', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarmup-logrotate-'));
    dirs.push(d);
    const log = join(d, 'opsd.log');
    writeFileSync(log, 'small\n');
    expect(rotateLog(log, 100)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('small\n');

    writeFileSync(join(d, 'opsd.1.log'), 'older\n');
    writeFileSync(log, 'x'.repeat(200));
    expect(rotateLog(log, 100)).toBe(true);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(join(d, 'opsd.1.log'), 'utf8')).toBe('x'.repeat(200));
    // A missing log is nothing to rotate.
    expect(rotateLog(log, 100)).toBe(false);
  });
});
