---
name: Stillfield
description: Flash screening results read like a visual field printout.
colors:
  ground: "#eaeeee"
  sheet: "#ffffff"
  ink: "#0e1b2c"
  ink-2: "#364556"
  ink-3: "#56636f"
  rule: "#d2d9dc"
  rule-strong: "#a9b4ba"
  rail: "#0e1b2c"
  rail-ink: "#e6ecf0"
  rail-ink-2: "#a7b6c4"
  fixation: "#e8a317"
  fixation-ink: "#7f5300"
  fixation-wash: "#fdf3df"
  fail: "#b8301e"
  fail-wash: "#fbebe7"
  warn: "#8a5600"
  warn-wash: "#fcf2df"
  pass: "#1b6a45"
  pass-wash: "#e4f2ea"
  series-red: "#b0123b"
  series-after: "#0f7480"
typography:
  verdict:
    fontFamily: "Fixation Display, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "clamp(64px, 8vw, 112px)"
    fontWeight: 800
    lineHeight: 0.86
    letterSpacing: "-0.03em"
  display:
    fontFamily: "Fixation Display, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "clamp(34px, 4.4vw, 60px)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "Fixation Display, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 800
    lineHeight: 1.2
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.3
  data:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.4
  figure:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, monospace"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: 1
rounded:
  sm: "3px"
  md: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  base: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
  section: "72px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "#22344a"
  button-quiet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "9px 10px"
  badge-fail:
    backgroundColor: "{colors.fail-wash}"
    textColor: "{colors.fail}"
    rounded: "{rounded.sm}"
    padding: "4px 6px"
  rail:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    height: "60px"
---

# Design System: Stillfield

## Overview

The screen is read like a visual field test printout. The WCAG area rule is literally a quarter of a 10 degree field,
so the result shows that field: a cool white sheet on a pale grey ground, a deep ink rail, greytone dot density for how
fast each part of the field flashes, and one amber fixation colour for the selected moment. Nothing moves unless the
person acts, and nothing on the page ever replays the content: results are numbers, step charts and stills.

It is an Operate surface: the intake column (drop, URL, settings, synthetic clips) and the result sheet (verdict,
reasons, charts, worst windows beside the field printout, reduced flash filter) are standard web controls. The world
lends type, palette, density and one signature move, the field printout.

## Colors

### Primary
- **Bowl ink** (`ink`, `rail`): text, the top rail, the general flash series, buttons.
- **Fixation amber** (`fixation`): the selected moment and the 10 degree field ring, the focus ring, text selection,
  the current nav item. Never used for text on white; `fixation-ink` carries amber text.

### Neutral
- **Ground** (`ground`) behind everything, **sheet** (`sheet`) for the result and inputs, `rule` and `rule-strong`
  for hairlines, `ink-2` and `ink-3` for secondary text (both pass 4.5:1 on white).

### State and data
- `fail`, `warn`, `pass` with their washes: only on verdicts, badges and level dots, always next to a word.
- `series-red` for red flash data, `series-after` (teal) for the filtered result.

### Named Rules
**The Word With Colour Rule.** State colour never stands alone: every red, amber or green mark carries its word
(fail, warn, pass) or sits beside it.

## Typography

**Fixation Display** (a modified Atkinson Hyperlegible Next ExtraBold, dots redrawn as rings like a perimetry
stimulus) carries the wordmark, the verdict, page and section headings and the drop title. **Atkinson Hyperlegible
Next** carries body text and labels. **Atkinson Hyperlegible Mono** carries every number: times, rates, areas, the
report line, tables and code.

### Hierarchy
- Verdict: 64 to 112 px, 800, tight leading. The one dominant element of a result.
- Display: 34 to 60 px (empty state title), 40 px (busy and error titles).
- Heading: 19 px for panels, 17 px in the intake column, 16 px for sub charts.
- Body 16 px; labels 14 px semibold; data 13 to 14 px mono; key figures 26 px mono.

### Named Rules
**The Title Stands Alone Rule.** No label above a title and no tagline or helper line under it, anywhere.
**The Numbers Are Mono Rule.** Any measured value is set in the mono with tabular figures.

## Layout

Two columns on desktop: a 340 px intake column (sticky under the rail) and a fluid result sheet, max width 1480 px,
24 px gutters. Inside the sheet: verdict row, reasons, charts at full width, then worst windows and the field printout
side by side, then the filter. Below 1100 px the side by side panels stack; below 860 px everything is one column with
16 px side gutters, the rail keeps only the current link, and a finished result scrolls into view. Charts are drawn at
the pixel width they are shown at.

## Elevation & Depth

Flat. Separation comes from the sheet against the ground, 1 px hairlines and spacing. No shadows except the inset
selection outline on the chosen synthetic clip.

## Shapes

Small radii only: 4 px on sheets, buttons and inputs, 3 px on badges, round level dots and rings. The drop target uses
a dashed 1.5 px border.

## Components

### Buttons
Primary is ink on white text; quiet is white with a `rule-strong` border. Both 10 by 16 px padding, 15 px semibold.

### Inputs
White, `rule-strong` border, 4 px radius; the URL field is mono. Selects carry a drawn chevron.

### Navigation
The ink rail: wordmark in Fixation Display, links in `rail-ink-2`, the current one in `rail-ink` with a 3 px amber
underline.

### Field printout (signature)
A still of the worst moment with the field marked in amber and ink, beside a greytone dot map of the field: dot size
grows with transitions per second, ink where a cell flashes more than 3 times a second and grey where slower, a 6 by 4
grid of the highest flashes per second, axes through an amber fixation ring with ticks every degree (341 CSS px is 10
degrees).

### Charts
Step charts: general flashes as an ink area, red as a crimson line, the limit as a dashed fail red line, worst windows
as amber bands and as exact duration bars on a lane under the time axis.

## Do's and Don'ts

### Do:
- Show stills and graphs of failing content; keep the page passing its own screen (`test/web.test.ts`).
- Put the measurement conditions (size, area rule, frame rate) next to every result.
- Say "screens"; keep the disclaimer quiet but present.

### Don't:
- Don't autoplay or animate any dropped or failing content, and don't add motion that the screen would flag.
- Don't use state colours without their word, or amber for body text.
- Don't add eyebrow labels, taglines, cards in cards or decorative gradients.
