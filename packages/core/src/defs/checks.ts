/**
 * Merge checks in git (W5 phase 4): `swarm.yaml` `checks.<name>` names commands swarmupd runs on
 * approved work before it moves the base. Per Decision 7 they never run until a person trusts
 * them on a machine (`swarmup defs trust`), which keeps a hash of the exact command set in the
 * user config (`swarmupd.trusted_defs.<root>`); any change to a command or its paths untrusts
 * them until a person trusts them again.
 */
import { createHash } from 'node:crypto';
import type { DefProblem } from './schema.js';
import type { SwarmCheck } from './swarm.js';

/** Prefix of a check-set hash; the rest is a SHA-256 in hex. */
export const CHECKS_HASH_PREFIX = 'c:';

/** A trusted hash as `swarmupd.trusted_defs.<root>` keeps it. */
export const CHECKS_HASH_RE = /^c:[0-9a-f]{64}$/;

/** A merge check as `swarmupd.merge.<root>.checks` takes it: a command, or one with its paths. */
export type GitMergeCheck = string | { run: string; paths: string[] };

/**
 * Whether a machine trusts a store's checks: `none` (the store names none), `trusted` (the hash
 * the machine keeps is the set's), `untrusted` (the machine keeps none) or `changed` (it keeps
 * another set's hash: a command or its paths changed since).
 */
export type ChecksTrust = 'none' | 'trusted' | 'untrusted' | 'changed';

/** The checks in name order, as the merge runs them. */
export function gitMergeChecks(checks: Record<string, SwarmCheck> | undefined): GitMergeCheck[] {
  return Object.keys(checks ?? {})
    .sort()
    .map((name) => {
      const c = checks![name]!;
      return c.paths && c.paths.length > 0 ? { run: c.run, paths: [...c.paths] } : c.run;
    });
}

/**
 * The hash of a check set: `c:` and the SHA-256 of each check's name, command and paths in name
 * order. Descriptions and key order do not change it.
 */
export function checksHash(checks: Record<string, SwarmCheck>): string {
  const lines = Object.keys(checks)
    .sort()
    .map((name) => JSON.stringify([name, checks[name]!.run, checks[name]!.paths ?? []]));
  return (
    CHECKS_HASH_PREFIX +
    createHash('sha256')
      .update(`swarmup-checks/1\n${lines.join('\n')}`, 'utf8')
      .digest('hex')
  );
}

/** Whether `trusted` (the hash a machine keeps for the root) trusts `checks`. */
export function checksTrust(
  checks: Record<string, SwarmCheck> | undefined,
  trusted: string | undefined,
): ChecksTrust {
  if (!checks || Object.keys(checks).length === 0) return 'none';
  if (!trusted) return 'untrusted';
  return trusted === checksHash(checks) ? 'trusted' : 'changed';
}

/** What a merge does with a store's checks that are not trusted, in one sentence. */
export function untrustedChecksText(root: string, trust: ChecksTrust, count: number): string {
  const what = `${count} merge check(s) in ${root}'s swarm.yaml`;
  const why =
    trust === 'changed'
      ? 'changed since this machine trusted them'
      : 'are not trusted on this machine';
  return `${what} ${why}; merges skip them until a person runs \`swarmup defs trust --root ${root}\``;
}

/** The warning `swarmup validate` and `doctor` give for checks that are not trusted, or null. */
export function checksTrustProblem(
  file: string,
  root: string,
  checks: Record<string, SwarmCheck> | undefined,
  trusted: string | undefined,
): DefProblem | null {
  const trust = checksTrust(checks, trusted);
  if (trust === 'none' || trust === 'trusted') return null;
  return {
    file,
    path: 'checks',
    line: 1,
    col: 1,
    severity: 'warning',
    message: untrustedChecksText(root, trust, Object.keys(checks!).length),
  };
}
