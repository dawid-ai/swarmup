// What a person trusts of a store's git definitions on this machine (W5 phase 4, Decision 7):
// the merge checks and the triggers, each by the hash of its exact set, kept in the user config
// as `swarmupd.trusted_defs.<root>.{checks, triggers}`.
import type { TriggerDef, Workspace } from '@swarmup/core';
import {
  daemonKeyIn,
  editUserConfig,
  isHuman,
  OpsError,
  triggerTarget,
  triggerWhen,
} from '@swarmup/core';
import { daemonCall, opsdConfig, readDaemon } from '@swarmup/supervisor';

/**
 * Refuses unless a person acts, outside any run: what git may start or run on this machine is
 * the machine's decision, never an agent's.
 */
export function requirePerson(ws: Workspace, what: string): void {
  const actor = ws.actor;
  if (ws.run || !actor || !isHuman(actor)) {
    throw new OpsError(
      `only a person ${what}, outside runs${actor ? `; ${actor}${ws.run ? ` in run ${ws.run}` : ''} cannot` : ''}`,
      2,
    );
  }
}

/** A change to one root's trust: a hash to keep, null to drop it; unset keys stay. */
export interface TrustChange {
  root: string;
  checks?: string | null;
  triggers?: string | null;
}

/** Writes trust changes into the user config, then has a running swarmupd read it again. */
export async function recordTrust(
  env: NodeJS.ProcessEnv,
  changes: readonly TrustChange[],
): Promise<void> {
  if (changes.length === 0) return;
  editUserConfig(
    env,
    (d) => {
      const key = daemonKeyIn(d);
      for (const c of changes) {
        for (const kind of ['checks', 'triggers'] as const) {
          const v = c[kind];
          const path = [key, 'trusted_defs', c.root, kind];
          if (typeof v === 'string') d.setIn(path, v);
          else if (v === null && d.hasIn(path)) d.deleteIn(path);
        }
        const entry = d.getIn([key, 'trusted_defs', c.root]) as { items?: unknown[] } | undefined;
        if (entry?.items?.length === 0) d.deleteIn([key, 'trusted_defs', c.root]);
      }
    },
    (next) => void opsdConfig(next),
  );
  await notifyDaemon(env);
}

/** Has a running swarmupd read the user config again at once. */
export async function notifyDaemon(env: NodeJS.ProcessEnv): Promise<void> {
  const info = readDaemon(env);
  if (info) await daemonCall(info, 'POST', '/api/settings', { patch: {} }).catch(() => undefined);
}

/** One line per trigger: what a person trusts when they trust the set. */
export function triggerLines(defs: readonly TriggerDef[]): string[] {
  return [...defs]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) => {
      const where = d.runs_on ? `  runs_on ${d.runs_on.join(', ')}` : '';
      const off = d.enabled ? '' : '  (enabled: false)';
      const prompt = d.prompt ? `  prompt ${JSON.stringify(d.prompt)}` : '';
      const params = d.params ? `  params ${JSON.stringify(d.params)}` : '';
      return `  ${d.name}  ${triggerWhen(d)}  ${triggerTarget(d)}${prompt}${params}${where}${off}`;
    });
}
