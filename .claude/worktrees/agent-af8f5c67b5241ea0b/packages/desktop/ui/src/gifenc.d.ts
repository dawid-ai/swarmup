declare module 'gifenc' {
  export type GifPalette = number[][];

  export interface GifEncoder {
    writeFrame(
      pixels: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: GifPalette;
        delay?: number;
        repeat?: number;
        dispose?: number;
        transparent?: boolean;
        transparentIndex?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    /** A view of the bytes written so far; writes to it change the output. */
    bytesView(): Uint8Array;
  }

  export function GIFEncoder(options?: { initialCapacity?: number }): GifEncoder;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' },
  ): GifPalette;
}
