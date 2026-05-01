import type { AlignedWord } from "./alignment";
import { buildLines, buildVerseRanges } from "./lyric-groups";
import { generateLrc, downloadLrc } from "./lrc";

export type EditorOptions = {
  initialWords: AlignedWord[];
  projectName: string;
  /** Bieżący czas odtwarzania w sekundach (do przycisków „ustaw = teraz"). */
  getCurrentTime: () => number;
  /** Długość całego utworu w sekundach (do auto-fill „Rozłóż równomiernie"). */
  getDuration: () => number;
  /** Skok audio do podanego czasu (do podglądu danego słowa). */
  seekTo: (seconds: number) => void;
  /** Wywoływane przy każdej zmianie — aktualizuje wizualizację na żywo. */
  onLiveUpdate: (words: AlignedWord[]) => void;
  /** Wywoływane po kliknięciu „Zapisz". Powinno utrwalić timingi (IndexedDB itd.). */
  onSave: (words: AlignedWord[]) => void | Promise<void>;
  /** Kliknięcie przycisku Whisper. */
  onWhisperRequest?: () => void;
  /**
   * Mutowalny ref wypełniany przez editor przy otwarciu.
   * Pozwala zewnętrznemu kodu przewijać do wiersza (np. z wizualizatora).
   */
  externalSelectRef?: { scrollTo: ((idx: number) => void) | null };
  /** Wywoływane przy zmianie zaznaczenia (do podświetlenia w wizualizatorze). */
  onSelectionChange?: (indices: Set<number>) => void;
  /**
   * Mutowalny ref przez który zewnętrzny kod może wstrzyknąć sugestie Whisper.
   */
  suggestionsRef?: { apply: ((s: AlignedWord[] | null) => void) | null };
  language?: "pl" | "en";
};

export function alignedLyricsToJson(words: AlignedWord[]): string {
  return JSON.stringify({ aligned_lyrics: words }, null, 2);
}

export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFilename(name: string): string {
  return (name.trim() || "aligned").replace(/[^\w\-. ]+/g, "_").slice(0, 80);
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return (Math.round(n * 1000) / 1000).toString();
}

export function openTimingEditor(opts: EditorOptions): { close(): boolean } {
  const isEn = opts.language === "en";
  const t = (pl: string, en: string): string => (isEn ? en : pl);
  const root = document.getElementById("editor-modal");
  const tableBody = document.getElementById("ed-tbody") as HTMLTableSectionElement;
  const btnClose = document.getElementById("ed-close") as HTMLButtonElement;
  const btnSave = document.getElementById("ed-save") as HTMLButtonElement;
  const btnDownload = document.getElementById("ed-download") as HTMLButtonElement;
  const btnAdd = document.getElementById("ed-add") as HTMLButtonElement;
  const btnSort = document.getElementById("ed-sort") as HTMLButtonElement;
  const btnAutofill = document.getElementById("ed-autofill") as HTMLButtonElement;
  const btnToggleLabel = document.getElementById("ed-toggle-label") as HTMLButtonElement | null;
  const btnMarkLine = document.getElementById("ed-mark-line") as HTMLButtonElement | null;
  const btnMarkVerse = document.getElementById("ed-mark-verse") as HTMLButtonElement | null;
  const btnClearBreaks = document.getElementById("ed-clear-breaks") as HTMLButtonElement | null;
  const btnExportLrc = document.getElementById("ed-export-lrc") as HTMLButtonElement;
  const btnExportLrcPlus = document.getElementById("ed-export-lrc-plus") as HTMLButtonElement;
  const btnToggleRaw = document.getElementById("ed-toggle-raw") as HTMLButtonElement | null;
  const rawWrap = document.getElementById("ed-raw-wrap") as HTMLElement | null;
  const rawPre = document.getElementById("ed-raw-json") as HTMLElement | null;
  const status = document.getElementById("ed-status")!;
  const tapHint = document.getElementById("ed-tap-hint")!;
  const whisperRow = document.getElementById("ed-whisper-row")!;
  const btnWhisper = document.getElementById("ed-whisper") as HTMLButtonElement;
  const btnAcceptAll = document.getElementById("ed-accept-all") as HTMLButtonElement;
  const btnRejectAll = document.getElementById("ed-reject-all") as HTMLButtonElement;
  const whisperStatus = document.getElementById("ed-whisper-status")!;
  if (!root || !tableBody) return { close: () => true };

  // Deep copy — nie modyfikujemy oryginału aż do save.
  const words: AlignedWord[] = opts.initialWords.map((w) => ({ ...w }));

  /** Sugestie timingów z Whispera (indeks = globalny indeks słowa). */
  let suggestions: AlignedWord[] | null = null;

  /** Indeks aktualnie aktywnego wiersza (do tap-mode). */
  let activeRow = 0;
  /** Wielokrotna selekcja (do akcji grupowych — Etykieta/Linijka/Zwrotka). */
  const selected = new Set<number>();
  /** Anchor do shift-click. */
  let selectionAnchor: number | null = null;
  let dirty = false;
  /** Zwinięte zwrotki (indeks 0-based w buildVerseRanges). */
  const collapsedVerses = new Set<number>();

  // —————————— Historia (undo / redo) ——————————
  type Snapshot = AlignedWord[];
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  const HISTORY_LIMIT = 100;
  let rawVisible = false;

  function cloneWords(): Snapshot {
    return words.map((w) => ({ ...w }));
  }

  function pushHistory(): void {
    undoStack.push(cloneWords());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  function refreshRawJson(): void {
    if (!rawVisible || !rawPre) return;
    rawPre.textContent = alignedLyricsToJson(words);
  }

  function restoreFrom(snap: Snapshot): void {
    words.length = 0;
    for (const w of snap) words.push({ ...w });
    selected.clear();
    selectionAnchor = null;
    if (activeRow >= words.length) activeRow = Math.max(0, words.length - 1);
    dirty = true;
    status.textContent = t("Cofnięto / przywrócono", "Undone / redone");
    status.style.color = "#9ec5ff";
    opts.onLiveUpdate(cloneWords());
    render();
    refreshRawJson();
  }

  function undo(): void {
    const prev = undoStack.pop();
    if (!prev) return;
    redoStack.push(cloneWords());
    restoreFrom(prev);
  }

  function redo(): void {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(cloneWords());
    restoreFrom(next);
  }

  function verseIndexForWord(wordIdx: number): number {
    const ranges = buildVerseRanges(words);
    for (let v = 0; v < ranges.length; v++) {
      const r = ranges[v]!;
      if (wordIdx >= r.start && wordIdx <= r.end) return v;
    }
    return 0;
  }

  function applySelectionClasses(): void {
    for (const tr of Array.from(tableBody.querySelectorAll("tr[data-i]"))) {
      const idx = Number((tr as HTMLElement).dataset.i);
      if (!Number.isFinite(idx)) continue;
      tr.classList.toggle("selected", selected.has(idx));
    }
    opts.onSelectionChange?.(new Set(selected));
  }

  /** Indeksy do działań grupowych: selekcja jeśli niepusta, inaczej activeRow. */
  function targetIndices(): number[] {
    if (selected.size > 0) return Array.from(selected).sort((a, b) => a - b);
    return [activeRow];
  }

  function setDirty(): void {
    dirty = true;
    status.textContent = t("Niezapisane zmiany", "Unsaved changes");
    status.style.color = "#ffc080";
    opts.onLiveUpdate(words.map((w) => ({ ...w })));
    refreshRawJson();
  }

  function applySuggestions(s: AlignedWord[] | null): void {
    suggestions = s;
    if (s) {
      whisperStatus.textContent = isEn ? `${s.length} suggestions ready` : `${s.length} sugestii gotowych`;
      btnAcceptAll.style.display = "";
      btnRejectAll.style.display = "";
    } else {
      whisperStatus.textContent = "";
      btnAcceptAll.style.display = "none";
      btnRejectAll.style.display = "none";
    }
    render();
  }

  function setActive(i: number): void {
    const newI = Math.max(0, Math.min(words.length - 1, i));
    const v = verseIndexForWord(newI);
    const needRerender = collapsedVerses.has(v);
    collapsedVerses.delete(v);
    activeRow = newI;
    if (needRerender) {
      render();
      tableBody.querySelector(`tr[data-i="${activeRow}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    for (const tr of Array.from(tableBody.querySelectorAll("tr[data-i]"))) {
      tr.classList.remove("active");
    }
    const row = tableBody.querySelector(`tr[data-i="${activeRow}"]`);
    row?.classList.add("active");
    row?.scrollIntoView({ block: "nearest" });
  }

  function scrollToWord(i: number): void {
    setActive(i);
  }

  function render(): void {
    tableBody.innerHTML = "";
    const verseRanges = buildVerseRanges(words);
    const lineIdxByWord: number[] = new Array(words.length).fill(0);
    buildLines(words).forEach((line, lineIdx) => {
      for (const wi of line.indices) lineIdxByWord[wi] = lineIdx;
    });

    const versePreview = (start: number, end: number): string => {
      const parts: string[] = [];
      const maxWords = 22;
      for (let j = start; j <= end && parts.length < maxWords; j++) {
        const token = words[j]?.word?.trim();
        if (token) parts.push(token);
      }
      const hasMore = (end - start + 1) > parts.length;
      if (!parts.length) return "…";
      return `${parts.join(" ")}${hasMore ? " …" : ""}`;
    };

    for (let v = 0; v < verseRanges.length; v++) {
      const { start, end } = verseRanges[v]!;
      const nWords = end - start + 1;
      const collapsed = collapsedVerses.has(v);

      const headerTr = document.createElement("tr");
      headerTr.className = "ed-verse-header";
      headerTr.dataset.verse = String(v);
      headerTr.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const tdH = document.createElement("td");
      tdH.className = "ed-verse-header-cell";
      const chevron = document.createElement("span");
      chevron.className = "ed-verse-chevron";
      chevron.textContent = collapsed ? "▶" : "▼";
      const title = document.createElement("span");
      title.className = "ed-verse-title";
      title.textContent = isEn
        ? `Verse ${v + 1} · ${nWords} words`
        : (verseRanges.length === 1 ? `Zwrotka 1 · ${nWords} słów` : `Zwrotka ${v + 1} · ${nWords} słów`);
      const preview = document.createElement("span");
      preview.className = "ed-verse-preview";
      preview.textContent = versePreview(start, end);
      const topRow = document.createElement("div");
      topRow.className = "ed-verse-header-top";
      topRow.append(chevron, title);
      tdH.append(topRow);
      const tdPreview = document.createElement("td");
      tdPreview.className = "ed-verse-preview-cell";
      tdPreview.colSpan = 4;
      tdPreview.append(preview);
      headerTr.append(tdH, tdPreview);
      headerTr.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (collapsedVerses.has(v)) collapsedVerses.delete(v);
        else collapsedVerses.add(v);
        render();
      });
      tableBody.appendChild(headerTr);

      for (let i = start; i <= end; i++) {
        const w = words[i]!;
        const lineIdx = lineIdxByWord[i] ?? 0;
        const tr = document.createElement("tr");
        tr.dataset.i = String(i);
        tr.dataset.v = String(v);
        if (collapsed) tr.classList.add("ed-verse-row-hidden");
        if (lineIdx % 2 === 0) tr.classList.add("ed-line-even");
        else tr.classList.add("ed-line-odd");
        if (i === activeRow) tr.classList.add("active");
        if (selected.has(i)) tr.classList.add("selected");
        if (w.kind === "label") tr.classList.add("label");
        if (w.line_break) tr.classList.add("line-break");
        if (w.verse_break) tr.classList.add("verse-break");
        if (w.blank_line) tr.classList.add("blank-line");

      const tdIdx = document.createElement("td");
      tdIdx.className = "idx";
      tdIdx.textContent = String(i + 1);

      const tdWord = document.createElement("td");
      tdWord.className = "word-cell";
      const wInput = document.createElement("input");
      wInput.type = "text";
      wInput.value = w.word;
      wInput.className = "ed-word";
      wInput.addEventListener("focus", () => pushHistory());
      wInput.addEventListener("input", () => { w.word = wInput.value; setDirty(); });
      tdWord.appendChild(wInput);

      const mkTimeCell = (which: "start_time" | "end_time"): HTMLTableCellElement => {
        const td = document.createElement("td");
        td.className = "time-cell";
        const field = document.createElement("span");
        field.className = "ed-time-field";

        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = "0.01";
        inp.min = "0";
        inp.value = fmtNum(w[which]);
        inp.className = "ed-time";
        inp.addEventListener("focus", () => pushHistory());
        inp.addEventListener("input", () => {
          const v = parseFloat(inp.value);
          w[which] = Number.isFinite(v) ? v : 0;
          setDirty();
        });

        const readStep = (): number => {
          const s = parseFloat(inp.step);
          return Number.isFinite(s) && s > 0 ? s : 0.01;
        };

        const spin = document.createElement("span");
        spin.className = "ed-time-spin";
        spin.setAttribute("aria-hidden", "true");

        const mkStepBtn = (dir: 1 | -1): HTMLButtonElement => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = `ed-time-step ${dir === 1 ? "ed-time-up" : "ed-time-down"}`;
          b.textContent = dir === 1 ? "▲" : "▼";
          b.tabIndex = -1;
          const st = readStep();
          b.title = dir === 1 ? `+${st} s` : `−${st} s`;
          b.addEventListener("click", () => {
            pushHistory();
            const v = parseFloat(inp.value);
            const base = Number.isFinite(v) ? v : 0;
            const step = readStep();
            const next = Math.max(0, Math.round((base + dir * step) * 1000) / 1000);
            w[which] = next;
            inp.value = fmtNum(next);
            setDirty();
          });
          return b;
        };
        spin.append(mkStepBtn(1), mkStepBtn(-1));

        const setBtn = document.createElement("button");
        setBtn.type = "button";
        setBtn.className = "ed-now";
        setBtn.title = t("Ustaw na bieżący czas odtwarzania", "Set to current playback time");
        setBtn.textContent = "⊙";
        setBtn.addEventListener("click", () => {
          pushHistory();
          const t = opts.getCurrentTime();
          w[which] = Math.round(t * 1000) / 1000;
          inp.value = fmtNum(w[which]);
          setDirty();
        });

        field.append(inp, spin);
        td.append(field, setBtn);
        return td;
      };

      const tdStart = mkTimeCell("start_time");
      const tdEnd = mkTimeCell("end_time");

      const tdActions = document.createElement("td");
      tdActions.className = "actions";

      const labelBtn = document.createElement("button");
      labelBtn.type = "button";
      labelBtn.title = w.kind === "label"
        ? t("Przywróć jako zwykłe słowo", "Restore as regular word")
        : t("Promuj do etykiety (np. Refren, imię wokalisty)", "Promote to label (e.g. Chorus, vocalist name)");
      labelBtn.textContent = w.kind === "label" ? "Aa" : "🏷";
      labelBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pushHistory();
        if (w.kind === "label") delete w.kind;
        else w.kind = "label";
        setDirty();
        render();
      });

      const insBtn = document.createElement("button");
      insBtn.type = "button";
      insBtn.title = t("Wstaw nowe słowo poniżej", "Insert new word below");
      insBtn.textContent = "+";
      insBtn.addEventListener("click", () => {
        pushHistory();
        words.splice(i + 1, 0, { word: "", start_time: w.end_time, end_time: w.end_time });
        selected.clear();
        selectionAnchor = null;
        setDirty();
        render();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.title = t("Usuń słowo", "Delete word");
      delBtn.textContent = "✕";
      delBtn.className = "danger";
      delBtn.addEventListener("click", () => {
        pushHistory();
        words.splice(i, 1);
        if (activeRow >= words.length) activeRow = Math.max(0, words.length - 1);
        selected.clear();
        selectionAnchor = null;
        setDirty();
        render();
      });

      tdActions.append(labelBtn, insBtn, delBtn);

      // Sugestia Whisper
      const sugg = suggestions?.[i];
      if (sugg) {
        tr.classList.add("suggestion");
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "accept-sug";
        acceptBtn.title = `Whisper: start=${fmtNum(sugg.start_time)} end=${fmtNum(sugg.end_time)}`;
        acceptBtn.textContent = "✓";
        acceptBtn.addEventListener("click", () => {
          pushHistory();
          w.start_time = sugg.start_time;
          w.end_time = sugg.end_time;
          if (suggestions) suggestions[i] = undefined as unknown as AlignedWord;
          setDirty();
          render();
        });
        tdActions.appendChild(acceptBtn);
      }

      tr.append(tdIdx, tdWord, tdStart, tdEnd, tdActions);
      tr.addEventListener("click", (ev) => {
        const target = ev.target as HTMLElement;
        const tag = target.tagName;
        // Nie kradnij focusa inputom/przyciskom — pozwól im działać normalnie.
        if (tag === "INPUT" || tag === "BUTTON") return;

        if (ev.shiftKey && selectionAnchor !== null) {
          // Zakres od anchora do i.
          const lo = Math.min(selectionAnchor, i);
          const hi = Math.max(selectionAnchor, i);
          selected.clear();
          for (let k = lo; k <= hi; k++) selected.add(k);
          setActive(i);
          applySelectionClasses();
          return;
        }
        if (ev.ctrlKey || ev.metaKey) {
          // Toggle pojedynczego wiersza.
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
          selectionAnchor = i;
          setActive(i);
          applySelectionClasses();
          return;
        }
        // Zwykły klik: wyczyść selekcję, ustaw aktywny i przewiń audio do start_time.
        selected.clear();
        selectionAnchor = i;
        setActive(i);
        applySelectionClasses();
        opts.seekTo(w.start_time);
      });
      tableBody.appendChild(tr);
      }
    }
  }

  function close(): boolean {
    if (dirty && !confirm(t("Masz niezapisane zmiany. Zamknąć mimo to?", "You have unsaved changes. Close anyway?"))) return false;
    document.removeEventListener("keydown", onKey);
    root!.classList.remove("visible");
    document.body.classList.remove("editor-open");
    if (opts.externalSelectRef) opts.externalSelectRef.scrollTo = null;
    if (opts.suggestionsRef) opts.suggestionsRef.apply = null;
    opts.onSelectionChange?.(new Set());
    return true;
  }

  function onKey(e: KeyboardEvent): void {
    if (!root!.classList.contains("visible")) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    const inField = tag === "INPUT" || tag === "TEXTAREA";
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyZ" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (ctrl && (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey))) {
      e.preventDefault();
      redo();
      return;
    }
    // Tap-mode klawisze działają wyłącznie poza polami formularza:
    if (!inField) {
      if (e.code === "KeyB") {
        e.preventDefault();
        const w = words[activeRow]; if (!w) return;
        pushHistory();
        w.start_time = Math.round(opts.getCurrentTime() * 1000) / 1000;
        setDirty();
        render();
        return;
      }
      if (e.code === "KeyN") {
        e.preventDefault();
        const w = words[activeRow]; if (!w) return;
        pushHistory();
        w.end_time = Math.round(opts.getCurrentTime() * 1000) / 1000;
        setDirty();
        // automatycznie ustaw start kolejnego słowa = end bieżącego
        const next = words[activeRow + 1];
        if (next) next.start_time = w.end_time;
        setActive(activeRow + 1);
        render();
        return;
      }
      if (e.code === "ArrowDown") { e.preventDefault(); setActive(activeRow + 1); return; }
      if (e.code === "ArrowUp") { e.preventDefault(); setActive(activeRow - 1); return; }
    }
    if (e.code === "Escape") { e.preventDefault(); close(); }
  }

  btnClose.onclick = close;
  btnAdd.onclick = () => {
    pushHistory();
    const last = words[words.length - 1];
    const t = last?.end_time ?? 0;
    words.push({ word: "", start_time: t, end_time: t });
    setDirty();
    render();
  };
  btnSort.onclick = () => {
    pushHistory();
    words.sort((a, b) => a.start_time - b.start_time);
    setDirty();
    render();
  };
  btnAutofill.onclick = () => {
    if (words.length === 0) return;
    const dur = opts.getDuration();
    if (!dur || !Number.isFinite(dur) || dur <= 0) {
      status.textContent = t("Brak długości audio — wczytaj utwór, by rozłożyć równomiernie.", "No audio duration - load a track to distribute timings evenly.");
      status.style.color = "#ffc080";
      return;
    }
    pushHistory();
    // Etykiet nie ruszamy — rozkładamy tylko zwykłe słowa.
    const slots = words.filter((w) => w.kind !== "label").length;
    if (slots === 0) return;
    const step = dur / slots;
    const gap = step * 0.1; // 10% segmentu jako przerwa między słowami
    let k = 0;
    words.forEach((w) => {
      if (w.kind === "label") return;
      w.start_time = Math.round(k * step * 1000) / 1000;
      w.end_time   = Math.round(((k + 1) * step - gap) * 1000) / 1000;
      k++;
    });
    setDirty();
    render();
  };

  // —————————— Akcje grupowe (Etykieta / Linijka / Zwrotka / Wyczyść) ——————————
  btnToggleLabel?.addEventListener("click", () => {
    const idxs = targetIndices();
    if (idxs.length === 0) return;
    pushHistory();
    // Jeśli wszystkie zaznaczone już są etykietami → odetykietuj. Inaczej → ustaw etykietę.
    const allLabels = idxs.every((i) => words[i]?.kind === "label");
    for (const i of idxs) {
      const w = words[i]; if (!w) continue;
      if (allLabels) delete w.kind;
      else w.kind = "label";
    }
    setDirty();
    render();
  });

  btnMarkLine?.addEventListener("click", () => {
    const idxs = targetIndices();
    if (idxs.length === 0) return;
    // Ostatnie słowo zaznaczonej grupy dostaje line_break.
    const last = idxs[idxs.length - 1]!;
    const w = words[last]; if (!w) return;
    pushHistory();
    w.line_break = true;
    setDirty();
    render();
  });

  btnMarkVerse?.addEventListener("click", () => {
    const idxs = targetIndices();
    if (idxs.length === 0) return;
    const last = idxs[idxs.length - 1]!;
    const w = words[last]; if (!w) return;
    pushHistory();
    w.verse_break = true;
    setDirty();
    render();
  });

  btnClearBreaks?.addEventListener("click", () => {
    const idxs = targetIndices();
    if (idxs.length === 0) return;
    pushHistory();
    for (const i of idxs) {
      const w = words[i]; if (!w) continue;
      delete w.line_break;
      delete w.verse_break;
    }
    setDirty();
    render();
  });
  btnDownload.onclick = () => {
    downloadJson(`${sanitizeFilename(opts.projectName)}.json`, alignedLyricsToJson(words));
  };
  btnSave.onclick = async () => {
    btnSave.disabled = true;
    try {
      await opts.onSave(words);
      dirty = false;
      status.textContent = t("Zapisano ✓", "Saved ✓");
      status.style.color = "#80e090";
    } catch (e) {
      status.textContent = `${t("Błąd zapisu", "Save error")}: ${e instanceof Error ? e.message : String(e)}`;
      status.style.color = "#ff8888";
    } finally {
      btnSave.disabled = false;
    }
  };

  // LRC export
  btnExportLrc.onclick = () => {
    downloadLrc(`${sanitizeFilename(opts.projectName)}.lrc`, generateLrc(words, false));
  };
  btnExportLrcPlus.onclick = () => {
    downloadLrc(`${sanitizeFilename(opts.projectName)}.lrc`, generateLrc(words, true));
  };

  // Whisper
  if (opts.onWhisperRequest) {
    whisperRow.classList.add("visible");
    btnWhisper.onclick = () => opts.onWhisperRequest!();
  }
  btnAcceptAll.onclick = () => {
    if (!suggestions) return;
    pushHistory();
    for (let i = 0; i < words.length; i++) {
      const s = suggestions[i];
      if (s) {
        words[i]!.start_time = s.start_time;
        words[i]!.end_time = s.end_time;
      }
    }
    applySuggestions(null);
    setDirty();
  };
  btnRejectAll.onclick = () => applySuggestions(null);

  // RAW JSON podgląd
  btnToggleRaw?.addEventListener("click", () => {
    rawVisible = !rawVisible;
    if (rawWrap) rawWrap.hidden = !rawVisible;
    root!.classList.toggle("raw-open", rawVisible);
    refreshRawJson();
  });

  // Wypeł ref-y
  if (opts.externalSelectRef) opts.externalSelectRef.scrollTo = scrollToWord;
  if (opts.suggestionsRef) opts.suggestionsRef.apply = applySuggestions;

  tapHint.textContent = t(
    "Klik wiersza = przewiń audio do tego słowa. Shift/Ctrl-klik = wybór zakresu/wielu wierszy. Tap-mode (poza polem tekstowym): B = ustaw start, N = ustaw koniec i przejdź dalej, ↑/↓ = nawigacja.",
    "Click a row to seek audio to that word. Shift/Ctrl-click selects range/multiple rows. Tap mode (outside text field): B = set start, N = set end and move next, ↑/↓ = navigate.",
  );
  status.textContent = `${words.length} ${t("słów", "words")}`;
  status.style.color = "#9ec5ff";
  activeRow = 0;
  render();
  document.addEventListener("keydown", onKey);
  root.classList.add("visible");
  document.body.classList.add("editor-open");

  return { close };
}
