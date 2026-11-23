// What a person trusts of a store's git definitions on this machine (W5 phase 4, Decision 7):
// the merge checks and the triggers, each by the hash of its exact set, kept in the user config
// as `swarmupd.trusted_defs.<root>.{checks, triggers}`. The config edits are swarmupd's own
// (`automation-api.ts`), so the desktop app writes the same values.
import type { Workspace } from '@swarmup/core';
import { editUserConfig, isHuman, OpsError } from '@swarmup/core';
import type { TrustChange } from '@swarmup/supervisor';
import { applyTrust, checkUserConfig, daemonCall, readDaemon } from '@swarmup/supervisor';

export type { TrustChange } from '@swarmup/supervisor';
export { triggerLines } from '@swarmup/supervisor';

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

/** Writes trust changes into the user config, then has a running swarmupd read it again. */
export async function recordTrust(
  env: NodeJS.ProcessEnv,
  changes: readonly TrustChange[],
): Promise<void> {
  if (changes.length === 0) return;
  editUserConfig(env, (d) => applyTrust(d, changes), checkUserConfig);
  await notifyDaemon(env);
}

/** Has a running swarmupd read the user config again at once. */
export async function notifyDaemon(env: NodeJS.ProcessEnv): Promise<void> {
  const info = readDaemon(env);
  if (info) await daemonCall(info, 'POST', '/api/settings', { patch: {} }).catch(() => undefined);
}
