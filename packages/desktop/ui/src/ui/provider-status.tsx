import type { ProviderUsage, UsageWindow } from '../types';
import { cx } from '../components';
import { identity } from '../lib/identity';
import { ProviderMark } from './identity';

export interface ProviderStatus {
  label: string;
  detail: string;
  state: 'normal' | 'warning' | 'signed-out' | 'empty';
}

/** A compact time until a usage window resets: `42m`, `8h 12m`, or `3d 3h`. */
export function resetIn(resetsAt: number, now = Date.now()): string | null {
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const minutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d${hours ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${rest ? ` ${rest}m` : ''}`;
  return `${rest}m`;
}

/** The most-used window is the useful one-line summary; every window remains on Agents. */
function busiestWindow(windows: Record<string, UsageWindow>): [string, UsageWindow] | null {
  return (
    Object.entries(windows).sort(
      ([aName, a], [bName, b]) => b.utilization - a.utilization || aName.localeCompare(bName),
    )[0] ?? null
  );
}

export function providerStatus(
  runtime: string,
  usage: ProviderUsage,
  pauseAt = 0.9,
  now = Date.now(),
): ProviderStatus {
  const provider = identity(`${runtime}:x`).provider;
  if (usage.signed_out) {
    const expired = Boolean(usage.signed_out.run);
    return {
      label: expired ? 'Sign-in expired' : 'Signed out',
      detail: `${provider.label}: ${usage.signed_out.steps}`,
      state: 'signed-out',
    };
  }
  const busiest = busiestWindow(usage.windows);
  if (!busiest) {
    return {
      label: 'No usage yet',
      detail: `${provider.label}: no usage reading yet`,
      state: 'empty',
    };
  }
  const [windowName, window] = busiest;
  const pct = Math.round(window.utilization * 100);
  const reset = resetIn(window.resets_at, now);
  const windowLabel = windowName.replace(/_/g, ' ');
  return {
    label: `${pct}%${reset ? ` · ${reset}` : ''}`,
    detail: `${provider.label} ${windowLabel}: ${pct}% used${reset ? `, resets in ${reset}` : ''}`,
    state: window.utilization >= pauseAt ? 'warning' : 'normal',
  };
}

/** One-line provider allowance summary at the bottom of every main view. */
export function ProviderStatusBar({
  providers,
  pauseAt = 0.9,
  pauseAtByProvider,
  now = Date.now(),
  onOpen,
}: {
  providers: Record<string, ProviderUsage>;
  pauseAt?: number;
  pauseAtByProvider?: Record<string, number | undefined>;
  now?: number;
  onOpen: (provider: string) => void;
}) {
  const names = Object.keys(providers).sort((a, b) =>
    identity(`${a}:x`).provider.label.localeCompare(identity(`${b}:x`).provider.label),
  );
  return (
    <footer
      data-provider-status-bar
      className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-t border-white/8 bg-ink-950/95 px-3 text-[11px]"
      aria-label="Provider usage"
    >
      <span className="label-caps mr-1 shrink-0 !text-[9px]">Used</span>
      {names.length === 0 ? (
        <span className="text-fg-4">No providers</span>
      ) : (
        names.map((name) => {
          const provider = identity(`${name}:x`).provider;
          const status = providerStatus(
            name,
            providers[name]!,
            pauseAtByProvider?.[name] ?? pauseAt,
            now,
          );
          return (
            <button
              key={name}
              type="button"
              data-provider={name}
              data-state={status.state}
              title={`${status.detail}. Open usage details.`}
              aria-label={`Open ${provider.label} usage details: ${status.label}`}
              onClick={() => onOpen(name)}
              className={cx(
                'inline-flex h-6 shrink-0 items-center gap-1.5 rounded px-2 font-medium transition hover:bg-white/7 focus-visible:outline-2 focus-visible:outline-signal',
                status.state === 'warning' && 'bg-warn/8 text-warn',
                status.state === 'signed-out' && 'bg-bad/8 text-bad',
                status.state === 'normal' && 'text-fg-2',
                status.state === 'empty' && 'text-fg-4',
              )}
            >
              <ProviderMark runtime={name} size={13} />
              <span>{provider.label}</span>
              <span className="font-mono">{status.label}</span>
            </button>
          );
        })
      )}
    </footer>
  );
}
