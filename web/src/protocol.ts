// Messages between the page and the analysis worker.
import type { MediaInfo, Reason, Report } from '../../src/core/index.ts';

export interface Still {
  t: number;
  width: number;
  height: number;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

export interface FieldSnapshot {
  kind: 'general' | 'red';
  t: number;
  lastT: number;
  score: number;
  /** Field rate in transitions per second and level 7 area at the snapshot. */
  rate: number;
  area: number;
  /** Highest per cell transition count in the last second, per 4 x 4 CSS px block. */
  blocks: Uint8Array;
  bw: number;
  bh: number;
  blockCssW: number;
  blockCssH: number;
}

export type ToWorker =
  | {
      type: 'start';
      width: number;
      height: number;
      format: 'rgb' | 'rgba';
      displayWidth: number;
      displayHeight: number;
      fps: number;
      areaRule: string;
      media: Partial<MediaInfo>;
      /** True when the page samples the media by seeking (video); false when the frames are the media's own (GIF). */
      sampled?: boolean;
      /** Warnings found before screening (frame rate unknown or above the sample rate, length cap). */
      reasons?: Reason[];
    }
  | { type: 'frame'; data: ArrayBuffer; t: number }
  | { type: 'end' }
  | { type: 'synthetic'; name: string; areaRule: string };

export type FromWorker =
  | { type: 'progress'; frames: number; t: number }
  | { type: 'done'; before: Report; after: Report; stills: Still[]; snaps: FieldSnapshot[] }
  | { type: 'error'; message: string };
