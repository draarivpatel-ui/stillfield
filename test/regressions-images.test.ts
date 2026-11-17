// Regressions: the image check, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { OUT, writeClip } from './helpers.ts';
import { imageKind, readLocalImage } from '../src/node/url.ts';

const svg = (inner: string) => Buffer.from(`﻿<?xml version="1.0" encoding="utf-8"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);

test('image bytes read as animated, a known still format, or unknown', async () => {
  assert.equal(imageKind(svg('<rect><set attributeName="fill" to="#fff" begin="1s"/></rect>')), 'animated');
  assert.equal(imageKind(svg('<g><animateTransform attributeName="transform" type="rotate" dur="1s"/></g>')), 'animated');
  assert.equal(imageKind(svg('<style>@keyframes f{to{opacity:0}}</style>')), 'animated');
  assert.equal(imageKind(svg('<rect style="animation: f 1s infinite"/>')), 'animated');
  assert.equal(imageKind(svg('<rect fill="#000"/><text>settings</text>')), 'still');
  // an SVG that embeds an animated GIF plays it
  const gif = readFileSync(await writeClip('fail-full-4hz', '.gif'));
  assert.equal(imageKind(svg(`<image href="data:image/gif;base64,${gif.toString('base64')}"/>`)), 'animated');
  // embedded under any label, wrapped base64, or hidden in an imported style sheet
  assert.equal(imageKind(svg(`<image href="data:;base64,${gif.toString('base64')}"/>`)), 'animated');
  const wrapped = gif.toString('base64').replace(/.{76}/g, '$&\n');
  assert.equal(imageKind(svg(`<image href="data:image/gif;base64,${wrapped}"/>`)), 'animated');
  const css = Buffer.from('rect{animation:f 1s}@keyframes f{to{opacity:0}}').toString('base64');
  assert.notEqual(imageKind(svg(`<style>@import url("data:text/css;base64,${css}");</style>`)), 'still');
  // markers spelled with character references, CSS escapes, entities or a namespace prefix
  assert.equal(imageKind(svg('<style>&#64;key&#x66;rames f{to{opacity:0}}</style>')), 'animated');
  assert.equal(imageKind(svg('<style>rect{\\61 nimation:f 1s}</style>')), 'unknown');
  assert.equal(imageKind(Buffer.from('<!DOCTYPE svg [<!ENTITY a "&#60;set attributeName=\'x\' to=\'1\'/>">]><svg>&a;</svg>')), 'unknown');
  assert.equal(imageKind(svg('<rect><discard begin="1s"/></rect>')), 'animated');
  assert.equal(imageKind(svg('<rect><s:set attributeName="fill" to="#fff"/></rect>')), 'animated');
  // an ISO media file that is not AVIF
  assert.equal(imageKind(Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 0, 0, ...Buffer.from('mp41')])), 'unknown');
  // gzip (svgz) is not decompressed, so it is not known
  assert.equal(imageKind(gzipSync(svg('<rect/>'))), 'unknown');
  const png = new PNG({ width: 2, height: 2 });
  assert.equal(imageKind(PNG.sync.write(png)), 'still');
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'still');
  assert.equal(imageKind(gif), 'animated');
  assert.equal(imageKind(Buffer.from('<!doctype html><title>Sign in</title>')), 'unknown');
  assert.equal(imageKind(Buffer.alloc(0)), 'unknown');
});

test('a file inside the page folder whose name starts with two dots is read', () => {
  const dir = join(OUT, 'dots');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, '..icon.png');
  writeFileSync(f, PNG.sync.write(new PNG({ width: 2, height: 2 })));
  const got = readLocalImage(f, realpathSync.native(dir));
  assert.ok(got.bytes, got.why);
  writeFileSync(join(OUT, 'dots-outside.png'), PNG.sync.write(new PNG({ width: 2, height: 2 })));
  assert.equal(readLocalImage(join(dir, '..', 'dots-outside.png'), realpathSync.native(dir)).why, "outside the page's folder");
});
