# Stillfield specification

This file defines what Stillfield measures and why. Every rule below cites the primary source it comes from.
Where a source is ambiguous, the choice is stated and labelled. Sources were opened on 2026-11-16 unless noted.

Stillfield **screens** content for flashing that can trigger seizures in people with photosensitive epilepsy. It
does not certify anything, it is not medical advice, and a pass is not a guarantee. IRIS, PEAT and every small
checker listed below say the same about themselves.

## 1. Sources

| Source | Opened | What it gives |
| --- | --- | --- |
| WCAG 2.2, W3C Recommendation 12 December 2024, https://www.w3.org/TR/WCAG22/ | yes | SC 2.3.1 text (normative), definitions of "flash", "general flash and red flash thresholds", "relative luminance" |
| Understanding SC 2.3.1, https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html | yes | Informative notes: 341 x 256 CSS px block, the 87,296 CSS px sentence, analyse at the largest scale, loop GIFs, BT.1702 quote for non sRGB, the WCAG 2.2 red flash formula |
| Trace Center PEAT page, https://trace.umd.edu/peat/ | yes (the page, not the tool) | PEAT's wording of the area rule: "one quarter of any 341 x 256 pixel rectangle ... viewed at 1024 by 768"; detects general flash, red flash, extended flash warnings |
| ITU-R BT.1702-3 (11/2023), https://www.itu.int/rec/R-REC-BT.1702-3-202311-I/en (English PDF) | yes | Broadcast rule: 20 cd/m2 change with darker image under 160 cd/m2 on a 200 cd/m2 SDR display; more than three flashes (six changes) in any second; 25% of the displayed screen; the five second note; Annex 4 adaptive temporal filtering |
| EA IRIS, https://github.com/electronicarts/IRIS, BSD-3-Clause, last push 2025-01-14 | yes, through the GitHub API | Algorithm and thresholds read from `src/Flash.cpp`, `FlashDetection.cpp`, `TransitionTracker.*`, `RedSaturation.h`, `config/appsettings.json` |
| Ofcom guidance note on flashing images | **not opened**: www.ofcom.org.uk answers robots.txt with HTTP 403, so no page was fetched | nothing is taken from it |
| ISO 9241-391 | **not opened** (paid standard) | only what WCAG quotes from it |
| Harding FPA | **not opened** (commercial tool) | nothing |

## 2. The rule (WCAG 2.2, normative)

SC 2.3.1: "Web pages do not contain anything that flashes more than three times in any one second period, or the
flash is below the general flash and red flash thresholds."

Definition, "general flash and red flash thresholds": content passes if **any** of these is true:
1. "there are no more than three general flashes and / or no more than three red flashes within any one-second
   period; or"
2. "the combined area of flashes occurring concurrently occupies no more than a total of .006 steradians within any
   10 degree visual field on the screen (25% of any 10 degree visual field on the screen) at typical viewing
   distance"

So content **fails** only when, in some one second period, there are more than three flashes **and** the flashes
that occur together cover more than the area limit inside some 10 degree field.

- **General flash**: "a pair of opposing changes in relative luminance of 10% or more of the maximum relative
  luminance (1.0) where the relative luminance of the darker image is below 0.80".
- **Transition** (Note 2): "the change in relative luminance ... between adjacent peaks and valleys in a plot of
  relative luminance ... against time. A flash consists of two opposing transitions."
- **Red flash**: "any pair of opposing transitions involving a saturated red". Note 3 (new in 2.2) gives the
  working definition: one transition is to or from a state with R/(R + G + B) >= 0.8, and the difference between
  the states is more than 0.2 in CIE 1976 u'v'.
- **Exception**: "a fine, balanced, pattern such as white noise or an alternating checkerboard pattern with
  'squares' smaller than 0.1 degree ... on a side does not violate the thresholds."

## 3. Formulas

Relative luminance (WCAG 2.2 definition, Note 1): for 8 bit sRGB, `c = v/255`; `c <= 0.04045 ? c/12.92 :
((c + 0.055)/1.055)^2.4`; `L = 0.2126 R + 0.7152 G + 0.0722 B`. Stillfield uses a 256 entry lookup table built
from this formula (IRIS does the same with a stored table).

Chromaticity (Understanding 2.3.1, from ISO 9241-391), with R, G, B the linearised values above:
```
X = 0.4124564 R + 0.3575761 G + 0.1804375 B
Y = 0.2126729 R + 0.7151522 G + 0.0721750 B
Z = 0.0193339 R + 0.1191920 G + 0.9503041 B
u' = 4X / (X + 15Y + 3Z)      v' = 9Y / (X + 15Y + 3Z)
distance = sqrt((u'1 - u'2)^2 + (v'1 - v'2)^2)
```
Hand computed check values (tested in `test/color.test.ts`): white (255,255,255) gives u' = 0.1978, v' = 0.4683
(D65); pure red (255,0,0) gives u' = 0.4507, v' = 0.5229; their distance is 0.2588 (> 0.2). Relative luminance of
sRGB 128 grey is 0.2159.

**Saturation ratio.** WCAG does not say whether R/(R+G+B) uses encoded or linear values. The sentence that
introduces R, G, B for the XYZ step says they are "as specified in 'relative luminance' definition", which is
linear. Stillfield uses linear values (IRIS does too: its red test runs on the linearised frame).

**Black has no chromaticity.** At (0,0,0) the u'v' denominator is zero, and near black the ratio R/(R+G+B) is
dominated by noise: an H.264 pixel of (3,0,0) is "saturated red" by ratio. Stillfield treats any state whose linear
R+G+B is below 0.01 as achromatic (the D65 white point) and never saturated red. **This is a deviation from the
bare WCAG text**, the same rule the MIT licensed Flash Check extension uses (`RED_MIN_LINEAR_SUM = 0.01`, see
THIRD_PARTY.md). It is configurable (`redBlackFloor`, set 0 to disable). Linear R+G+B = 0.01 is about sRGB
(26,0,0): a red darker than that cannot make a red transition.

## 4. Area: the one reading Stillfield uses

The W3C text states the area two ways:
- **Normative** (the Recommendation): 25% of any 10 degree field. Note 1 says a 341 x 256 px rectangle at 1024 x 768
  "will provide a good estimate of a 10 degree visual field". 25% of 341 x 256 is **21,824 px**.
- **Informative** (Understanding): "the combined area of flashing becomes 341 x 256 CSS pixels, or a flashing area
  of 87,296 CSS pixels", which is the whole field, four times the normative limit.

**Stillfield uses the normative reading by default: more than 21,824 CSS px flashing together inside any
341 x 256 CSS px window fails.** Why:
1. The Recommendation is normative; the Understanding document is not, and its sentence equates the size of the
   field with the size of the limit, which the normative text explicitly does not do ("25% of any 10 degree visual
   field").
2. PEAT, the tool W3C lists in its resources, states the rule the same way ("one quarter of any 341 x 256 pixel
   rectangle").
3. It is the stricter reading. For a screening tool a false alarm costs a second look; a false pass can cost a
   seizure.

Two other readings are selectable with `--area`, and every report gives the measured area in CSS px so a reader can
apply any of them:
- `understanding`: more than 87,296 CSS px inside any 341 x 256 window.
- `frame`: more than 25% of the whole frame (ITU-R BT.1702 "25% of the displayed screen area", the rule IRIS uses).
  This is the mode used for comparing against IRIS.

**Display size.** Area depends on how big the content is shown. Understanding 2.3.1: "Content should be analyzed
at the largest scale at which a user may view the content ... the video should be analyzed for risks at full
screen." Defaults, each overridable with `--display WxH` (CSS px):
- Video files: fitted inside the 1024 x 768 reference screen (full screen at the WCAG reference size). A 16:9 video
  is assessed at 1024 x 576 CSS px.
- GIFs and image sequences: their own pixel size, 1 image px = 1 CSS px (how a page shows an `<img>` by default).
- Web pages: the viewport in CSS px (default 1024 x 768, device scale factor 1).

`--display WxH` in the CLI, the Action and the MCP tool means the content is shown at exactly W x H CSS px (it is
stretched if its shape differs). The web page's "Fit in W x H" choices instead fit the media inside a screen of that
size and keep its shape; the report always gives the size used in `settings.display`.

When the whole frame at the display size is no bigger than the area limit, nothing in it can fail. If part of it
still flashes more than three times a second, and that area scaled up to the frame fitted in 1024 x 768 would be
over the limit, the report adds a `small-frame` warning that names the rate and both areas and asks for a screen at
the size the content is really shown (chat apps, full width images and lightboxes show small GIFs larger). One tiny
blinking detail does not trigger it.

## 5. Detection algorithm

1. **Resample** each frame to a grid of cells 2 x 2 CSS px at the display size, averaging **linear** RGB (light
   adds linearly; Note 4 of the luminance definition says to use the average colour of dithered areas). A cell is
   about 0.06 degree at the reference viewing distance (341 px = 10 degrees), under the 0.1 degree pattern
   exception, so balanced patterns finer than a cell average out and coarser ones do not.
2. **Luminance transitions**, per cell. A zigzag tracker holds the last confirmed extreme (peak or valley) and the
   running extreme of the current leg. A leg counts as a transition **at the first frame where** it spans 0.1 or
   more from the last extreme **and** its darker end is below 0.8. For a rising leg the darker end is the start;
   for a falling leg it is the current value, so a fall that starts above 0.8 counts once it goes below 0.8.
   When the signal reverses by 0.1 or more from the running extreme, that extreme is confirmed and a new leg
   starts. Small wobbles under 0.1 never start a leg; slow fades are one leg each.
3. **Red transitions**, per cell. Each state is either saturated red (R/(R+G+B) >= 0.8, linear, above the black
   floor) or other. The tracker keeps an extreme for each side: the most saturated red of the current red run
   (farthest from D65 in u'v') and the other state farthest from that red. A transition is counted when the colour
   crosses to the other side and its u'v' distance from that side's extreme is more than 0.2; then the sides
   swap. So a red flash that starts from a pink in between (within 0.2 of both red and grey) and smooth multi frame
   red fades are both counted (proof clips `fail-red-pink-start`, `fail-red-smooth-4hz`).
4. **Counting.** Each cell keeps the timestamps of its recent transitions. Time is the frame timestamp in seconds
   (variable frame rate is fine). A cell's count at time t is the number of its transitions with timestamp in
   (t - 1 s, t]. That window holds exactly the frame to frame changes that happen inside one second of frames. A
   flash is two transitions, so **more than three flashes means 7 or more transitions** (IRIS: fail when
   transitions > 6; BT.1702: "more than three flashes (i.e. six changes in luminance)"; Flash Check: same).
5. **Area.** On every frame, for each count level k, the cells with count >= k are summed into 4 x 4 CSS px blocks
   (2 x 2 cells) and a summed area table finds the window holding the most such area. The window is the 341 x 256
   CSS px field rounded up to whole blocks (344 x 256 CSS px at 1:1, never smaller than the field, so the search
   is slightly conservative), placed at 4 CSS px steps; in `frame` mode it is the whole frame. The **field rate** at time t is the largest k for which that area is over the limit. This is
   "the flashes of a region at least as big as the limit".
6. **Verdict.**
   - `fail`, general: field rate for luminance >= 7 transitions (more than 3 flashes) at any time.
   - `fail`, red: same for red transitions.
   - `warn`, at the limit: field rate exactly 6 (3 flashes in a second). WCAG allows it; capture timing can push it
     either way.
   - `warn`, near the area limit: more than 3 flashes a second over 80% to 100% of the area limit.
   - `warn`, extended flashing: field rate >= 4 (two flashes or more a second) for 4 s or more within 5 s. This is
     IRIS's "extended failure" and BT.1702's five second note. WCAG has no such rule, so it never changes the
     WCAG result.
   - `warn`, small frame: see section 4.
   - `warn`, coverage (not fully screened): `incomplete` (decoding stopped early, the file is shorter than it says,
     ffmpeg reported damaged data, a length cap was reached, a page capture timed out), `sample-rate` (the content
     was sampled more slowly than it plays, or its frame rate is unknown), `uncontrolled-content` (animated images,
     SVG animation or frames in a page, which play outside the page clock), `no-frames`. These set
     `complete: false`.
   - `pass`: none of the above.
   The report always carries `wcag231: "pass" | "fail"` separately from the overall `verdict`, and `complete`. When
   `complete` is false a `wcag231` pass covers only the part screened, and the text output says "Not fully
   screened". The CLI exits 2 (could not run) when the file could not be read in full and no failure was found in
   the part read; the Action counts that file as an error.

**Concurrency.** Cells only count toward the area while each one is itself over the rate in the same one second
window. Two regions flashing in counter phase each count (each region flashes; together they are the "combined
area"). Flash Check does the same; IRIS's whole frame mean cannot see counter phase flashing at all.

**Known limits** (also in the README):
- Fast motion of high contrast detail (fast scrolling text, a pan across a fence) changes each cell's luminance
  even though the scene is not "flashing" as a whole. Stillfield can count that as flashing. Harding style
  analysers that use region mean luminance count less of it.
- Spatial patterns (BT.1702 Guideline 2, IRIS pattern detection) are not checked. 2.3.1 is about flashes.
- Display gamma, brightness, HDR and viewing distance are unknown. Content is treated as sRGB on an sRGB display
  (WCAG Note 3: "authors should evaluate using sRGB colorspace"). HDR and wide gamut sources are converted to sRGB
  by ffmpeg and that is flagged.
- When Stillfield samples (page capture, the web page seeking a video), rates under 20 fps can hide fast flashing
  between samples: `low-frame-rate` is then a warning. For decoded video, GIFs and PNG files the frames are the
  content, so a low frame rate is only noted (`info`).

## 6. Media handling

- **Video**: decoded by the system ffmpeg (4.4 or newer; `-vsync passthrough` before 5.1, `-fps_mode` after) to
  rgb24 at the display size (area scaling), frame timestamps kept. ffmpeg applies the stream's display rotation
  while decoding, so a quarter turn swaps the size used. ffmpeg output is treated as sRGB. If ffmpeg is missing the
  CLI says so and exits 2. ffmpeg's area scaling averages gamma encoded values before the linear cell average of
  section 5, so very fine detail (1 px lines) flashing at full contrast reads slightly lower in luminance change
  than a linear downscale would give; flashes over areas bigger than a few pixels are not affected.
  ffmpeg exits 0 on many truncated or damaged files and simply stops, so after decoding Stillfield compares the
  frames read with the frame count and length the file states (stream duration, Matroska DURATION tag, frame count
  over frame rate) and with ffmpeg's error messages. The end of what was read is the last frame's timestamp plus
  its own duration (ffmpeg 5.0 and newer report it; otherwise one average frame), so a variable frame rate file
  that holds its last frame for seconds is not short; when every stated frame was read there is no gap. Anything
  more than 0.5 s or half a second of frames short, or any decoder error, gives an `incomplete` warning. A
  fragmented MP4 without a total length (no `mehd` box) states only the length of the fragments present, so one cut
  exactly at a fragment boundary cannot be told from a complete shorter file.
- **GIF**: decoded in JavaScript (omggif, MIT) with disposal handled by Stillfield, in Node and the browser.
  Understanding 2.3.1: "For short clips that might be looped (such as GIF animations), the content should be
  analyzed while looping." A looping GIF is analysed for at least two full loops and at least 6 s, including the
  last frame to first frame wrap. Frame delays of 0 or 1 hundredth of a second are played at 100 ms by common
  browsers; Stillfield follows that and says so in the report's media notes. The browser behaviour was measured in
  Chromium by `test/gif.test.ts` (0 and 1 hundredth play at about 10 changes a second like 10 hundredths; 2
  hundredths at about 45 a second, not raised).
- **Image sequences**: a folder of PNG files in name order, `--fps` (default 30). Transparent pixels are composited
  over `--background` (default white), as GIFs are. Animated PNG (APNG) files are refused with exit 2: the PNG
  decoder reads only their first image, so screening them would miss the animation.
- **Web pages**: Chromium through Playwright, viewport in CSS px, page clock installed before load and stepped by
  exactly one frame interval per capture; CSS and Web Animations are paused and stepped to the same time; videos
  are paused and seeked. A script that runs before the page's own keeps every shadow root the page makes (open or
  closed), so videos and animations inside web components are stepped too. What the page clock cannot control is
  named in the report: animated images (GIF with more than one frame, APNG, animated WebP, AVIF sequences, SVG
  files with SMIL or CSS animation or an embedded animated image, as
  `<img>`, SVG `<image>`, `<object>`, `<embed>`, image inputs, CSS backgrounds, `content`, list and border images,
  masks, and `::before`, `::after` and `::marker` backgrounds and `content`; each is fetched again, with the page's
  cookies and referrer and at most 64 MB whatever the server states, and its bytes checked. Only a known still
  format (PNG without animation, JPEG, still WebP, single frame GIF, still AVIF, BMP, ICO, an SVG with no animation whose embedded `data:` URIs are all such stills)
  counts as checked; any other image, or one that could not be read, is named whatever its URL looks like, except a
  missing local file or an image the browser itself only got a 404 or 410 for, which shows nothing), SVG SMIL
  animation, frames (iframes), closed
  shadow roots declared in the HTML (which page scripts cannot reach; counted over the DevTools protocol), videos
  (sampled at the capture rate) and seeks that took over 1.5 s. The page is listed before and after the capture,
  and images loaded during it are added, so content added later is covered. Up to 200 images are checked within
  60 s; any beyond that are named as not checked. Local images (`file:`) are read only when the page itself is a
  local file, only from inside the folder of the page given (not one it navigates to) once links are resolved, and only regular files up to 64 MB,
  opened without blocking; any other local image is named as not read. Each of these is a coverage warning, so
  such a page never reads as a plain pass.
- **Web page (browser)**: never plays dropped media. It reads the frame rate from the container (MP4 and MOV
  sample durations; WebM and Matroska DefaultDuration) and by default seeks to the middle of every frame at that
  rate, up to 60 fps. The fastest rate is the shortest frame duration held for 3 frames in a row, so a short burst
  of fast frames counts. A video whose length reads as unknown (Infinity) is first seeked past its end to find it. When the rate cannot be read (fragmented MP4, WebM without a frame duration) or is higher
  than the sample rate, it adds a `sample-rate` warning. Video past 300 s is not screened, with an `incomplete`
  warning.

## 7. Reduced flash output (`--fix`)

BT.1702 Annex 4 describes "adaptive temporal filtering" that reduces "frame-to-frame ... stimuli" with "trade-offs
between the effectiveness of protection, and image blur". Stillfield's `--fix` is such a filter:
- every pixel keeps an exponential moving average of linear RGB with time constant tau (default 1 s);
- each output pixel is a blend of the input and that average; the blend weight is 1 where the cell has made 2 or
  more luminance or red transitions in the last second (one flash), ramps in over 2 frames and decays over 1 s, and
  is spread to cells within 4 cells (8 CSS px) so edges do not show;
- elsewhere the output is the input.
The output is encoded, decoded again from the file and screened again. If it still fails, tau doubles (up to 3
tries). The report shows before and after. It never says the output is safe; it says what the screen found.
`--fix` refuses to write over its input (compared as files, by device and inode, so a case variant, a symlink or a
hard link of the input is refused too), takes `--fix-out` for one input only, writes nothing when the input could
not be read in full or is a single frame GIF, writes to a temporary file of its own next to the output and moves it
into place only after it was written and screened (a failure deletes only that temporary file), says when the
written file could not be screened in full (exit 2), copies MP4 friendly
audio and re-encodes other audio to AAC, and keeps a GIF's loop count (a GIF that plays once is written to play
once).

## 8. Comparison with prior art

| Tool | Licence | Area rule | Red rule | Notes, and what Stillfield borrows |
| --- | --- | --- | --- | --- |
| EA IRIS (C++, OpenCV) | BSD-3 | 25% of the frame (any changed pixel counts toward area), whole frame mean luminance | (R-G-B) x 320 on pixels with R/(R+G+B) >= 0.8, threshold 20 | Extended failure rule (4 to 6 transitions per second for 4 s in 5 s). Borrowed: the transitions > 6 rule, the extended rule as a warning, the onset counting idea. No code copied. |
| Trace PEAT (Windows) | free, closed | quarter of any 341 x 256 rectangle at 1024 x 768 | older Harding red value | Not run. Its area wording supports the normative reading. |
| Flash Check: WCAG 2.3.1 Tester (jasonday, Chrome extension) | MIT | more than 25% of any 341 x 256 CSS px window | WCAG 2.2 u'v' | Per cell (4 x 4 CSS px) state machines, then a sliding window. Stillfield's design matches it closely and borrows its black floor (linear R+G+B < 0.01). No code copied. |
| flash-safety-audit (7391226) | MIT | IRIS with area 0.111 of the screen | IRIS | Python skill around the IRIS Python port. Keeps IRIS's broadcast rules apart from the WCAG verdict, as Stillfield does. |
| video-safety-check (CosLynxAI) | MIT | more than a quarter of the frame | (R-G-B) x 320 | Node CLI with ffmpeg, also loudness and captions. |
| FlashTrace (ashrit725-beep) | no licence file | 4 x 4 px patches with W3C formulas | | Deterministic page clock and CSS fix suggestions. No licence, so nothing is borrowed. |
| flash-guard (zz-plant) | Unlicense | one third of each screen axis | older red rule | TypeScript library for frame sequences plus a live canvas governor. |

## 9. Report schema (version 1)

`Report` (see `src/core/types.ts`): `schema: "stillfield/report@1"`, `verdict`, `wcag231`, `complete`, `reasons[]` (code,
level, message, start, end, peak), `general` and `red` summaries (max flashes per second, max area over the limit
in CSS px, time of the worst moment), `worstWindows[]` (start, end, kind, peak flashes per second, peak area,
window rectangle in CSS px), `perSecond[]` (second index, general and red max flashes), `timeline` (frame times,
general and red flashes per second, areas, mean luminance), `settings` (area rule, limit, window, display size,
grid, thresholds), `media` (source, fps, frames, duration, notes), `disclaimer`.
