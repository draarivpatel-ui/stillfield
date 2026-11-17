// Colour maths against hand computed constants (independent of the generator). SPEC.md section 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  srgbToLinear,
  luminance8,
  chromaticity,
  isSaturatedRed,
  uvDistance,
  D65_UV,
  linearToSrgb8,
} from '../src/core/index.ts';

const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);

test('sRGB to linear follows the WCAG 2.2 formula', () => {
  close(srgbToLinear(0), 0);
  close(srgbToLinear(255), 1);
  // 10/255 = 0.0392 <= 0.04045, linear branch
  close(srgbToLinear(10), 10 / 255 / 12.92, 1e-9);
  // 128: ((0.50196 + 0.055) / 1.055)^2.4 = 0.21586
  close(srgbToLinear(128), 0.21586);
});

test('relative luminance of known colours', () => {
  close(luminance8(255, 255, 255), 1);
  close(luminance8(0, 0, 0), 0);
  close(luminance8(255, 0, 0), 0.2126);
  close(luminance8(0, 255, 0), 0.7152);
  close(luminance8(0, 0, 255), 0.0722);
  close(luminance8(128, 128, 128), 0.21586);
});

test('u prime v prime of white is D65 and of red matches hand calculation', () => {
  close(D65_UV[0], 0.19784);
  close(D65_UV[1], 0.46834);
  const [u, v] = chromaticity(1, 0, 0);
  // X = 0.4124564, Y = 0.2126729, Z = 0.0193339; d = X + 15Y + 3Z = 3.6605516
  close(u, (4 * 0.4124564) / 3.6605516);
  close(v, (9 * 0.2126729) / 3.6605516);
  close(u, 0.45071);
  close(v, 0.52289);
  close(uvDistance(u, v, D65_UV[0], D65_UV[1]), 0.25876);
});

test('black and near black have no chromaticity (black floor)', () => {
  assert.deepEqual(chromaticity(0, 0, 0), [D65_UV[0], D65_UV[1]]);
  // sRGB (3,0,0) is red by ratio but far below the floor
  const r3 = srgbToLinear(3);
  assert.equal(isSaturatedRed(r3, 0, 0), false);
  assert.equal(isSaturatedRed(r3, 0, 0, 0), true);
  // linear R+G+B = 0.01 is about sRGB 26 red
  assert.equal(isSaturatedRed(srgbToLinear(25), 0, 0), false);
  assert.equal(isSaturatedRed(srgbToLinear(27), 0, 0), true);
});

test('saturation ratio uses linear values', () => {
  // sRGB (255, 100, 100): linear (1, 0.1274, 0.1274): ratio 0.797, not saturated red
  assert.equal(isSaturatedRed(1, srgbToLinear(100), srgbToLinear(100)), false);
  // sRGB (255, 90, 90): linear 0.1022 each: ratio 0.830
  assert.equal(isSaturatedRed(1, srgbToLinear(90), srgbToLinear(90)), true);
});

test('linear to sRGB round trips every 8 bit value', () => {
  for (let i = 0; i < 256; i++) assert.equal(linearToSrgb8(srgbToLinear(i)), i);
});
