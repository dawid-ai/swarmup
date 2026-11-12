import type { LucideIcon } from 'lucide-react';
import {
  Asterisk,
  BookOpen,
  Bot,
  CodeXml,
  Compass,
  Database,
  Eye,
  Network,
  Palette,
  PenLine,
  Server,
  ShieldAlert,
  ShieldCheck,
  Telescope,
  User,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { RoleIcon } from '../lib/identity';
import { TILE_INK, identity, priorityInfo, statusInfo, tileOf } from '../lib/identity';
import { tileImage } from './brand';

export const ROLE_ICONS: Record<RoleIcon, LucideIcon> = {
  engineer: CodeXml,
  qa: ShieldCheck,
  reviewer: Eye,
  pm: Compass,
  designer: Palette,
  docs: BookOpen,
  orchestrator: Network,
  writer: PenLine,
  research: Telescope,
  ops: Server,
  security: ShieldAlert,
  data: Database,
  person: User,
  any: Asterisk,
  bot: Bot,
};

/**
 * A provider as a small flat tile in its tile color, for sizes under 24 px. A provider the brand
 * kit has no tile for carries its initial. The tile is never the only cue: it has the provider's
 * name as its label and tooltip, and callers show the name next to it.
 */
export function ProviderMark({ runtime, size = 14 }: { runtime: string; size?: number }) {
  const tile = tileOf(runtime);
  const label = identity(`${runtime}:x`).provider.label;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
      className="shrink-0"
      data-tile={tile.key ?? 'flat'}
    >
      <title>{label}</title>
      <rect x="2" y="2" width="20" height="20" rx="5" fill={tile.color} />
      {!tile.key && (
        <text
          x="12"
          y="16.6"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill={TILE_INK}
          fontFamily="Chakra Petch, sans-serif"
        >
          {runtime === '*' ? '*' : runtime.charAt(0).toUpperCase()}
        </text>
      )}
    </svg>
  );
}

/**
 * The provider's tile with the role icon on it. From 24 px it is the brand kit's straight-on
 * render; under 24 px, and for a provider without a render, a flat rounded square in the tile's
 * color. The id is its label and tooltip, so two providers are never told apart by color alone.
 */
export function Avatar({
  id,
  size = 26,
  live,
}: {
  id: string;
  size?: number;
  /** Shows a pulsing dot: a run is live. */
  live?: boolean;
}) {
  const who = identity(id);
  const tile = tileOf(id);
  const RoleI = who.human || who.role ? ROLE_ICONS[who.roleInfo.icon] : null;
  const img = tile.key && size >= 24 ? tileImage(tile.key, size) : null;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={id}
      role="img"
      aria-label={id}
      data-tile={tile.key ?? 'flat'}
    >
      {img ? (
        <img
          src={img.src}
          srcSet={img.srcSet}
          width={size}
          height={size}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full"
        />
      ) : (
        <span
          className="absolute inset-[4%] rounded-[24%]"
          style={{ background: tile.color }}
          data-flat-tile
        />
      )}
      {RoleI ? (
        <RoleI
          className="relative"
          size={Math.round(size * 0.54)}
          color={TILE_INK}
          strokeWidth={size < 24 ? 2.6 : 2.2}
        />
      ) : (
        // A bare provider the kit has no tile for: its initial, as on `ProviderMark`.
        !tile.key && (
          <span
            className="relative font-display leading-none font-bold"
            style={{ color: TILE_INK, fontSize: Math.round(size * 0.5) }}
          >
            {who.runtime === '*' ? '*' : who.runtime.charAt(0).toUpperCase()}
          </span>
        )
      )}
      {live && (
        <span
          className="animate-pulse-dot absolute -top-0.5 -left-0.5 h-2 w-2 rounded-full"
          style={{ background: '#3ddc97', color: '#3ddc97' }}
        />
      )}
    </span>
  );
}

/**
 * An agent or person: avatar, then the provider part in its color and the role in the role's
 * color. `plain` drops the avatar for dense rows.
 */
export function Who({
  id,
  size = 'sm',
  plain,
  live,
  label,
}: {
  id: string | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  plain?: boolean;
  live?: boolean;
  /** Show the role's display name (Engineer, QA) after the id. */
  label?: boolean;
}) {
  if (!id) return <span className="text-fg-4">-</span>;
  const who = identity(id);
  const px = size === 'xs' ? 16 : size === 'sm' ? 20 : 28;
  const text = size === 'md' ? 'text-sm' : 'text-xs';
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 align-middle ${text}`}>
      {!plain && <Avatar id={id} size={px} live={live} />}
      <span className="truncate font-mono">
        <span style={{ color: who.provider.color }}>{who.runtime}</span>
        {who.role && (
          <>
            <span className="text-fg-4">:</span>
            <span style={{ color: who.roleInfo.color }}>{who.role}</span>
          </>
        )}
      </span>
      {label && !who.human && who.role && who.role !== '*' && (
        <span className="text-fg-3">{who.roleInfo.label}</span>
      )}
    </span>
  );
}

/** A tag-shaped chip for an id, used inside pickers; `onRemove` adds a remove button. */
export function AgentTag({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const who = identity(id);
  const c = who.provider.color;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-xs"
      style={{
        background: `color-mix(in oklab, ${c} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 32%, transparent)`,
      }}
    >
      <Avatar id={id} size={18} />
      <span className="font-mono">
        <span style={{ color: c }}>{who.runtime}</span>
        {who.role && (
          <>
            <span className="text-fg-4">:</span>
            <span style={{ color: who.roleInfo.color }}>{who.role}</span>
          </>
        )}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="-mr-1 rounded-full px-1 text-fg-3 hover:bg-white/10 hover:text-fg"
          aria-label={`Remove ${id}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Signal bars for a priority; Urgent is a filled alert tile. */
export function PriorityIcon({ p, size = 14 }: { p: string; size?: number }) {
  const info = priorityInfo(p);
  if (info.key === 'p0') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-label={info.label}>
        <rect x="1" y="1" width="14" height="14" rx="3.5" fill={info.color} />
        <rect x="7.1" y="3.8" width="1.8" height="5.6" rx="0.9" fill="#05070a" />
        <circle cx="8" cy="11.6" r="1.1" fill="#05070a" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={info.label}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2 + i * 4.5}
          y={10 - i * 3.5}
          width="3"
          height={4 + i * 3.5}
          rx="1"
          fill={i < info.bars ? info.color : '#273042'}
        />
      ))}
    </svg>
  );
}

export function PriorityTag({ p, compact }: { p: string; compact?: boolean }) {
  const info = priorityInfo(p);
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium"
      style={{ color: info.key === 'p3' ? '#7f8899' : info.color }}
      title={`${info.label} (${info.key})`}
    >
      <PriorityIcon p={p} />
      {!compact && info.label}
    </span>
  );
}

/** A status glyph: ring for to do, dashed for claimed, half for in progress, and so on. */
export function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  const { color } = statusInfo(status);
  const s = { width: size, height: size, viewBox: '0 0 16 16' };
  switch (status) {
    case 'claimed':
      return (
        <svg {...s}>
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeDasharray="3 2.4"
          />
        </svg>
      );
    case 'in-progress':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7Z" fill={color} />
        </svg>
      );
    case 'blocked':
      return (
        <svg {...s}>
          <path
            d="M5.5 1.8h5l3.7 3.7v5l-3.7 3.7h-5L1.8 10.5v-5Z"
            fill="none"
            stroke={color}
            strokeWidth="1.8"
          />
          <path d="M5.5 8h5" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'needs-review':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
          <circle cx="8" cy="8" r="2.2" fill={color} />
        </svg>
      );
    case 'done':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="7" fill={color} />
          <path
            d="m4.8 8.2 2.2 2.2 4.2-4.6"
            fill="none"
            stroke="#05070a"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'parked':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
          <path d="M5 11 11 5" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
        </svg>
      );
  }
}

export function StatusTag({
  status,
  stale,
  unblocked,
}: {
  status: string;
  stale?: boolean;
  unblocked?: boolean;
}) {
  const shown = stale || unblocked ? 'todo' : status;
  const info = statusInfo(shown);
  const style: CSSProperties = {
    color: info.color,
    background: `color-mix(in oklab, ${info.color} 11%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${info.color} 26%, transparent)`,
  };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={style}
    >
      <StatusIcon status={shown} size={12} />
      {info.label}
      {stale && <span className="text-warn">· stale claim</span>}
      {unblocked && <span className="text-ok">· unblocked</span>}
    </span>
  );
}
