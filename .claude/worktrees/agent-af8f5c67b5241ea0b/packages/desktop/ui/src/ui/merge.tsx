import { GitMerge, Hourglass } from 'lucide-react';
import { useEffect, useState } from 'react';
import { minutes } from '../lib/format';
import type { MergeStatus, WaitItem } from '../types';

/** Whole minutes from `iso` to `now`, as `4m` or `1h5m`. */
function since(iso: string, now: number): string {
  return minutes(Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000)));
}

/** What the merge does now, in a few words. */
export function mergeStepText(m: MergeStatus): string {
  if (m.step === 'checks') return "Runs the checks in swarmupd's worktree";
  if (m.step === 'build') return `Builds ${m.base}`;
  if (m.step === 'waiting') return 'Waits for the writing run in its checkout to end';
  return `Rebases onto ${m.base}`;
}

/**
 * The merge swarmupd runs now (AO-0161): the task, the base, the step and its command with the time
 * it took so far against its timeout, and the work that waits for it. A merge can hold every
 * writing run in its checkout, so without this the queue looks stuck.
 */
export function MergeUnderWay({
  merge: m,
  waits,
  onOpen,
}: {
  merge: MergeStatus;
  waits: WaitItem[];
  onOpen: (ref: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const held = waits.filter((w) => w.merge && w.task);
  const task = (ref: string) => (
    <button
      key={ref}
      className="font-mono text-xs text-signal hover:underline"
      onClick={() => onOpen(ref)}
    >
      {ref.split('/').pop()}
    </button>
  );
  return (
    <div
      className="panel flex items-start gap-3 px-4 py-3"
      data-testid="merge-under-way"
      role="status"
    >
      <span
        className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'color-mix(in oklab, #b18cff 13%, transparent)' }}
      >
        <GitMerge size={14} color="#b18cff" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-fg">swarmupd merges</span>
          {task(m.task)}
          <span className="text-fg">
            into <span className="font-mono text-xs">{m.base}</span>
          </span>
          <span className="text-xs text-fg-4">{since(m.started_at, now)} so far</span>
        </div>
        <div className="mt-1 text-xs text-fg-3">
          {mergeStepText(m)}
          {m.command && (
            <>
              : {m.command.index + 1}/{m.command.count}{' '}
              <code className="font-mono">{m.command.text}</code>,{' '}
              {since(m.command.started_at, now)} of its {minutes(m.timeout_minutes)} timeout
            </>
          )}
        </div>
        {m.holds && (
          <div className="mt-1 text-xs text-fg-3">
            No new writing run starts in <span className="font-mono">{m.top}</span> until the build
            ends.
          </div>
        )}
        {held.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
            <Hourglass size={12} className="shrink-0 text-warn" />
            <span>Waiting for it:</span>
            {held.map((w) => task(w.task!))}
          </div>
        )}
      </div>
    </div>
  );
}
