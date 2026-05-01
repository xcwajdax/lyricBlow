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

type LandingLanguage = "pl" | "en";

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
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return parseAlignmentJson(await res.text());
}

function main(): void {
  const app = document.getElementById("app")!;
  const landingDiv = document.getElementById("landing")!;
  const landingStartBtn = document.getElementById("landing-start-app") as HTMLButtonElement;
  const landingLiveTapBtn = document.getElementById("landing-jump-livetap") as HTMLButtonElement;
  const landingLangPlBtn = document.getElementById("landing-lang-pl") as HTMLButtonElement;
  const landingLangEnBtn = document.getElementById("landing-lang-en") as HTMLButtonElement;
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
  const appLangSelect = document.getElementById("app-lang") as HTMLSelectElement;

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

    modeLabel.textContent = `${t("modeLoaded")}: ${file.name}`;
  }

  // ── Load project audio (via fetch → blob → Audio element) ──────────
  async function loadProjectAudio(url: string): Promise<void> {
    teardownAudio();
    clearWaveformStorage();

    const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status}`);

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
  const APP_LANG_KEY = "app-lang";

  const landingCopy: Record<LandingLanguage, Record<string, string>> = {
    pl: {
      hero_title: "Lyric Visualizer - local-first",
      hero_lead: "Narzędzie do synchronizacji i wizualizacji tekstu piosenek działające lokalnie na Twoim komputerze.",
      privacy_callout:
        "Prywatność: audio, tekst i timingi zostają lokalnie (IndexedDB + lokalne pliki). Aplikacja nie wysyła danych do chmury. Whisper działa wyłącznie na Twoim lokalnym serwerze, jeśli sam go uruchomisz.",
      how_title: "Jak to działa",
      how_1: "Tworzysz projekt i dodajesz audio oraz tekst/JSON.",
      how_2: "Doprecyzowujesz czasy słów w edytorze lub timeline.",
      how_3: "Tagujesz słowa na żywo w trybie Live TAP.",
      how_4: "Eksportujesz gotowe napisy do JSON, LRC lub LRC+.",
      livetap_title: "Dlaczego Live TAP?",
      livetap_1: "Najszybsza metoda ustawiania timingów w rytmie utworu.",
      livetap_2: "Używasz tylko klawiatury: Spacja, strzałki i P/K.",
      livetap_3: "Idealny punkt startowy przed finalnym szlifem w timeline.",
      cta_start: "Uruchom aplikację",
      cta_livetap: "Pokaż jak uruchomić Live TAP",
    },
    en: {
      hero_title: "Lyric Visualizer - local-first",
      hero_lead: "A local tool for syncing and visualizing song lyrics directly on your computer.",
      privacy_callout:
        "Privacy: audio, lyrics and timings stay local (IndexedDB + local files). The app does not send your data to the cloud. Whisper is used only via your own local server when you run it.",
      how_title: "How it works",
      how_1: "Create a project and add your audio plus lyrics text/JSON.",
      how_2: "Refine word timings in the timing editor or timeline.",
      how_3: "Tag words in real time with Live TAP.",
      how_4: "Export finished lyrics to JSON, LRC, or LRC+.",
      livetap_title: "Why Live TAP?",
      livetap_1: "The fastest way to build timings in song rhythm.",
      livetap_2: "Keyboard-first flow: Space, arrows, and P/K.",
      livetap_3: "Perfect first pass before final cleanup in timeline.",
      cta_start: "Start app",
      cta_livetap: "Show Live TAP quickstart",
    },
  };
  let appLang: LandingLanguage = "pl";

  const tr: Record<LandingLanguage, Record<string, string>> = {
    pl: {
      projectsTitle: "Wybierz projekt",
      modeLoaded: "Wczytano",
      modeLoading: "Ładowanie",
      modeReady: "gotowe",
      modeLoadAudio: "wczytaj audio",
      modeError: "Błąd",
      builtins: "Przykłady (wbudowane)",
      yourProjects: "Twoje projekty",
      noProjects: "Nie masz jeszcze zapisanych projektów — utwórz pierwszy poniżej.",
      fixtureNoAudio: "bez domyślnego audio",
      created: "Utworzono",
      updated: "ostatnia edycja",
      words: "słów",
      sectionLabels: "etykiet sekcji",
      delete: "Usuń",
      deleteTitle: "Usuń projekt",
      deleteConfirm: "Usunąć projekt \"{name}\"?",
      newProject: "+ Nowy projekt",
      npTitle: "Nowy projekt",
      npNameLabel: "Nazwa projektu",
      npNamePlaceholder: "np. Tiny Hands Tiny Plans",
      npLyricsLabel: "Tekst piosenki:",
      npTabJson: "Wgraj JSON",
      npTabText: "Edytor tekstu",
      npPickAudio: "Wybierz plik audio...",
      npPickJson: "Wybierz plik JSON...",
      npNoFile: "brak pliku",
      npCancel: "Anuluj",
      npSave: "Zapisz projekt",
      edWordCol: "Słowo",
      ltLegend:
        "<kbd>Spacja</kbd> tap &middot; <kbd>⌫</kbd> cofnij ostatni tap &middot; <kbd>P</kbd>/<kbd>K</kbd> play/pause &middot; <kbd>←</kbd> -5s &middot; <kbd>Shift+←</kbd> -10s &middot; <kbd>→</kbd> +5s &middot; <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> tempo &middot; <kbd>Ctrl+S</kbd> zapisz &middot; <kbd>Esc</kbd> wyjście",
      appLangLabel: "Język:",
      btnBack: "← Projekty",
      btnEditTiming: "Edytor czasów",
      liveTapGuide:
        "Szybki start Live TAP:\n1) Otwórz lub utwórz projekt.\n2) Kliknij 'LiveTap' na dolnym pasku.\n3) Podczas odtwarzania wciskaj Spację, aby tagować słowa.\n4) Zapisz przez Ctrl+S.",
      npTextHint:
        "<strong>Format wklejanego tekstu:</strong><ul style=\"margin: 4px 0 4px 18px; padding: 0;\"><li>każdy <strong>Enter</strong> = koniec wiersza (line break)</li><li>puste linie są ignorowane — używaj ich tylko do wizualnego grupowania</li><li><strong>nowa zwrotka</strong>: dodaj nagłówek w nawiasach kwadratowych — np. <code>[Zwrotka 1]</code>, <code>[Refren]</code>, <code>[Chorus]</code>, <code>[Bridge]</code>. Sama etykieta jest pomijana, ale wymusza początek nowej sekcji.</li><li>fallback: gdy w tekście nie ma w ogóle enterów, przecinek (<code>, </code>) traktowany jest jako koniec wiersza</li></ul>Po zapisaniu projektu czasy słów są <strong>automatycznie rozłożone równomiernie</strong> na całą długość audio. Doprecyzuj je później w Edytorze czasów lub w timeline.",
      waveSync: "Sync",
      waveAll: "Całość",
      viewLabel: "Widok:",
      viewMulti: "Wieloliniowy",
      viewRail: "Jedna linia (środek)",
      viewFull: "Cały tekst (zwrotki/refren)",
    },
    en: {
      projectsTitle: "Choose project",
      modeLoaded: "Loaded",
      modeLoading: "Loading",
      modeReady: "ready",
      modeLoadAudio: "load audio",
      modeError: "Error",
      builtins: "Built-in examples",
      yourProjects: "Your projects",
      noProjects: "No saved projects yet — create your first one below.",
      fixtureNoAudio: "no default audio",
      created: "Created",
      updated: "last edited",
      words: "words",
      sectionLabels: "section labels",
      delete: "Delete",
      deleteTitle: "Delete project",
      deleteConfirm: "Delete project \"{name}\"?",
      newProject: "+ New project",
      npTitle: "New project",
      npNameLabel: "Project name",
      npNamePlaceholder: "e.g. Tiny Hands Tiny Plans",
      npLyricsLabel: "Song lyrics:",
      npTabJson: "Upload JSON",
      npTabText: "Text editor",
      npPickAudio: "Pick audio file...",
      npPickJson: "Pick JSON file...",
      npNoFile: "no file",
      npCancel: "Cancel",
      npSave: "Save project",
      edWordCol: "Word",
      ltLegend:
        "<kbd>Space</kbd> tap &middot; <kbd>⌫</kbd> undo last tap &middot; <kbd>P</kbd>/<kbd>K</kbd> play/pause &middot; <kbd>←</kbd> -5s &middot; <kbd>Shift+←</kbd> -10s &middot; <kbd>→</kbd> +5s &middot; <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> speed &middot; <kbd>Ctrl+S</kbd> save &middot; <kbd>Esc</kbd> close",
      appLangLabel: "Language:",
      btnBack: "← Projects",
      btnEditTiming: "Timing editor",
      liveTapGuide:
        "Live TAP quickstart:\n1) Open or create a project.\n2) Click 'LiveTap' in the bottom bar.\n3) Press Space while the track plays to tag words.\n4) Save with Ctrl+S.",
      npTextHint:
        "<strong>Pasted text format:</strong><ul style=\"margin: 4px 0 4px 18px; padding: 0;\"><li>each <strong>Enter</strong> = end of line (line break)</li><li>empty lines are ignored — use them only for visual grouping</li><li><strong>new verse</strong>: add a square-bracket header, e.g. <code>[Verse 1]</code>, <code>[Chorus]</code>, <code>[Bridge]</code>. The label itself is skipped, but it starts a new section.</li><li>fallback: if there are no line breaks, comma (<code>, </code>) is treated as line end</li></ul>After saving, word timings are <strong>distributed evenly</strong> across full audio duration. Refine them later in Timing Editor or timeline.",
      waveSync: "Sync",
      waveAll: "Full",
      viewLabel: "View:",
      viewMulti: "Multiline",
      viewRail: "Single line (center)",
      viewFull: "Full text (verses/chorus)",
    },
  };

  function t(key: string, vars?: Record<string, string>): string {
    let s = tr[appLang][key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    }
    return s;
  }

  function applyLanguage(lang: LandingLanguage): void {
    appLang = lang;
    localStorage.setItem(APP_LANG_KEY, lang);
    document.documentElement.lang = lang;
    landingLangPlBtn.classList.toggle("active", lang === "pl");
    landingLangEnBtn.classList.toggle("active", lang === "en");
    appLangSelect.value = lang;
    const dict = landingCopy[lang];
    const i18nNodes = landingDiv.querySelectorAll<HTMLElement>("[data-i18n]");
    i18nNodes.forEach((node) => {
      const key = node.dataset.i18n;
      if (!key) return;
      const value = dict[key];
      if (value) node.textContent = value;
    });
    const byId = (id: string): HTMLElement | null => document.getElementById(id);
    const setText = (id: string, value: string): void => { const el = byId(id); if (el) el.textContent = value; };
    setText("projects-title", t("projectsTitle"));
    setText("np-title", t("npTitle"));
    setText("np-name-label", t("npNameLabel"));
    setText("np-lyrics-label", t("npLyricsLabel"));
    setText("np-tab-json", t("npTabJson"));
    setText("np-tab-text", t("npTabText"));
    setText("np-pick-audio", t("npPickAudio"));
    setText("np-pick-json", t("npPickJson"));
    setText("np-cancel", t("npCancel"));
    setText("np-save", t("npSave"));
    setText("app-lang-label", t("appLangLabel"));
    setText("btn-back", t("btnBack"));
    setText("btn-edit-timing", t("btnEditTiming"));
    setText("btn-waveform-sync", t("waveSync"));
    setText("btn-waveform-zoom-all", t("waveAll"));
    setText("ed-add", appLang === "en" ? "+ Word" : "+ Słowo");
    setText("ed-sort", appLang === "en" ? "Sort" : "Sortuj");
    setText("ed-autofill", appLang === "en" ? "Distribute evenly" : "Rozłóż równomiernie");
    setText("ed-toggle-label", appLang === "en" ? "🏷 Label" : "🏷 Etykieta");
    setText("ed-mark-line", appLang === "en" ? "↵ Line" : "↵ Linijka");
    setText("ed-mark-verse", appLang === "en" ? "¶ Verse" : "¶ Zwrotka");
    setText("ed-clear-breaks", appLang === "en" ? "Clear breaks" : "Wyczyść granice");
    setText("ed-toggle-raw", "{ } RAW");
    setText("ed-download", "JSON");
    setText("ed-export-lrc", "LRC");
    setText("ed-export-lrc-plus", "LRC+");
    setText("ed-save", appLang === "en" ? "Save" : "Zapisz");
    setText("ed-close", appLang === "en" ? "Close" : "Zamknij");
    setText("ed-whisper", "Whisper ✦");
    setText("ed-accept-all", appLang === "en" ? "Accept all" : "Przyjmij wszystko");
    setText("ed-reject-all", appLang === "en" ? "Reject" : "Odrzuć");
    setText("btn-play", "▶");
    setText("btn-pause", "⏸");
    setText("btn-stop", "⏹");
    setText("hud-pick-audio", appLang === "en" ? "Audio..." : "Audio...");
    setText("hud-pick-json", "JSON...");
    setText("btn-livetap", "⏱ LiveTap");
    setText("btn-viz-settings", "Aa");
    setText("lt-rew10", appLang === "en" ? "⟲ -10s" : "⟲ -10s");
    setText("lt-rew5", appLang === "en" ? "⟲ -5s" : "⟲ -5s");
    setText("lt-play", appLang === "en" ? "▶ / ⏸" : "▶ / ⏸");
    setText("lt-fwd5", appLang === "en" ? "⟳ +5s" : "⟳ +5s");
    setText("lt-save", appLang === "en" ? "💾 Save" : "💾 Zapisz");
    setText("lt-close", appLang === "en" ? "✕ Close" : "✕ Zamknij");
    setText("lt-play-under", appLang === "en" ? "▶ / ⏸" : "▶ / ⏸");
    setText("btn-vs-reset", appLang === "en" ? "Reset defaults" : "Przywróć domyślne");
    const npNameInput = document.getElementById("np-name") as HTMLInputElement | null;
    if (npNameInput) npNameInput.placeholder = t("npNamePlaceholder");
    const ltLegend = byId("lt-legend");
    if (ltLegend) ltLegend.innerHTML = t("ltLegend");
    const ltOffsetLabel = byId("lt-offset-label-text");
    if (ltOffsetLabel) ltOffsetLabel.textContent = appLang === "en" ? "Offset:" : "Offset:";
    const wordHeader = document.querySelector("#editor-modal thead th:nth-child(2)");
    if (wordHeader) wordHeader.textContent = t("edWordCol");
    const actionsHeader = document.querySelector("#editor-modal thead th:nth-child(5)");
    if (actionsHeader) actionsHeader.textContent = appLang === "en" ? "Actions" : "Akcje";
    const setTitle = (id: string, value: string): void => {
      const el = byId(id);
      if (el) el.setAttribute("title", value);
    };
    setTitle("btn-waveform-sync", appLang === "en" ? "Sync waveform with text timeline" : "Zsynchronizuj widok fali z timeline tekstu");
    setTitle("btn-waveform-zoom-all", appLang === "en" ? "Show full track" : "Pokaż cały utwór");
    setTitle("waveform-loop-clear", appLang === "en" ? "Clear loop" : "Wyczyść loop");
    setTitle("btn-livetap", appLang === "en" ? "LiveTap mode - tag words with Space during playback" : "Tryb LiveTap — taguj słowa Spacją w trakcie odtwarzania");
    setTitle("btn-viz-settings", appLang === "en" ? "Visualizer settings (font, colors)" : "Ustawienia wizualizatora (czcionka, kolory)");
    setTitle("lt-rew10", appLang === "en" ? "Rewind 10 s (Shift+←)" : "Cofnij 10 s (Shift+←)");
    setTitle("lt-rew5", appLang === "en" ? "Rewind 5 s (←)" : "Cofnij 5 s (←)");
    setTitle("lt-fwd5", appLang === "en" ? "Forward 5 s (→)" : "Do przodu 5 s (→)");
    setTitle("lt-save", appLang === "en" ? "Save state (Ctrl+S)" : "Zapisz stan (Ctrl+S)");
    setTitle("lt-close", appLang === "en" ? "Close (Esc)" : "Zamknij (Esc)");
    setTitle("lt-offset-label", appLang === "en" ? "Reaction-time compensation - subtracted from audio.currentTime on each tap" : "Kompensacja czasu reakcji — odejmowana od audio.currentTime przy każdym tapie");
    setTitle("ed-add", appLang === "en" ? "Add new word at end" : "Dodaj nowe słowo na końcu");
    setTitle("ed-sort", appLang === "en" ? "Sort by start_time" : "Posortuj wg start_time");
    setTitle("ed-autofill", appLang === "en" ? "Distribute words across full track duration" : "Rozłóż słowa równomiernie na całą długość utworu");
    setTitle("ed-toggle-label", appLang === "en" ? "Promote selected words to label (Chorus / vocalist / etc.)" : "Promuj zaznaczone słowa do etykiety (Refren / imię wokalisty / itp.)");
    setTitle("ed-mark-line", appLang === "en" ? "Mark line end on last selected word" : "Oznacz koniec linijki na ostatnim słowie selekcji");
    setTitle("ed-mark-verse", appLang === "en" ? "Mark verse end on last selected word" : "Oznacz koniec zwrotki na ostatnim słowie selekcji");
    setTitle("ed-clear-breaks", appLang === "en" ? "Clear line/verse breaks from selected words" : "Usuń granice linii/zwrotki z zaznaczonych słów");
    setTitle("ed-toggle-raw", appLang === "en" ? "Show/hide RAW JSON preview" : "Pokaż/ukryj podgląd RAW JSON");
    setTitle("ed-download", appLang === "en" ? "Download JSON" : "Pobierz JSON");
    setTitle("ed-export-lrc", appLang === "en" ? "Export as LRC (lines)" : "Eksportuj jako LRC (linie)");
    setTitle("ed-export-lrc-plus", appLang === "en" ? "Export as enhanced LRC (words)" : "Eksportuj jako enhanced LRC (słowa)");
    setTitle("ed-whisper-url", appLang === "en" ? "Whisper server URL" : "URL serwera Whisper");
    const projectsH = byId("projects-title");
    if (projectsH) projectsH.textContent = t("projectsTitle");
    const editorH2 = document.querySelector("#editor-modal h2");
    if (editorH2) editorH2.textContent = appLang === "en" ? "Word Timing Editor" : "Edytor czasów słów";
    const modalH2 = byId("np-title");
    if (modalH2) modalH2.textContent = appLang === "en" ? "New project" : "Nowy projekt";
    const hint = byId("np-text-hint");
    if (hint) hint.innerHTML = t("npTextHint");
    const viewLabel = vizModeSelect.previousElementSibling as HTMLElement | null;
    if (viewLabel) viewLabel.textContent = t("viewLabel");
    const opts = vizModeSelect.options;
    if (opts.length >= 3) {
      opts[0].text = t("viewMulti");
      opts[1].text = t("viewRail");
      opts[2].text = t("viewFull");
    }
  }

  function showLanding(): void {
    landingDiv.classList.add("visible");
    projectsDiv.classList.remove("visible");
    hud.classList.add("hidden");
    miniVisualizer.classList.remove("active");
    hideTimeline();
    viz.setBottomMargin(0);
  }

  function showProjectPicker(): void {
    landingDiv.classList.remove("visible");
    projectsDiv.classList.add("visible");
    hud.classList.add("hidden");
    miniVisualizer.classList.remove("active");
  }

  function showProjects(): void {
    if (editorHandle && !editorHandle.close()) return;
    editorHandle = null;
    cancelAnimationFrame(raf);
    alignment = null;
    currentUserProjectId = null;
    currentProjectName = "aligned";
    showProjectPicker();
    hideTimeline();
    viz.setBottomMargin(0);
    if (audio) { audio.pause(); }
    teardownAudio();
    viz.setAlignedLyrics([]);
  }

  function showHud(): void {
    landingDiv.classList.remove("visible");
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
    const projectPickerDateFmt = new Intl.DateTimeFormat(appLang === "pl" ? "pl-PL" : "en-US", {
      dateStyle: "short",
      timeStyle: "short",
    });
    projectsList.innerHTML = "";

    appendProjectsSectionTitle(t("builtins"));
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
        : `Fixture · ${p.jsonUrl} · ${t("fixtureNoAudio")}`;
      openBtn.appendChild(subEl);
      openBtn.addEventListener("click", () => void loadBuiltinProject(id));
      row.appendChild(openBtn);
      projectsList.appendChild(row);
    }

    appendProjectsSectionTitle(t("yourProjects"));
    let userProjects: UserProject[] = [];
    try {
      userProjects = await listProjects();
    } catch (e) {
      console.warn("Could not load user projects:", e);
    }
    if (userProjects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "projects-empty-hint";
      empty.textContent = t("noProjects");
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
      lineChips.appendChild(document.createTextNode(` ${wordsN} ${t("words")}`));
      const labelN = countSectionLabels(p.alignedLyrics);
      if (labelN > 0) {
        lineChips.appendChild(document.createTextNode(` · ${labelN} ${t("sectionLabels")}`));
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
          ? ` · ${t("updated")}: ${projectPickerDateFmt.format(new Date(p.updatedAt))}`
          : ` · ${t("updated")}: —`;
      lineDates.textContent =
        `${t("created")}: ${projectPickerDateFmt.format(new Date(p.createdAt))}` + updatedPart;
      metaWrap.appendChild(lineDates);

      openBtn.appendChild(metaWrap);
      openBtn.addEventListener("click", () => void loadUserProject(p.id));
      row.appendChild(openBtn);

      const del = document.createElement("button");
      del.className = "project-delete";
      del.type = "button";
      del.title = t("deleteTitle");
      del.textContent = t("delete");
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm(t("deleteConfirm", { name: p.name }))) return;
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
    newBtn.textContent = t("newProject");
    newBtn.addEventListener("click", openProjectModal);
    newRow.appendChild(newBtn);
    projectsList.appendChild(newRow);
  }

  btnBack.addEventListener("click", showProjects);
  landingStartBtn.addEventListener("click", showProjectPicker);
  landingLangPlBtn.addEventListener("click", () => applyLanguage("pl"));
  landingLangEnBtn.addEventListener("click", () => applyLanguage("en"));
  appLangSelect.addEventListener("change", () => {
    applyLanguage(appLangSelect.value === "en" ? "en" : "pl");
    void renderProjectPicker();
  });
  landingLiveTapBtn.addEventListener("click", () => {
    showProjectPicker();
    alert(t("liveTapGuide"));
  });

  btnEditTiming.addEventListener("click", () => {
    if (!alignment) return;
    editorHandle = openTimingEditor({
      initialWords: alignment.aligned_lyrics,
      projectName: currentProjectName,
      language: appLang,
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
      language: appLang,
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
      modeLabel.textContent = `${t("modeLoaded")}: ${f.name} (${alignment.aligned_lyrics.length} ${t("words")})`;
      startLoop();
    } catch (e) {
      modeLabel.textContent = `${t("modeError")} JSON: ${e}`;
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
    timeline.setVisibleTimeRange(waveformViewStart, waveformViewEnd);
  });

  btnWaveformZoomAll.addEventListener("click", () => {
    if (!waveformAudioBuffer) return;
    const d = waveformAudioBuffer.duration;
    if (!d || !Number.isFinite(d)) return;
    waveformViewStart = 0;
    waveformViewEnd = d;
    void redrawStaticWaveform();
    timeline.fitAll();
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
      const lower = msg.toLowerCase();
      whisperBar.style.width = lower.includes("pars") ? "90%" : lower.includes("upload") || lower.includes("wysy") ? "30%" : "60%";
    };

    try {
      // Pobierz blob audio z projektu lub z elementu audio
      let audioBlob: Blob;
      if (currentUserProjectId) {
        const proj = await getProject(currentUserProjectId);
        if (!proj?.audioBlob) throw new Error(appLang === "en" ? "No audio in project" : "Brak audio w projekcie");
        audioBlob = proj.audioBlob;
      } else if (audio.src.startsWith("blob:")) {
        const resp = await fetch(audio.src);
        audioBlob = await resp.blob();
      } else {
        throw new Error(appLang === "en" ? "No available audio file" : "Brak dostępnego pliku audio");
      }

      const whisperWords = await transcribeWithWhisper(audioBlob, serverUrl, setStatus, appLang);
      setStatus(appLang === "en" ? `Aligning ${whisperWords.length} words...` : `Wyrównywanie ${whisperWords.length} słów...`);
      whisperBar.style.width = "80%";

      const suggestions = alignWhisperToLyrics(alignment.aligned_lyrics, whisperWords);
      whisperBar.style.width = "100%";

      timeline.setSuggestions(suggestions);
      editorSuggestionsRef.apply?.(suggestions);
      whisperStatusEl.textContent = appLang === "en" ? `${whisperWords.length} Whisper words` : `${whisperWords.length} słów Whisper`;
    } catch (e) {
      whisperStatusEl.textContent = `${t("modeError")}: ${e instanceof Error ? e.message : String(e)}`;
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
    modeLabel.textContent = `${t("modeLoading")}: ${project.name}...`;

    try {
      alignment = await loadAlignment(project.jsonUrl);
      setLyrics(alignment.aligned_lyrics);

      if (project.audioUrl) {
        await loadProjectAudio(project.audioUrl);
        modeLabel.textContent = `${project.name} - ${t("modeReady")}`;
      } else {
        modeLabel.textContent = `${project.name} - ${t("modeLoadAudio")}`;
      }

      startLoop();
    } catch (e) {
      modeLabel.textContent = `${t("modeError")}: ${e}`;
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
    modeLabel.textContent = `${t("modeLoading")}: ${p.name}...`;

    try {
      if (!p.audioBlob) {
        modeLabel.textContent = appLang === "en"
          ? `No audio file in project (${p.audioFileName})`
          : `Brak pliku audio w projekcie (${p.audioFileName})`;
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
        ? (appLang === "en" ? " (text without timings - load audio)" : " (tekst bez timingów - wczytaj audio)")
        : "";
      modeLabel.textContent = `${p.name} - ${t("modeReady")}${noteUnaligned}`;
      startLoop();
    } catch (e) {
      modeLabel.textContent = `${t("modeError")}: ${e}`;
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
    npJsonName.textContent = t("npNoFile");
    npJsonStatus.textContent = "";
    npError.textContent = "";
    npAudioStatus.textContent = t("npNoFile");
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
      npError.textContent = `${t("modeError")}: ${e}`;
    }
  });

  npPickJson.addEventListener("click", () => npJsonFile.click());

  npJsonFile.addEventListener("change", async () => {
    npError.textContent = "";
    const f = npJsonFile.files?.[0];
    if (!f) {
      draftLyrics = { kind: "none" };
      npJsonName.textContent = t("npNoFile");
      npJsonStatus.textContent = "";
      refreshSaveEnabled();
      return;
    }
    npJsonName.textContent = f.name;
    try {
      const text = await f.text();
      const parsed = parseAlignmentJson(text);
      draftLyrics = { kind: "json", words: parsed.aligned_lyrics };
      npJsonStatus.textContent = `${parsed.aligned_lyrics.length} ${t("words")}`;
    } catch (e) {
      draftLyrics = { kind: "none" };
      npJsonStatus.textContent = "";
      npError.textContent = `${t("modeError")} JSON: ${e instanceof Error ? e.message : String(e)}`;
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
      npError.textContent = `${t("modeError")}: ${e instanceof Error ? e.message : String(e)}`;
    }
  });

  // ── Bootstrap ───────────────────────────────────────────────────────
  const storedLang = localStorage.getItem(APP_LANG_KEY);
  applyLanguage(storedLang === "en" ? "en" : "pl");
  showLanding();
  void renderProjectPicker();
}

main();
