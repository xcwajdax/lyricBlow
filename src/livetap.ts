import type { AlignedWord } from "./alignment";

export type LiveTapOptions = {
  initialWords: AlignedWord[];
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  isPlaying: () => boolean;
  setPlaybackRate: (rate: number) => void;
  onLiveUpdate: (words: AlignedWord[]) => void;
  onSave: (words: AlignedWord[]) => void | Promise<void>;
};

export type LiveTapHandle = {
  close: () => void;
  isOpen: () => boolean;
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function isTappable(w: AlignedWord): boolean {
  return w.kind !== "label";
}

function findStartCursor(words: AlignedWord[], t: number): number {
  let firstTappable = -1;
  let lastTappable = -1;
  let bestForward = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!isTappable(w)) continue;
    if (firstTappable < 0) firstTappable = i;
    lastTappable = i;
    if (bestForward < 0 && w.start_time >= t) bestForward = i;
  }
  if (bestForward >= 0) return bestForward;
  if (lastTappable >= 0) return lastTappable;
  return firstTappable >= 0 ? firstTappable : 0;
}

function prevTappable(words: AlignedWord[], from: number): number {
  for (let i = from - 1; i >= 0; i--) if (isTappable(words[i])) return i;
  return -1;
}

function nextTappable(words: AlignedWord[], from: number): number {
  for (let i = from + 1; i < words.length; i++) if (isTappable(words[i])) return i;
  return -1;
}

export function openLiveTap(opts: LiveTapOptions): LiveTapHandle {
  const root = document.getElementById("livetap-modal") as HTMLDivElement | null;
  const railEl = document.getElementById("lt-rail") as HTMLDivElement | null;
  const rateSel = document.getElementById("lt-rate") as HTMLSelectElement | null;
  const offsetInp = document.getElementById("lt-offset") as HTMLInputElement | null;
  const offsetVal = document.getElementById("lt-offset-val") as HTMLSpanElement | null;
  const btnRew10 = document.getElementById("lt-rew10") as HTMLButtonElement | null;
  const btnRew5 = document.getElementById("lt-rew5") as HTMLButtonElement | null;
  const btnFwd5 = document.getElementById("lt-fwd5") as HTMLButtonElement | null;
  const btnPlay = document.getElementById("lt-play") as HTMLButtonElement | null;
  const btnPlayUnder = document.getElementById("lt-play-under") as HTMLButtonElement | null;
  const btnSave = document.getElementById("lt-save") as HTMLButtonElement | null;
  const btnClose = document.getElementById("lt-close") as HTMLButtonElement | null;
  const statusEl = document.getElementById("lt-status") as HTMLSpanElement | null;
  const timeCur = document.getElementById("lt-time-current") as HTMLSpanElement | null;
  const timeTot = document.getElementById("lt-time-total") as HTMLSpanElement | null;
  const barFill = document.getElementById("lt-bar-fill") as HTMLDivElement | null;

  if (!root || !railEl || !rateSel || !offsetInp || !offsetVal ||
      !btnRew10 || !btnRew5 || !btnFwd5 || !btnPlay || !btnPlayUnder || !btnSave || !btnClose ||
      !statusEl || !timeCur || !timeTot || !barFill) {
    return { close: () => {}, isOpen: () => false };
  }

  const words: AlignedWord[] = opts.initialWords;
  let cursor = findStartCursor(words, opts.getCurrentTime());
  let offsetMs = parseInt(offsetInp.value, 10) || 0;
  let raf = 0;
  let open = true;

  type Snap = { idx: number; cursorBefore: number; prevStart: number; prevEnd: number; prevPrevEnd: number | null; prevPrevIdx: number | null };
  const history: Snap[] = [];
  const HIST_LIMIT = 200;

  function emit(): void {
    opts.onLiveUpdate(words);
  }

  function setStatus(msg: string, color = "#9ec5ff"): void {
    statusEl!.textContent = msg;
    statusEl!.style.color = color;
  }

  /** Cache spanów po każdym pełnym buildzie — żeby nie rebuildować przy każdym tapie. */
  let wordSpans: HTMLSpanElement[] = [];

  function buildRail(): void {
    railEl!.innerHTML = "";
    wordSpans = words.map((w) => {
      const span = document.createElement("span");
      span.className = "lt-word";
      span.textContent = w.word || "·";
      if (w.kind === "label") span.classList.add("label");
      railEl!.appendChild(span);
      return span;
    });
  }

  function updateRail(): void {
    if (wordSpans.length === 0) return;
    wordSpans.forEach((s, i) => {
      s.classList.toggle("current", i === cursor);
      s.classList.toggle("tapped", i < cursor);
    });
    const cur = wordSpans[Math.min(cursor, wordSpans.length - 1)];
    if (!cur) return;
    // Sync read offsetLeft/Width — wymusza layout i daje poprawne wartości od razu.
    const center = cur.offsetLeft + cur.offsetWidth / 2;
    railEl!.style.transform = `translate(${-center}px, -50%)`;
  }

  function renderRail(): void {
    if (wordSpans.length !== words.length) buildRail();
    updateRail();
  }

  function tick(): void {
    if (!open) return;
    const t = opts.getCurrentTime();
    const d = opts.getDuration();
    timeCur!.textContent = fmtTime(t);
    timeTot!.textContent = fmtTime(d);
    if (d > 0) {
      barFill!.style.transform = `scaleX(${Math.min(1, t / d)})`;
    }
    const playLabel = opts.isPlaying() ? "⏸ Pause" : "▶︎ Play";
    btnPlay!.textContent = playLabel;
    btnPlayUnder!.textContent = playLabel;
    raf = requestAnimationFrame(tick);
  }

  function tap(): void {
    if (cursor < 0 || cursor >= words.length) {
      setStatus("Gotowe — wszystkie słowa zaznaczone", "#80ffa0");
      return;
    }
    const w = words[cursor];
    if (!isTappable(w)) {
      const next = nextTappable(words, cursor);
      if (next < 0) {
        setStatus("Gotowe — wszystkie słowa zaznaczone", "#80ffa0");
        return;
      }
      cursor = next;
      renderRail();
      return;
    }
    const t = Math.max(0, opts.getCurrentTime() - offsetMs / 1000);
    const prevIdx = prevTappable(words, cursor);
    const snap: Snap = {
      idx: cursor,
      cursorBefore: cursor,
      prevStart: w.start_time,
      prevEnd: w.end_time,
      prevPrevEnd: prevIdx >= 0 ? words[prevIdx].end_time : null,
      prevPrevIdx: prevIdx >= 0 ? prevIdx : null,
    };
    history.push(snap);
    if (history.length > HIST_LIMIT) history.shift();

    w.start_time = round3(t);
    if (w.end_time < w.start_time) w.end_time = w.start_time;
    if (prevIdx >= 0) words[prevIdx].end_time = w.start_time;

    const next = nextTappable(words, cursor);
    if (next < 0) {
      cursor = words.length;
      setStatus("Gotowe — wszystkie słowa zaznaczone", "#80ffa0");
    } else {
      cursor = next;
      setStatus(`Słowo ${cursor + 1} / ${words.length}`);
    }
    emit();
    renderRail();
  }

  function undoTap(): void {
    const snap = history.pop();
    if (!snap) {
      setStatus("Brak czego cofać", "#ffc080");
      return;
    }
    const w = words[snap.idx];
    w.start_time = snap.prevStart;
    w.end_time = snap.prevEnd;
    if (snap.prevPrevIdx !== null && snap.prevPrevEnd !== null) {
      words[snap.prevPrevIdx].end_time = snap.prevPrevEnd;
    }
    cursor = snap.cursorBefore;
    setStatus(`Cofnięto — słowo ${cursor + 1}`, "#9ec5ff");
    emit();
    renderRail();
  }

  function rew(s: number): void {
    opts.seekTo(Math.max(0, opts.getCurrentTime() - s));
  }

  function fwd(s: number): void {
    const d = opts.getDuration() || Infinity;
    opts.seekTo(Math.min(d, opts.getCurrentTime() + s));
  }

  function togglePlay(): void {
    if (opts.isPlaying()) opts.pause();
    else opts.play();
  }

  function setRate(r: number): void {
    opts.setPlaybackRate(r);
    rateSel!.value = String(r);
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    const inField = tag === "INPUT" || tag === "TEXTAREA";
    if (e.code === "Escape") { e.preventDefault(); close(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
      e.preventDefault();
      btnSave!.click();
      return;
    }
    if (inField) return;
    if (e.code === "Space") { e.preventDefault(); tap(); return; }
    if (e.code === "Backspace") { e.preventDefault(); undoTap(); return; }
    if (e.code === "KeyP" || e.code === "KeyK") { e.preventDefault(); togglePlay(); return; }
    if (e.code === "ArrowLeft") { e.preventDefault(); rew(e.shiftKey ? 10 : 5); return; }
    if (e.code === "ArrowRight") { e.preventDefault(); fwd(5); return; }
    if (e.code === "Digit1") { e.preventDefault(); setRate(0.5); return; }
    if (e.code === "Digit2") { e.preventDefault(); setRate(0.75); return; }
    if (e.code === "Digit3") { e.preventDefault(); setRate(1); return; }
  }

  function close(): void {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey, true);
    root!.classList.remove("visible");
    opts.setPlaybackRate(1);
  }

  // ── Wire UI ──────────────────────────────────────────────────────────
  rateSel.value = "1";
  opts.setPlaybackRate(1);
  rateSel.onchange = () => {
    const r = parseFloat(rateSel.value);
    if (Number.isFinite(r)) opts.setPlaybackRate(r);
  };
  offsetInp.oninput = () => {
    offsetMs = parseInt(offsetInp.value, 10) || 0;
    offsetVal.textContent = `${offsetMs} ms`;
  };
  offsetVal.textContent = `${offsetMs} ms`;
  btnRew10.onclick = () => rew(10);
  btnRew5.onclick = () => rew(5);
  btnFwd5.onclick = () => fwd(5);
  btnPlay.onclick = () => togglePlay();
  btnPlayUnder.onclick = () => togglePlay();
  btnSave.onclick = async () => {
    btnSave!.disabled = true;
    setStatus("Zapisuję…", "#9ec5ff");
    try {
      await opts.onSave(words);
      setStatus("Zapisano ✓", "#80ffa0");
    } catch (e) {
      setStatus(`Błąd zapisu: ${e}`, "#ff8080");
    } finally {
      btnSave!.disabled = false;
    }
  };
  btnClose.onclick = () => close();

  document.addEventListener("keydown", onKey, true);
  root.classList.add("visible");
  setStatus(words.length > 0 ? `Słowo ${cursor + 1} / ${words.length}` : "Brak słów do otagowania", words.length > 0 ? "#9ec5ff" : "#ffc080");
  renderRail();
  tick();

  return {
    close,
    isOpen: () => open,
  };
}
