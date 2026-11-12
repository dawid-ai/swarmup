import type { LoopState } from '../lib/statusloop';
import { LOOP_MIN_PX, LOOPS } from '../lib/statusloop';

const FILES = import.meta.glob<string>('../assets/brand/status/*.{webp,png}', {
  eager: true,
  query: '?url',
  import: 'default',
});

const file = (name: string): string => FILES[`../assets/brand/status/swarmup-status-${name}`] ?? '';

/**
 * The files for one state at `size` CSS px: the animated WebP for 1x and 2x screens, and the
 * still PNGs shown when `prefers-reduced-motion` is set. The kit renders the loops at 64 and
 * 128 px and the stills at 64 and 256 px.
 */
export function loopImage(
  state: LoopState,
  size: number,
): { src: string; srcSet: string; stillSet: string } {
  const big = size > 64;
  const src = file(`${state}-${big ? 128 : 64}.webp`);
  const still = file(`${state}-still-${big ? 256 : 64}.png`);
  return {
    src,
    srcSet: big ? src : `${src} 1x, ${file(`${state}-128.webp`)} 2x`,
    stillSet: big ? still : `${still} 1x, ${file(`${state}-still-256.png`)} 2x`,
  };
}

/**
 * The mark in one of its four animated states: `working` and `needs-you` loop, `done` and
 * `failed` play once and stop on their last frame (the files are encoded that way). With
 * `prefers-reduced-motion` set, the browser picks the still PNG and nothing moves.
 *
 * Use it for one task's or one run's state, at 48 px and up, and at most once per visible panel:
 * never in a list row. Small sizes keep the flat `StatusIcon`.
 */
export function StatusLoop({
  state,
  size = LOOP_MIN_PX,
  className,
}: {
  state: LoopState;
  /** CSS px; sizes under 48 are drawn at 48, where the 3D mark is still readable. */
  size?: number;
  className?: string;
}) {
  const px = Math.max(LOOP_MIN_PX, Math.round(size));
  const img = loopImage(state, px);
  const { label } = LOOPS[state];
  return (
    <picture className={className ? `block ${className}` : 'block'} data-loop={state}>
      <source media="(prefers-reduced-motion: reduce)" srcSet={img.stillSet} />
      <img
        // A new state is a new element, so a play-once file starts from its first frame.
        key={state}
        src={img.src}
        srcSet={img.srcSet}
        width={px}
        height={px}
        alt={label}
        title={label}
        draggable={false}
        className="block shrink-0"
      />
    </picture>
  );
}
