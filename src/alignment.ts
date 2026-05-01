export type AlignedWord = {
  word: string;
  start_time: number;
  end_time: number;
  /** Etykieta strukturalna (np. "Refren", imię wokalisty) — renderowana inaczej w wizualizatorze. */
  kind?: "label";
  /** Po tym słowie kończy się linijka (wymusza łamanie w wizualizatorze niezależnie od gap'u). */
  line_break?: boolean;
  /** Po tym słowie kończy się zwrotka/sekcja (mocniejsza separacja niż line_break). */
  verse_break?: boolean;
  /** Po tej linii w źródle była pusta linia — wizualny odstęp, NIE tworzy verse_break. */
  blank_line?: boolean;
};

export type AlignmentPayload = {
  aligned_lyrics: AlignedWord[];
};

export function findActiveWordIndex(
  words: AlignedWord[],
  timeSeconds: number,
): number {
  if (words.length === 0) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid]!;
    if (timeSeconds < w.start_time) hi = mid - 1;
    else if (timeSeconds >= w.end_time) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function parseAlignmentJson(text: string): AlignmentPayload {
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("Alignment JSON: oczekiwany obiekt");
  }
  const aligned = (data as { aligned_lyrics?: unknown }).aligned_lyrics;
  if (!Array.isArray(aligned)) {
    throw new Error("Alignment JSON: brak tablicy aligned_lyrics");
  }
  const words: AlignedWord[] = aligned.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`aligned_lyrics[${i}]: oczekiwany obiekt`);
    }
    const o = raw as Record<string, unknown>;
    const word = o.word;
    const start = o.start_time;
    const end = o.end_time;
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") {
      throw new Error(`aligned_lyrics[${i}]: word/start_time/end_time`);
    }
    const out: AlignedWord = { word, start_time: start, end_time: end };
    if (o.kind === "label") out.kind = "label";
    if (o.line_break === true) out.line_break = true;
    if (o.verse_break === true) out.verse_break = true;
    if (o.blank_line === true) out.blank_line = true;
    return out;
  });
  return { aligned_lyrics: words };
}
