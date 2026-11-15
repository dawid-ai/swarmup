import { useEffect, useState } from 'react';
import type { PauseShares } from '../lib/usage';
import { usageItems } from '../lib/usage';
import type { ProviderUsage } from '../types';
import { ProviderMark } from './identity';
import { cx } from '../components';

/**
 * The slim bar at the bottom of the window: each provider's share used of its fullest window and
 * the time to that window's reset. Clicking an item opens the provider in Agents.
 */
export function ProviderStatusBar({
  usage,
  pause,
  onOpen,
}: {
  usage: Record<string, ProviderUsage> | null | undefined;
  pause: PauseShares | undefined;
  onOpen: (provider: string) => void;
}) {
  // Reset times count down between usage readings.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const items = usage ? usageItems(usage, pause, now) : [];
  return (
    <footer
      aria-label="Provider usage"
      className="flex h-6 shrink-0 items-center gap-1 border-t border-white/6 bg-ink-950 px-3 text-[11px] text-fg-3"
    >
      <span className="label-caps mr-1 !text-[10px]">Used</span>
      {items.length === 0 && <span className="text-fg-4">No usage reading yet</span>}
      {items.map((it) => (
        <button
          key={it.provider}
          type="button"
          data-provider={it.provider}
          data-state={it.state}
          title={it.title}
          onClick={() => onOpen(it.provider)}
          className={cx(
            'inline-flex h-5 items-center gap-1.5 rounded px-1.5 hover:bg-white/8',
            it.state === 'normal' && 'text-fg-2',
            it.state === 'empty' && 'text-fg-4',
            it.state !== 'normal' && it.state !== 'empty' && 'text-warn',
          )}
        >
          <ProviderMark runtime={it.provider} size={12} />
          <span>{it.label}</span>
          <span className="font-mono">
            {it.state === 'signed-out'
              ? 'Signed out'
              : it.state === 'expired'
                ? 'Sign-in expired'
                : it.state === 'empty'
                  ? '-'
                  : `${it.pct}%`}
          </span>
          {it.reset && <span className="text-fg-4">· {it.reset}</span>}
        </button>
      ))}
    </footer>
  );
}
