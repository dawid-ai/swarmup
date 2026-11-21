import { useMemo } from 'react';
import { hashColor } from '../lib/identity';
import { graphLayout } from '../lib/map';
import type { MapNodeBrief } from '../types';

const SIZE = 600;

/**
 * The map as a constellation (see `graphLayout`), a line per link. A click or Enter on a node
 * opens it; the open node and its links stand out.
 */
export function MapGraph(props: {
  nodes: MapNodeBrief[];
  selected?: string | null;
  onOpen: (id: string) => void;
}) {
  const { nodes, selected, onOpen } = props;
  const points = useMemo(() => new Map(graphLayout(nodes, SIZE).map((p) => [p.id, p])), [nodes]);
  const edges = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<[string, string]> = [];
    for (const n of nodes) {
      for (const l of n.links) {
        const key = [n.id, l].sort().join('\0');
        if (seen.has(key) || !points.has(l) || !points.has(n.id)) continue;
        seen.add(key);
        out.push([n.id, l]);
      }
    }
    return out;
  }, [nodes, points]);
  const near = new Set(
    selected
      ? edges.filter(([a, b]) => a === selected || b === selected).flatMap(([a, b]) => [a, b])
      : [],
  );
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`Map graph: ${nodes.length} nodes, ${edges.length} links`}
      className="mx-auto block h-full max-h-[640px] w-full max-w-[640px]"
    >
      {edges.map(([a, b]) => {
        const p = points.get(a)!;
        const q = points.get(b)!;
        const lit = selected === a || selected === b;
        return (
          <line
            key={`${a}>${b}`}
            x1={p.x}
            y1={p.y}
            x2={q.x}
            y2={q.y}
            stroke={lit ? '#5ce1e6' : 'rgba(255,255,255,0.12)'}
            strokeWidth={lit ? 1.6 : 1}
          />
        );
      })}
      {nodes.map((n) => {
        const p = points.get(n.id);
        if (!p) return null;
        const on = n.id === selected;
        const dim = selected && !on && !near.has(n.id);
        const color = hashColor(n.kind || '?');
        const label = n.id === 'index' ? 'root' : n.id.split('/').pop()!;
        return (
          <g
            key={n.id}
            role="button"
            tabIndex={0}
            aria-label={`${n.id}: ${n.summary}`}
            aria-pressed={on}
            data-map-node={n.id}
            onClick={() => onOpen(n.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(n.id);
              }
            }}
            className="cursor-pointer outline-none"
            opacity={dim ? 0.45 : 1}
          >
            <title>{`${n.id} (${n.kind}): ${n.summary}`}</title>
            <circle
              cx={p.x}
              cy={p.y}
              r={n.id === 'index' ? 11 : 7}
              fill={color}
              fillOpacity={on ? 0.9 : 0.35}
              stroke={on ? '#fff' : color}
              strokeWidth={on ? 2 : 1.2}
            />
            <text
              x={p.x}
              y={p.y + (n.id === 'index' ? 24 : 19)}
              textAnchor="middle"
              className="font-mono"
              fontSize={11}
              fill={on ? '#e8f6f7' : 'rgba(232,246,247,0.7)'}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
