// Entry point for the browser and Node. No Node APIs are used anywhere under src/core.
export {
  FlashAnalyzer,
  analyzeFrames,
  areaLimitFor,
  DISCLAIMER,
  VERSION,
  FIELD_W,
  FIELD_H,
  CELL_CSS,
  GENERAL_DELTA,
  DARK_LIMIT,
  RED_RATIO,
  RED_UV_DELTA,
  FAIL_TRANSITIONS,
  COVERAGE_CODES,
} from './analyzer.ts';
export {
  srgbToLinear,
  linearToSrgb8,
  relativeLuminance,
  luminance8,
  chromaticity,
  isSaturatedRed,
  uvDistance,
  D65_UV,
  SRGB_TO_LINEAR,
  DEFAULT_RED_BLACK_FLOOR,
} from './color.ts';
export { decodeGif, loopGifFrames } from './gif.ts';
export type { GifFrames } from './gif.ts';
export { ReducedFlashFilter } from './fix.ts';
export type { FixOptions } from './fix.ts';
export { generateClip, CLIPS } from './synth.ts';
export type { ClipSpec, ClipFrame } from './synth.ts';
export { formatText } from './format.ts';
export type * from './types.ts';
