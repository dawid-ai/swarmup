import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import type { MapType, ProjectMap } from '@swarmup/core';
import {
  checkMap,
  findNode,
  initMap,
  MAP_DIR,
  MAP_TYPES,
  nodeLine,
  nodeNeighbours,
  nodesCovering,
  OpsError,
  pathInProject,
  projectTop,
  readMap,
  searchMap,
  surveyRepo,
  detectMapType,
  writeMapIndex,
} from '@swarmup/core';

/** What `swarmup map` needs of the CLI's context. */
interface MapCtx {
  io: { out: (line: string) => void; err: (line: string) => void; cwd: string };
  args: string[];
  opts: Record<string, string | boolean | string[] | undefined>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** `swarmup map`: search, show, index, check and init the project map. */
export const mapCommand = {
  usage:
    'map [WORDS...] | map --file PATH | map show ID | map index | map check [--base REF] [--json] | map init [--type code|website|campaign]; each takes [--cwd DIR]',
  summary:
    'the project map in .swarmup/map/: find nodes by words or file, show one, regenerate _INDEX.md, check it against a change, or start one',
  options: {
    cwd: { type: 'string' },
    file: { type: 'string' },
    base: { type: 'string' },
    type: { type: 'string' },
  } satisfies NonNullable<ParseArgsConfig['options']>,
  run: (ctx: MapCtx): number => runMap(ctx),
};

function runMap(ctx: MapCtx): number {
  const cwd = resolve(ctx.io.cwd, str(ctx.opts.cwd) ?? '.');
  const top = projectTop(cwd);
  const [sub, ...rest] = ctx.args;
  const json = Boolean(ctx.opts.json);
  if (sub === 'init') return init(ctx, top);
  if (sub === 'check') return check(ctx, top, json);
  const map = readMap(top);
  if (!map) {
    ctx.io.out(`${top} has no project map (${MAP_DIR}/); \`swarmup map init\` starts one`);
    return 0;
  }
  if (sub === 'index') {
    const file = writeMapIndex(map);
    ctx.io.out(`wrote ${file} (${map.nodes.length} nodes)`);
    return 0;
  }
  if (sub === 'show') {
    if (!rest[0]) throw new OpsError('name the node: swarmup map show <id>', 2);
    return show(ctx, map, rest[0], json);
  }
  const file = str(ctx.opts.file);
  if (file) {
    const path = pathInProject(top, cwd, file);
    const nodes = nodesCovering(map, path);
    if (json) ctx.io.out(JSON.stringify(nodes.map(brief), null, 2));
    else if (nodes.length === 0) ctx.io.out(`no node covers ${path}`);
    else for (const n of nodes) ctx.io.out(nodeLine(n));
    return 0;
  }
  const hits = searchMap(map, ctx.args, 10);
  if (json)
    ctx.io.out(
      JSON.stringify(
        hits.map((h) => ({ ...brief(h.node), score: h.score })),
        null,
        2,
      ),
    );
  else if (hits.length === 0) ctx.io.out(`no node matches ${ctx.args.join(' ')}`);
  else for (const h of hits) ctx.io.out(nodeLine(h.node));
  return 0;
}

function brief(n: { id: string; kind: string; summary: string; file: string }) {
  return { id: n.id, kind: n.kind, summary: n.summary, file: `${MAP_DIR}/${n.file}` };
}

function show(ctx: MapCtx, map: ProjectMap, id: string, json: boolean): number {
  const node = findNode(map, id);
  const { links, from } = nodeNeighbours(map, node);
  if (json) {
    ctx.io.out(
      JSON.stringify({ ...node, links: links.map(brief), linked_from: from.map(brief) }, null, 2),
    );
    return 0;
  }
  ctx.io.out(`${MAP_DIR}/${node.file}`);
  ctx.io.out(readFileSync(join(map.dir, node.file), 'utf8').replace(/\r\n/g, '\n').trimEnd());
  if (links.length > 0) {
    ctx.io.out('\nLinks:');
    for (const n of links) ctx.io.out(`- ${nodeLine(n)}`);
  }
  if (from.length > 0) {
    ctx.io.out('\nLinked from:');
    for (const n of from) ctx.io.out(`- ${nodeLine(n)}`);
  }
  return 0;
}

function check(ctx: MapCtx, top: string, json: boolean): number {
  const res = checkMap(top, { base: str(ctx.opts.base) });
  if (json) {
    ctx.io.out(JSON.stringify({ ok: res.errors.length === 0, ...res }, null, 2));
    return res.errors.length > 0 ? 1 : 0;
  }
  if (!res.hasMap) {
    ctx.io.out(`${top} has no project map (${MAP_DIR}/): nothing to check`);
    return 0;
  }
  for (const e of res.errors) ctx.io.out(`error: ${e.message}`);
  for (const w of res.warnings) ctx.io.out(`warning: ${w.message}`);
  const against = res.base ? ` against ${res.base.ref} (${res.base.commit.slice(0, 8)})` : '';
  ctx.io.out(
    `map check: ${res.errors.length} error(s), ${res.warnings.length} warning(s); ${res.nodes} nodes, ${res.changed} changed path(s)${against}`,
  );
  return res.errors.length > 0 ? 1 : 0;
}

function init(ctx: MapCtx, top: string): number {
  const type = str(ctx.opts.type);
  if (type && !(MAP_TYPES as readonly string[]).includes(type)) {
    throw new OpsError(`no map type '${type}': use ${MAP_TYPES.join(', ')}`, 2);
  }
  let detected: MapType | undefined;
  if (!type) {
    let survey: { stacks: string[]; frameworks: string[] } | undefined;
    try {
      survey = surveyRepo(top);
    } catch {
      survey = undefined;
    }
    detected = detectMapType(top, survey);
  }
  const res = initMap(top, { type: (type as MapType | undefined) ?? detected });
  ctx.io.out(
    `created ${res.dir} (${res.type}${type ? '' : ', detected'}): ${res.files.join(', ')}`,
  );
  ctx.io.out(
    'Next: write the root summary in index.md, add a node per area, then run `swarmup map index` and `swarmup map check`.',
  );
  return 0;
}
