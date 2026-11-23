// Learn-note promotion candidates (W6): notes that keep mattering belong in a role file as a rule,
// where every run of the role reads them, not in `kb/`, where a run sees at most a few. This only
// picks the notes and the agents they are for; the improver writes the change and a person
// promotes it (`swarmup defs promote`), then archives the notes (`swarmup kb archive`).
import { isHuman } from './ids.js';
import type { KbNote } from './kb.js';
import type { KbRead, KbShown } from './kb-reads.js';
import { likelyDuplicate } from './similar.js';

/** Run prompts in the window that make a note a candidate, by default. */
export const PROMOTE_MIN_SHOWN = 5;
/** Agent reads in the window that make a note a candidate, by default. */
export const PROMOTE_MIN_READS = 3;

/** The window, in days, by default. */
export const PROMOTE_DAYS = 30;

export interface PromoteOptions {
  /** The current time (ms). */
  now: number;
  /** The window: only records of the last this many days count. Default `PROMOTE_DAYS`. */
  days?: number;
  /** Run prompts in the window that make a note a candidate. Default `PROMOTE_MIN_SHOWN`. */
  minShown?: number;
  /** Agent reads in the window that make a note a candidate. Default `PROMOTE_MIN_READS`. */
  minReads?: number;
}

/** How often one agent's runs saw a note in the window. */
export interface PromoteAgent {
  agent: string;
  shown: number;
  reads: number;
}

/** A note that keeps mattering, with why and for whom. */
export interface PromoteCandidate {
  note: KbNote;
  /** Run prompts of agents in the window that listed the note. */
  shown: number;
  /** Reads by agents in the window. */
  reads: number;
  /**
   * Other notes with a near-identical title (`likelyDuplicate`): the lesson was learned again.
   * Each is `<topic>/<slug>`, or `<root>/<topic>/<slug>` when it is in another root.
   */
  relearned: string[];
  /** One line per reason, such as `shown in 7 run prompts in 30 days`. */
  why: string[];
  /** The agents whose runs listed or read the note in the window, most first. */
  agents: PromoteAgent[];
  /**
   * The agents the note is for: those with at least half the uses of the top one. With no use in
   * the window, the agents that wrote the note and its duplicates.
   */
  for: string[];
}

/** An agent's record, not a person's or swarmupd's own. */
function byAgent(actor: string): boolean {
  return !isHuman(actor) && !actor.startsWith('opsd:');
}

/**
 * The notes that keep mattering (W6): shown in at least `minShown` run prompts in the window, read
 * by agents at least `minReads` times in it (the last `days` days), or learned again (another note has a near-identical
 * title). Records of people and swarmupd, and of notes that no longer exist, count for nothing.
 * Most reasons first, then most uses.
 */
export function promotionCandidates(
  notes: KbNote[],
  reads: KbRead[],
  shown: KbShown[],
  opts: PromoteOptions,
): PromoteCandidate[] {
  const minShown = opts.minShown ?? PROMOTE_MIN_SHOWN;
  const minReads = opts.minReads ?? PROMOTE_MIN_READS;
  const days = opts.days ?? PROMOTE_DAYS;
  const sinceMs = opts.now - days * 86_400_000;
  const recent = (r: { at: string; actor: string }): boolean =>
    byAgent(r.actor) && Date.parse(r.at) >= sinceMs;
  // Per note key (`<root>/<ref>`), per agent: [shown, reads].
  const uses = new Map<string, Map<string, [number, number]>>();
  const add = (key: string, agent: string, i: 0 | 1): void => {
    const m = uses.get(key) ?? new Map<string, [number, number]>();
    const u = m.get(agent) ?? [0, 0];
    u[i] += 1;
    m.set(agent, u);
    uses.set(key, m);
  };
  for (const s of shown) {
    if (!recent(s)) continue;
    for (const ref of new Set(s.refs)) add(`${s.root}/${ref}`, s.actor, 0);
  }
  for (const r of reads) if (recent(r)) add(`${r.root}/${r.ref}`, r.actor, 1);

  const out: PromoteCandidate[] = [];
  for (const note of notes) {
    // The same ref in another root is a copy (a mirror's union of `kb/`), not a second lesson.
    const dups = notes.filter((o) => o.ref !== note.ref && likelyDuplicate(note.title, o.title));
    const per = [...(uses.get(`${note.root}/${note.ref}`) ?? new Map<string, [number, number]>())];
    const nShown = per.reduce((n, [, u]) => n + u[0], 0);
    const nReads = per.reduce((n, [, u]) => n + u[1], 0);
    const why: string[] = [];
    if (nShown >= minShown && nShown > 0)
      why.push(`shown in ${nShown} run prompts in ${days} days`);
    if (nReads >= minReads && nReads > 0) why.push(`read ${nReads} times in ${days} days`);
    const relearned = dups.map((d) => (d.root === note.root ? d.ref : `${d.root}/${d.ref}`));
    if (relearned.length > 0) why.push(`learned again as ${relearned.join(', ')}`);
    if (why.length === 0) continue;
    const agents = per
      .map(([agent, [s, r]]) => ({ agent, shown: s, reads: r }))
      .sort(
        (a, b) =>
          b.shown + b.reads - (a.shown + a.reads) ||
          b.reads - a.reads ||
          a.agent.localeCompare(b.agent),
      );
    const top = agents[0] ? agents[0].shown + agents[0].reads : 0;
    const forAgents =
      top > 0
        ? agents.filter((a) => (a.shown + a.reads) * 2 >= top).map((a) => a.agent)
        : [...new Set([note, ...dups].map((n) => n.author).filter((a) => a && byAgent(a)))].sort();
    out.push({
      note,
      shown: nShown,
      reads: nReads,
      relearned,
      why,
      agents,
      for: forAgents,
    });
  }
  return out.sort(
    (a, b) =>
      b.why.length - a.why.length ||
      b.shown + b.reads - (a.shown + a.reads) ||
      a.note.ref.localeCompare(b.note.ref),
  );
}
