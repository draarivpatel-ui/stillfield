// Public types for the Stillfield core. Report schema version 1 (SPEC.md section 9).

export type AreaRule = 'wcag' | 'understanding' | 'frame';
export type Verdict = 'pass' | 'warn' | 'fail';

/** Pixel layout of frames handed to the analyzer. */
export type PixelFormat = 'rgba' | 'rgb' | 'luminance';

export interface AnalyzerOptions {
  /** Width and height of the frames you will push, in pixels. */
  width: number;
  height: number;
  /** Layout of pushed frames. `luminance` is linear relative luminance (Float32Array), red analysis is skipped. */
  format?: PixelFormat;
  /** Size at which the content is shown, in CSS px. Defaults to the frame size (1 px = 1 CSS px). */
  displayWidth?: number;
  displayHeight?: number;
  /** Frame rate, used only when push() is called without a timestamp. */
  fps?: number;
  /** Which reading of the area rule to apply. Default `wcag` (SPEC.md section 4). */
  areaRule?: AreaRule;
  /** Override the area limit in CSS px^2 (advanced). */
  areaLimit?: number;
  /** Linear R+G+B under which a colour is treated as black for the red test. Default 0.01. Set 0 to disable. */
  redBlackFloor?: number;
  /** Keep a per frame timeline in the report (default true). */
  timeline?: boolean;
  /** Free form description of the media, copied into the report. */
  media?: Partial<MediaInfo>;
  /**
   * True when the frames are samples Stillfield took from something that changes between them (page capture, the
   * browser seeking a video). Then a low frame rate can hide flashes and gives a warning. False when the frames
   * are the content itself (decoded video, GIF, PNG files): a low frame rate is only noted. Default true.
   */
  sampled?: boolean;
}

export interface MediaInfo {
  source: string;
  kind: 'video' | 'gif' | 'images' | 'url' | 'frames';
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  notes: string[];
}

export interface Reason {
  code:
    | 'general-flash'
    | 'red-flash'
    | 'general-at-limit'
    | 'red-at-limit'
    | 'general-near-area'
    | 'red-near-area'
    | 'extended-flashing'
    | 'low-frame-rate'
    | 'too-short'
    | 'small-frame'
    | 'incomplete'
    | 'sample-rate'
    | 'uncontrolled-content'
    | 'no-frames';
  level: 'fail' | 'warn' | 'info';
  message: string;
  start?: number;
  end?: number;
  peakFlashesPerSecond?: number;
  peakArea?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorstWindow {
  kind: 'general' | 'red';
  level: 'fail' | 'warn';
  start: number;
  end: number;
  /** Highest flashes per second reached by an area over the limit. */
  peakFlashesPerSecond: number;
  /** True when the true rate may be higher (the per cell history was full). */
  rateIsMinimum: boolean;
  /** Largest area flashing more than 3 times a second inside one window, CSS px^2. */
  peakArea: number;
  /** Time of the peak, seconds. */
  peakTime: number;
  /** Window (10 degree field, or the frame) where the peak happened, CSS px. */
  region: Rect;
}

export interface ChannelSummary {
  /** Highest flashes per second reached by an area over the limit. */
  maxFlashesPerSecond: number;
  rateIsMinimum: boolean;
  /** Largest area (CSS px^2) flashing more than 3 times a second in one window. */
  maxAreaOverRate: number;
  /** Same as a fraction of the area limit. */
  maxAreaRatio: number;
  /** Time of the worst moment, seconds, or null. */
  worstTime: number | null;
  /** Seconds during which the WCAG rule is broken. */
  failSeconds: number;
}

export interface Timeline {
  t: number[];
  generalFlashes: number[];
  redFlashes: number[];
  generalArea: number[];
  redArea: number[];
  meanLuminance: number[];
}

export interface Settings {
  areaRule: AreaRule;
  areaLimit: number;
  window: { width: number; height: number };
  display: { width: number; height: number };
  grid: { width: number; height: number; cellCss: number };
  thresholds: {
    generalDelta: number;
    darkLimit: number;
    redRatio: number;
    redUvDelta: number;
    redBlackFloor: number;
    failTransitions: number;
    extendedTransitions: number;
    extendedSeconds: number;
    extendedWindow: number;
  };
}

export interface Report {
  schema: 'stillfield/report@1';
  tool: { name: string; version: string };
  verdict: Verdict;
  wcag231: 'pass' | 'fail';
  /**
   * False when part of the content was not screened, or was screened at a lower frame rate than it plays at (see the
   * `incomplete`, `sample-rate`, `uncontrolled-content` and `no-frames` reasons). A `wcag231` pass then only covers
   * what was screened, and the verdict is at least `warn`.
   */
  complete: boolean;
  reasons: Reason[];
  general: ChannelSummary;
  red: ChannelSummary;
  worstWindows: WorstWindow[];
  perSecond: { second: number; general: number; red: number }[];
  timeline?: Timeline;
  settings: Settings;
  media: MediaInfo;
  disclaimer: string;
}
