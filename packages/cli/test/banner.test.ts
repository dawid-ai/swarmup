import { describe, expect, it } from 'vitest';
import { banner, colorLevel } from '../src/banner.js';
import { run } from '../src/cli.js';
import { VERSION } from '../src/version.js';

const E = '\x1b';
const R = `${E}[0m`;
// The tile colors as escape sequences: 24-bit, then the 256-color index.
const TRUE = {
  pink: `${E}[38;2;228;111;179m`,
  orange: `${E}[38;2;232;135;91m`,
  cyan: `${E}[38;2;79;195;217m`,
  violet: `${E}[38;2;163;147;255m`,
};
const INDEXED = {
  pink: `${E}[38;5;205m`,
  orange: `${E}[38;5;209m`,
  cyan: `${E}[38;5;80m`,
  violet: `${E}[38;5;141m`,
};

/** The compact banner written out by hand: the snapshot the CLI output must match. */
const compact = (c: typeof TRUE, version: string): string =>
  [
    ` ${c.pink}██ ${c.orange}██${R}`,
    ` ${c.cyan}▄▄ ${c.violet}▄▄${R}  ${E}[1mSWARMUP${R} ${version}`,
    ` ${c.cyan}▀▀ ${c.violet}▀▀${R}`,
  ].join('\n');

/** Runs `swarmup <argv>` in-process and returns what it printed. */
function swarmup(argv: string[], env: NodeJS.ProcessEnv, isTTY: boolean): string {
  const out: string[] = [];
  const code = run(argv, {
    out: (l) => out.push(l),
    err: (l) => out.push(l),
    env,
    cwd: '.',
    isTTY,
  });
  expect(code).toBe(0);
  return out.join('\n');
}

describe('colorLevel', () => {
  it('is none without a terminal, with NO_COLOR and with TERM=dumb', () => {
    expect(colorLevel({ isTTY: false }, { COLORTERM: 'truecolor' })).toBe('none');
    expect(colorLevel({}, { WT_SESSION: 'x' })).toBe('none');
    expect(colorLevel({ isTTY: true }, { NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('none');
    expect(colorLevel({ isTTY: true }, { TERM: 'dumb', WT_SESSION: 'x' })).toBe('none');
  });

  it('is truecolor where the terminal says so, and 256 otherwise', () => {
    expect(colorLevel({ isTTY: true }, { COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(colorLevel({ isTTY: true }, { COLORTERM: '24bit' })).toBe('truecolor');
    expect(colorLevel({ isTTY: true }, { WT_SESSION: 'x' })).toBe('truecolor');
    expect(colorLevel({ isTTY: true }, { TERM: 'xterm-256color' })).toBe('256');
    expect(colorLevel({ isTTY: true }, {})).toBe('256');
    // An empty NO_COLOR is not set (https://no-color.org).
    expect(colorLevel({ isTTY: true }, { NO_COLOR: '' })).toBe('256');
  });
});

describe('banner', () => {
  it('draws the compact form in three lines', () => {
    expect(banner({ version: '1.2.3', color: 'truecolor', compact: true })).toBe(
      compact(TRUE, '1.2.3'),
    );
    expect(banner({ version: '1.2.3', color: '256', compact: true })).toBe(
      compact(INDEXED, '1.2.3'),
    );
  });

  it('draws the five-line form with the tagline and the URL', () => {
    const c = TRUE;
    expect(banner({ version: '1.2.3' })).toBe(
      [
        ` ${c.pink}████ ${c.orange}████${R}`,
        ` ${c.pink}████ ${c.orange}████${R}   ${E}[1mSWARMUP${R} 1.2.3`,
        ` ${c.cyan}▄▄▄▄ ${c.violet}▄▄▄▄${R}   Your coding agents need a manager.`,
        ` ${c.cyan}████ ${c.violet}████${R}   ${E}[2mswarmup.tech${R}`,
        ` ${c.cyan}▀▀▀▀ ${c.violet}▀▀▀▀${R}`,
      ].join('\n'),
    );
  });

  it('is one plain line without color', () => {
    expect(banner({ version: '1.2.3', color: 'none' })).toBe('swarmup 1.2.3');
    expect(banner({ version: '1.2.3', color: 'none', compact: true })).toBe('swarmup 1.2.3');
  });
});

describe('swarmup --version', () => {
  it('prints the compact banner in a truecolor terminal', () => {
    for (const env of [{ COLORTERM: 'truecolor' }, { WT_SESSION: 'x' }])
      for (const name of ['--version', 'version'])
        expect(swarmup([name], env, true)).toBe(compact(TRUE, VERSION));
  });

  it('prints the compact banner with indexed colors in a 256-color terminal', () => {
    expect(swarmup(['--version'], { TERM: 'xterm-256color' }, true)).toBe(
      compact(INDEXED, VERSION),
    );
    expect(swarmup(['version'], {}, true)).toBe(compact(INDEXED, VERSION));
  });

  it('prints the bare version when stdout is not a terminal', () => {
    const env = { COLORTERM: 'truecolor', WT_SESSION: 'x' };
    expect(swarmup(['--version'], env, false)).toBe(VERSION);
    expect(swarmup(['version'], env, false)).toBe(VERSION);
    // An Io without `isTTY`, as every caller had before the banner.
    const out: string[] = [];
    run(['--version'], { out: (l) => out.push(l), err: () => {}, env, cwd: '.' });
    expect(out).toEqual([VERSION]);
  });

  it('prints the bare version in a terminal with NO_COLOR, TERM=dumb or --json', () => {
    expect(swarmup(['--version'], { NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe(VERSION);
    expect(swarmup(['--version'], { TERM: 'dumb', WT_SESSION: 'x' }, true)).toBe(VERSION);
    expect(swarmup(['--version', '--json'], { COLORTERM: 'truecolor' }, true)).toBe(VERSION);
    expect(swarmup(['version', '--json'], { WT_SESSION: 'x' }, true)).toBe(VERSION);
  });
});
