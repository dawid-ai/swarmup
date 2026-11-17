// Edit project location (AO-0354): the renderer names the existing config entry, but only the
// main process's system dialog may choose the new folder. Kept apart from Electron for tests.
import type { Reply } from './add-project.js';

export interface RelocateProjectDeps<E, T> {
  /** Whether the call comes from the app's own page in its own window. */
  fromPage: (event: E) => boolean;
  /** Opens the system folder dialog; null when the person closes it. */
  pickFolder: () => Promise<string | null>;
  /** Calls swarmupd after the person picked the folder. */
  relocate: (root: string, to: string) => Promise<T>;
}

/** The guarded IPC handler behind `projectRelocate` in the preload bridge. */
export function relocateProjectHandler<E, T>(
  deps: RelocateProjectDeps<E, T>,
): (event: E, root: unknown) => Promise<Reply<T>> {
  return async (event, root) => {
    if (!deps.fromPage(event)) return { ok: false, error: 'not allowed from this page' };
    try {
      if (typeof root !== 'string' || !root.trim()) throw new Error('project: name a folder');
      const to = await deps.pickFolder();
      if (!to) throw new Error('cancelled');
      return { ok: true, data: await deps.relocate(root, to) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
}
