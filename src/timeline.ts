import type { AlignedWord } from "./alignment";

// ── Stałe układu ────────────────────────────────────────────────────────────
const HEADER_H = 22;       // Wysokość osi czasu (px)
const TRACK_H = 26;        // Wysokość jednego wiersza tekstu (px)
const GUTTER_W = 60;       // Szerokość lewego panelu z etykietami linii
const RESIZE_ZONE = 6;     // Szerokość strefy resize na krawędzi bloku (px)
const BLOCK_PAD_Y = 3;     // Margines pionowy wewnątrz bloku
const MIN_ZOOM = 2;        // px/s — minimum (widok całości)
const MAX_ZOOM = 3000;     // px/s — maksimum (ms-precyzja)
const MIN_BLOCK_DUR = 0.01; // Minimalna długość bloku po resize (s)
type TimelinePalette = {
  bg: string;
  grid: string;
  tickLabel: string;
  gutterBg: string;
  gutterText: string;
  blockA: string;
  blockB: string;
  blockSel: string;
  blockActive: string;
  blockSugg: string;
  blockBorderA: string;
  blockBorderB: string;
  blockSelBorder: string;
  blockSuggBorder: string;
  wordTextA: string;
  wordTextB: string;
  wordTextSel: string;
  wordTextSugg: string;
  breakMarker: string;
  verseMarker: string;
  playhead: string;
  lassoFill: string;
  lassoStroke: string;
  lineBreak: string;
  verseBreak: string;
  gutterDivider: string;
};

const DEFAULT_TIMELINE_PALETTE: TimelinePalette = {
  bg: "#0a0a0f",
  grid: "rgba(40,50,70,0.7)",
  tickLabel: "#555",
  gutterBg: "rgba(15,18,28,0.95)",
  gutterText: "#6a8aaa",
  blockA: "#1e3a5a",
  blockB: "#2a2850",
  blockSel: "#7cf0ff",
  blockActive: "#4a7aaa",
  blockSugg: "#5a3a10",
  blockBorderA: "#2a5a8a",
  blockBorderB: "#4a3a7a",
  blockSelBorder: "rgba(124,240,255,0.8)",
  blockSuggBorder: "#aa6a20",
  wordTextA: "#9ec5ff",
  wordTextB: "#c8a0ff",
  wordTextSel: "#0a0a0f",
  wordTextSugg: "#ffc864",
  breakMarker: "rgba(124,240,255,0.6)",
  verseMarker: "rgba(255,180,90,0.8)",
  playhead: "rgba(158,197,255,0.9)",
  lassoFill: "rgba(124,240,255,0.06)",
  lassoStroke: "rgba(124,240,255,0.5)",
  lineBreak: "rgba(124,240,255,0.35)",
  verseBreak: "rgba(255,180,90,0.55)",
  gutterDivider: "rgba(40,60,80,0.8)",
};

const TOPKEK_TIMELINE_PALETTE: TimelinePalette = {
  bg: "#0f150f",
  grid: "rgba(76,175,80,0.34)",
  tickLabel: "#4f7353",
  gutterBg: "rgba(10,18,11,0.96)",
  gutterText: "#7aa67d",
  blockA: "#173120",
  blockB: "#1f2d1f",
  blockSel: "#81c784",
  blockActive: "#4caf50",
  blockSugg: "#4d3912",
  blockBorderA: "#2f6a3f",
  blockBorderB: "#426744",
  blockSelBorder: "rgba(129,199,132,0.85)",
  blockSuggBorder: "#aa8440",
  wordTextA: "#b7e3bb",
  wordTextB: "#9fd0a3",
  wordTextSel: "#071107",
  wordTextSugg: "#f2d08f",
  breakMarker: "rgba(129,199,132,0.65)",
  verseMarker: "rgba(240,190,120,0.85)",
  playhead: "rgba(129,199,132,0.92)",
  lassoFill: "rgba(129,199,132,0.08)",
  lassoStroke: "rgba(129,199,132,0.48)",
  lineBreak: "rgba(129,199,132,0.4)",
  verseBreak: "rgba(240,190,120,0.6)",
  gutterDivider: "rgba(76,175,80,0.55)",
};

/** Kursor SVG — nawias przy zmianie początku / końca słowa (hotspot przy krawędzi). */
const BRACKET_L_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='24' viewBox='0 0 16 24'><path d='M 12 3 L 5 3 L 5 21 L 12 21' fill='none' stroke='%239ec5ff' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/></svg>";
const BRACKET_R_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='24' viewBox='0 0 16 24'><path d='M 4 3 L 11 3 L 11 21 L 4 21' fill='none' stroke='%239ec5ff' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/></svg>";
const CURSOR_RESIZE_START = `url("data:image/svg+xml,${encodeURIComponent(BRACKET_L_SVG)}") 4 12, auto`;
const CURSOR_RESIZE_END = `url("data:image/svg+xml,${encodeURIComponent(BRACKET_R_SVG)}") 12 12, auto`;

// ── Typy ────────────────────────────────────────────────────────────────────

type DragState =
  | { kind: "move"; pointerId: number; anchorTime: number; origStarts: number[]; origEnds: number[] }
  | { kind: "resize-start"; pointerId: number; idx: number; anchorTime: number; origStart: number; origEnd: number }
  | { kind: "resize-end"; pointerId: number; idx: number; anchorTime: number; origStart: number; origEnd: number }
  | { kind: "lasso"; pointerId: number; startX: number; startY: number; curX: number; curY: number }
  | { kind: "pan"; pointerId: number; startClientX: number; startScrollX: number };

export type TimelineOptions = {
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo: (t: number) => void;
  onWordsChanged: (words: AlignedWord[]) => void;
};

// ── Klasa ────────────────────────────────────────────────────────────────────

export class LyricTimeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tooltip: HTMLElement;

  private words: AlignedWord[] = [];
  private suggestions: AlignedWord[] | null = null;
  private selected: Set<number> = new Set();

  private undoStack: AlignedWord[][] = [];
  private redoStack: AlignedWord[][] = [];
  private static readonly HISTORY_LIMIT = 100;

  private zoom = 100;        // px/s
  private scrollX = 0;      // odsunięcie osi czasu (sekundy) — lewa krawędź widoku
  private playheadTime = 0;

  private dragState: DragState | null = null;

  private readonly opts: TimelineOptions;
  private palette: TimelinePalette = { ...DEFAULT_TIMELINE_PALETTE };

  constructor(container: HTMLElement, opts: TimelineOptions) {
    this.opts = opts;

    this.canvas = document.getElementById("timeline-canvas") as HTMLCanvasElement;
    this.tooltip = document.getElementById("timeline-tooltip") as HTMLElement;

    this.ctx = this.canvas.getContext("2d")!;

    this.attachEvents();
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.resize()).observe(container);
    }
    this.resize();
  }

  // ── Publiczne API ──────────────────────────────────────────────────────────

  setWords(words: AlignedWord[]): void {
    this.words = words.map((w) => ({ ...w }));
    this.selected.clear();
    // Zewnętrzne wczytanie nowego stanu (np. nowy projekt) zeruje historię.
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.redraw();
  }

  private snapshot(): AlignedWord[] {
    return this.words.map((w) => ({ ...w }));
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > LyricTimeline.HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private restoreFrom(snap: AlignedWord[]): void {
    this.words = snap.map((w) => ({ ...w }));
    this.selected.clear();
    this.opts.onWordsChanged(this.getWords());
    this.redraw();
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.snapshot());
    this.restoreFrom(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restoreFrom(next);
    return true;
  }

  setPlayhead(t: number): void {
    this.playheadTime = t;
    this.autoScrollToPlayhead();
    this.redraw();
  }

  setSuggestions(s: AlignedWord[] | null): void {
    this.suggestions = s ? s.map((w) => ({ ...w })) : null;
    this.redraw();
  }

  getWords(): AlignedWord[] {
    return this.words.map((w) => ({ ...w }));
  }

  clearSelection(): void {
    this.selected.clear();
    this.redraw();
  }

  setSkin(skin: "default" | "topkek"): void {
    this.palette = skin === "topkek" ? { ...TOPKEK_TIMELINE_PALETTE } : { ...DEFAULT_TIMELINE_PALETTE };
    this.redraw();
  }

  selectAll(): void {
    this.selected = new Set(this.words.map((_, i) => i));
    this.redraw();
  }

  /** Przesuwa zaznaczone słowa o deltaSec sekund. */
  shiftSelected(deltaSec: number): void {
    if (this.selected.size === 0) return;
    this.pushHistory();
    for (const i of this.selected) {
      const w = this.words[i]!;
      w.start_time = Math.max(0, w.start_time + deltaSec);
      w.end_time = Math.max(w.start_time + MIN_BLOCK_DUR, w.end_time + deltaSec);
    }
    this.opts.onWordsChanged(this.getWords());
    this.redraw();
  }

  /** Ustaw widok na podany zakres czasu (synchronizacja z waveformem). */
  setVisibleTimeRange(start: number, end: number): void {
    const w = this.canvas.width;
    const trackW = Math.max(1e-9, w - GUTTER_W);
    const span = Math.max(0.01, end - start);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, trackW / span));
    this.scrollX = Math.max(0, start);
    this.redraw();
  }

  /** Pokaż cały utwór na osi czasu. */
  fitAll(): void {
    const duration = this.opts.getDuration();
    if (duration <= 0 || !Number.isFinite(duration)) return;
    const w = this.canvas.width;
    const trackW = Math.max(1e-9, w - GUTTER_W);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, trackW / duration));
    this.scrollX = 0;
    this.redraw();
  }

  /** Zakres czasu widoczny na osi (ścieżka po gutterze), do synchronizacji z innymi widżetami. */
  getVisibleTimeRange(): { start: number; end: number } {
    const w = this.canvas.width;
    const trackW = Math.max(1e-9, w - GUTTER_W);
    const duration = this.opts.getDuration();
    let start = this.scrollX;
    let end = this.scrollX + trackW / this.zoom;
    if (duration > 0 && Number.isFinite(duration)) {
      start = Math.max(0, Math.min(start, duration));
      end = Math.max(start + 1e-6, Math.min(end, duration));
    }
    return { start, end };
  }

  dispose(): void {
    // ResizeObserver i eventy są na canvas/window — GC je posprzątuje
  }

  // ── Układ ──────────────────────────────────────────────────────────────────

  private canvasHeight(): number {
    // Single-rail: jeden wspólny pas niezależnie od liczby logicznych linii.
    return HEADER_H + TRACK_H + 4;
  }

  private resize(): void {
    const container = this.canvas.parentElement!;
    const w = container.clientWidth || 600;
    const h = this.canvasHeight();
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.height = `${h}px`;
    this.redraw();
  }

  private timeToX(t: number): number {
    return (t - this.scrollX) * this.zoom + GUTTER_W;
  }

  private xToTime(x: number): number {
    return (x - GUTTER_W) / this.zoom + this.scrollX;
  }

  private lineRowY(_lineIdx: number): number {
    // Single-rail: wszystkie słowa w jednym wierszu.
    return HEADER_H;
  }

  /** True jeśli Y jest w obrębie jedynego pasa słów. */
  private yInTrack(y: number): boolean {
    return y >= HEADER_H && y <= HEADER_H + TRACK_H;
  }

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  private autoScrollToPlayhead(): void {
    const w = this.canvas.width;
    const visibleDur = (w - GUTTER_W) / this.zoom;
    const margin = visibleDur * 0.2;
    if (this.playheadTime < this.scrollX + margin) {
      this.scrollX = Math.max(0, this.playheadTime - margin);
    } else if (this.playheadTime > this.scrollX + visibleDur - margin) {
      this.scrollX = this.playheadTime - visibleDur + margin;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private redraw(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, w, h);

    this.drawTimeAxis(ctx, w);
    this.drawLines(ctx, w);
    this.drawPlayhead(ctx, h);
    this.drawLasso(ctx);
    this.drawGutter(ctx, h);
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D, w: number): void {
    const visibleDur = (w - GUTTER_W) / this.zoom;
    // Dobierz interwał ticków
    const candidatesMs = [1, 2, 5, 10, 20, 50, 100, 200, 500,
                          1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000];
    const targetTicks = 8;
    let intervalMs = 1000;
    for (const c of candidatesMs) {
      if ((visibleDur * 1000) / c <= targetTicks * 2) {
        intervalMs = c;
        break;
      }
    }
    const intervalSec = intervalMs / 1000;
    const firstTick = Math.ceil(this.scrollX / intervalSec) * intervalSec;

    ctx.fillStyle = "rgba(12,15,24,0.8)";
    ctx.fillRect(GUTTER_W, 0, w - GUTTER_W, HEADER_H);

    ctx.strokeStyle = this.palette.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.palette.tickLabel;

    for (let t = firstTick; t <= this.scrollX + visibleDur + intervalSec; t += intervalSec) {
      const x = this.timeToX(t);
      if (x < GUTTER_W || x > w) continue;
      // Linia siatki przez cały kanwas
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H);
      ctx.lineTo(x, this.canvas.height);
      ctx.stroke();
      // Etykieta
      const label = this.formatTime(t);
      ctx.fillText(label, x, HEADER_H / 2);
    }
  }

  private drawLines(ctx: CanvasRenderingContext2D, w: number): void {
    const sugg = this.suggestions;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = "middle";

    const rowY = this.lineRowY(0);

    // Pionowe separatory line_break/verse_break — rysowane PRZED blokami,
    // żeby bloki je przykryły i było widać tylko przerwy między słowami.
    for (let i = 0; i < this.words.length; i++) {
      const word = this.words[i]!;
      if (!word.line_break && !word.verse_break) continue;
      const next = this.words[i + 1];
      const x = next
        ? this.timeToX((word.end_time + next.start_time) / 2)
        : this.timeToX(word.end_time);
      if (x < GUTTER_W || x > w) continue;
      const isVerse = !!word.verse_break;
      ctx.strokeStyle = isVerse ? this.palette.verseBreak : this.palette.lineBreak;
      ctx.lineWidth = isVerse ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, rowY);
      ctx.lineTo(x, rowY + TRACK_H);
      ctx.stroke();

      // Znacznik: ¶ dla końca zwrotki, ↵ dla końca linijki
      ctx.font = isVerse ? 'bold 13px system-ui, sans-serif' : '11px system-ui, sans-serif';
      ctx.fillStyle = isVerse ? this.palette.verseMarker : this.palette.breakMarker;
      ctx.textAlign = "center";
      ctx.fillText(isVerse ? "¶" : "↵", x, rowY - 2);
      ctx.textAlign = "left";
    }
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';

    {
      let lineWordIdx = 0;
      for (let wordIdx = 0; wordIdx < this.words.length; wordIdx++) {
        const word = this.words[wordIdx]!;
        const isSel = this.selected.has(wordIdx);
        const isActive = Math.abs(this.playheadTime - word.start_time) < 0.001 ||
          (this.playheadTime >= word.start_time && this.playheadTime < word.end_time);
        const isOdd = lineWordIdx % 2 === 1;

        const x1 = this.timeToX(word.start_time);
        const x2 = this.timeToX(word.end_time);
        const bw = Math.max(2, x2 - x1);
        const by = rowY + BLOCK_PAD_Y;
        const bh = TRACK_H - BLOCK_PAD_Y * 2;

        // Sugestia Whisper
        if (sugg?.[wordIdx]) {
          const sx1 = this.timeToX(sugg[wordIdx]!.start_time);
          const sx2 = this.timeToX(sugg[wordIdx]!.end_time);
          const sbw = Math.max(2, sx2 - sx1);
          ctx.fillStyle = this.palette.blockSugg;
          ctx.fillRect(sx1, by, sbw, bh);
          ctx.strokeStyle = this.palette.blockSuggBorder;
          ctx.lineWidth = 1;
          ctx.strokeRect(sx1 + 0.5, by + 0.5, sbw - 1, bh - 1);
          ctx.fillStyle = this.palette.wordTextSugg;
          ctx.save();
          ctx.rect(Math.max(GUTTER_W, sx1 + 2), by, sbw - 4, bh);
          ctx.clip();
          ctx.fillText(word.word, sx1 + 4, by + bh / 2);
          ctx.restore();
        }

        // Blok główny — naprzemienne kolory A/B w obrębie linijki
        const blockColor = isSel ? this.palette.blockSel : isActive ? this.palette.blockActive : isOdd ? this.palette.blockB : this.palette.blockA;
        const borderColor = isSel ? this.palette.blockSelBorder : isOdd ? this.palette.blockBorderB : this.palette.blockBorderA;
        ctx.fillStyle = blockColor;
        ctx.fillRect(x1, by, bw, bh);
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 0.5, by + 0.5, bw - 1, bh - 1);

        // Tekst — naprzemienne kolory
        if (bw > 8) {
          ctx.fillStyle = isSel ? this.palette.wordTextSel : isOdd ? this.palette.wordTextB : this.palette.wordTextA;
          ctx.save();
          ctx.rect(Math.max(GUTTER_W, x1 + 2), by, bw - 4, bh);
          ctx.clip();
          ctx.fillText(word.word, x1 + 4, by + bh / 2);
          ctx.restore();
        }

        // Paski resize na krawędziach (tylko przy zaznaczeniu lub hover)
        if (isSel && bw > RESIZE_ZONE * 2 + 4) {
          ctx.fillStyle = "rgba(124,240,255,0.25)";
          ctx.fillRect(x1, by, RESIZE_ZONE, bh);
          ctx.fillRect(x2 - RESIZE_ZONE, by, RESIZE_ZONE, bh);
        }

        if (word.line_break || word.verse_break) {
          lineWordIdx = 0;
        } else {
          lineWordIdx++;
        }
      }
    }
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, h: number): void {
    const x = this.timeToX(this.playheadTime);
    if (x < GUTTER_W || x > this.canvas.width) return;
    ctx.strokeStyle = this.palette.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_H);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  private drawLasso(ctx: CanvasRenderingContext2D): void {
    if (this.dragState?.kind !== "lasso") return;
    const { startX, startY, curX, curY } = this.dragState;
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const lw = Math.abs(curX - startX);
    const lh = Math.abs(curY - startY);
    ctx.fillStyle = this.palette.lassoFill;
    ctx.fillRect(x, y, lw, lh);
    ctx.strokeStyle = this.palette.lassoStroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, lw - 1, lh - 1);
    ctx.setLineDash([]);
  }

  private drawGutter(ctx: CanvasRenderingContext2D, h: number): void {
    ctx.fillStyle = this.palette.gutterBg;
    ctx.fillRect(0, 0, GUTTER_W, h);

    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.palette.gutterText;

    // Single-rail: jedna etykieta zamiast L1..LN.
    ctx.fillText("TXT", GUTTER_W / 2, this.lineRowY(0) + TRACK_H / 2);

    // Pionowy separator
    ctx.strokeStyle = this.palette.gutterDivider;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER_W, 0);
    ctx.lineTo(GUTTER_W, h);
    ctx.stroke();
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  private onCanvasMouseLeave(): void {
    this.tooltip.classList.remove("visible");
    this.canvas.style.cursor = "";
  }

  private setCanvasCursorFromHit(
    hit: { kind: "resize-start" | "resize-end" | "block" | "gutter" | "empty"; wordIdx: number },
    ey: number,
  ): void {
    let c = "";
    if (hit.kind === "gutter") c = "default";
    else if (hit.kind === "resize-start") c = CURSOR_RESIZE_START;
    else if (hit.kind === "resize-end") c = CURSOR_RESIZE_END;
    else if (hit.kind === "block") c = "grab";
    else if (hit.kind === "empty") c = this.yInTrack(ey) ? "crosshair" : "default";
    this.canvas.style.cursor = c;
  }

  private setCanvasCursorFromDrag(ds: DragState): void {
    if (ds.kind === "pan") this.canvas.style.cursor = "grabbing";
    else if (ds.kind === "lasso") this.canvas.style.cursor = "crosshair";
    else if (ds.kind === "move") this.canvas.style.cursor = "grabbing";
    else if (ds.kind === "resize-start") this.canvas.style.cursor = CURSOR_RESIZE_START;
    else if (ds.kind === "resize-end") this.canvas.style.cursor = CURSOR_RESIZE_END;
  }

  private hitTest(ex: number, ey: number): {
    kind: "resize-start" | "resize-end" | "block" | "gutter" | "empty";
    wordIdx: number;
  } {
    if (ex < GUTTER_W) {
      return { kind: "gutter", wordIdx: -1 };
    }
    if (!this.yInTrack(ey)) return { kind: "empty", wordIdx: -1 };

    const by = this.lineRowY(0) + BLOCK_PAD_Y;
    const bh = TRACK_H - BLOCK_PAD_Y * 2;
    if (ey < by || ey > by + bh) return { kind: "empty", wordIdx: -1 };

    for (let wordIdx = 0; wordIdx < this.words.length; wordIdx++) {
      const word = this.words[wordIdx]!;
      const x1 = this.timeToX(word.start_time);
      const x2 = this.timeToX(word.end_time);
      const bw = x2 - x1;

      if (ex >= x1 && ex <= x2) {
        if (bw > RESIZE_ZONE * 2 + 4 && ex <= x1 + RESIZE_ZONE)
          return { kind: "resize-start", wordIdx };
        if (bw > RESIZE_ZONE * 2 + 4 && ex >= x2 - RESIZE_ZONE)
          return { kind: "resize-end", wordIdx };
        return { kind: "block", wordIdx };
      }
    }
    return { kind: "empty", wordIdx: -1 };
  }

  // ── Eventy ─────────────────────────────────────────────────────────────────

  private attachEvents(): void {
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener("mousemove", (e) => this.onMouseMove(e));
    this.canvas.addEventListener("mouseleave", () => this.onCanvasMouseLeave());
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    // Edytor czasów ma własny stos historii — nie wchodzimy mu w drogę.
    const editor = document.getElementById("editor-modal");
    if (editor?.classList.contains("visible")) return;
    // W polach formularza pozwól na natywne undo przeglądarki.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.code === "KeyZ" && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }
    if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) {
      e.preventDefault();
      this.redo();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();

    const ex = e.offsetX;
    const ey = e.offsetY;
    const hit = this.hitTest(ex, ey);

    // Klik środkowy = pan
    if (e.button === 1) {
      this.canvas.setPointerCapture(e.pointerId);
      this.dragState = { kind: "pan", pointerId: e.pointerId, startClientX: e.clientX, startScrollX: this.scrollX };
      return;
    }

    // Klik w gutter = zaznacz wszystkie słowa (single-rail).
    if (hit.kind === "gutter") {
      if (!e.shiftKey) this.selected.clear();
      for (let i = 0; i < this.words.length; i++) this.selected.add(i);
      this.redraw();
      return;
    }

    if (hit.kind === "resize-start" || hit.kind === "resize-end") {
      this.canvas.setPointerCapture(e.pointerId);
      this.pushHistory();
      const w = this.words[hit.wordIdx]!;
      this.dragState = {
        kind: hit.kind,
        pointerId: e.pointerId,
        idx: hit.wordIdx,
        anchorTime: this.xToTime(ex),
        origStart: w.start_time,
        origEnd: w.end_time,
      };
      return;
    }

    if (hit.kind === "block") {
      // Zaznaczenie
      if (e.shiftKey) {
        if (this.selected.has(hit.wordIdx)) this.selected.delete(hit.wordIdx);
        else this.selected.add(hit.wordIdx);
      } else if (!this.selected.has(hit.wordIdx)) {
        this.selected = new Set([hit.wordIdx]);
      }
      // Snap seek do start_time klikniętego słowa
      this.opts.seekTo(this.words[hit.wordIdx]!.start_time);

      this.canvas.setPointerCapture(e.pointerId);
      this.pushHistory();
      const anchorTime = this.xToTime(ex);
      this.dragState = {
        kind: "move",
        pointerId: e.pointerId,
        anchorTime,
        origStarts: [...this.selected].map((i) => this.words[i]!.start_time),
        origEnds: [...this.selected].map((i) => this.words[i]!.end_time),
      };
      this.redraw();
      return;
    }

    // Puste miejsce = lasso
    if (!e.shiftKey) this.selected.clear();
    this.canvas.setPointerCapture(e.pointerId);
    this.dragState = { kind: "lasso", pointerId: e.pointerId, startX: ex, startY: ey, curX: ex, curY: ey };
    this.redraw();
  }

  private onPointerMove(e: PointerEvent): void {
    const ds = this.dragState;
    if (!ds || e.pointerId !== ds.pointerId) return;
    e.preventDefault();

    const ex = e.offsetX;

    if (ds.kind === "pan") {
      const dx = e.clientX - ds.startClientX;
      this.scrollX = Math.max(0, ds.startScrollX - dx / this.zoom);
      this.setCanvasCursorFromDrag(ds);
      this.redraw();
      return;
    }

    if (ds.kind === "lasso") {
      ds.curX = ex;
      ds.curY = e.offsetY;
      this.setCanvasCursorFromDrag(ds);
      this.redraw();
      return;
    }

    const curTime = this.xToTime(ex);
    const duration = this.opts.getDuration();

    if (ds.kind === "move") {
      const delta = curTime - ds.anchorTime;
      const selArr = [...this.selected];
      for (let k = 0; k < selArr.length; k++) {
        const i = selArr[k]!;
        const w = this.words[i]!;
        const newStart = Math.max(0, Math.min(duration - MIN_BLOCK_DUR, ds.origStarts[k]! + delta));
        const newEnd = Math.max(0, Math.min(duration, ds.origEnds[k]! + delta));
        w.start_time = newStart;
        w.end_time = newEnd;
      }
      this.setCanvasCursorFromDrag(ds);
      this.redraw();
      return;
    }

    if (ds.kind === "resize-start") {
      const w = this.words[ds.idx]!;
      w.start_time = Math.max(0, Math.min(ds.origEnd - MIN_BLOCK_DUR, curTime));
      this.setCanvasCursorFromDrag(ds);
      this.redraw();
      return;
    }

    if (ds.kind === "resize-end") {
      const w = this.words[ds.idx]!;
      w.end_time = Math.max(ds.origStart + MIN_BLOCK_DUR, Math.min(duration, curTime));
      this.setCanvasCursorFromDrag(ds);
      this.redraw();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const ds = this.dragState;
    if (!ds || e.pointerId !== ds.pointerId) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}

    if (ds.kind === "lasso") {
      this.finalizeLasso(ds);
    } else if (ds.kind === "move" || ds.kind === "resize-start" || ds.kind === "resize-end") {
      this.opts.onWordsChanged(this.getWords());
    }
    this.dragState = null;
    this.setCanvasCursorFromHit(this.hitTest(e.offsetX, e.offsetY), e.offsetY);
    this.redraw();
  }

  private finalizeLasso(ds: Extract<DragState, { kind: "lasso" }>): void {
    const x1 = Math.min(ds.startX, ds.curX);
    const x2 = Math.max(ds.startX, ds.curX);
    const y1 = Math.min(ds.startY, ds.curY);
    const y2 = Math.max(ds.startY, ds.curY);

    const rowY = this.lineRowY(0);
    if (rowY + TRACK_H >= y1 && rowY <= y2) {
      for (let wordIdx = 0; wordIdx < this.words.length; wordIdx++) {
        const word = this.words[wordIdx]!;
        const wx1 = this.timeToX(word.start_time);
        const wx2 = this.timeToX(word.end_time);
        if (wx2 >= x1 && wx1 <= x2) {
          this.selected.add(wordIdx);
        }
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const ex = e.offsetX;
    const tAtCursor = this.xToTime(ex);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.scrollX = Math.max(0, tAtCursor - (ex - GUTTER_W) / this.zoom);
    this.redraw();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragState) {
      this.setCanvasCursorFromHit(this.hitTest(e.offsetX, e.offsetY), e.offsetY);
    }
    const t = this.xToTime(e.offsetX);
    if (e.offsetX < GUTTER_W) {
      this.tooltip.classList.remove("visible");
      return;
    }
    const wrapper = this.canvas.parentElement!;
    const wrapRect = wrapper.getBoundingClientRect();
    this.tooltip.textContent = this.formatTimePrecise(t);
    this.tooltip.style.left = `${e.clientX - wrapRect.left}px`;
    this.tooltip.classList.add("visible");
  }

  // ── Formatowanie czasu ─────────────────────────────────────────────────────

  private formatTime(s: number): string {
    if (s < 0) s = 0;
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return s < 60
      ? `${ss}.${String(Math.round((s % 1) * 10))}`
      : `${m}:${String(ss).padStart(2, "0")}`;
  }

  private formatTimePrecise(s: number): string {
    if (s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 1000);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }
}
