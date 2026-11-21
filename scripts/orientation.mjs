// Orientation cost of swarmupd task runs: how much of a run goes by before its first edit.
//   node scripts/orientation.mjs [--dir STATE] [--all] [--agent A] [--since YYYY-MM-DD]
//                                [--last N] [--runs] [--json]
// Reads the run records in `<state>/runs` and their logs in `<state>/logs` (state:
// SWARMUP_STATE_DIR, else ~/.swarmup/swarmupd), read-only. Per run it reports the tool calls
// before the first edit (Edit, Write, MultiEdit, NotebookEdit, apply_patch; a Codex
// `file_change`), the tool calls in all, and the share of tool-result bytes that came before the
// first edit. Without --all only work runs count: a task, not a review, question, helper, chat,
// plan check or inbox run. swarmupd removes logs after `log_days` (14), so older runs are skipped.
import { Buffer } from 'node:buffer';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/** A shell call of the `swarmup` CLI (or its old name `ops`), such as `swarmup show AO-0123`. */
const SWARMUP_RE = /(^|[\s;&|"'(])(swarmup|ops)(\.cmd|\.exe)?\s+[a-z]/;

/**
 * Tool calls of one Claude `stream-json` or Codex `--json` log, in order: each with its name,
 * whether it edits, and the bytes of its result.
 */
export function toolCalls(text) {
  const calls = [];
  const byId = new Map();
  let runtime = null;
  for (const line of text.split('\n')) {
    if (line[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      runtime ??= 'claude';
      for (const c of ev.message.content) {
        if (c?.type !== 'tool_use' || byId.has(c.id)) continue;
        const call = {
          name: c.name,
          edit: EDIT_TOOLS.has(c.name),
          bytes: 0,
          swarmup: c.name === 'Bash' && SWARMUP_RE.test(String(c.input?.command ?? '')),
        };
        byId.set(c.id, call);
        calls.push(call);
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c?.type !== 'tool_result') continue;
        const call = byId.get(c.tool_use_id);
        if (call) call.bytes += resultBytes(c.content);
      }
    } else if (ev.type === 'item.completed' && ev.item) {
      // Codex: each finished item; messages and reasoning are not tool calls.
      const it = ev.item;
      if (it.type === 'agent_message' || it.type === 'reasoning') continue;
      runtime ??= 'codex';
      const edit = it.type === 'file_change';
      const bytes = Buffer.byteLength(String(it.aggregated_output ?? ''), 'utf8');
      const swarmup = it.type === 'command_execution' && SWARMUP_RE.test(String(it.command ?? ''));
      calls.push({ name: it.type, edit, bytes, swarmup });
    } else if (ev.type === 'thread.started') {
      runtime ??= 'codex';
    }
  }
  return { runtime, calls };
}

function resultBytes(content) {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (typeof c?.text === 'string') n += Buffer.byteLength(c.text, 'utf8');
  }
  return n;
}

/** The orientation numbers of one run's tool calls; `firstEdit` is null when it never edited. */
export function orientation(calls) {
  const first = calls.findIndex((c) => c.edit);
  const total = calls.reduce((n, c) => n + c.bytes, 0);
  const head = first < 0 ? calls : calls.slice(0, first);
  const before = head.reduce((n, c) => n + c.bytes, 0);
  return {
    firstEdit: first < 0 ? null : first,
    swarmupBefore: head.filter((c) => c.swarmup).length,
    calls: calls.length,
    bytesBefore: before,
    bytes: total,
    share: total > 0 ? before / total : 0,
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function spread(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? null,
    p25: quantile(s, 0.25),
    median: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    max: s[s.length - 1] ?? null,
  };
}

function isWorkRun(r) {
  return (
    !!r.task &&
    !r.review &&
    !r.question &&
    !r.parent &&
    !r.chat &&
    !r.plan_check &&
    !r.inbox &&
    !r.schedule
  );
}

function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      all: { type: 'boolean' },
      agent: { type: 'string' },
      since: { type: 'string' },
      last: { type: 'string' },
      runs: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const dir =
    values.dir ?? process.env.SWARMUP_STATE_DIR ?? join(homedir(), '.swarmup', 'swarmupd');
  const runsDir = join(dir, 'runs');
  if (!existsSync(runsDir)) {
    console.error(`no run records in ${runsDir}`);
    process.exit(2);
  }
  let records = [];
  for (const f of readdirSync(runsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(readFileSync(join(runsDir, f), 'utf8')));
    } catch {
      // A record being written; the next report reads it.
    }
  }
  records = records
    .filter((r) => r.status === 'ended')
    .filter((r) => values.all || isWorkRun(r))
    .filter((r) => !values.agent || r.agent === values.agent)
    .filter((r) => !values.since || r.started_at >= values.since)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const rows = [];
  for (const r of records) {
    const log = join(dir, 'logs', `${r.id}.log`);
    if (!existsSync(log)) continue;
    const { runtime, calls } = toolCalls(readFileSync(log, 'utf8'));
    if (!runtime || calls.length === 0) continue;
    rows.push({
      id: r.id,
      agent: r.agent,
      task: r.task ?? null,
      started_at: r.started_at,
      runtime,
      ...orientation(calls),
    });
  }
  const last = values.last ? Number(values.last) : 0;
  const shown = last > 0 ? rows.slice(-last) : rows;
  const edited = shown.filter((r) => r.firstEdit !== null);
  const summary = (list) => ({
    runs: list.length,
    edited: list.filter((r) => r.firstEdit !== null).length,
    before_first_edit: spread(list.filter((r) => r.firstEdit !== null).map((r) => r.firstEdit)),
    calls: spread(list.map((r) => r.calls)),
    swarmup_before_first_edit: spread(
      list.filter((r) => r.firstEdit !== null).map((r) => r.swarmupBefore),
    ),
    share_before_first_edit: spread(list.filter((r) => r.firstEdit !== null).map((r) => r.share)),
  });
  const runtimes = [...new Set(shown.map((r) => r.runtime))].sort();
  const report = {
    state: dir,
    from: shown[0]?.started_at ?? null,
    to: shown[shown.length - 1]?.started_at ?? null,
    all: summary(shown),
    by_runtime: Object.fromEntries(
      runtimes.map((rt) => [rt, summary(shown.filter((r) => r.runtime === rt))]),
    ),
    ...(values.runs || values.json ? { rows: shown } : {}),
  };
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (values.runs) {
    console.log(
      'run                         agent                task       first-edit  calls  share',
    );
    for (const r of shown) {
      console.log(
        [
          r.id.padEnd(27),
          r.agent.padEnd(20),
          String(r.task ?? '-').padEnd(10),
          String(r.firstEdit ?? 'none').padStart(10),
          String(r.calls).padStart(6),
          `${Math.round(r.share * 100)}%`.padStart(6),
        ].join(' '),
      );
    }
    console.log('');
  }
  const fmt = (s, pct = false) =>
    s.n === 0
      ? 'no runs'
      : ['min', 'p25', 'median', 'p75', 'p90', 'max']
          .map((k) => `${k} ${pct ? `${Math.round(s[k] * 100)}%` : Math.round(s[k] * 10) / 10}`)
          .join(', ');
  const print = (name, s) => {
    console.log(`${name}: ${s.runs} runs, ${s.edited} with an edit`);
    console.log(`  tool calls before the first edit: ${fmt(s.before_first_edit)}`);
    console.log(`  tool calls in all:                ${fmt(s.calls)}`);
    console.log(`  swarmup calls before first edit:  ${fmt(s.swarmup_before_first_edit)}`);
    console.log(`  result bytes before first edit:   ${fmt(s.share_before_first_edit, true)}`);
  };
  console.log(`${basename(dir)}: ${report.from ?? '-'} to ${report.to ?? '-'}`);
  print(values.all ? 'all runs' : 'work runs', report.all);
  for (const rt of runtimes) print(rt, report.by_runtime[rt]);
  if (edited.length === 0) console.log('no run with an edit');
}

if (process.argv[1] && basename(process.argv[1]) === 'orientation.mjs') main();
