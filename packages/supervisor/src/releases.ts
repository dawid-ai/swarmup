// The releases and tags of each code checkout, for runs that cannot read them (AO-0350).
//
// A Codex run works in a sandbox without network, so `gh release list` fails there, and a role
// file's `tools` do not change that. swarmupd has network: it reads the releases itself, at most
// every `RELEASES_TTL_MS`, and a Codex PM run gets them in its prompt.

import { execOffThread } from '@swarmup/core';

/** How long a read of the releases holds before swarmupd reads them again. */
export const RELEASES_TTL_MS = 10 * 60_000;
/** How many releases and tags the prompt lists per checkout. */
export const RELEASES_SHOWN = 5;
const READ_TIMEOUT_MS = 30_000;

export interface ReleaseInfo {
  tagName: string;
  name?: string;
  isLatest?: boolean;
  isPrerelease?: boolean;
  isDraft?: boolean;
  publishedAt?: string;
}

/** What swarmupd read for one code checkout. */
export interface ReleaseSnapshot {
  top: string;
  /** When swarmupd read it, in ms. */
  at: number;
  /** GitHub releases, newest first; unset when `gh` failed. */
  releases?: ReleaseInfo[];
  /** Why `gh release list` failed, first line only. */
  ghError?: string;
  /** Local tags, newest first. */
  tags: string[];
}

/** Runs a command in a folder and returns what it printed; tests replace it. */
export type Exec = (file: string, args: string[], cwd: string) => Promise<string>;

const execDefault =
  (env: NodeJS.ProcessEnv): Exec =>
  (file, args, cwd) =>
    execOffThread(file, args, {
      cwd,
      env: { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      timeoutMs: READ_TIMEOUT_MS,
    });

function firstLine(err: unknown): string {
  const text =
    err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('Command failed')) ?? 'failed'
  ).slice(0, 200);
}

/**
 * Reads the GitHub releases (`gh release list`) and the local tags of the checkout `top`.
 * Read-only. Never throws: a failed `gh` leaves `releases` unset with the reason in `ghError`.
 */
export async function readReleases(
  top: string,
  opts: { env?: NodeJS.ProcessEnv; exec?: Exec; now?: () => number } = {},
): Promise<ReleaseSnapshot> {
  const exec = opts.exec ?? execDefault(opts.env ?? process.env);
  const snap: ReleaseSnapshot = { top, at: (opts.now ?? Date.now)(), tags: [] };
  try {
    const out = await exec(
      'gh',
      [
        'release',
        'list',
        '--limit',
        String(RELEASES_SHOWN),
        '--json',
        'tagName,name,isLatest,isPrerelease,isDraft,publishedAt',
      ],
      top,
    );
    const list = JSON.parse(out) as unknown;
    if (!Array.isArray(list)) throw new Error('gh release list printed no list');
    snap.releases = list
      .filter((r): r is ReleaseInfo => typeof (r as ReleaseInfo)?.tagName === 'string')
      .slice(0, RELEASES_SHOWN);
  } catch (err) {
    snap.ghError = firstLine(err);
  }
  try {
    const out = await exec(
      'git',
      ['tag', '-l', '--sort=-creatordate', `--format=%(refname:short)`],
      top,
    );
    snap.tags = out
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, RELEASES_SHOWN);
  } catch {
    // No tags to list; the releases may still be there.
  }
  return snap;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function releaseLine(r: ReleaseInfo): string {
  const marks = [
    r.isLatest ? 'latest' : '',
    r.isPrerelease ? 'pre-release' : '',
    r.isDraft ? 'draft' : '',
  ].filter(Boolean);
  const date = r.publishedAt ? `, published ${r.publishedAt.slice(0, 10)}` : '';
  const name = r.name && r.name !== r.tagName ? ` "${r.name}"` : '';
  return `  - \`${r.tagName}\`${name}${marks.length ? ` (${marks.join(', ')})` : ''}${date}`;
}

/**
 * The prompt lines that give a run the releases and tags swarmupd read, or an empty string when
 * there are none. GitHub lists releases newest first; the first one that is no draft is the newest
 * release, pre-releases included.
 */
export function releasesNote(snaps: ReleaseSnapshot[]): string {
  const known = snaps.filter((s) => (s.releases && s.releases.length > 0) || s.tags.length > 0);
  if (known.length === 0) return '';
  const lines = [
    '',
    'Releases and tags: your sandbox has no network, so `gh release list` and `gh pr view` fail',
    'here. swarmupd read these for you; answer questions about releases from them, and say when',
    'they were read:',
  ];
  for (const s of known) {
    lines.push(`- ${s.top.replace(/\\/g, '/')} (read ${stamp(s.at)}):`);
    if (s.releases && s.releases.length > 0) {
      const newest = s.releases.find((r) => !r.isDraft);
      if (newest) lines.push(`  newest release: \`${newest.tagName}\``);
      lines.push('  GitHub releases, newest first:', ...s.releases.map(releaseLine));
    } else if (s.ghError) {
      lines.push(`  GitHub releases: not read (${s.ghError})`);
    } else {
      lines.push('  GitHub releases: none');
    }
    if (s.tags.length > 0) {
      lines.push(`  local tags, newest first: ${s.tags.map((t) => `\`${t}\``).join(', ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
