import hero128 from '../assets/brand/swarmup-icon-hero-128.png';
import hero256 from '../assets/brand/swarmup-icon-hero-256.png';
import hero64 from '../assets/brand/swarmup-icon-hero-64.png';
import type { TileKey } from '../lib/identity';

const TILE_FILES = import.meta.glob<string>('../assets/brand/tiles/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

const TILE_SIZES = [32, 64, 128, 256] as const;

/** The smallest render that covers `px`, or the largest one. */
function fit<T extends number>(sizes: readonly T[], px: number): T {
  return sizes.find((s) => s >= px) ?? sizes[sizes.length - 1]!;
}

/**
 * The straight-on render of a tile for an image `size` CSS px wide: `src` for 1x screens and a
 * `srcSet` with the 2x file.
 */
export function tileImage(key: TileKey, size: number): { src: string; srcSet: string } {
  const url = (px: number): string =>
    TILE_FILES[`../assets/brand/tiles/swarmup-tile-${key}-front-${fit(TILE_SIZES, px)}.png`] ?? '';
  return { src: url(size), srcSet: `${url(size)} 1x, ${url(size * 2)} 2x` };
}

const HERO_SIZES = [64, 128, 256] as const;
const HERO: Record<(typeof HERO_SIZES)[number], string> = {
  64: hero64,
  128: hero128,
  256: hero256,
};

/**
 * The SwarmUp mark: four tiles, pink (you), orange (Claude), cyan (Codex), violet (the
 * orchestrator). Under 48 px it is the flat mark of `assets/brand/logo.svg`; from 48 px the 3D
 * render, as the brand sheet asks. It is decoration: the name stands next to it.
 */
export function Mark({ size = 22 }: { size?: number }) {
  if (size >= 48) {
    const url = (px: number): string => HERO[fit(HERO_SIZES, px)];
    return (
      <img
        src={url(size)}
        srcSet={`${url(size)} 1x, ${url(size * 2)} 2x`}
        width={size}
        height={size}
        alt=""
        draggable={false}
        className="shrink-0"
        data-mark="hero"
      />
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      aria-hidden
      className="shrink-0"
      data-mark="flat"
    >
      <rect width="10" height="10" fill="#E46FB3" />
      <rect x="12" width="10" height="10" fill="#E8875B" />
      <rect y="12" width="10" height="10" fill="#4FC3D9" />
      <rect x="12" y="12" width="10" height="10" fill="#A393FF" />
    </svg>
  );
}
