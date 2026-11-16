// A project is a data root that the user config lists (AO-0353). These functions archive, label,
// relocate and remove one. Each changes only the user config: nothing on disk outside that file is
// read for writing, moved or deleted.
import { existsSync } from 'node:fs';
import { isMap, isSeq, isScalar, type Document } from 'yaml';
import type { RootOptions, UserConfig } from './config.js';
import {
  checkRoot,
  editUserConfig,
  readUserConfig,
  rootNameOf,
  rootOptionsOf,
  sameRoot,
  storeDirIn,
} from './config.js';
import { OpsError } from './ids.js';

/** The user config key of the per-root options. */
export const ROOT_OPTIONS_KEY = 'root_options';

/** A root as the user config lists it, with its options. */
export interface ListedRoot {
  /** The folder as `roots` lists it. */
  root: string;
  /** The name in the root's own config: its id. Null when the folder holds no readable root. */
  name: string | null;
  /** The name the app shows: `label` when set, else `name`. */
  label: string | null;
  archived: boolean;
  /** The folder is there. A root whose folder moved needs a relocate. */
  found: boolean;
}

/** Every root in the user config's `roots`, archived ones included, in the listed order. */
export function listRoots(
  env: NodeJS.ProcessEnv,
  user: UserConfig = readUserConfig(env),
): ListedRoot[] {
  return (user.roots ?? []).map(String).map((root) => {
    const found = existsSync(root);
    const name = found ? rootNameOf(storeDirIn(root) ?? root) : null;
    const opts = rootOptionsOf(user, root);
    return {
      root,
      name,
      label: typeof opts.label === 'string' && opts.label.trim() ? opts.label : name,
      archived: opts.archived === true,
      found,
    };
  });
}

/** The entry of `roots` that names `root`, as listed. Throws when none does. */
function listedEntry(user: UserConfig, root: string): string {
  if (typeof root !== 'string' || !root.trim()) throw new OpsError('root: name a folder', 2);
  const hit = (user.roots ?? []).map(String).find((r) => sameRoot(r, root));
  if (!hit) throw new OpsError(`${root} is not in the user config's roots`, 2);
  return hit;
}

/** The key under `root_options` that names `root`, or null. */
function optionsKey(doc: Document, root: string): string | null {
  const map = doc.get(ROOT_OPTIONS_KEY, true);
  if (!isMap(map)) return null;
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (sameRoot(key, root)) return key;
  }
  return null;
}

/** Sets or clears one option of a root; drops the root's options, then the map, once empty. */
function setOption<K extends keyof RootOptions>(
  doc: Document,
  root: string,
  key: K,
  value: RootOptions[K] | undefined,
): void {
  const at = optionsKey(doc, root);
  if (value === undefined) {
    if (at === null || !doc.hasIn([ROOT_OPTIONS_KEY, at, key])) return;
    doc.deleteIn([ROOT_OPTIONS_KEY, at, key]);
    const left = doc.getIn([ROOT_OPTIONS_KEY, at], true);
    if (!isMap(left) || left.items.length === 0) doc.deleteIn([ROOT_OPTIONS_KEY, at]);
    const all = doc.get(ROOT_OPTIONS_KEY, true);
    if (isMap(all) && all.items.length === 0) doc.delete(ROOT_OPTIONS_KEY);
    return;
  }
  if (!isMap(doc.get(ROOT_OPTIONS_KEY, true))) doc.set(ROOT_OPTIONS_KEY, doc.createNode({}));
  doc.setIn([ROOT_OPTIONS_KEY, at ?? root, key], value);
}

/**
 * Archives a root, or with `archived` false unarchives it. An archived root stays in `roots`, but
 * no reader loads it: it is off the board and swarmupd starts no run on its tasks. A run already
 * going finishes, since swarmupd hands each run its roots when it starts.
 */
export function archiveRoot(
  env: NodeJS.ProcessEnv,
  root: string,
  archived: boolean,
  check?: (next: UserConfig) => void,
): ListedRoot {
  if (typeof archived !== 'boolean') throw new OpsError('archived: use true or false', 2);
  const entry = listedEntry(readUserConfig(env), root);
  const next = editUserConfig(
    env,
    (doc) => setOption(doc, entry, 'archived', archived ? true : undefined),
    check,
  );
  return listRoots(env, next).find((r) => r.root === entry)!;
}

/**
 * Sets the name the app shows for a root. An empty or null `label` clears it, so the root's own
 * name shows again. The root's own name is its id in task references and stays as it is.
 */
export function labelRoot(
  env: NodeJS.ProcessEnv,
  root: string,
  label: string | null,
  check?: (next: UserConfig) => void,
): ListedRoot {
  if (label !== null && typeof label !== 'string') {
    throw new OpsError('label: use a name, or null to clear it', 2);
  }
  const text = label?.trim() ?? '';
  if (/[\r\n]/.test(text)) throw new OpsError('label: use one line', 2);
  if (text.length > 80) throw new OpsError('label: use 80 characters at most', 2);
  const entry = listedEntry(readUserConfig(env), root);
  const next = editUserConfig(
    env,
    (doc) => setOption(doc, entry, 'label', text || undefined),
    check,
  );
  return listRoots(env, next).find((r) => r.root === entry)!;
}

/**
 * Points a root's entry at another folder, keeping its place in `roots` and its options. The new
 * folder must hold a data root, as on add, and no other entry may list it. Moves nothing on disk.
 */
export function relocateRoot(
  env: NodeJS.ProcessEnv,
  root: string,
  to: string,
  check?: (next: UserConfig) => void,
): ListedRoot {
  if (typeof to !== 'string' || !to.trim()) throw new OpsError('to: name a folder', 2);
  const user = readUserConfig(env);
  const entry = listedEntry(user, root);
  const target = checkRoot(to);
  const other = (user.roots ?? []).map(String).find((r) => r !== entry && sameRoot(r, target));
  if (other) throw new OpsError(`${target} is in the user config's roots already, as ${other}`, 2);
  const next = editUserConfig(
    env,
    (doc) => {
      const seq = doc.get('roots', true);
      if (!isSeq(seq)) throw new OpsError('roots: expected a list', 2);
      const i = seq.items.findIndex((n) => String(isScalar(n) ? n.value : n) === entry);
      seq.set(i, target);
      const at = optionsKey(doc, entry);
      if (at !== null) {
        const opts = doc.getIn([ROOT_OPTIONS_KEY, at]);
        doc.deleteIn([ROOT_OPTIONS_KEY, at]);
        doc.setIn([ROOT_OPTIONS_KEY, target], doc.createNode(opts));
      }
    },
    check,
  );
  return listRoots(env, next).find((r) => r.root === target)!;
}

/**
 * Drops a root's entry, and its options, from the user config. Never deletes or changes anything
 * on disk: the folder, its tasks and its git history stay where they are, and adding the folder
 * again brings the project back.
 */
export function removeRoot(
  env: NodeJS.ProcessEnv,
  root: string,
  check?: (next: UserConfig) => void,
): ListedRoot[] {
  const entry = listedEntry(readUserConfig(env), root);
  const next = editUserConfig(
    env,
    (doc) => {
      const seq = doc.get('roots', true);
      if (!isSeq(seq)) throw new OpsError('roots: expected a list', 2);
      const i = seq.items.findIndex((n) => String(isScalar(n) ? n.value : n) === entry);
      seq.delete(i);
      const at = optionsKey(doc, entry);
      if (at !== null) doc.deleteIn([ROOT_OPTIONS_KEY, at]);
      const all = doc.get(ROOT_OPTIONS_KEY, true);
      if (isMap(all) && all.items.length === 0) doc.delete(ROOT_OPTIONS_KEY);
    },
    check,
  );
  return listRoots(env, next);
}
