import { findActiveWordIndex, type AlignedWord } from "./alignment";
import { buildLines, LINE_GAP_SEC, SECTION_GAP_SEC, type LyricLine } from "./lyric-groups";

export interface VizSettings {
  fontSize: number;      // full-mode font size in px (default 26); multiline scales proportionally
  activeColor: string;   // hex, default "#7cf0ff"
  inactiveColor: string; // hex, default "#5a5a68"
  bgColor: string;       // hex, default "#0a0a0f"
}

export const DEFAULT_VIZ_SETTINGS: VizSettings = {
  fontSize: 26,
  activeColor: "#7cf0ff",
  inactiveColor: "#5a5a68",
  bgColor: "#0a0a0f",
};

export function defaultVizSettingsForSkin(skin: "default" | "topkek"): VizSettings {
  if (skin === "topkek") {
    return {
      fontSize: DEFAULT_VIZ_SETTINGS.fontSize,
      activeColor: "#81c784",
      inactiveColor: "#5f8a63",
      bgColor: "#0f150f",
    };
  }
  return { ...DEFAULT_VIZ_SETTINGS };
}

// Fixed layout constants
const FULL_PAD = 48;
const FULL_SECTION_GAP = 16;
const FULL_SCROLL_TAU_SEC = 0.18;
const RAIL_SCROLL_TAU_SEC = 0.14;
const RAIL_CULL_MARGIN = 120;
const INTRO_GAP_SEC = 4.0;
const COLOR_HEADER = "#9ec5ff";

export type LyricVizMode = "multiline" | "rail" | "full";

type RailLayout = {
  left: number[];
  centerX: number[];
  right: number[];
  stripWidth: number;
};

type FullLine = {
  indices: number[];
};

type FullSection = {
  title: string;
  lines: FullLine[];
};

type FullLayoutLine = {
  y: number;
  kind: "header" | "words";
  text?: string;
  words?: { idx: number; text: string; x: number; w: number }[];
  firstIdx?: number;
  lastIdx?: number;
};

type FullLayout = {
  lines: FullLayoutLine[];
  totalHeight: number;
  wordToLine: Map<number, number>;
};

export class LyricPlane {
  onWordClick: ((idx: number) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private alignedLyrics: AlignedWord[] = [];
  private allWords: string[] = [];
  private lastKnownActive = -1;
  private active = -1;
  private selected: Set<number> = new Set();
  private mode: LyricVizMode = "full";
  private multilineHitRects: { idx: number; x: number; y: number; w: number }[] = [];
  private multilineLines: LyricLine[] = [];
  private railLayout: RailLayout | null = null;
  private displayScroll = 0;
  private scrollInitialized = false;
  private lastTickMs = 0;

  private sections: FullSection[] = [];
  private fullLayout: FullLayout | null = null;
  private fullScrollY = 0;
  private fullScrollManualUntilMs = 0;
  private fullScrollInit = false;

  private container: HTMLElement;
  private bottomMargin = 0;
  private settings: VizSettings = { ...DEFAULT_VIZ_SETTINGS };

  // Logical (CSS-pixel) canvas dimensions, kept in sync with resize()
  private logicalW = 0;
  private logicalH = 0;

  // Touch / pointer scroll state for full mode
  private ptrActive = false;
  private ptrId = -1;
  private ptrStartY = 0;
  private ptrScrollStart = 0;
  private ptrMoved = false;

  // ── Computed font / size helpers ───────────────────────────────────
  private get multilineFontSize(): number { return this.settings.fontSize * 1.69; }
  private get multilineLineHeight(): number { return this.multilineFontSize * 1.27; }
  private get multilineFont(): string {
    return `600 ${Math.round(this.multilineFontSize)}px system-ui, "Segoe UI", sans-serif`;
  }
  private get fullFont(): string {
    return `500 ${this.settings.fontSize}px system-ui, "Segoe UI", sans-serif`;
  }
  private get fullLineHeight(): number { return this.settings.fontSize * 1.38; }
  private get fullHeaderFont(): string {
    return `700 ${Math.round(this.settings.fontSize * 0.7)}px system-ui, "Segoe UI", sans-serif`;
  }
  private get fullHeaderHeight(): number { return Math.round(this.settings.fontSize * 1.7); }

  private shadowColor(hex: string, alpha: number): string {
    const n = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  private get effectiveH(): number {
    return Math.max(120, this.logicalH - this.bottomMargin);
  }

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      display: block;
      touch-action: none;
    `;
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.resize()).observe(container);
    }
    this.canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.handlePointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.handlePointerUp(e));
    this.canvas.addEventListener("pointercancel", () => { this.ptrActive = false; });
    this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
  }

  setBottomMargin(px: number): void {
    this.bottomMargin = Math.max(0, px);
    this.redraw();
  }

  setSettings(s: Partial<VizSettings>): void {
    const fontChanged = s.fontSize !== undefined && s.fontSize !== this.settings.fontSize;
    this.settings = { ...this.settings, ...s };
    if (fontChanged) {
      this.rebuildRailLayout();
      this.rebuildFullLayout();
    }
    this.redraw();
  }

  getSettings(): VizSettings {
    return { ...this.settings };
  }

  private handleWheel(e: WheelEvent): void {
    if (this.mode !== "full") return;
    const layout = this.fullLayout;
    if (!layout) return;
    e.preventDefault();
    const maxScroll = Math.max(0, layout.totalHeight - this.effectiveH);
    this.fullScrollY = Math.min(maxScroll, Math.max(0, this.fullScrollY + e.deltaY));
    this.fullScrollManualUntilMs = performance.now() + 4000;
    this.redraw();
  }

  private handlePointerDown(e: PointerEvent): void {
    // Only primary pointer (left mouse / first finger)
    if (e.button > 0) return;
    this.ptrActive = true;
    this.ptrId = e.pointerId;
    this.ptrStartY = e.clientY;
    this.ptrScrollStart = this.fullScrollY;
    this.ptrMoved = false;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.ptrActive || e.pointerId !== this.ptrId) return;
    if (this.mode !== "full") return;
    const deltaY = this.ptrStartY - e.clientY;
    if (Math.abs(deltaY) > 6) this.ptrMoved = true;
    if (!this.ptrMoved) return;
    const layout = this.fullLayout;
    if (!layout) return;
    const maxScroll = Math.max(0, layout.totalHeight - this.effectiveH);
    this.fullScrollY = Math.min(maxScroll, Math.max(0, this.ptrScrollStart + deltaY));
    this.fullScrollManualUntilMs = performance.now() + 4000;
    this.redraw();
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.ptrActive || e.pointerId !== this.ptrId) return;
    this.ptrActive = false;
    if (!this.ptrMoved) {
      // Short tap without movement — treat as word click
      this.handleCanvasClick(e);
    }
  }

  getMode(): LyricVizMode {
    return this.mode;
  }

  setMode(mode: LyricVizMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "rail") this.scrollInitialized = false;
    if (mode === "full") {
      this.fullScrollInit = false;
      this.rebuildFullLayout();
    }
    this.redraw();
  }

  setAlignedLyrics(lyrics: AlignedWord[]): void {
    this.alignedLyrics = lyrics;
    this.allWords = lyrics.map((w) => w.word);
    this.multilineLines = buildLines(lyrics);
    this.lastKnownActive = -1;
    this.active = -1;
    this.rebuildRailLayout();
    this.rebuildSections();
    this.rebuildFullLayout();
    this.scrollInitialized = false;
    this.fullScrollInit = false;
    this.redraw();
  }

  setSelection(indices: Set<number>): void {
    this.selected = indices;
    this.redraw();
  }

  tick(timeSeconds: number): void {
    const now = performance.now();
    const dtSec = this.lastTickMs > 0 ? Math.min(0.1, (now - this.lastTickMs) / 1000) : 0;
    this.lastTickMs = now;

    const idx = findActiveWordIndex(this.alignedLyrics, timeSeconds);
    if (idx >= 0) this.lastKnownActive = idx;
    this.active = idx;

    if (this.mode === "rail") {
      this.updateRailScroll(dtSec);
    } else if (this.mode === "full") {
      this.updateFullScroll(dtSec);
    }

    this.redraw();
  }

  dispose(): void {
    this.canvas.remove();
  }

  private rebuildRailLayout(): void {
    if (this.allWords.length === 0) {
      this.railLayout = null;
      return;
    }
    const ctx = this.ctx;
    ctx.font = this.multilineFont;
    const left: number[] = [];
    const centerX: number[] = [];
    const right: number[] = [];
    let x = 0;
    const measureAdvance = (t: string) => ctx.measureText(t + " ").width;
    for (let i = 0; i < this.allWords.length; i++) {
      const word = this.allWords[i]!;
      const w = ctx.measureText(word).width;
      left.push(x);
      centerX.push(x + w / 2);
      right.push(x + w);
      x += measureAdvance(word);
    }
    this.railLayout = { left, centerX, right, stripWidth: x };
  }

  private updateRailScroll(dtSec: number): void {
    const layout = this.railLayout;
    const w = this.logicalW;
    const cx = w / 2;
    if (!layout || layout.centerX.length === 0) return;

    let target: number;
    if (this.active >= 0) {
      target = layout.centerX[this.active]! - cx;
    } else if (this.lastKnownActive >= 0) {
      target = layout.centerX[this.lastKnownActive]! - cx;
    } else {
      target = layout.centerX[0]! - cx;
    }

    const c0 = layout.centerX[0]!;
    const cLast = layout.centerX[layout.centerX.length - 1]!;
    const minT = c0 - cx;
    const maxT = cLast - cx;
    target = Math.min(maxT, Math.max(minT, target));

    if (!this.scrollInitialized) {
      this.displayScroll = target;
      this.scrollInitialized = true;
      return;
    }

    const k = 1 - Math.exp(-dtSec / RAIL_SCROLL_TAU_SEC);
    this.displayScroll += (target - this.displayScroll) * k;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.logicalW = w;
    this.logicalH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // Scale context so all drawing coordinates use CSS pixels
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rebuildRailLayout();
    this.rebuildFullLayout();
    this.redraw();
  }

  private redraw(): void {
    if (this.mode === "multiline") this.redrawMultiline();
    else if (this.mode === "rail") this.redrawRail();
    else this.redrawFull();
  }

  private redrawMultiline(): void {
    const w = this.logicalW;
    const h = this.logicalH;
    const H = this.effectiveH;
    const ctx = this.ctx;

    ctx.fillStyle = this.settings.bgColor;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, H);
    ctx.clip();

    const cx = w / 2;
    const cy = H / 2;
    const lineH = this.multilineLineHeight;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = this.multilineFont;

    const lines = this.multilineLines;
    if (lines.length === 0) { ctx.restore(); return; }

    const activeIdx = this.active >= 0 ? this.active : this.lastKnownActive;

    let activeLineIdx = 0;
    if (activeIdx >= 0) {
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]!;
        if (activeIdx >= ln.indices[0]! && activeIdx <= ln.indices[ln.indices.length - 1]!) {
          activeLineIdx = i;
          break;
        }
        if (ln.indices[0]! > activeIdx) break;
        activeLineIdx = i;
      }
    }

    const prevIdx = activeLineIdx - 1;
    const nextIdx = activeLineIdx + 1;
    const visibleIndices: number[] = [];
    if (prevIdx >= 0) visibleIndices.push(prevIdx);
    visibleIndices.push(activeLineIdx);
    if (nextIdx < lines.length) visibleIndices.push(nextIdx);

    const measure = (t: string) => ctx.measureText(t + " ").width;

    const slotY = (slot: number) => {
      if (visibleIndices.length === 1) return cy;
      if (visibleIndices.length === 2) {
        const activeSlot = prevIdx >= 0 ? 1 : 0;
        return cy + (slot - activeSlot) * lineH;
      }
      return cy + (slot - 1) * lineH;
    };

    this.multilineHitRects = [];

    for (let slot = 0; slot < visibleIndices.length; slot++) {
      const lineIdx = visibleIndices[slot]!;
      const ln = lines[lineIdx]!;
      const isActiveLine = lineIdx === activeLineIdx;

      const words = ln.indices.map((idx) => ({
        idx,
        text: this.allWords[idx]!,
      }));

      const fullW = words.reduce((acc, wd) => acc + measure(wd.text), 0);
      let x = cx - fullW / 2;
      const y = slotY(slot);

      for (const wd of words) {
        const tw = measure(wd.text);
        const isActive = wd.idx === this.active;
        const isLabel = this.alignedLyrics[wd.idx]?.kind === "label";
        const isSel = this.selected.has(wd.idx);

        ctx.globalAlpha = 1;
        if (isActive) {
          ctx.fillStyle = this.settings.activeColor;
          ctx.shadowColor = this.shadowColor(this.settings.activeColor, 0.55);
          ctx.shadowBlur = 18;
        } else if (isSel) {
          ctx.fillStyle = this.settings.activeColor;
          ctx.shadowColor = this.shadowColor(this.settings.activeColor, 0.35);
          ctx.shadowBlur = 8;
        } else if (isLabel) {
          ctx.fillStyle = COLOR_HEADER;
          ctx.shadowBlur = 0;
        } else if (isActiveLine) {
          ctx.fillStyle = this.settings.inactiveColor;
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = this.settings.inactiveColor;
          ctx.globalAlpha = 0.75;
          ctx.shadowBlur = 0;
        }
        ctx.fillText(wd.text, x + tw / 2, y);
        this.multilineHitRects.push({ idx: wd.idx, x, y: y - lineH / 2, w: tw });
        x += tw;
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private redrawRail(): void {
    const w = this.logicalW;
    const h = this.logicalH;
    const H = this.effectiveH;
    const ctx = this.ctx;
    const layout = this.railLayout;
    const cy = H / 2;

    ctx.fillStyle = this.settings.bgColor;
    ctx.fillRect(0, 0, w, h);

    if (!layout || this.allWords.length === 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, H);
    ctx.clip();

    ctx.textBaseline = "middle";
    ctx.font = this.multilineFont;

    const scroll = this.displayScroll;
    const v0 = scroll - RAIL_CULL_MARGIN;
    const v1 = scroll + w + RAIL_CULL_MARGIN;

    ctx.save();
    ctx.translate(-scroll, 0);

    for (let i = 0; i < this.allWords.length; i++) {
      const L = layout.left[i]!;
      const R = layout.right[i]!;
      if (R < v0 || L > v1) continue;

      const word = this.allWords[i]!;
      const cxWord = layout.centerX[i]!;
      const isActive = i === this.active;
      const isLabel = this.alignedLyrics[i]?.kind === "label";
      const isSel = this.selected.has(i);

      if (isActive) {
        ctx.fillStyle = this.settings.activeColor;
        ctx.shadowColor = this.shadowColor(this.settings.activeColor, 0.55);
        ctx.shadowBlur = 18;
      } else if (isSel) {
        ctx.fillStyle = this.settings.activeColor;
        ctx.shadowColor = this.shadowColor(this.settings.activeColor, 0.35);
        ctx.shadowBlur = 8;
      } else if (isLabel) {
        ctx.fillStyle = COLOR_HEADER;
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = this.settings.inactiveColor;
        ctx.shadowBlur = 0;
      }
      ctx.textAlign = "center";
      ctx.fillText(word, cxWord, cy);
    }

    ctx.restore();
    ctx.restore();
  }

  private rebuildSections(): void {
    const lyrics = this.alignedLyrics;
    this.sections = [];
    if (lyrics.length === 0) return;

    const hasExplicit = lyrics.some((w) => w.line_break === true || w.verse_break === true);

    const rawSections: { lines: number[][] }[] = [];
    let curSection: { lines: number[][] } = { lines: [] };
    let curLine: number[] = [0];

    for (let i = 1; i < lyrics.length; i++) {
      const prev = lyrics[i - 1]!;
      const cur = lyrics[i]!;
      const gap = cur.start_time - prev.end_time;
      const explicitVerse = prev.verse_break === true;
      const explicitLine = prev.line_break === true;
      const verseBreak = hasExplicit ? explicitVerse : gap >= SECTION_GAP_SEC;
      const lineBreak = hasExplicit ? explicitLine : gap >= LINE_GAP_SEC;
      if (verseBreak) {
        if (curLine.length) curSection.lines.push(curLine);
        if (curSection.lines.length) rawSections.push(curSection);
        curSection = { lines: [] };
        curLine = [];
      } else if (lineBreak) {
        if (curLine.length) curSection.lines.push(curLine);
        curLine = [];
      }
      curLine.push(i);
    }
    if (curLine.length) curSection.lines.push(curLine);
    if (curSection.lines.length) rawSections.push(curSection);

    const sigOf = (s: { lines: number[][] }) =>
      s.lines
        .map((ln) => ln.map((i) => lyrics[i]!.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).join(" "))
        .join("\n");
    const sigCount = new Map<string, number>();
    for (const s of rawSections) {
      const sig = sigOf(s);
      sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
    }

    let chorusSig = "";
    let chorusN = 1;
    for (const [sig, n] of sigCount) {
      if (n >= 2 && n > chorusN) {
        chorusN = n;
        chorusSig = sig;
      }
    }

    const out: FullSection[] = [];
    if (lyrics[0]!.start_time >= INTRO_GAP_SEC) {
      out.push({ title: "Intro", lines: [] });
    }
    let verseNo = 0;
    let bridgeNo = 0;
    const seenNonChorus = new Set<string>();
    for (const s of rawSections) {
      const sig = sigOf(s);
      let title: string;
      if (sig === chorusSig) {
        title = "Refren";
      } else {
        const cnt = sigCount.get(sig) ?? 1;
        if (cnt >= 2 && seenNonChorus.has(sig)) {
          bridgeNo++;
          title = bridgeNo === 1 ? "Bridge" : `Bridge ${bridgeNo}`;
        } else {
          verseNo++;
          title = `Zwrotka ${verseNo}`;
          seenNonChorus.add(sig);
        }
      }
      out.push({ title, lines: s.lines.map((indices) => ({ indices })) });
    }

    this.sections = out;
  }

  private rebuildFullLayout(): void {
    if (this.sections.length === 0 || this.logicalW === 0) {
      this.fullLayout = null;
      return;
    }
    const ctx = this.ctx;
    const maxWidth = this.logicalW - FULL_PAD * 2;
    const lines: FullLayoutLine[] = [];
    const wordToLine = new Map<number, number>();
    const lineH = this.fullLineHeight;
    const headerH = this.fullHeaderHeight;
    let y = FULL_PAD + lineH / 2;

    for (let s = 0; s < this.sections.length; s++) {
      const sec = this.sections[s]!;
      if (s > 0) y += FULL_SECTION_GAP;
      lines.push({ y, kind: "header", text: sec.title });
      y += headerH;

      ctx.font = this.fullFont;
      const measureAdvance = (t: string) => ctx.measureText(t + " ").width;
      const measureWord = (t: string) => ctx.measureText(t).width;

      for (const ln of sec.lines) {
        let cur: { idx: number; text: string; w: number; adv: number }[] = [];
        let curW = 0;
        const flush = () => {
          if (!cur.length) return;
          let x = FULL_PAD;
          const placed: { idx: number; text: string; x: number; w: number }[] = [];
          for (const p of cur) {
            placed.push({ idx: p.idx, text: p.text, x, w: p.w });
            x += p.adv;
          }
          const lineIdx = lines.length;
          for (const p of cur) wordToLine.set(p.idx, lineIdx);
          lines.push({
            y,
            kind: "words",
            words: placed,
            firstIdx: cur[0]!.idx,
            lastIdx: cur[cur.length - 1]!.idx,
          });
          y += lineH;
          cur = [];
          curW = 0;
        };
        for (const idx of ln.indices) {
          const t = this.allWords[idx]!;
          const wWord = measureWord(t);
          const adv = measureAdvance(t);
          if (cur.length && curW + wWord > maxWidth) flush();
          cur.push({ idx, text: t, w: wWord, adv });
          curW += adv;
        }
        flush();
      }
    }
    const totalHeight = y + FULL_PAD;
    this.fullLayout = { lines, totalHeight, wordToLine };
  }

  private updateFullScroll(dtSec: number): void {
    const layout = this.fullLayout;
    if (!layout) return;
    if (performance.now() < this.fullScrollManualUntilMs) return;
    const H = this.effectiveH;
    const idx = this.active >= 0 ? this.active : this.lastKnownActive;
    let target = 0;
    if (idx >= 0) {
      const lineIdx = layout.wordToLine.get(idx);
      if (lineIdx !== undefined) {
        const line = layout.lines[lineIdx]!;
        target = line.y - H * 0.4;
      }
    }
    const maxScroll = Math.max(0, layout.totalHeight - H);
    target = Math.min(maxScroll, Math.max(0, target));

    if (!this.fullScrollInit) {
      this.fullScrollY = target;
      this.fullScrollInit = true;
      return;
    }
    const k = 1 - Math.exp(-dtSec / FULL_SCROLL_TAU_SEC);
    this.fullScrollY += (target - this.fullScrollY) * k;
  }

  private handleCanvasClick(e: MouseEvent): void {
    if (!this.onWordClick) return;
    const ex = e.offsetX;
    const ey = e.offsetY;

    if (this.mode === "multiline") {
      const lineH = this.multilineLineHeight;
      for (const r of this.multilineHitRects) {
        if (ex >= r.x && ex <= r.x + r.w && ey >= r.y && ey <= r.y + lineH) {
          this.onWordClick(r.idx);
          return;
        }
      }
    } else if (this.mode === "rail") {
      const layout = this.railLayout;
      if (!layout) return;
      const scroll = this.displayScroll;
      const H = this.effectiveH;
      const cy = H / 2;
      const lineH = this.multilineLineHeight;
      for (let i = 0; i < this.allWords.length; i++) {
        const screenX = layout.left[i]! - scroll;
        const wordW = layout.right[i]! - layout.left[i]!;
        if (
          ex >= screenX && ex <= screenX + wordW &&
          ey >= cy - lineH / 2 && ey <= cy + lineH / 2
        ) {
          this.onWordClick(i);
          return;
        }
      }
    } else {
      const layout = this.fullLayout;
      if (!layout) return;
      const scroll = this.fullScrollY;
      const lineH = this.fullLineHeight;
      for (const line of layout.lines) {
        if (line.kind !== "words" || !line.words) continue;
        const screenY = line.y - scroll;
        if (Math.abs(ey - screenY) > lineH / 2) continue;
        for (const p of line.words) {
          if (ex >= p.x && ex <= p.x + p.w) {
            this.onWordClick(p.idx);
            return;
          }
        }
      }
    }
  }

  private redrawFull(): void {
    const w = this.logicalW;
    const h = this.logicalH;
    const H = this.effectiveH;
    const ctx = this.ctx;

    // Fill full canvas including area behind HUD
    ctx.fillStyle = this.settings.bgColor;
    ctx.fillRect(0, 0, w, h);

    const layout = this.fullLayout;
    if (!layout) return;

    // Clip to visible area above HUD
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, H);
    ctx.clip();

    const scroll = this.fullScrollY;
    const lineH = this.fullLineHeight;
    ctx.textBaseline = "middle";

    for (const line of layout.lines) {
      const screenY = line.y - scroll;
      if (screenY < -lineH || screenY > H + lineH) continue;

      if (line.kind === "header") {
        ctx.font = this.fullHeaderFont;
        ctx.textAlign = "left";
        ctx.fillStyle = COLOR_HEADER;
        ctx.shadowBlur = 0;
        ctx.fillText(line.text!.toUpperCase(), FULL_PAD, screenY);
        ctx.strokeStyle = "rgba(158, 197, 255, 0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        const tw = ctx.measureText(line.text!.toUpperCase()).width;
        ctx.moveTo(FULL_PAD + tw + 12, screenY);
        ctx.lineTo(w - FULL_PAD, screenY);
        ctx.stroke();
        continue;
      }

      ctx.font = this.fullFont;
      ctx.textAlign = "left";
      for (const p of line.words!) {
        const isActive = p.idx === this.active;
        const isPast = this.lastKnownActive >= 0 && p.idx < this.lastKnownActive;
        const isLabel = this.alignedLyrics[p.idx]?.kind === "label";
        const isSel = this.selected.has(p.idx);
        ctx.globalAlpha = 1;
        if (isActive) {
          ctx.fillStyle = this.settings.activeColor;
          ctx.shadowColor = this.shadowColor(this.settings.activeColor, 0.55);
          ctx.shadowBlur = 14;
        } else if (isSel) {
          ctx.fillStyle = this.settings.activeColor;
          ctx.shadowColor = this.shadowColor(this.settings.activeColor, 0.35);
          ctx.shadowBlur = 8;
        } else if (isLabel) {
          ctx.fillStyle = COLOR_HEADER;
          ctx.shadowBlur = 0;
        } else if (isPast) {
          ctx.fillStyle = this.settings.inactiveColor;
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = this.settings.inactiveColor;
          ctx.globalAlpha = 0.7;
          ctx.shadowBlur = 0;
        }
        ctx.fillText(p.text, p.x, screenY);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // Scrollbar within visible area
    if (layout.totalHeight > H) {
      const trackW = 4;
      const trackX = w - trackW - 2;
      const thumbH = Math.max(24, (H / layout.totalHeight) * H);
      const maxScroll = layout.totalHeight - H;
      const thumbY = (scroll / maxScroll) * (H - thumbH);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(158, 197, 255, 0.08)";
      ctx.fillRect(trackX, 0, trackW, H);
      ctx.fillStyle = "rgba(158, 197, 255, 0.45)";
      ctx.fillRect(trackX, thumbY, trackW, thumbH);
    }

    ctx.restore();
  }
}
