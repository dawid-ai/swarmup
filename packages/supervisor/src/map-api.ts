import { isAbsolute, join } from 'node:path';
import type { MapCheck, MapNode, MapType, ProjectMap } from '@swarmup/core';
import {
  checkMapAsync,
  detectMapTypeAsync,
  findNode,
  initMap,
  MAP_DIR,
  MAP_ROOT_ID,
  MAP_TYPES,
  nodeNeighbours,
  nodesCovering,
  OpsError,
  pathInProject,
  readMap,
  resolveLink,
  searchMap,
  slashPath,
  surveyRepo,
  writeMapIndex,
} from '@swarmup/core';

// The project map over swarmupd's API, for the desktop app's Map view. Node files are read
// synchronously, as `readMap` does; anything that runs git (the check, type detection) runs it
// off the event loop.

/** A node as the app lists it: no body, links resolved to node ids. */
export interface MapNodeBrief {
  id: string;
  /** The node file from the project top, such as `.swarmup/map/core/fold.md`. */
  file: string;
  kind: string;
  summary: string;
  covers: string[];
  /** The node ids its links resolve to. */
  links: string[];
  /** Links that name no node. */
  broken: string[];
  verified?: string;
  review_after?: string;
  /** Body lines. */
  size: number;
  /** What is wrong with the file itself: bad frontmatter, a field of the wrong type. */
  problems: string[];
}

export interface MapView {
  root: string;
  /** The project folder the map is in: the root's code checkout, else its store's folder. */
  top: string;
  /** The map folder, or null when the project has none. */
  dir: string | null;
  exists: boolean;
  /** The root node's `type`, when it has one. */
  type: string | null;
  /** The type `init` would pick, when the project has no map yet. */
  detected?: MapType;
  /** The root node's summary. */
  summary: string;
  kinds: string[];
  nodes: MapNodeBrief[];
}

export interface MapNodeView extends MapNodeBrief {
  body: string;
  /** The nodes it links to, and the ones that link to it. */
  linksTo: MapNodeBrief[];
  linkedFrom: MapNodeBrief[];
}

function brief(map: ProjectMap, ids: Set<string>, n: MapNode): MapNodeBrief {
  const links: string[] = [];
  const broken: string[] = [];
  for (const l of n.links) {
    const id = resolveLink(n, l, ids);
    if (id) links.push(id);
    else broken.push(l);
  }
  return {
    id: n.id,
    file: `${MAP_DIR}/${n.file}`,
    kind: n.kind,
    summary: n.summary,
    covers: n.covers,
    links,
    broken,
    ...(n.verified ? { verified: n.verified } : {}),
    ...(n.review_after ? { review_after: n.review_after } : {}),
    size: n.bodyLines,
    problems: n.problems,
  };
}

/** The type `swarmup map init` picks for the project at `top`. */
async function detectedType(top: string): Promise<MapType> {
  let survey: { stacks: string[]; frameworks: string[] } | undefined;
  try {
    survey = surveyRepo(top);
  } catch {
    survey = undefined;
  }
  return detectMapTypeAsync(top, survey);
}

const idsOf = (map: ProjectMap): Set<string> => new Set(map.nodes.map((n) => n.id));

/** `GET /api/map`: the map of the project at `top`, or what `init` would start there. */
export async function mapView(root: string, top: string): Promise<MapView> {
  const map = readMap(top);
  if (!map) {
    return {
      root,
      top,
      dir: null,
      exists: false,
      type: null,
      detected: await detectedType(top),
      summary: '',
      kinds: [],
      nodes: [],
    };
  }
  const ids = idsOf(map);
  const rootNode = map.nodes.find((n) => n.id === MAP_ROOT_ID);
  return {
    root,
    top,
    dir: map.dir,
    exists: true,
    type: rootNode?.type ?? null,
    summary: rootNode?.summary ?? '',
    kinds: [...map.kinds].sort(),
    nodes: map.nodes.map((n) => brief(map, ids, n)),
  };
}

function needMap(top: string): ProjectMap {
  const map = readMap(top);
  if (!map) throw new OpsError(`${top} has no project map (${MAP_DIR}/)`, 1);
  return map;
}

/** `GET /api/map/node`: one node with its body and neighbours; null when no node has the id. */
export function mapNodeView(top: string, id: string): MapNodeView | null {
  const map = needMap(top);
  let node: MapNode;
  try {
    node = findNode(map, id);
  } catch (err) {
    // Several nodes end in the id: a bad request, said as such. None: not found.
    if (err instanceof OpsError && err.code === 2) throw err;
    return null;
  }
  const ids = idsOf(map);
  const { links, from } = nodeNeighbours(map, node);
  return {
    ...brief(map, ids, node),
    body: node.body,
    linksTo: links.map((n) => brief(map, ids, n)),
    linkedFrom: from.map((n) => brief(map, ids, n)),
  };
}

/** Most nodes a word search answers with. */
export const MAP_SEARCH_LIMIT = 20;

/**
 * `GET /api/map/search`: the nodes that cover `file` (from the project top, or absolute inside
 * it), else the nodes that match any of the words in `q`, best first.
 */
export function mapSearch(
  top: string,
  opts: { q?: string; file?: string },
): Array<MapNodeBrief & { score?: number }> {
  const map = needMap(top);
  const ids = idsOf(map);
  if (opts.file) {
    const path = isAbsolute(opts.file) ? pathInProject(top, top, opts.file) : slashPath(opts.file);
    return nodesCovering(map, path).map((n) => brief(map, ids, n));
  }
  const words = (opts.q ?? '').split(/\s+/).filter(Boolean);
  return searchMap(map, words, MAP_SEARCH_LIMIT).map((h) => ({
    ...brief(map, ids, h.node),
    score: h.score,
  }));
}

/** `POST /api/map/check`: errors and warnings, against `base` or the default base. */
export async function mapCheck(
  top: string,
  base?: string,
): Promise<MapCheck & { ok: boolean; top: string }> {
  const res = await checkMapAsync(top, base ? { base } : {});
  return { ok: res.errors.length === 0, top, ...res };
}

/** `POST /api/map/index`: writes `_INDEX.md`. */
export function mapIndex(top: string): { file: string; nodes: number } {
  const map = needMap(top);
  return { file: writeMapIndex(map), nodes: map.nodes.length };
}

/** `POST /api/map/init`: starts a map of `type`, else of the detected type. */
export async function mapInit(
  top: string,
  type?: string,
): Promise<{ dir: string; type: MapType; files: string[]; detected: boolean }> {
  if (type && !(MAP_TYPES as readonly string[]).includes(type)) {
    throw new OpsError(`no map type '${type}': use ${MAP_TYPES.join(', ')}`, 2);
  }
  if (readMap(top)) throw new OpsError(`${join(top, MAP_DIR)} exists already`, 1);
  const picked = (type as MapType | undefined) ?? (await detectedType(top));
  return { ...initMap(top, { type: picked }), detected: !type };
}
