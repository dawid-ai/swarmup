// Knowledge constellation (AO-0080): a force graph of tasks, agents, learn notes and files. Edges
// come from ownership (work spans), parent and blocked-by links, learn notes, and the files event
// text names (`timeline.graph`, `/api/timeline?graph=1`). Nodes appear when the playhead reaches
// them and pulse each time playback touches them.
//
// `prepare` does all the work: a seeded force layout with a fixed number of steps, then label
// placement that drops any label that would overlap another label, a node, the header or the
// legend. `render` only reads that and `frame.t`, so two renders of the same t are identical.
//
// Notes light up when written (`learn` events) and each time an agent reads one with
// `ops kb --read` (`noteReads`, AO-0186); a read links the note to the reader and its task.
import { identity } from '../../lib/identity';
import { playbackOf, realAt, seeded, seedOf, utcStamp } from '../../lib/replay';
import type { TimeMap, Timeline } from '../../types';
import { BACKDROP } from '../scene';
import type { Scene, Stage } from '../scene';

export type NodeKind = 'agent' | 'task' | 'note' | 'file';
export type EdgeKind = 'owns' | 'parent' | 'blocks' | 'learn' | 'read' | 'file';

export interface ConstellationNode {
  key: string;
  kind: NodeKind;
  label: string;
  color: string;
  x: number;
  y: number;
  r: number;
  /** Playback ms the node appears at; 0 for what existed before the window. */
  appear: number;
  /** Playback ms of every touch, ascending. */
  touches: number[];
  /** Tasks: playback ms the task closed at, when it closed in the window. */
  closeAt?: number;
}

export interface ConstellationEdge {
  a: number;
  b: number;
  kind: EdgeKind;
  /** Playback ms the link exists from. */
  at: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ConstellationLabel extends Box {
  node: number;
  text: string;
  size: number;
  /** An agent's name on a backdrop, drawn above nodes and edges. */
  badge: boolean;
}

export interface ConstellationData {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  labels: ConstellationLabel[];
  /** Areas labels keep out of: the header and the legend. */
  reserved: Box[];
  legend: Box;
  duration: number;
  map: TimeMap;
}

export const NODE_COLORS: Record<Exclude<NodeKind, 'agent'>, string> = {
  task: '#5aa9ff',
  note: '#ffd166',
  file: '#b18cff',
};
const CLOSED_COLOR = '#3ddc97';
const EDGE_COLORS: Record<EdgeKind, string> = {
  owns: '#5ce1e6',
  parent: '#5aa9ff',
  blocks: '#ff9f43',
  learn: '#ffd166',
  read: '#ffd166',
  file: '#b18cff',
};

/** Files past this many (fewest mentions first) are left out, so the graph stays readable. */
export const MAX_FILES = 80;
/** How long a touched node stays enlarged, in playback ms. */
const PULSE_MS = 900;
const LAYOUT_STEPS = 300;
const GRAVITY = 5;
const GRAVITY_LONE = 60;
const HEADER_H = 130;
const MARGIN = 60;
const FONT = "'IBM Plex Sans', sans-serif";
const LABEL_SIZE: Record<NodeKind, number> = { agent: 20, task: 15, note: 15, file: 14 };
const LABEL_RANK: Record<NodeKind, number> = { agent: 0, task: 1, note: 2, file: 3 };
/** Wider than IBM Plex Sans' average advance, so an estimated box never undershoots the text. */
const CHAR_EM = 0.62;

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** The label box of `text` at `size`, without its position. */
export function textSize(text: string, size: number): { w: number; h: number } {
  return { w: Math.ceil(text.length * size * CHAR_EM), h: Math.ceil(size * 1.25) };
}

export function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

interface Builder {
  nodes: ConstellationNode[];
  index: Map<string, number>;
  edges: Map<string, ConstellationEdge>;
}

function node(
  g: Builder,
  key: string,
  init: () => Omit<ConstellationNode, 'key' | 'x' | 'y' | 'r' | 'touches'>,
): number {
  let i = g.index.get(key);
  if (i === undefined) {
    i = g.nodes.length;
    g.nodes.push({ key, x: 0, y: 0, r: 0, touches: [], ...init() });
    g.index.set(key, i);
  }
  return i;
}

function edge(g: Builder, a: number, b: number, kind: EdgeKind, at: number): void {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  const key = `${kind}:${x}:${y}`;
  const old = g.edges.get(key);
  if (!old || at < old.at) g.edges.set(key, { a: x, b: y, kind, at });
}

/** The nodes and edges of the timeline, before layout. */
function graphOf(tl: Timeline): Builder {
  const g: Builder = { nodes: [], index: new Map(), edges: new Map() };
  const pt = (iso: string): number => playbackOf(tl.time, iso);
  const created = new Map(tl.created.map((c) => [`${c.root}/${c.task}`, pt(c.at)]));
  const title = new Map<string, string>();
  for (const x of [...(tl.graph?.tasks ?? []), ...tl.created, ...tl.spans, ...tl.closes]) {
    title.set(`${x.root}/${x.task}`, x.title);
  }

  const task = (root: string, id: string): number =>
    node(g, `task:${root}/${id}`, () => ({
      kind: 'task',
      label: id,
      color: NODE_COLORS.task,
      appear: created.get(`${root}/${id}`) ?? 0,
    }));
  const agent = (id: string, at: number): number => {
    const i = node(g, `agent:${id}`, () => ({
      kind: 'agent',
      label: id,
      color: identity(id).provider.color,
      appear: at,
    }));
    g.nodes[i]!.appear = Math.min(g.nodes[i]!.appear, at);
    return i;
  };
  const touch = (i: number, at: number): void => {
    g.nodes[i]!.touches.push(at);
  };

  // Tasks in a stable order, so the layout does not depend on the order the server sent them in.
  const tasks = new Set<string>();
  for (const t of tl.graph?.tasks ?? []) tasks.add(`${t.root}\u0000${t.task}`);
  for (const x of [...tl.created, ...tl.spans, ...tl.reviews, ...tl.waits, ...tl.notes]) {
    tasks.add(`${x.root}\u0000${x.task}`);
  }
  const reads = tl.noteReads ?? [];
  for (const r of reads) if (r.task) tasks.add(`${r.taskRoot ?? r.root}\u0000${r.task}`);
  for (const k of [...tasks].sort()) {
    const [root, id] = k.split('\u0000') as [string, string];
    task(root, id);
  }

  for (const c of tl.created) {
    const i = task(c.root, c.task);
    touch(i, pt(c.at));
    touch(agent(c.by, pt(c.at)), pt(c.at));
  }
  for (const s of tl.spans) {
    const at = pt(s.start);
    const i = task(s.root, s.task);
    const a = agent(s.agent, at);
    touch(i, at);
    touch(a, at);
    edge(g, a, i, 'owns', at);
  }
  // Every event in the window lights up its task and its actor: progress, checkpoints, comments,
  // releases and the rest, not only the events the timeline turns into spans and rounds.
  for (const x of tl.graph?.touches ?? []) {
    const at = pt(x.at);
    touch(task(x.root, x.task), at);
    touch(agent(x.actor, at), at);
  }
  for (const r of tl.runs) touch(agent(r.agent, pt(r.start)), pt(r.start));
  for (const r of tl.reviews) {
    const i = task(r.root, r.task);
    touch(i, pt(r.start));
    touch(agent(r.author, pt(r.start)), pt(r.start));
    // The request reaches the reviewer when it is sent.
    if (r.reviewer) touch(agent(r.reviewer, pt(r.start)), pt(r.start));
    if (r.end && r.decidedBy) {
      touch(i, pt(r.end));
      touch(agent(r.decidedBy, pt(r.end)), pt(r.end));
    }
  }
  for (const w of tl.waits) {
    const at = pt(w.start);
    const i = task(w.root, w.task);
    touch(i, at);
    touch(agent(w.actor, at), at);
    if (w.waitingOn) touch(agent(w.waitingOn, at), at);
    if (w.end) touch(i, pt(w.end));
    if (w.kind === 'block') for (const on of w.on) edge(g, i, task(w.root, on), 'blocks', at);
  }
  for (const c of tl.closes) {
    const i = task(c.root, c.task);
    const at = pt(c.at);
    touch(i, at);
    touch(agent(c.by, at), at);
    const n = g.nodes[i]!;
    n.closeAt = Math.min(n.closeAt ?? Infinity, at);
  }
  // A note appears when it is first written or read in the window, like an agent.
  const note = (root: string, name: string, label: string, at: number): number => {
    const i = node(g, `note:${root}/${name}`, () => ({
      kind: 'note',
      label: cut(label, 24),
      color: NODE_COLORS.note,
      appear: at,
    }));
    g.nodes[i]!.appear = Math.min(g.nodes[i]!.appear, at);
    touch(i, at);
    return i;
  };
  for (const n of tl.notes) {
    const at = pt(n.at);
    const name = n.ref ?? `${n.task}/${n.title}`;
    const i = note(n.root, name, n.ref ? (n.ref.split('/').pop() ?? n.ref) : n.title, at);
    const t = task(n.root, n.task);
    const a = agent(n.agent, at);
    touch(t, at);
    touch(a, at);
    edge(g, i, t, 'learn', at);
    edge(g, i, a, 'learn', at);
  }
  // Each read lights the note up again: knowledge being reused.
  for (const r of reads) {
    const at = pt(r.at);
    const i = note(r.root, r.ref, r.ref.split('/').pop() ?? r.ref, at);
    const a = agent(r.agent, at);
    touch(a, at);
    edge(g, i, a, 'read', at);
    if (r.task) {
      const t = task(r.taskRoot ?? r.root, r.task);
      touch(t, at);
      edge(g, i, t, 'read', at);
    }
  }
  for (const d of tl.decisions) {
    const t = d.task ? task(d.root, d.task) : null;
    const moments: Array<[string, string]> = [
      [d.proposedBy, d.start],
      ...d.ballots.map((b): [string, string] => [b.actor, b.at]),
      ...(d.decidedBy && d.end ? [[d.decidedBy, d.end] as [string, string]] : []),
    ];
    for (const [who, iso] of moments) {
      const at = pt(iso);
      touch(agent(who, at), at);
      if (t !== null) touch(t, at);
    }
  }

  // Parent and blocked-by links from the task files: they exist once both ends do.
  for (const t of tl.graph?.tasks ?? []) {
    const i = task(t.root, t.task);
    const links: Array<[string, EdgeKind]> = [
      ...(t.parent ? [[t.parent, 'parent'] as [string, EdgeKind]] : []),
      ...t.blockedBy.map((b): [string, EdgeKind] => [b, 'blocks']),
    ];
    for (const [other, kind] of links) {
      const j = task(t.root, other);
      edge(g, i, j, kind, Math.max(g.nodes[i]!.appear, g.nodes[j]!.appear));
    }
  }

  // Files: the most-mentioned ones only.
  const mentions = new Map<string, number>();
  for (const f of tl.graph?.files ?? []) {
    const k = `${f.root}\u0000${f.path}`;
    mentions.set(k, (mentions.get(k) ?? 0) + 1);
  }
  const kept = new Set(
    [...mentions.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_FILES)
      .map(([k]) => k),
  );
  for (const f of tl.graph?.files ?? []) {
    if (!kept.has(`${f.root}\u0000${f.path}`)) continue;
    const at = pt(f.at);
    const i = node(g, `file:${f.root}/${f.path}`, () => ({
      kind: 'file',
      label: cut(f.path.split('/').pop() ?? f.path, 26),
      color: NODE_COLORS.file,
      appear: at,
    }));
    g.nodes[i]!.appear = Math.min(g.nodes[i]!.appear, at);
    touch(i, at);
    const t = task(f.root, f.task);
    touch(t, at);
    touch(agent(f.actor, at), at);
    edge(g, i, t, 'file', at);
  }

  // Several sources can report the same moment (a span start and its claim event); keep it once.
  for (const n of g.nodes) {
    n.touches = [...new Set(n.touches)].sort((a, b) => a - b);
  }
  return g;
}

/**
 * A Fruchterman-Reingold layout in `area`, seeded per node key and run for a fixed number of
 * steps, so the same graph always lands in the same place.
 */
function layout(
  nodes: ConstellationNode[],
  edges: ConstellationEdge[],
  deg: number[],
  area: Box,
): void {
  const n = nodes.length;
  if (n === 0) return;
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const k = 0.8 * Math.sqrt((area.w * area.h) / n);
  for (const nd of nodes) {
    const rnd = seeded(seedOf(nd.key));
    nd.x = area.x + rnd() * area.w;
    nd.y = area.y + rnd() * area.h;
  }
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let step = 0; step < LAYOUT_STEPS; step++) {
    const temp = (area.w / 10) * (1 - step / LAYOUT_STEPS) + 1;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]!;
        let ex = a.x - b.x;
        let ey = a.y - b.y;
        let d = Math.hypot(ex, ey);
        if (d < 0.01) {
          // Coincident nodes: push apart along a direction fixed by their indices.
          ex = Math.cos(i + j * 7);
          ey = Math.sin(i + j * 7);
          d = 0.01;
        }
        const gap = Math.max(1, d - a.r - b.r);
        const f = (k * k) / gap / d;
        dx[i]! += ex * f;
        dy[i]! += ey * f;
        dx[j]! -= ex * f;
        dy[j]! -= ey * f;
      }
    }
    for (const e of edges) {
      const a = nodes[e.a]!;
      const b = nodes[e.b]!;
      const ex = a.x - b.x;
      const ey = a.y - b.y;
      const d = Math.max(0.01, Math.hypot(ex, ey));
      const f = d / k;
      dx[e.a]! -= ex * f;
      dy[e.a]! -= ey * f;
      dx[e.b]! += ex * f;
      dy[e.b]! += ey * f;
    }
    for (let i = 0; i < n; i++) {
      const nd = nodes[i]!;
      // A pull to the middle, relative to the area's half-width and half-height so the cloud
      // takes the frame's shape. Nodes without links have nothing else holding them, so they
      // get a stronger pull and sit among the rest instead of pinning to the edges.
      const pull = k * (deg[i] === 0 ? GRAVITY_LONE : GRAVITY);
      dx[i]! -= ((nd.x - cx) / (area.w / 2)) * pull;
      dy[i]! -= ((nd.y - cy) / (area.h / 2)) * pull;
      const d = Math.hypot(dx[i]!, dy[i]!);
      if (d > 0) {
        const m = Math.min(d, temp) / d;
        nd.x += dx[i]! * m;
        nd.y += dy[i]! * m;
      }
      nd.x = Math.min(Math.max(nd.x, area.x + nd.r), area.x + area.w - nd.r);
      nd.y = Math.min(Math.max(nd.y, area.y + nd.r), area.y + area.h - nd.r);
    }
  }
  for (const nd of nodes) {
    nd.x = Math.round(nd.x * 10) / 10;
    nd.y = Math.round(nd.y * 10) / 10;
  }
}

/** The box of a node's circle, with a little air around it. */
function nodeBox(n: ConstellationNode): Box {
  const r = n.r + 2;
  return { x: n.x - r, y: n.y - r, w: 2 * r, h: 2 * r };
}

/** Padding around an agent badge's text. */
const BADGE_PAD = 6;

/**
 * Places one label per node where it fits: right, left, above, below, then the corners. Agents
 * go first and get badges: drawn above nodes and edges on a backdrop, so they may cover small
 * nodes in the crowd around a busy agent, but never another label. Then tasks with the most
 * links, notes and files, each kept clear of every node; a label that fits nowhere is left out.
 */
function placeLabels(
  nodes: ConstellationNode[],
  deg: number[],
  stage: Stage,
  reserved: Box[],
): ConstellationLabel[] {
  const order = nodes
    .map((n, i) => ({ n, i }))
    .sort(
      (a, b) =>
        LABEL_RANK[a.n.kind] - LABEL_RANK[b.n.kind] ||
        deg[b.i]! - deg[a.i]! ||
        b.n.touches.length - a.n.touches.length ||
        (a.n.key < b.n.key ? -1 : 1),
    );
  const circles = nodes.map(nodeBox);
  const placed: ConstellationLabel[] = [];
  const free = (b: Box, self: number, badge: boolean): boolean => {
    if (b.x < 4 || b.y < 4 || b.x + b.w > stage.width - 4 || b.y + b.h > stage.height - 4) {
      return false;
    }
    if (reserved.some((r) => overlap(b, r))) return false;
    if (placed.some((l) => overlap(b, l))) return false;
    // A badge keeps clear of its own node and of the other agents.
    if (badge) {
      return !nodes.some((m, i) => (i === self || m.kind === 'agent') && overlap(b, circles[i]!));
    }
    return !circles.some((c, i) => i !== self && overlap(b, c));
  };
  for (const { n, i } of order) {
    const badge = n.kind === 'agent';
    const size = LABEL_SIZE[n.kind];
    const text = textSize(n.label, size);
    const pad = badge ? BADGE_PAD : 0;
    const w = text.w + 2 * pad;
    const h = text.h + pad;
    // Badges may step further out when the spot next to the agent is taken.
    const rings = badge ? [4, 16, 32, 56, 90] : [5];
    search: for (const ring of rings) {
      const gap = n.r + ring;
      const candidates: Array<[number, number]> = [
        [n.x + gap, n.y - h / 2],
        [n.x - gap - w, n.y - h / 2],
        [n.x - w / 2, n.y - gap - h],
        [n.x - w / 2, n.y + gap],
        [n.x + gap * 0.7, n.y - gap * 0.7 - h],
        [n.x - gap * 0.7 - w, n.y - gap * 0.7 - h],
        [n.x + gap * 0.7, n.y + gap * 0.7],
        [n.x - gap * 0.7 - w, n.y + gap * 0.7],
      ];
      for (const [x, y] of candidates) {
        const box = { x: Math.round(x), y: Math.round(y), w, h };
        if (free(box, i, badge)) {
          placed.push({ ...box, node: i, text: n.label, size, badge });
          break search;
        }
      }
    }
  }
  return placed.sort((a, b) => a.node - b.node);
}

const LEGEND: Array<[string, string]> = [
  ['Agent', '#e6edf3'],
  ['Task', NODE_COLORS.task],
  ['Closed', CLOSED_COLOR],
  ['Note', NODE_COLORS.note],
  ['File', NODE_COLORS.file],
];

export function prepareConstellation(tl: Timeline, stage: Stage): ConstellationData {
  const g = graphOf(tl);
  // A task nothing touched in the window and nothing links to says nothing; leave it out.
  const linked = new Set<number>();
  for (const e of g.edges.values()) linked.add(e.a).add(e.b);
  const keep = g.nodes.map((n, i) => n.kind !== 'task' || n.touches.length > 0 || linked.has(i));
  const newIndex: number[] = [];
  const nodes: ConstellationNode[] = [];
  g.nodes.forEach((n, i) => {
    newIndex[i] = nodes.length;
    if (keep[i]) nodes.push(n);
  });
  const edges = [...g.edges.values()]
    .map((e) => ({ ...e, a: newIndex[e.a]!, b: newIndex[e.b]! }))
    .sort((a, b) => a.at - b.at || a.a - b.a || a.b - b.b);
  const deg = new Array<number>(nodes.length).fill(0);
  for (const e of edges) {
    deg[e.a]!++;
    deg[e.b]!++;
  }
  const scale = Math.min(1, Math.sqrt(220 / Math.max(1, nodes.length)) + 0.35);
  nodes.forEach((n, i) => {
    const base =
      n.kind === 'agent'
        ? 15
        : n.kind === 'task'
          ? 6 + Math.min(6, deg[i]! * 0.6)
          : n.kind === 'note'
            ? 7
            : 4 + Math.min(4, n.touches.length * 0.4);
    n.r = Math.round(base * scale * 10) / 10;
  });

  const legendW = LEGEND.reduce((w, [label]) => w + 34 + textSize(label, 18).w, 0);
  const legend: Box = { x: MARGIN, y: stage.height - MARGIN + 6, w: legendW, h: 28 };
  const header: Box = { x: 0, y: 0, w: stage.width, h: HEADER_H };
  const area: Box = {
    x: MARGIN,
    y: HEADER_H + 20,
    w: stage.width - 2 * MARGIN,
    h: stage.height - HEADER_H - 20 - MARGIN - 10,
  };
  layout(nodes, edges, deg, area);
  const reserved = [header, legend];
  return {
    nodes,
    edges,
    labels: placeLabels(nodes, deg, stage, reserved),
    reserved,
    legend,
    duration: tl.time.playbackMs,
    map: tl.time,
  };
}

/** The last touch of `touches` at or before `t`, or -Infinity. */
function lastTouch(touches: number[], t: number): number {
  let lo = 0;
  let hi = touches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (touches[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? touches[lo - 1]! : -Infinity;
}

/** 1 right at a touch, falling to 0 after `PULSE_MS`. */
function pulse(n: ConstellationNode, t: number): number {
  const age = t - lastTouch(n.touches, t);
  return age < PULSE_MS ? 1 - age / PULSE_MS : 0;
}

export const constellationScene: Scene<ConstellationData> = {
  id: 'constellation',
  label: 'Constellation',
  description: 'Tasks, agents, notes and files as a graph that lights up as work touches it',
  query: 'graph=1',
  prepare: prepareConstellation,
  render(d, frame) {
    const t = Math.min(Math.max(0, frame.t), d.duration);
    const shown = d.nodes.map((n) => n.appear <= t);
    const glow = d.nodes.map((n, i) => (shown[i] ? pulse(n, t) : 0));
    const color = (n: ConstellationNode): string =>
      n.kind === 'task' && n.closeAt !== undefined && n.closeAt <= t ? CLOSED_COLOR : n.color;
    let lx = d.legend.x;
    return (
      <g fontFamily={FONT}>
        <text x={MARGIN + 20} y={92} fill="#e6edf3" fontSize={44} fontWeight={600}>
          Knowledge constellation
        </text>
        <text x={frame.width - MARGIN - 20} y={92} fill="#8b98a5" fontSize={28} textAnchor="end">
          {utcStamp(realAt(d.map, t))}
        </text>
        <g strokeLinecap="round">
          {d.edges.map((e, i) => {
            if (e.at > t || !shown[e.a] || !shown[e.b]) return null;
            const a = d.nodes[e.a]!;
            const b = d.nodes[e.b]!;
            const hot = Math.max(glow[e.a]!, glow[e.b]!);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={EDGE_COLORS[e.kind]}
                strokeOpacity={0.16 + 0.5 * hot}
                strokeWidth={1.5 + 1.5 * hot}
                strokeDasharray={
                  e.kind === 'blocks' ? '6 6' : e.kind === 'read' ? '2 5' : undefined
                }
              />
            );
          })}
        </g>
        {d.nodes.map((n, i) => {
          if (!shown[i]) return null;
          const p = glow[i]!;
          const c = color(n);
          return (
            <g key={n.key}>
              {p > 0 && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r * (1.6 + 1.6 * p)}
                  fill={c}
                  fillOpacity={0.28 * p}
                />
              )}
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r * (1 + 0.6 * p)}
                fill={n.kind === 'agent' ? '#0b0f14' : c}
                fillOpacity={n.kind === 'agent' ? 1 : 0.55 + 0.45 * p}
                stroke={c}
                strokeWidth={n.kind === 'agent' ? 3 : 0}
              />
            </g>
          );
        })}
        {d.labels.map((l) => {
          if (l.badge || !shown[l.node]) return null;
          return (
            <text
              key={d.nodes[l.node]!.key}
              x={l.x}
              y={l.y + l.h / 2}
              fill="#c9d4df"
              fillOpacity={0.6 + 0.4 * glow[l.node]!}
              fontSize={l.size}
              dominantBaseline="middle"
            >
              {l.text}
            </text>
          );
        })}
        {d.labels.map((l) => {
          if (!l.badge || !shown[l.node]) return null;
          const n = d.nodes[l.node]!;
          return (
            <g key={n.key}>
              <rect
                x={l.x}
                y={l.y}
                width={l.w}
                height={l.h}
                rx={8}
                fill={BACKDROP}
                fillOpacity={0.85}
                stroke={n.color}
                strokeOpacity={0.35 + 0.65 * glow[l.node]!}
                strokeWidth={1.5}
              />
              <text
                x={l.x + l.w / 2}
                y={l.y + l.h / 2}
                fill={n.color}
                fontSize={l.size}
                fontWeight={600}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {l.text}
              </text>
            </g>
          );
        })}
        <g fontSize={18}>
          {LEGEND.map(([label, c]) => {
            const x = lx;
            lx += 34 + textSize(label, 18).w;
            return (
              <g key={label}>
                <circle
                  cx={x + 9}
                  cy={d.legend.y + 14}
                  r={label === 'Agent' ? 7 : 6}
                  fill={label === 'Agent' ? '#0b0f14' : c}
                  stroke={c}
                  strokeWidth={label === 'Agent' ? 2.5 : 0}
                />
                <text x={x + 24} y={d.legend.y + 14} fill="#8b98a5" dominantBaseline="middle">
                  {label}
                </text>
              </g>
            );
          })}
        </g>
      </g>
    );
  },
};
