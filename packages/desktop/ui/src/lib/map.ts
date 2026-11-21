import type { MapCheck, MapNodeBrief } from '../types';

// Pure helpers of the Map view: what a search box entry means, review dates, grouping and the
// health of a check.

/**
 * Whether the search text names a file rather than words: one token with a backslash, or with a
 * slash and a file extension in its last segment, or a bare file name such as `package.json`.
 * Node ids such as `core/fold` stay words, so they match by id.
 */
export function isPathQuery(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  if (t.includes('\\')) return true;
  const last = t.split('/').pop() ?? '';
  return /\.[A-Za-z0-9]{1,8}$/.test(last);
}

/** Today in the person's time zone, `YYYY-MM-DD`. */
export function localDay(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whether a node is past its `review_after` date. */
export function reviewDue(node: Pick<MapNodeBrief, 'review_after'>, today = localDay()): boolean {
  return !!node.review_after && node.review_after < today;
}

export function isUrl(entry: string): boolean {
  return /^https?:\/\//i.test(entry.trim());
}

/** Nodes by kind, the root kind first, then kinds by name; nodes keep their id order. */
export function byKind(nodes: MapNodeBrief[]): Array<[string, MapNodeBrief[]]> {
  const groups = new Map<string, MapNodeBrief[]>();
  for (const n of nodes) {
    const k = n.kind || '?';
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return [...groups.entries()].sort(([a], [b]) =>
    a === 'root' ? -1 : b === 'root' ? 1 : a.localeCompare(b),
  );
}

export interface TreeRow {
  node: MapNodeBrief;
  /** Folders above the node: `core/fold` is 1 deep. */
  depth: number;
  /** The last segment of the id. */
  label: string;
}

/** Nodes as a tree by id path: the root, then each id after its folder node. */
export function treeRows(nodes: MapNodeBrief[]): TreeRow[] {
  const sorted = [...nodes].sort((a, b) =>
    a.id === 'index' ? -1 : b.id === 'index' ? 1 : a.id.localeCompare(b.id),
  );
  return sorted.map((node) => {
    const parts = node.id.split('/');
    return {
      node,
      depth: node.id === 'index' ? 0 : parts.length - 1,
      label: parts[parts.length - 1]!,
    };
  });
}

export type MapHealth = 'errors' | 'warnings' | 'ok';

/** The badge of a check: errors win over warnings. */
export function healthOf(check: Pick<MapCheck, 'errors' | 'warnings'>): {
  health: MapHealth;
  label: string;
} {
  const e = check.errors.length;
  const w = check.warnings.length;
  if (e > 0) return { health: 'errors', label: `${e} error${e === 1 ? '' : 's'}` };
  if (w > 0) return { health: 'warnings', label: `${w} warning${w === 1 ? '' : 's'}` };
  return { health: 'ok', label: 'Map OK' };
}

export interface GraphPoint {
  id: string;
  x: number;
  y: number;
}

/**
 * Places nodes for the constellation: the root in the middle, folder nodes on an inner ring, the
 * nodes in them and top-level nodes with nothing below them on an outer ring. Each folder gets a
 * share of the circle by how many nodes it holds, so a large folder does not crowd its nodes
 * together. Coordinates are in a square of `size`.
 */
export function graphLayout(nodes: Pick<MapNodeBrief, 'id'>[], size = 600): GraphPoint[] {
  const c = size / 2;
  const top = (id: string): string => id.split('/')[0]!;
  const others = nodes.filter((n) => n.id !== 'index');
  const areas = [...new Set(others.map((n) => top(n.id)))].sort().map((area) => ({
    area,
    kids: others.filter((n) => top(n.id) === area && n.id !== area),
  }));
  const total = areas.reduce((sum, a) => sum + Math.max(a.kids.length, 1), 0);
  const out: GraphPoint[] = [];
  if (nodes.some((n) => n.id === 'index')) out.push({ id: 'index', x: c, y: c });
  const at = (r: number, t: number, id: string): GraphPoint => ({
    id,
    x: c + r * Math.cos(t),
    y: c + r * Math.sin(t),
  });
  let start = -Math.PI / 2;
  for (const { area, kids } of areas) {
    const span = (2 * Math.PI * Math.max(kids.length, 1)) / Math.max(total, 1);
    // A folder node sits inside its nodes; a node with none below it stays on the outer ring.
    const r = size * (kids.length > 0 ? 0.22 : 0.42);
    if (others.some((n) => n.id === area)) out.push(at(r, start + span / 2, area));
    kids.forEach((k, j) =>
      out.push(at(size * 0.42, start + (span * (j + 0.5)) / kids.length, k.id)),
    );
    start += span;
  }
  return out;
}
