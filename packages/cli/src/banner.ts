// The SwarmUp mark for a terminal: four tiles drawn with block characters, next to the name and
// the version. `swarmup --version` prints the compact form in a terminal; the five-line form is
// for a welcome screen.

/** How much color a stream can show. */
export type ColorLevel = 'truecolor' | '256' | 'none';

type Tile = 'pink' | 'orange' | 'cyan' | 'violet';

// The mark's colors, with the nearest xterm 256-color index for terminals without 24-bit color.
const TILES: Record<Tile, { rgb: readonly [number, number, number]; index: number }> = {
  pink: { rgb: [228, 111, 179], index: 205 },
  orange: { rgb: [232, 135, 91], index: 209 },
  cyan: { rgb: [79, 195, 217], index: 80 },
  violet: { rgb: [163, 147, 255], index: 141 },
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

/**
 * How much color the stream can show. Follows https://no-color.org and treats a pipe or a file as
 * 'none', so a script that reads the output never sees an escape sequence.
 */
export function colorLevel(
  stream: { isTTY?: boolean } = process.stdout,
  env: Record<string, string | undefined> = process.env,
): ColorLevel {
  if (!stream.isTTY || env.NO_COLOR || env.TERM === 'dumb') return 'none';
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || env.WT_SESSION) {
    return 'truecolor';
  }
  return '256';
}

function paint(tile: Tile, level: ColorLevel): string {
  const { rgb, index } = TILES[tile];
  return level === 'truecolor' ? `\x1b[38;2;${rgb.join(';')}m` : `\x1b[38;5;${index}m`;
}

export interface BannerOptions {
  version: string;
  color?: ColorLevel;
  /** Three lines with the name and version, instead of five with the tagline and the URL. */
  compact?: boolean;
  tagline?: string;
  url?: string;
}

/**
 * The banner as a string, without a trailing newline. With color 'none' it is one plain line.
 *
 * A character cell is twice as tall as it is wide, so a tile of 4 cells by 2 rows is square. Half
 * blocks put half a row between the two tile rows, which with the one-cell gap between columns
 * gives the mark's even gutter. The compact form uses tiles of 2 cells by 1 row.
 */
export function banner({
  version,
  color = 'truecolor',
  compact = false,
  tagline = 'Your coding agents need a manager.',
  url = 'swarmup.tech',
}: BannerOptions): string {
  if (color === 'none') return `swarmup ${version}`;
  const width = compact ? 2 : 4;
  const row = (left: Tile, right: Tile, char: string): string =>
    ` ${paint(left, color)}${char.repeat(width)} ${paint(right, color)}${char.repeat(width)}${RESET}`;
  const name = `${BOLD}SWARMUP${RESET} ${version}`;
  if (compact) {
    return [
      row('pink', 'orange', '█'),
      `${row('cyan', 'violet', '▄')}  ${name}`,
      row('cyan', 'violet', '▀'),
    ].join('\n');
  }
  return [
    row('pink', 'orange', '█'),
    `${row('pink', 'orange', '█')}   ${name}`,
    `${row('cyan', 'violet', '▄')}   ${tagline}`,
    `${row('cyan', 'violet', '█')}   ${DIM}${url}${RESET}`,
    row('cyan', 'violet', '▀'),
  ].join('\n');
}
