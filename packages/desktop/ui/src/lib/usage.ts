import type { ProviderUsage } from '../types';
import { identity } from './identity';

/** Provider order of the status bar and the Agents view; others follow by name. */
export const PROVIDER_ORDER = ['claude', 'codex', 'gemini', 'grok', 'cursor'];

export function byProvider(a: string, b: string): number {
  const rank = (rt: string): number => {
    if (rt === 'human') return 1000;
    const i = PROVIDER_ORDER.indexOf(rt);
    return i === -1 ? 100 : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * One provider in the status bar. `warning`: swarmupd pauses its runs, because its highest window
 * is at or over the pause share, a window has status `rejected`, or `limited_until` is ahead. `expired`: a run could not sign in, so a sign-in that worked has run
 * out; `signed-out`: the sign-in check found it signed out. `empty`: no current usage window.
 */
export interface UsageItem {
  provider: string;
  label: string;
  state: 'normal' | 'warning' | 'signed-out' | 'expired' | 'empty';
  /** Share used of the fullest window, 0 to 100. */
  pct?: number;
  /** Time until that window resets, such as "3d 3h"; missing when unknown or past. */
  reset?: string;
  /** The tooltip. */
  title: string;
}

/** The pause thresholds from `GET /api/settings`: the global share and each provider's own. */
export interface PauseShares {
  usage_pause_at?: number;
  runtimes?: Record<string, { pause_at?: number }>;
}

/** swarmupd's default `usage_pause_at`. */
const DEFAULT_PAUSE_AT = 0.9;

/** A duration as the status bar shows it: "3d 3h", "5h 12m", "42m" or "<1m". */
export function resetIn(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '<1m';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** The status bar's items from `GET /api/usage`, in provider order. */
export function usageItems(
  usage: Record<string, ProviderUsage>,
  pause: PauseShares | undefined,
  now = Date.now(),
): UsageItem[] {
  return Object.keys(usage)
    .sort(byProvider)
    .map((provider) => {
      const u = usage[provider]!;
      const label = identity(`${provider}:x`).provider.label;
      if (u.signed_out) {
        const expired = Boolean(u.signed_out.run);
        return {
          provider,
          label,
          state: expired ? 'expired' : 'signed-out',
          title: `${label}: ${expired ? 'the sign-in expired' : 'signed out'}; no ${label} run starts until it is signed in`,
        };
      }
      // Match `usageHold` in packages/supervisor/src/quota.ts: cached windows stop describing
      // current usage at their reset boundary.
      const windows = Object.entries(u.windows ?? {}).filter(([, w]) => w.resets_at > now);
      const limited = u.limited_until !== undefined && u.limited_until > now;
      if (windows.length === 0) {
        if (limited) {
          const reset = resetIn(u.limited_until! - now);
          return {
            provider,
            label,
            state: 'warning',
            reset,
            title: `${label}: refused work (usage limit); swarmupd starts no ${label} run for ${reset}`,
          };
        }
        return { provider, label, state: 'empty', title: `${label}: no current usage window` };
      }
      // A rejected window pauses the provider at any share, so it wins over a fuller window.
      const rejected = windows.find(([, w]) => w.status === 'rejected');
      const [name, top] =
        rejected ?? windows.reduce((a, b) => (b[1].utilization > a[1].utilization ? b : a));
      const at = pause?.runtimes?.[provider]?.pause_at ?? pause?.usage_pause_at ?? DEFAULT_PAUSE_AT;
      const pct = Math.round(top.utilization * 100);
      const reset = resetIn(top.resets_at - now);
      const used = `${label}: ${pct}% used${reset ? `, resets in ${reset}` : ''}`;
      let why = '';
      if (limited) {
        why = `; refused work (usage limit), swarmupd starts no ${label} run for ${resetIn(u.limited_until! - now)}`;
      } else if (rejected) {
        why = `; ${label} rejected work in the ${name} window, swarmupd pauses its runs until it resets`;
      } else if (top.utilization >= at) {
        why = `; swarmupd pauses its runs at ${Math.round(at * 100)}%`;
      }
      return {
        provider,
        label,
        state: why ? 'warning' : 'normal',
        pct,
        ...(reset ? { reset } : {}),
        title: used + why,
      };
    });
}
