# Third party material

Stillfield's own code is MIT (LICENSE). Everything below is used under its own licence, all compatible with MIT.

## Code shipped with or bundled into Stillfield

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| [omggif](https://github.com/deanm/omggif) (c) Dean McNamee, 2013 | 1.0.10 | MIT | GIF decoding in Node and the browser (bundled into `web/assets`) |
| [pngjs](https://github.com/pngjs/pngjs) (c) 2015 Luke Page and contributors, derived from work (c) 2012 Kuba Niegowski | 7.0.0 | MIT | PNG sequences and page screenshots |
| [playwright-core](https://github.com/microsoft/playwright) (c) Microsoft | 1.60.0 | Apache-2.0 | Optional: recording web pages in Chromium |

Development only (not shipped): TypeScript (Apache-2.0), esbuild (MIT, (c) 2020 Evan Wallace), `@types/*` (MIT),
`@modelcontextprotocol/sdk` (MIT, used only to test the MCP server against the official client).

## Programs run, not linked

- **ffmpeg and ffprobe** (LGPL or GPL depending on the build) are run as separate programs to decode and encode
  video. Stillfield does not include or link them.
- **Chromium** is downloaded by Playwright when page mode is used.

## Fonts (SIL Open Font License 1.1)

- **Fixation Display** is a Modified Version of **Atkinson Hyperlegible Next ExtraBold**, Copyright 2020-2024 The
  Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next). Changes:
  round dots redrawn as rings, display spacing, CFF outlines, new name. Built by `fonts/build.py` with fontTools.
  Licence: `web/fonts/OFL-FixationDisplay.txt`. The upstream font declares no Reserved Font Name; the modified font
  is renamed anyway.
- **Atkinson Hyperlegible Next** (Regular, SemiBold) and **Atkinson Hyperlegible Mono** (Regular, Medium),
  unmodified apart from subsetting, from https://github.com/googlefonts/atkinson-hyperlegible-next and
  https://github.com/googlefonts/atkinson-hyperlegible-next-mono. Licences in `fonts/src/` and `web/fonts/`.

## Standards and prior work (read, not copied)

- W3C WCAG 2.2 and Understanding SC 2.3.1 (W3C Document License): thresholds and formulas, quoted in SPEC.md.
- ITU-R BT.1702-3: broadcast guidance, quoted in SPEC.md.
- EA IRIS (BSD-3-Clause, Copyright (c) 2023 Electronic Arts Inc.): its transitions over 6 per second rule and its
  extended flash rule (used here as a warning) informed the design. No IRIS code is included. IRIS was built only
  locally to compare results (`docs/IRIS-COMPARISON.md`, `scripts/iris-compare.ts`).
- Flash Check: WCAG 2.3.1 Tester by jasonday (MIT): its near black rule for red (linear R+G+B under 0.01) is used,
  with credit. No code copied.
