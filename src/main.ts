import { parseAlignmentJson, type AlignedWord, type AlignmentPayload } from "./alignment";
import { LyricPlane, type LyricVizMode, DEFAULT_VIZ_SETTINGS } from "./visualizer";
import {
  deleteProject,
  getProject,
  listProjects,
  newProjectId,
  pickAudioFile,
  saveProject,
  updateProjectLyrics,
  type UserProject,
} from "./projects";
import { openTimingEditor } from "./editor";
import { openLiveTap, type LiveTapHandle } from "./livetap";
import { LyricTimeline } from "./timeline";
import { transcribeWithWhisper, getWhisperUrl, saveWhisperUrl } from "./whisper-client";
import { alignWhisperToLyrics } from "./fuzzy-align";

interface BuiltinProject {
  name: string;
  jsonUrl: string;
  audioUrl?: string;
}

const BUILTIN_PROJECTS: Record<string, BuiltinProject> = {
  sample_sonauto: {
    name: "Sample Sonauto",
    jsonUrl: "/fixtures/sample_sonauto.json",
    audioUrl: "/fixtures/sample_sonauto.mp3",
  },
  aligned: {
    name: "Aligned (mock)",
    jsonUrl: "/fixtures/aligned.json",
    audioUrl: undefined,
  },
};

/**
 * Czysty tekst → tablica słów bez timingów (start/end = 0).
 * Reguły podziału:
 *   • każda nowa linia (`\n`) → line_break na ostatnim słowie poprzedniej linii
 *   • pusta linia → blank_line na ostatnim słowie poprzedniej linii (wizualny odstęp,
 *     NIE tworzy verse_break; wielokrotne puste linie są idempotentne)
 *   • nagłówek `[Chorus]`, `[Verse 1]`, `[Bridge]` itp. → verse_break (jedyne źródło zwrotek)
 *   • fallback: gdy w wejściu nie ma `\n`, `, ` traktowane jest jako koniec linii
 */
function textToUnalignedWords(text: string): AlignedWord[] {
  const out: AlignedWord[] = [];
  let normalized = text;
  if (!/\r?\n/.test(text)) {
    normalized = text.replace(/\s*,\s+/g, "\n");
  }
  const rawLines = normalized.split(/\r?\n/);
  let pendingVerseBreak = false;

  for (const raw of rawLines) {
    const line = raw.trim();
    if (line.length === 0) {
      // Pusta linia: oznacz blank_line na ostatnim słowie (wizualny odstęp).
      // Verse_break powstaje TYLKO z nagłówka [..].
      if (out.length > 0) out[out.length - 1]!.blank_line = true;
      continue;
    }
    if (/^\[.+\]$/.test(line)) {
      if (out.length > 0) pendingVerseBreak = true;
      continue;
    }

    if (out.length > 0) {
      const last = out[out.length - 1]!;
      if (pendingVerseBreak) {
        last.verse_break = true;
        delete last.line_break;
      } else {
        last.line_break = true;
      }
    }
    pendingVerseBreak = false;

    const words = line.split(/\s+/).filter((w) => w.length > 0);
    for (const w of words) {
      out.push({ word: w, start_time: 0, end_time: 0 });
    }
  }

  return out;
}

/** Rozkłada start/end_time równomiernie na całą długość audio (jak przycisk autofill). */
function distributeWordsEvenly(words: AlignedWord[], duration: number): void {
  const slots = words.filter((w) => w.kind !== "label").length;
  if (slots === 0 || !Number.isFinite(duration) || duration <= 0) return;
  const step = duration / slots;
  const gap = step * 0.1;
  let k = 0;
  for (const w of words) {
    if (w.kind === "label") continue;
    w.start_time = Math.round(k * step * 1000) / 1000;
    w.end_time = Math.round(((k + 1) * step - gap) * 1000) / 1000;
    k++;
  }
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function formatTimePrecise(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

const projectPickerDateFmt = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "short",
  timeStyle: "short",
});

function formatBlobSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function userProjectWordCount(p: UserProject): number {
  if (p.lyricsKind === "json") return p.alignedLyrics?.length ?? 0;
  return p.rawLyrics?.split(/\s+/).filter(Boolean).length ?? 0;
}

function countSectionLabels(words: AlignedWord[] | undefined): number {
  if (!words) return 0;
  let n = 0;
  for (const w of words) {
    if (w.kind === "label") n++;
  }
  return n;
}

async function loadAlignment(url: string): Promise<AlignmentPayload> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nie udało się wczytać ${url}: ${res.status}`);
  return parseAlignmentJson(await res.text());
}

function main(): void {
  const app = document.getElementById("app")!;
  const projectsDiv = document.getElementById("projects")!;
  const hud = document.getElementById("hud")!;
  const modeLabel = document.getElementById("mode-label")!;
  const btnPlay = document.getElementById("btn-play") as HTMLButtonElement;
  const btnPause = document.getElementById("btn-pause") as HTMLButtonElement;
  const btnStop = document.getElementById("btn-stop") as HTMLButtonElement;
  const btnBack = document.getElementById("btn-back") as HTMLButtonElement;
  const audioInput = document.getElementById("audio-file") as HTMLInputElement;
  const jsonInput = document.getElementById("json-file") as HTMLInputElement;
  const hudPickAudio = document.getElementById("hud-pick-audio") as HTMLButtonElement;
  const hudAudioName = document.getElementById("hud-audio-name")!;
  const hudPickJson = document.getElementById("hud-pick-json") as HTMLButtonElement;
  const hudJsonName = document.getElementById("hud-json-name")!;
  const timeDisplay = document.getElementById("time-display")!;
  const waveformWrapper = document.getElementById("waveform-wrapper")!;
  const waveformPlayhead = document.getElementById("waveform-playhead")!;
  const waveformTooltip = document.getElementById("waveform-tooltip")!;
  const waveformLoop = document.getElementById("waveform-loop")!;
  const waveformLoopClear = document.getElementById("waveform-loop-clear") as HTMLButtonElement;
  const timeCurrent = document.getElementById("time-current")!;
  const timeTotal = document.getElementById("time-total")!;
  const miniVisualizer = document.getElementById("mini-visualizer") as HTMLCanvasElement;
  const staticWaveformCanvas = document.getElementById("static-waveform") as HTMLCanvasElement;
  const waveformCanvasWrap = document.getElementById("waveform-canvas-wrap")!;
  const btnWaveformSync = document.getElementById("btn-waveform-sync") as HTMLButtonElement;
  const btnWaveformZoomAll = document.getElementById("btn-waveform-zoom-all") as HTMLButtonElement;
  const waveformMinimap = document.getElementById("waveform-minimap")!;
  const waveformMinimapViewport = document.getElementById("waveform-minimap-viewport")!;
  const waveformMinimapPlayhead = document.getElementById("waveform-minimap-playhead")!;
  const vizModeSelect = document.getElementById("viz-mode") as HTMLSelectElement;
  const projectsList = document.getElementById("projects-list")!;
  const btnEditTiming = document.getElementById("btn-edit-timing") as HTMLButtonElement;
  const btnLiveTap = document.getElementById("btn-livetap") as HTMLButtonElement;
  const volumeSlider = document.getElementById("volume-slider") as HTMLInputElement;
  const volumeLabel = document.getElementById("volume-label")!;

  /** Aktualnie wczytany projekt użytkownika (null dla wbudowanych lub gdy nic nie wczytane). */
  let currentUserProjectId: string | null = null;
  /** Nazwa do nazwy pliku JSON przy pobieraniu z edytora. */
  let currentProjectName = "aligned";

  // ── New-project modal refs ───────────────────────────────────────────
  const modal = document.getElementById("project-modal")!;
  const npName = document.getElementById("np-name") as HTMLInputElement;
  const npPickAudio = document.getElementById("np-pick-audio") as HTMLButtonElement;
  const npAudioStatus = document.getElementById("np-audio-status")!;
  const npTabJson = document.getElementById("np-tab-json") as HTMLButtonElement;
  const npTabText = document.getElementById("np-tab-text") as HTMLButtonElement;
  const npPaneJson = document.getElementById("np-pane-json")!;
  const npPaneText = document.getElementById("np-pane-text")!;
  const npJsonFile = document.getElementById("np-json-file") as HTMLInputElement;
  const npPickJson = document.getElementById("np-pick-json") as HTMLButtonElement;
  const npJsonName = document.getElementById("np-json-name")!;
  const npJsonStatus = document.getElementById("np-json-status")!;
  const npText = document.getElementById("np-text") as HTMLTextAreaElement;
  const npCancel = document.getElementById("np-cancel") as HTMLButtonElement;
  const npSave = document.getElementById("np-save") as HTMLButtonElement;
  const npError = document.getElementById("np-error")!;

  const viz = new LyricPlane(app);

  // ── Viz settings panel ──────────────────────────────────────────────
  const vizSettingsPanel = document.getElementById("viz-settings-panel")!;
  const btnVizSettings = document.getElementById("btn-viz-settings") as HTMLButtonElement;
  const vsFontSize = document.getElementById("vs-font-size") as HTMLInputElement;
  const vsFontSizeVal = document.getElementById("vs-font-size-val")!;
  const vsActiveColor = document.getElementById("vs-active-color") as HTMLInputElement;
  const vsInactiveColor = document.getElementById("vs-inactive-color") as HTMLInputElement;
  const vsBgColor = document.getElementById("vs-bg-color") as HTMLInputElement;
  const btnVsReset = document.getElementById("btn-vs-reset") as HTMLButtonElement;

  const VIZ_SETTINGS_KEY = "viz-settings";

  function loadVizSettings(): void {
    try {
      const raw = localStorage.getItem(VIZ_SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<typeof DEFAULT_VIZ_SETTINGS>;
      if (typeof s.fontSize === "number") {
        vsFontSize.value = String(s.fontSize);
        vsFontSizeVal.textContent = String(s.fontSize);
      }
      if (s.activeColor) vsActiveColor.value = s.activeColor;
      if (s.inactiveColor) vsInactiveColor.value = s.inactiveColor;
      if (s.bgColor) vsBgColor.value = s.bgColor;
      viz.setSettings(s);
    } catch {}
  }

  function saveVizSettings(): void {
    localStorage.setItem(VIZ_SETTINGS_KEY, JSON.stringify(viz.getSettings()));
  }

  function applyVizSettings(): void {
    const fontSize = parseInt(vsFontSize.value, 10);
    vsFontSizeVal.textContent = String(fontSize);
    viz.setSettings({
      fontSize,
      activeColor: vsActiveColor.value,
      inactiveColor: vsInactiveColor.value,
      bgColor: vsBgColor.value,
    });
    saveVizSettings();
  }

  vsFontSize.addEventListener("input", applyVizSettings);
  vsActiveColor.addEventListener("input", applyVizSettings);
  vsInactiveColor.addEventListener("input", applyVizSettings);
  vsBgColor.addEventListener("input", applyVizSettings);

  btnVsReset.addEventListener("click", () => {
    const d = DEFAULT_VIZ_SETTINGS;
    vsFontSize.value = String(d.fontSize);
    vsFontSizeVal.textContent = String(d.fontSize);
    vsActiveColor.value = d.activeColor;
    vsInactiveColor.value = d.inactiveColor;
    vsBgColor.value = d.bgColor;
    viz.setSettings({ ...d });
    saveVizSettings();
  });

  btnVizSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    vizSettingsPanel.classList.toggle("open");
    positionVizSettingsPanel();
  });

  document.addEventListener("click", (e) => {
    if (!vizSettingsPanel.contains(e.target as Node) && e.target !== btnVizSettings) {
      vizSettingsPanel.classList.remove("open");
    }
  });

  function positionVizSettingsPanel(): void {
    const hudRect = hud.getBoundingClientRect();
    vizSettingsPanel.style.bottom = `${window.innerHeight - hudRect.top + 8}px`;
  }

  function updateVizMargin(): void {
    if (hud.classList.contains("hidden")) {
      viz.setBottomMargin(0);
      return;
    }
    const hudRect = hud.getBoundingClientRect();
    viz.setBottomMargin(window.innerHeight - hudRect.top + 8);
    positionVizSettingsPanel();
  }

  window.addEventListener("resize", updateVizMargin);

  // Observe HUD size changes (timeline/waveform toggling changes its height)
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(updateVizMargin).observe(hud);
  }

  loadVizSettings();
  // Initial margin will be set after first showHud() call

  const timelineWrapper = document.getElementById("timeline-wrapper") as HTMLDivElement;
  const timeline = new LyricTimeline(timelineWrapper, {
    getCurrentTime: () => audio?.currentTime ?? 0,
    getDuration: () => audio?.duration ?? 0,
    seekTo: (t) => {
      if (!audio) return;
      if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
      audio.currentTime = Math.max(0, t);
      updateTimeline();
    },
    onWordsChanged: (updatedWords) => {
      alignment = { aligned_lyrics: updatedWords };
      viz.setAlignedLyrics(updatedWords);
      if (currentUserProjectId) {
        void updateProjectLyrics(currentUserProjectId, updatedWords);
      }
    },
  });

  /** Ref do przewijania edytora z kliknięcia w wizualizatorze. */
  const editorSelectRef: { scrollTo: ((idx: number) => void) | null } = { scrollTo: null };
  /** Ref do wstrzykiwania sugestii Whisper do edytora. */
  const editorSuggestionsRef: { apply: ((s: AlignedWord[] | null) => void) | null } = { apply: null };

  viz.onWordClick = (idx) => editorSelectRef.scrollTo?.(idx);

  let alignment: AlignmentPayload | null = null;
  let audio: HTMLAudioElement | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let mediaSource: MediaElementAudioSourceNode | null = null;
  let gainNode: GainNode | null = null;
  /** `createMediaElementSource` można wywołać tylko raz na element — powtórne `loadedmetadata` psuje graf. */
  let mediaElementWired: HTMLAudioElement | null = null;
  let currentVolume = 1.0;
  let raf = 0;
  let miniVisRaf = 0;
  /** Active loop range in seconds. When set, playback wraps `end → start` in `tick()`. */
  let loopRange: { start: number; end: number } | null = null;

  /** Bufor do ponownego rysowania fali przy zoomie / sync. */
  let waveformAudioBuffer: AudioBuffer | null = null;
  let waveformViewStart = 0;
  let waveformViewEnd = 0;
  const WF_MIN_WINDOW_SEC = 0.05;

  // ── Mini visualizer (top-right, small) ──────────────────────────────
  function drawMiniVisualizer(): void {
    if (!analyser || !miniVisualizer) return;
    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(dataArr);

    const w = miniVisualizer.width = miniVisualizer.offsetWidth * window.devicePixelRatio;
    const h = miniVisualizer.height = miniVisualizer.offsetHeight * window.devicePixelRatio;
    const ctx = miniVisualizer.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);

    const barW = w / bufLen;
    let x = 0;
    ctx.fillStyle = "#3a7aaa";
    for (let i = 0; i < bufLen; i++) {
      const barH = (dataArr[i] / 255) * h;
      const y = h - barH;
      ctx.fillRect(x, y, barW - 0.5, barH);
      x += barW;
    }

    miniVisRaf = requestAnimationFrame(drawMiniVisualizer);
  }

  function stopMiniVisualizer(): void {
    cancelAnimationFrame(miniVisRaf);
    if (miniVisualizer) {
      const ctx = miniVisualizer.getContext("2d");
      ctx?.clearRect(0, 0, miniVisualizer.width, miniVisualizer.height);
    }
  }

  // ── Static waveform from decoded audio ───────────────────────────────
  function getWaveformDurationSec(): number {
    const bd = waveformAudioBuffer?.duration;
    if (bd && bd > 0 && Number.isFinite(bd)) return bd;
    const ad = audio?.duration;
    if (ad && ad > 0 && !Number.isNaN(ad)) return ad;
    return 0;
  }

  function clampWaveformView(): void {
    const d = waveformAudioBuffer?.duration ?? 0;
    if (!d || !Number.isFinite(d) || d <= 0) return;
    let span = waveformViewEnd - waveformViewStart;
    span = Math.max(WF_MIN_WINDOW_SEC, Math.min(span, d));
    waveformViewStart = Math.max(0, Math.min(waveformViewStart, d - span));
    waveformViewEnd = Math.min(d, waveformViewStart + span);
    if (waveformViewEnd - waveformViewStart < WF_MIN_WINDOW_SEC) {
      waveformViewEnd = Math.min(d, waveformViewStart + WF_MIN_WINDOW_SEC);
    }
  }

  function updateWaveformChrome(): void {
    const d = getWaveformDurationSec();
    if (d <= 0) {
      waveformMinimap.classList.remove("visible");
      waveformMinimapPlayhead.classList.remove("visible");
      return;
    }
    const span = waveformViewEnd - waveformViewStart;
    const zoomed =
      waveformAudioBuffer !== null && span > 0 && span < d * 0.98;
    if (zoomed) {
      waveformMinimap.classList.add("visible");
      const leftPct = (waveformViewStart / d) * 100;
      const widthPct = (span / d) * 100;
      waveformMinimapViewport.style.left = `${leftPct}%`;
      waveformMinimapViewport.style.width = `${widthPct}%`;
      if (audio && audio.duration > 0 && !Number.isNaN(audio.duration)) {
        const mp = (audio.currentTime / d) * 100;
        waveformMinimapPlayhead.style.left = `${mp}%`;
        waveformMinimapPlayhead.classList.add("visible");
      } else {
        waveformMinimapPlayhead.classList.remove("visible");
      }
    } else {
      waveformMinimap.classList.remove("visible");
      waveformMinimapPlayhead.classList.remove("visible");
    }

    if (!audio || !audio.duration || audio.duration <= 0 || Number.isNaN(audio.duration)) return;
    const t = audio.currentTime;
    if (span <= 0 || t < waveformViewStart - 1e-6 || t > waveformViewEnd + 1e-6) {
      waveformPlayhead.classList.remove("visible");
    } else {
      const p = ((t - waveformViewStart) / span) * 100;
      waveformPlayhead.style.left = `${p}%`;
      waveformPlayhead.classList.add("visible");
    }
  }

  function clearWaveformStorage(): void {
    waveformAudioBuffer = null;
    waveformViewStart = 0;
    waveformViewEnd = 0;
    waveformMinimap.classList.remove("visible");
    waveformMinimapPlayhead.classList.remove("visible");
    const ctx = staticWaveformCanvas.getContext("2d");
    if (ctx && staticWaveformCanvas.width > 0 && staticWaveformCanvas.height > 0) {
      ctx.clearRect(0, 0, staticWaveformCanvas.width, staticWaveformCanvas.height);
    }
  }

  async function redrawStaticWaveform(): Promise<void> {
    const audioBuffer = waveformAudioBuffer;
    if (!audioBuffer) return;
    clampWaveformView();

    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const canvas = staticWaveformCanvas;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width = Math.max(1, canvas.offsetWidth * window.devicePixelRatio);
    const h = canvas.height = Math.max(1, canvas.offsetHeight * window.devicePixelRatio);
    ctx.clearRect(0, 0, w, h);

    const data = audioBuffer.getChannelData(0);
    const sr = audioBuffer.sampleRate;
    const total = audioBuffer.length;
    const dur = audioBuffer.duration;
    const t0 = Math.max(0, Math.min(waveformViewStart, dur - 1e-9));
    const t1 = Math.max(t0 + 1e-6, Math.min(waveformViewEnd, dur));
    let i0 = Math.floor(t0 * sr);
    let i1 = Math.ceil(t1 * sr);
    i0 = Math.max(0, Math.min(i0, Math.max(0, total - 1)));
    i1 = Math.max(i0 + 1, Math.min(i1, total));
    const sliceLen = i1 - i0;
    const amp = h / 2;

    ctx.fillStyle = "#2a4a6a";
    for (let x = 0; x < w; x++) {
      let min = 1.0, max = -1.0;
      const frac0 = x / w;
      const frac1 = (x + 1) / w;
      let s0 = Math.floor(i0 + frac0 * sliceLen);
      let s1 = Math.floor(i0 + frac1 * sliceLen);
      if (s1 <= s0) s1 = s0 + 1;
      s1 = Math.min(s1, i1);
      for (let j = s0; j < s1; j++) {
        const datum = data[j] ?? 0;
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      const y1 = (1 - max) * amp;
      const y2 = (1 - min) * amp;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    drawTimeAxis(ctx, w, h, t0, t1);
    updateWaveformChrome();
    applyLoopOverlay();
  }

  async function setWaveformFromBuffer(audioBuffer: AudioBuffer): Promise<void> {
    waveformAudioBuffer = audioBuffer;
    const d = audioBuffer.duration;
    waveformViewStart = 0;
    waveformViewEnd = d > 0 && Number.isFinite(d) ? d : 1;
    await redrawStaticWaveform();
  }

  /** Subtle time axis: thin tick marks along the bottom + sparse labels (zakres [t0, t1] w sekundach). */
  function drawTimeAxis(ctx: CanvasRenderingContext2D, w: number, h: number, t0: number, t1: number): void {
    const visibleDur = t1 - t0;
    if (!visibleDur || !Number.isFinite(visibleDur) || visibleDur <= 0) return;

    const candidates = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const targetLabels = 8;
    let interval = candidates[candidates.length - 1]!;
    for (const c of candidates) {
      if (visibleDur / c <= targetLabels) {
        interval = c;
        break;
      }
    }
    const minorInterval = interval / (interval >= 10 ? 5 : interval >= 1 ? 5 : 2);

    const dpr = window.devicePixelRatio;
    ctx.save();

    ctx.strokeStyle = "rgba(180, 200, 220, 0.08)";
    ctx.lineWidth = 1;
    const tMinor0 = Math.ceil(t0 / minorInterval) * minorInterval;
    for (let t = tMinor0; t <= t1 + 1e-9; t += minorInterval) {
      const x = Math.round(((t - t0) / visibleDur) * w) + 0.5;
      if (x < 0 || x > w) continue;
      ctx.beginPath();
      ctx.moveTo(x, h - 4 * dpr);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(180, 200, 220, 0.22)";
    ctx.fillStyle = "rgba(180, 200, 220, 0.45)";
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = "bottom";
    const tMajor0 = Math.ceil(t0 / interval) * interval;
    for (let t = tMajor0; t <= t1 + 1e-9; t += interval) {
      const x = Math.round(((t - t0) / visibleDur) * w) + 0.5;
      if (x < 0 || x > w) continue;
      ctx.beginPath();
      ctx.moveTo(x, h - 8 * dpr);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (t > t0 + 1e-9) {
        ctx.fillText(formatTime(t), x + 2 * dpr, h - 2 * dpr);
      }
    }

    ctx.restore();
  }

  // ── Web Audio setup (for live visualizer) ───────────────────────────
  function teardownAudio(): void {
    cancelAnimationFrame(miniVisRaf);
    if (analyser) { try { analyser.disconnect(); } catch {} }
    if (gainNode) { try { gainNode.disconnect(); } catch {} }
    if (mediaSource) { try { mediaSource.disconnect(); } catch {} }
    if (audioCtx && audioCtx.state !== "closed") { audioCtx.close().catch(() => {}); }
    analyser = null;
    gainNode = null;
    mediaSource = null;
    audioCtx = null;
    mediaElementWired = null;
    stopMiniVisualizer();
  }

  async function setupAudioWithVisualizer(audioEl: HTMLAudioElement): Promise<void> {
    if (
      mediaElementWired === audioEl &&
      audioCtx &&
      mediaSource &&
      audioCtx.state !== "closed"
    ) {
      void audioCtx.resume();
      return;
    }
    teardownAudio();
    try {
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      gainNode = audioCtx.createGain();
      gainNode.gain.value = currentVolume;
      mediaSource = audioCtx.createMediaElementSource(audioEl);
      mediaElementWired = audioEl;
      mediaSource.connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      void audioCtx.resume();
      drawMiniVisualizer();
    } catch (e) {
      console.warn("Audio setup failed:", e);
      mediaElementWired = null;
    }
  }

  // ── Load audio file → decode → static waveform ──────────────────────
  async function loadAudioFile(file: File): Promise<void> {
    teardownAudio();
    clearWaveformStorage();

    audio = new Audio();
    audio.preload = "auto";
    audio.addEventListener("loadedmetadata", () => {
      setupAudioWithVisualizer(audio!);
      updateTimeline();
    });
    audio.addEventListener("timeupdate", updateTimeline);
    audio.src = URL.createObjectURL(file);

    showTimeline();

    const ctx2 = new AudioContext();
    try {
      const buf = await file.arrayBuffer();
      const audioBuffer = await ctx2.decodeAudioData(buf);
      await setWaveformFromBuffer(audioBuffer);
    } catch (e) {
      console.warn("Static waveform decode failed:", e);
    } finally {
      await ctx2.close();
    }

    modeLabel.textContent = "Wczytano: " + file.name;
  }

  // ── Load project audio (via fetch → blob → Audio element) ──────────
  async function loadProjectAudio(url: string): Promise<void> {
    teardownAudio();
    clearWaveformStorage();

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Nie udało się pobrać audio: ${res.status}`);

    const blob = await res.blob();
    const file = new File([blob], "audio.mp3", { type: blob.type });

    audio = new Audio();
    audio.preload = "auto";
    audio.addEventListener("loadedmetadata", () => {
      setupAudioWithVisualizer(audio!);
      updateTimeline();
    });
    audio.addEventListener("timeupdate", updateTimeline);
    audio.src = URL.createObjectURL(blob);

    showTimeline();

    const ctx2 = new AudioContext();
    try {
      const buf = await file.arrayBuffer();
      const audioBuffer = await ctx2.decodeAudioData(buf);
      await setWaveformFromBuffer(audioBuffer);
    } catch (e) {
      console.warn("Static waveform decode failed:", e);
    } finally {
      await ctx2.close();
    }
  }

  // ── UI helpers ──────────────────────────────────────────────────────
  let editorHandle: { close(): boolean } | null = null;

  function showProjects(): void {
    if (editorHandle && !editorHandle.close()) return;
    editorHandle = null;
    cancelAnimationFrame(raf);
    alignment = null;
    currentUserProjectId = null;
    currentProjectName = "aligned";
    projectsDiv.classList.add("visible");
    hud.classList.add("hidden");
    miniVisualizer.classList.remove("active");
    hideTimeline();
    viz.setBottomMargin(0);
    if (audio) { audio.pause(); }
    teardownAudio();
    viz.setAlignedLyrics([]);
  }

  function showHud(): void {
    projectsDiv.classList.remove("visible");
    hud.classList.remove("hidden");
    miniVisualizer.classList.add("active");
    // Defer margin calculation until HUD finishes layout
    requestAnimationFrame(updateVizMargin);
  }

  function showTimeline(): void {
    timeDisplay.classList.add("visible");
    waveformWrapper.classList.add("visible");
    if (alignment && alignment.aligned_lyrics.length > 0) {
      timelineWrapper.classList.add("visible");
    }
  }

  function hideTimeline(): void {
    timeDisplay.classList.remove("visible");
    waveformWrapper.classList.remove("visible");
    timelineWrapper.classList.remove("visible");
    waveformPlayhead.classList.remove("visible");
    waveformTooltip.classList.remove("visible");
    clearLoop();
    clearWaveformStorage();
  }

  function updateTimeline(): void {
    if (!audio || !audio.duration || Number.isNaN(audio.duration)) return;
    timeCurrent.textContent = formatTime(audio.currentTime);
    timeTotal.textContent = formatTime(audio.duration);
    updateWaveformChrome();
  }

  // ── Main render loop ────────────────────────────────────────────────
  const tick = (): void => {
    if (!alignment) return;
    let t = 0;
    if (audio && audio.duration > 0 && !Number.isNaN(audio.duration)) {
      if (loopRange && !audio.paused && audio.currentTime >= loopRange.end) {
        audio.currentTime = loopRange.start;
      }
      t = audio.currentTime;
      updateWaveformChrome();
    }
    viz.tick(t);
    timeline.setPlayhead(t);
    raf = requestAnimationFrame(tick);
  };

  function startLoop(): void {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function setLyrics(words: AlignedWord[]): void {
    viz.setAlignedLyrics(words);
    timeline.setWords(words);
    if (words.length > 0) timelineWrapper.classList.add("visible");
  }

  // ── Project picker rendering ─────────────────────────────────────────
  function appendProjectsSectionTitle(label: string): void {
    const h = document.createElement("h2");
    h.className = "projects-section-title";
    h.textContent = label;
    projectsList.appendChild(h);
  }

  async function renderProjectPicker(): Promise<void> {
    projectsList.innerHTML = "";

    appendProjectsSectionTitle("Przykłady (wbudowane)");
    for (const [id, p] of Object.entries(BUILTIN_PROJECTS)) {
      const row = document.createElement("div");
      row.className = "project-row project-row-builtin";

      const openBtn = document.createElement("button");
      openBtn.className = "project-card-main";
      openBtn.type = "button";
      const titleEl = document.createElement("span");
      titleEl.className = "project-card-title";
      titleEl.textContent = p.name;
      openBtn.appendChild(titleEl);
      const subEl = document.createElement("span");
      subEl.className = "project-card-line project-card-line-sub";
      subEl.textContent = p.audioUrl
        ? `Fixture · ${p.jsonUrl}`
        : `Fixture · ${p.jsonUrl} · bez domyślnego audio`;
      openBtn.appendChild(subEl);
      openBtn.addEventListener("click", () => void loadBuiltinProject(id));
      row.appendChild(openBtn);
      projectsList.appendChild(row);
    }

    appendProjectsSectionTitle("Twoje projekty");
    let userProjects: UserProject[] = [];
    try {
      userProjects = await listProjects();
    } catch (e) {
      console.warn("Nie udało się wczytać projektów użytkownika:", e);
    }
    if (userProjects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "projects-empty-hint";
      empty.textContent = "Nie masz jeszcze zapisanych projektów — utwórz pierwszy poniżej.";
      projectsList.appendChild(empty);
    }
    for (const p of userProjects) {
      const row = document.createElement("div");
      row.className = "project-row";

      const openBtn = document.createElement("button");
      openBtn.className = "project-card-main";
      openBtn.type = "button";

      const titleEl = document.createElement("span");
      titleEl.className = "project-card-title";
      titleEl.textContent = p.name;
      openBtn.appendChild(titleEl);

      const metaWrap = document.createElement("div");
      metaWrap.className = "project-card-meta";

      const lineChips = document.createElement("div");
      lineChips.className = "project-card-line";
      const chip = document.createElement("span");
      chip.className = p.lyricsKind === "json" ? "meta-chip meta-chip-json" : "meta-chip meta-chip-text";
      chip.textContent = p.lyricsKind === "json" ? "JSON" : "Tekst";
      lineChips.appendChild(chip);
      const wordsN = userProjectWordCount(p);
      lineChips.appendChild(document.createTextNode(` ${wordsN} słów`));
      const labelN = countSectionLabels(p.alignedLyrics);
      if (labelN > 0) {
        lineChips.appendChild(document.createTextNode(` · ${labelN} etykiet sekcji`));
      }
      metaWrap.appendChild(lineChips);

      const lineFile = document.createElement("div");
      lineFile.className = "project-card-line project-card-line-file";
      const fileSpan = document.createElement("span");
      fileSpan.className = "project-card-filename";
      fileSpan.textContent = p.audioFileName;
      fileSpan.title = p.audioFileName;
      lineFile.appendChild(fileSpan);
      lineFile.appendChild(document.createTextNode(` · ${formatBlobSize(p.audioBlob.size)}`));
      metaWrap.appendChild(lineFile);

      const lineDates = document.createElement("div");
      lineDates.className = "project-card-line project-card-line-dates";
      const updatedPart =
        p.updatedAt != null
          ? ` · ostatnia edycja: ${projectPickerDateFmt.format(new Date(p.updatedAt))}`
          : " · ostatnia edycja: —";
      lineDates.textContent =
        `Utworzono: ${projectPickerDateFmt.format(new Date(p.createdAt))}` + updatedPart;
      metaWrap.appendChild(lineDates);

      openBtn.appendChild(metaWrap);
      openBtn.addEventListener("click", () => void loadUserProject(p.id));
      row.appendChild(openBtn);

      const del = document.createElement("button");
      del.className = "project-delete";
      del.type = "button";
      del.title = "Usuń projekt";
      del.textContent = "Usuń";
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Usunąć projekt „${p.name}"?`)) return;
        await deleteProject(p.id);
        void renderProjectPicker();
      });
      row.appendChild(del);

      projectsList.appendChild(row);
    }

    const newRow = document.createElement("div");
    newRow.className = "project-row";
    const newBtn = document.createElement("button");
    newBtn.className = "project-card-new";
    newBtn.type = "button";
    newBtn.textContent = "+ Nowy projekt";
    newBtn.addEventListener("click", openProjectModal);
    newRow.appendChild(newBtn);
    projectsList.appendChild(newRow);
  }

  btnBack.addEventListener("click", showProjects);

  btnEditTiming.addEventListener("click", () => {
    if (!alignment) return;
    editorHandle = openTimingEditor({
      initialWords: alignment.aligned_lyrics,
      projectName: currentProjectName,
      getCurrentTime: () => audio?.currentTime ?? 0,
      getDuration: () => audio?.duration ?? 0,
      seekTo: (t) => {
        if (!audio) return;
        resumeAudioIfNeeded();
        audio.currentTime = Math.max(0, t);
        updateTimeline();
      },
      onLiveUpdate: (words) => {
        alignment = { aligned_lyrics: words };
        viz.setAlignedLyrics(words);
      },
      onSave: async (words) => {
        alignment = { aligned_lyrics: words };
        setLyrics(words);
        if (currentUserProjectId) {
          await updateProjectLyrics(currentUserProjectId, words);
        }
      },
      onSelectionChange: (indices) => viz.setSelection(indices),
      externalSelectRef: editorSelectRef,
      suggestionsRef: editorSuggestionsRef,
      onWhisperRequest: () => void runWhisper(),
    });
  });

  let liveTap: LiveTapHandle | null = null;
  btnLiveTap.addEventListener("click", () => {
    if (!alignment || !audio) return;
    if (liveTap?.isOpen()) { liveTap.close(); liveTap = null; return; }
    resumeAudioIfNeeded();
    liveTap = openLiveTap({
      initialWords: alignment.aligned_lyrics,
      getCurrentTime: () => audio?.currentTime ?? 0,
      getDuration: () => audio?.duration ?? 0,
      seekTo: (t) => {
        if (!audio) return;
        resumeAudioIfNeeded();
        audio.currentTime = Math.max(0, t);
        updateTimeline();
      },
      play: () => {
        if (!audio) return;
        resumeAudioIfNeeded();
        void audio.play().catch(() => {});
      },
      pause: () => { audio?.pause(); },
      isPlaying: () => !!audio && !audio.paused,
      setPlaybackRate: (r) => { if (audio) audio.playbackRate = r; },
      onLiveUpdate: (words) => {
        alignment = { aligned_lyrics: words };
        viz.setAlignedLyrics(words);
        if (currentUserProjectId) {
          void updateProjectLyrics(currentUserProjectId, words);
        }
      },
      onSave: async (words) => {
        alignment = { aligned_lyrics: words };
        setLyrics(words);
        if (currentUserProjectId) {
          await updateProjectLyrics(currentUserProjectId, words);
        }
      },
    });
  });

  vizModeSelect.addEventListener("change", () => {
    const v = vizModeSelect.value as LyricVizMode;
    if (v === "multiline" || v === "rail" || v === "full") viz.setMode(v);
  });

  btnPlay.addEventListener("click", () => {
    if (!audio) return;
    if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
    void audio.play().catch(() => {});
  });

  btnPause.addEventListener("click", () => { audio?.pause(); });

  btnStop.addEventListener("click", () => {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    updateTimeline();
  });

  volumeSlider.addEventListener("input", () => {
    const v = parseFloat(volumeSlider.value);
    currentVolume = v;
    if (gainNode) gainNode.gain.value = v;
    volumeLabel.textContent = Math.round(v * 100) + "%";
  });

  hudPickAudio.addEventListener("click", () => audioInput.click());
  hudPickJson.addEventListener("click", () => jsonInput.click());

  audioInput.addEventListener("change", () => {
    const f = audioInput.files?.[0];
    if (!f) return;
    hudAudioName.textContent = f.name;
    void loadAudioFile(f);
  });

  jsonInput.addEventListener("change", async () => {
    const f = jsonInput.files?.[0];
    if (!f) return;
    hudJsonName.textContent = f.name;
    try {
      const text = await f.text();
      alignment = parseAlignmentJson(text);
      setLyrics(alignment.aligned_lyrics);
      modeLabel.textContent = `Wczytano: ${f.name} (${alignment.aligned_lyrics.length} słów)`;
      startLoop();
    } catch (e) {
      modeLabel.textContent = `Błąd JSON: ${e}`;
    }
  });

  function resumeAudioIfNeeded(): void {
    if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
  }

  function seekFromRatio(ratio: number): void {
    const d = getWaveformDurationSec();
    if (!audio || !d || Number.isNaN(d)) return;
    clampWaveformView();
    const span = waveformViewEnd - waveformViewStart;
    if (span <= 0) return;
    const r = Math.min(1, Math.max(0, ratio));
    resumeAudioIfNeeded();
    audio.currentTime = Math.max(0, Math.min(d - 1e-6, waveformViewStart + r * span));
    updateTimeline();
  }

  function clearLoop(): void {
    loopRange = null;
    waveformLoop.classList.remove("visible");
    waveformLoopClear.classList.remove("visible");
  }

  function applyLoopOverlay(): void {
    if (!loopRange || !audio || !audio.duration || Number.isNaN(audio.duration)) return;
    const d = getWaveformDurationSec();
    if (!d) return;
    clampWaveformView();
    const span = waveformViewEnd - waveformViewStart;
    if (span <= 0) return;
    const vs = waveformViewStart;
    const a = Math.max(loopRange.start, vs);
    const b = Math.min(loopRange.end, waveformViewEnd);
    if (b <= a + 1e-9) {
      waveformLoop.classList.remove("visible");
      waveformLoopClear.classList.remove("visible");
      return;
    }
    const startPct = ((a - vs) / span) * 100;
    const widthPct = ((b - a) / span) * 100;
    waveformLoop.style.left = `${startPct}%`;
    waveformLoop.style.width = `${widthPct}%`;
    waveformLoop.classList.add("visible");
    waveformLoopClear.classList.add("visible");
  }

  waveformLoopClear.addEventListener("click", clearLoop);

  // Drag-or-click on waveform: drag past threshold = loop selection, otherwise seek.
  const DRAG_PX = 4;
  let pressState: { startX: number; startRatio: number; dragging: boolean; pointerId: number } | null = null;

  staticWaveformCanvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!audio || !audio.duration || Number.isNaN(audio.duration)) return;
    const rect = staticWaveformCanvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    pressState = { startX: e.clientX, startRatio: ratio, dragging: false, pointerId: e.pointerId };
    staticWaveformCanvas.setPointerCapture(e.pointerId);
  });

  staticWaveformCanvas.addEventListener("pointermove", (e) => {
    if (!pressState || e.pointerId !== pressState.pointerId) return;
    if (!audio || !audio.duration) return;
    if (!pressState.dragging && Math.abs(e.clientX - pressState.startX) >= DRAG_PX) {
      pressState.dragging = true;
    }
    if (!pressState.dragging) return;
    const rect = staticWaveformCanvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const a = Math.min(pressState.startRatio, ratio);
    const b = Math.max(pressState.startRatio, ratio);
    clampWaveformView();
    const span = waveformViewEnd - waveformViewStart;
    loopRange = {
      start: waveformViewStart + a * span,
      end: waveformViewStart + b * span,
    };
    applyLoopOverlay();
  });

  staticWaveformCanvas.addEventListener("pointerup", (e) => {
    if (!pressState || e.pointerId !== pressState.pointerId) return;
    const wasDragging = pressState.dragging;
    const startRatio = pressState.startRatio;
    try { staticWaveformCanvas.releasePointerCapture(e.pointerId); } catch {}
    pressState = null;

    if (!wasDragging) {
      seekFromRatio(startRatio);
      return;
    }
    // Reject zero-width selections (sub-threshold ended in same pixel after capture).
    if (loopRange && loopRange.end - loopRange.start < 0.05) {
      clearLoop();
      seekFromRatio(startRatio);
    }
  });

  staticWaveformCanvas.addEventListener("mousemove", (e) => {
    if (!audio || !audio.duration || Number.isNaN(audio.duration)) return;
    const wrapRect = waveformCanvasWrap.getBoundingClientRect();
    const wfRect = staticWaveformCanvas.getBoundingClientRect();
    if (wfRect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - wfRect.left) / wfRect.width));
    clampWaveformView();
    const span = waveformViewEnd - waveformViewStart;
    const t = waveformViewStart + ratio * span;
    waveformTooltip.textContent = formatTimePrecise(t);
    waveformTooltip.style.left = `${e.clientX - wrapRect.left}px`;
    waveformTooltip.classList.add("visible");
  });

  staticWaveformCanvas.addEventListener("mouseleave", () => {
    waveformTooltip.classList.remove("visible");
  });

  staticWaveformCanvas.addEventListener(
    "wheel",
    (e) => {
      if (!waveformAudioBuffer) return;
      e.preventDefault();
      const wfRect = staticWaveformCanvas.getBoundingClientRect();
      if (wfRect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - wfRect.left) / wfRect.width));
      const d = waveformAudioBuffer.duration;
      if (!d || !Number.isFinite(d) || d <= 0) return;
      clampWaveformView();
      let span = waveformViewEnd - waveformViewStart;
      const tAt = waveformViewStart + ratio * span;
      const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
      span = Math.min(d, Math.max(WF_MIN_WINDOW_SEC, span * factor));
      let newStart = tAt - ratio * span;
      let newEnd = newStart + span;
      if (newStart < 0) {
        newStart = 0;
        newEnd = span;
      }
      if (newEnd > d) {
        newEnd = d;
        newStart = d - span;
      }
      waveformViewStart = Math.max(0, newStart);
      waveformViewEnd = Math.min(d, newEnd);
      clampWaveformView();
      void redrawStaticWaveform();
    },
    { passive: false },
  );

  btnWaveformSync.addEventListener("click", () => {
    if (!waveformAudioBuffer) return;
    const { start, end } = timeline.getVisibleTimeRange();
    waveformViewStart = start;
    waveformViewEnd = end;
    clampWaveformView();
    void redrawStaticWaveform();
  });

  btnWaveformZoomAll.addEventListener("click", () => {
    if (!waveformAudioBuffer) return;
    const d = waveformAudioBuffer.duration;
    if (!d || !Number.isFinite(d)) return;
    waveformViewStart = 0;
    waveformViewEnd = d;
    void redrawStaticWaveform();
  });

  // ── Whisper ─────────────────────────────────────────────────────────
  const whisperUrlInput = document.getElementById("ed-whisper-url") as HTMLInputElement | null;
  const whisperStatusEl = document.getElementById("ed-whisper-status")!;
  const whisperBarWrap = document.getElementById("ed-whisper-bar-wrap")!;
  const whisperBar = document.getElementById("ed-whisper-bar")!;

  // Wczytaj zapisany URL
  if (whisperUrlInput) {
    whisperUrlInput.value = getWhisperUrl();
    whisperUrlInput.addEventListener("change", () => saveWhisperUrl(whisperUrlInput.value));
  }

  async function runWhisper(): Promise<void> {
    if (!alignment || !audio) return;
    const serverUrl = whisperUrlInput?.value.trim() || getWhisperUrl();

    whisperBarWrap.classList.add("visible");
    whisperBar.style.width = "5%";

    const setStatus = (msg: string): void => {
      whisperStatusEl.textContent = msg;
      whisperBar.style.width = msg.includes("Parsow") ? "90%" : msg.includes("Wysyła") ? "30%" : "60%";
    };

    try {
      // Pobierz blob audio z projektu lub z elementu audio
      let audioBlob: Blob;
      if (currentUserProjectId) {
        const proj = await getProject(currentUserProjectId);
        if (!proj?.audioBlob) throw new Error("Brak audio w projekcie");
        audioBlob = proj.audioBlob;
      } else if (audio.src.startsWith("blob:")) {
        const resp = await fetch(audio.src);
        audioBlob = await resp.blob();
      } else {
        throw new Error("Brak dostępnego pliku audio");
      }

      const whisperWords = await transcribeWithWhisper(audioBlob, serverUrl, setStatus);
      setStatus(`Wyrównywanie ${whisperWords.length} słów...`);
      whisperBar.style.width = "80%";

      const suggestions = alignWhisperToLyrics(alignment.aligned_lyrics, whisperWords);
      whisperBar.style.width = "100%";

      timeline.setSuggestions(suggestions);
      editorSuggestionsRef.apply?.(suggestions);
      whisperStatusEl.textContent = `${whisperWords.length} słów Whisper`;
    } catch (e) {
      whisperStatusEl.textContent = `Błąd: ${e instanceof Error ? e.message : String(e)}`;
      whisperStatusEl.style.color = "#ff8888";
    } finally {
      setTimeout(() => { whisperBarWrap.classList.remove("visible"); whisperBar.style.width = "0%"; }, 1500);
    }
  }

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (liveTap?.isOpen()) return; // LiveTap przejmuje skróty
    if (e.code === "Space" && audio) {
      e.preventDefault();
      if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
      if (audio.paused) void audio.play();
      else audio.pause();
    }
    if (e.code === "Escape") showProjects();
  });

  // ── Load project ────────────────────────────────────────────────────
  async function loadBuiltinProject(projectId: string): Promise<void> {
    const project = BUILTIN_PROJECTS[projectId];
    if (!project) return;

    currentUserProjectId = null;
    currentProjectName = projectId;
    showHud();
    modeLabel.textContent = `Ładowanie: ${project.name}...`;

    try {
      alignment = await loadAlignment(project.jsonUrl);
      setLyrics(alignment.aligned_lyrics);

      if (project.audioUrl) {
        await loadProjectAudio(project.audioUrl);
        modeLabel.textContent = `${project.name} - gotowe`;
      } else {
        modeLabel.textContent = `${project.name} - wczytaj audio`;
      }

      startLoop();
    } catch (e) {
      modeLabel.textContent = `Błąd: ${e}`;
    }
  }

  /** Wczyta plik audio z `File` (bez channeli FSA), reuse logiki z loadAudioFile ale bez podmiany modeLabel. */
  async function loadAudioFromFile(file: File): Promise<void> {
    teardownAudio();
    clearWaveformStorage();

    audio = new Audio();
    audio.preload = "auto";
    audio.addEventListener("loadedmetadata", () => {
      setupAudioWithVisualizer(audio!);
      updateTimeline();
    });
    audio.addEventListener("timeupdate", updateTimeline);
    audio.src = URL.createObjectURL(file);

    showTimeline();

    const ctx2 = new AudioContext();
    try {
      const buf = await file.arrayBuffer();
      const audioBuffer = await ctx2.decodeAudioData(buf);
      await setWaveformFromBuffer(audioBuffer);
    } catch (e) {
      console.warn("Static waveform decode failed:", e);
    } finally {
      await ctx2.close();
    }
  }

  async function loadUserProject(id: string): Promise<void> {
    const p = await getProject(id);
    if (!p) return;

    currentUserProjectId = p.id;
    currentProjectName = p.name;
    showHud();
    modeLabel.textContent = `Ładowanie: ${p.name}...`;

    try {
      if (!p.audioBlob) {
        modeLabel.textContent = `Brak pliku audio w projekcie (${p.audioFileName})`;
        return;
      }
      const file = new File([p.audioBlob], p.audioFileName, { type: p.audioBlob.type });

      const words = p.lyricsKind === "json"
        ? (p.alignedLyrics ?? [])
        : textToUnalignedWords(p.rawLyrics ?? "");

      // Overlay flag line/verse_break ze źródłowego tekstu (jeśli istnieje), żeby
      // struktura zwrotek/wierszy była zawsze synchronizowana z `rawLyrics`
      // — niezależnie od edycji timingów (autofill / drag w timeline) wykonywanych
      // po pierwszym zapisie.
      if (p.rawLyrics && p.lyricsKind === "json") {
        const fromText = textToUnalignedWords(p.rawLyrics);
        if (fromText.length === words.length) {
          for (let i = 0; i < words.length; i++) {
            const src = fromText[i]!;
            const dst = words[i]!;
            if (src.line_break) dst.line_break = true;
            else delete dst.line_break;
            if (src.verse_break) dst.verse_break = true;
            else delete dst.verse_break;
            if (src.blank_line) dst.blank_line = true;
            else delete dst.blank_line;
          }
        }
      }

      await loadAudioFromFile(file);

      // Auto-dystrybucja dla świeżo wklejonego tekstu — gdy wszystkie czasy są zerowe
      // a audio ma znaną długość, rozłóż słowa równomiernie (zachowuje line/verse_break).
      const allZero = words.length > 0 && words.every((w) => w.start_time === 0 && w.end_time === 0);
      const dur = audio?.duration ?? 0;
      if (p.lyricsKind === "text" && allZero && dur > 0) {
        distributeWordsEvenly(words, dur);
        if (currentUserProjectId) {
          void updateProjectLyrics(currentUserProjectId, words);
        }
      }

      alignment = { aligned_lyrics: words };
      setLyrics(words);

      const noteUnaligned = p.lyricsKind === "text" && allZero && dur === 0
        ? " (tekst bez timingów — wczytaj audio)"
        : "";
      modeLabel.textContent = `${p.name} - gotowe${noteUnaligned}`;
      startLoop();
    } catch (e) {
      modeLabel.textContent = `Błąd: ${e}`;
    }
  }

  // ── New-project modal ───────────────────────────────────────────────
  type DraftLyrics =
    | { kind: "json"; words: AlignedWord[] }
    | { kind: "text"; text: string }
    | { kind: "none" };

  let draftAudio: { file: File; name: string } | null = null;
  let draftLyrics: DraftLyrics = { kind: "none" };
  let activeTab: "json" | "text" = "json";

  function refreshSaveEnabled(): void {
    const nameOk = npName.value.trim().length > 0;
    const audioOk = draftAudio !== null;
    const lyricsOk =
      (activeTab === "json" && draftLyrics.kind === "json" && draftLyrics.words.length > 0) ||
      (activeTab === "text" && npText.value.trim().length > 0);
    npSave.disabled = !(nameOk && audioOk && lyricsOk);
  }

  function setTab(tab: "json" | "text"): void {
    activeTab = tab;
    npTabJson.classList.toggle("active", tab === "json");
    npTabText.classList.toggle("active", tab === "text");
    npPaneJson.classList.toggle("active", tab === "json");
    npPaneText.classList.toggle("active", tab === "text");
    refreshSaveEnabled();
  }

  function openProjectModal(): void {
    npName.value = "";
    npText.value = "";
    npJsonFile.value = "";
    npJsonName.textContent = "brak pliku";
    npJsonStatus.textContent = "";
    npError.textContent = "";
    npAudioStatus.textContent = "brak pliku";
    draftAudio = null;
    draftLyrics = { kind: "none" };
    setTab("json");
    modal.classList.add("visible");
    npName.focus();
  }

  function closeProjectModal(): void {
    modal.classList.remove("visible");
  }

  npName.addEventListener("input", refreshSaveEnabled);
  npText.addEventListener("input", refreshSaveEnabled);
  npTabJson.addEventListener("click", () => setTab("json"));
  npTabText.addEventListener("click", () => setTab("text"));

  npPickAudio.addEventListener("click", async () => {
    npError.textContent = "";
    try {
      const file = await pickAudioFile();
      if (!file) return;
      draftAudio = { file, name: file.name };
      npAudioStatus.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      refreshSaveEnabled();
    } catch (e) {
      npError.textContent = `Błąd wyboru pliku: ${e}`;
    }
  });

  npPickJson.addEventListener("click", () => npJsonFile.click());

  npJsonFile.addEventListener("change", async () => {
    npError.textContent = "";
    const f = npJsonFile.files?.[0];
    if (!f) {
      draftLyrics = { kind: "none" };
      npJsonName.textContent = "brak pliku";
      npJsonStatus.textContent = "";
      refreshSaveEnabled();
      return;
    }
    npJsonName.textContent = f.name;
    try {
      const text = await f.text();
      const parsed = parseAlignmentJson(text);
      draftLyrics = { kind: "json", words: parsed.aligned_lyrics };
      npJsonStatus.textContent = `${parsed.aligned_lyrics.length} słów`;
    } catch (e) {
      draftLyrics = { kind: "none" };
      npJsonStatus.textContent = "";
      npError.textContent = `Błąd JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
    refreshSaveEnabled();
  });

  npCancel.addEventListener("click", closeProjectModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeProjectModal();
  });

  npSave.addEventListener("click", async () => {
    if (!draftAudio) return;
    npError.textContent = "";

    const proj: UserProject = {
      id: newProjectId(),
      name: npName.value.trim(),
      createdAt: Date.now(),
      audioBlob: draftAudio.file,
      audioFileName: draftAudio.name,
      lyricsKind: activeTab,
      alignedLyrics: activeTab === "json" && draftLyrics.kind === "json" ? draftLyrics.words : undefined,
      rawLyrics: activeTab === "text" ? npText.value : undefined,
    };

    try {
      await saveProject(proj);
      closeProjectModal();
      await renderProjectPicker();
    } catch (e) {
      npError.textContent = `Nie udało się zapisać: ${e instanceof Error ? e.message : String(e)}`;
    }
  });

  // ── Bootstrap ───────────────────────────────────────────────────────
  void renderProjectPicker();
}

main();
