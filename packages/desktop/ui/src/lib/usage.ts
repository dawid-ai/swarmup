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
 * One provider in the status bar. `warning`: its highest window is at or over the share at which
 * swarmupd pauses its runs. `expired`: a run could not sign in, so a sign-in that worked has run
 * out; `signed-out`: the sign-in check found it signed out. `empty`: no usage reading yet.
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
      const windows = Object.values(u.windows ?? {});
      if (windows.length === 0) {
        return { provider, label, state: 'empty', title: `${label}: no usage reading yet` };
      }
      const top = windows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
      const at = pause?.runtimes?.[provider]?.pause_at ?? pause?.usage_pause_at ?? DEFAULT_PAUSE_AT;
      const pct = Math.round(top.utilization * 100);
      const reset = top.resets_at > now ? resetIn(top.resets_at - now) : undefined;
      const warning = top.utilization >= at;
      return {
        provider,
        label,
        state: warning ? 'warning' : 'normal',
        pct,
        ...(reset ? { reset } : {}),
        title:
          `${label}: ${pct}% used${reset ? `, resets in ${reset}` : ''}` +
          (warning ? `; swarmupd pauses its runs at ${Math.round(at * 100)}%` : ''),
      };
    });
}
