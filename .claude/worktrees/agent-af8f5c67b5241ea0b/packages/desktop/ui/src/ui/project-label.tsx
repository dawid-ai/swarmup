import { useCallback, useSyncExternalStore } from 'react';

/**
 * Display names of projects, keyed by the root's own `name`. Tasks, filters, saved views and API
 * calls keep the name; only what a person reads shows the label set with **Edit name** (AO-0353).
 */
export type ProjectLabels = ReadonlyMap<string, string>;

const store: { labels: ProjectLabels; key: string; listeners: Set<() => void> } = {
  labels: new Map(),
  key: '[]',
  listeners: new Set(),
};

/**
 * The labels of `sources`, later entries winning: App passes the settings' roots, then the
 * sidebar's projects, which update as soon as a rename answers.
 */
export function projectLabels(
  ...sources: Array<ReadonlyArray<{ name: string | null; label?: string | null }> | undefined>
): Map<string, string> {
  const out = new Map<string, string>();
  for (const list of sources) {
    for (const p of list ?? []) {
      const label = p.label?.trim();
      if (p.name && label) out.set(p.name, label);
    }
  }
  return out;
}

/** App sets the labels from its live `/api/settings` and `/api/projects` data. */
export function setProjectLabels(labels: ProjectLabels): void {
  const key = JSON.stringify([...labels]);
  if (key === store.key) return;
  store.key = key;
  store.labels = new Map(labels);
  for (const fn of store.listeners) fn();
}

function subscribe(fn: () => void): () => void {
  store.listeners.add(fn);
  return () => {
    store.listeners.delete(fn);
  };
}

const current = (): ProjectLabels => store.labels;

/** The label of the project `name`, else `name` itself; '' for no name. */
export function projectLabelOf(labels: ProjectLabels, name: string | null | undefined): string {
  if (!name) return '';
  return labels.get(name) ?? name;
}

/** Turns a project `name` into the name to show; draws again when a label changes. */
export function useProjectLabel(): (name: string | null | undefined) => string {
  const labels = useSyncExternalStore(subscribe, current);
  return useCallback((name: string | null | undefined) => projectLabelOf(labels, name), [labels]);
}

/** The display name of the project `name`, for JSX. */
export function ProjectName({ name }: { name: string | null | undefined }) {
  return <>{useProjectLabel()(name)}</>;
}
