// Orientation of a run (W4): how much the agent read before its first edit. Parsed from the run
// log swarmupd keeps (Claude `stream-json`, Codex `--json`). The `orientation` scorer takes any
// provider of these figures, so a measurement from elsewhere, such as the Claude session file,
// can replace this one.
import { readFileSync } from 'node:fs';

/** What a run did before its first edit. */
export interface OrientationStats {
  /** Tool calls before the first edit; every tool call of a run with no edit. */
  toolCalls: number;
  /** Bytes of tool results the agent read before its first edit. */
  resultBytesBefore: number;
  /** Bytes of tool results over the whole run. */
  resultBytes: number;
  /** The run edited a file through an edit tool. Edits through a shell command do not count. */
  edited: boolean;
}

/** Claude Code tools that change a file. */
const CLAUDE_EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Codex items that are a tool call; `file_change` is its edit. */
const CODEX_TOOLS = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);

/** The text of a Claude tool result's `content`: a string or a list of blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content as Array<{ type?: string; text?: unknown }>) {
    if (b && typeof b.text === 'string') out += b.text;
  }
  return out;
}

/**
 * The orientation figures of one run log, or null when the log is missing or holds no tool call
 * in a format this reads. Only lines that can hold a tool call or its result are parsed, so a
 * 10 MB log reads in some tens of milliseconds. Tool calls of Claude sub-agents are left out:
 * their results never reach the run's own context.
 */
export function logOrientation(path: string): OrientationStats | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const s: OrientationStats = { toolCalls: 0, resultBytesBefore: 0, resultBytes: 0, edited: false };
  let calls = 0;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const claude = line.includes('"tool_use"') || line.includes('"tool_result"');
    const codex = line.includes('"item.completed"');
    if (!claude && !codex) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (codex && ev.type === 'item.completed') {
      const item = ev.item as { type?: string; aggregated_output?: unknown } | undefined;
      if (!item?.type || !CODEX_TOOLS.has(item.type)) continue;
      calls++;
      if (item.type === 'file_change' && !s.edited) {
        s.edited = true;
        s.toolCalls = calls - 1;
      }
      const out = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      const bytes = Buffer.byteLength(out);
      s.resultBytes += bytes;
      if (!s.edited) s.resultBytesBefore += bytes;
      continue;
    }
    if (ev.parent_tool_use_id) continue;
    const msg = ev.message as { content?: unknown } | undefined;
    if (!Array.isArray(msg?.content)) continue;
    for (const b of msg.content as Array<Record<string, unknown>>) {
      if (b?.type === 'tool_use') {
        calls++;
        if (!s.edited && CLAUDE_EDITS.has(String(b.name))) {
          s.edited = true;
          s.toolCalls = calls - 1;
        }
      } else if (b?.type === 'tool_result') {
        const bytes = Buffer.byteLength(resultText(b.content));
        s.resultBytes += bytes;
        if (!s.edited) s.resultBytesBefore += bytes;
      }
    }
  }
  if (calls === 0) return null;
  if (!s.edited) s.toolCalls = calls;
  return s;
}
