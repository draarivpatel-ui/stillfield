// Colour maths from WCAG 2.2 ("relative luminance") and Understanding SC 2.3.1 (CIE 1976 u'v').
// See SPEC.md section 3.

/** sRGB 8 bit value to linear light, WCAG 2.2 formula with the 0.04045 threshold. */
export function srgbToLinear(v8: number): number {
  const c = v8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 256 entry lookup table of srgbToLinear. */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i);
  return t;
})();

/** Linear light to sRGB 8 bit (rounded, clamped). Used by the reduced flash filter. */
export function linearToSrgb8(l: number): number {
  if (!(l > 0)) return 0;
  if (l >= 1) return 255;
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

/** 4096 entry table, linear [0,1] to sRGB 8 bit, for fast encoding. */
export const LINEAR_TO_SRGB_4096: Uint8Array = (() => {
  const t = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) t[i] = linearToSrgb8(i / 4096);
  return t;
})();

/** Relative luminance of linear R, G, B. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Relative luminance of an 8 bit sRGB colour. */
export function luminance8(r8: number, g8: number, b8: number): number {
  return relativeLuminance(SRGB_TO_LINEAR[r8], SRGB_TO_LINEAR[g8], SRGB_TO_LINEAR[b8]);
}

/** D65 white point in u'v' (the chromaticity of any neutral grey). */
export const D65_UV: readonly [number, number] = (() => {
  const X = 0.4124564 + 0.3575761 + 0.1804375;
  const Y = 0.2126729 + 0.7151522 + 0.072175;
  const Z = 0.0193339 + 0.119192 + 0.9503041;
  const d = X + 15 * Y + 3 * Z;
  return [(4 * X) / d, (9 * Y) / d] as const;
})();

/** Default floor: a state with linear R+G+B below this is treated as black (achromatic). SPEC.md section 3. */
export const DEFAULT_RED_BLACK_FLOOR = 0.01;

/**
 * CIE 1976 u'v' of linear R, G, B. States darker than `blackFloor` (linear R+G+B) are given the D65 white point,
 * since black has no chromaticity.
 */
export function chromaticity(r: number, g: number, b: number, blackFloor = DEFAULT_RED_BLACK_FLOOR): [number, number] {
  if (r + g + b < blackFloor || r + g + b <= 0) return [D65_UV[0], D65_UV[1]];
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const d = X + 15 * Y + 3 * Z;
  if (d <= 0) return [D65_UV[0], D65_UV[1]];
  return [(4 * X) / d, (9 * Y) / d];
}

/** True when the linear colour is a saturated red: R/(R+G+B) >= 0.8 and above the black floor. */
export function isSaturatedRed(r: number, g: number, b: number, blackFloor = DEFAULT_RED_BLACK_FLOOR): boolean {
  const s = r + g + b;
  if (s <= 0 || s < blackFloor) return false;
  return r / s >= 0.8;
}

/** Distance between two u'v' points. */
export function uvDistance(u1: number, v1: number, u2: number, v2: number): number {
  const du = u1 - u2;
  const dv = v1 - v2;
  return Math.sqrt(du * du + dv * dv);
}
