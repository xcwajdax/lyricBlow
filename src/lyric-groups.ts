import type { AlignedWord } from "./alignment";

export const LINE_GAP_SEC = 0.5;
export const SECTION_GAP_SEC = 1.8;

export type LyricLine = {
  /** Globalne indeksy słów w tablicy aligned_lyrics. */
  indices: number[];
  /** start_time pierwszego słowa w linii. */
  startTime: number;
};

/**
 * Grupuje słowa w linie (wiersze) wg progu LINE_GAP_SEC.
 * Nie rozróżnia sekcji — to robi visualizer.ts z własną logiką etykiet.
 */
export function buildLines(words: AlignedWord[]): LyricLine[] {
  if (words.length === 0) return [];

  const lines: LyricLine[] = [];
  let curLine: number[] = [0];

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const cur = words[i]!;
    const gap = cur.start_time - prev.end_time;
    // Jawne flagi (line_break/verse_break) przebijają próg gap'u — pozwalają
    // łamać linie nawet gdy słowa są blisko siebie czasowo.
    const explicitBreak = prev.line_break === true || prev.verse_break === true;
    if (explicitBreak || gap >= LINE_GAP_SEC) {
      lines.push({ indices: curLine, startTime: words[curLine[0]!]!.start_time });
      curLine = [];
    }
    curLine.push(i);
  }
  if (curLine.length) {
    lines.push({ indices: curLine, startTime: words[curLine[0]!]!.start_time });
  }
  return lines;
}

export type VerseRange = { start: number; end: number };

/**
 * Dzieli słowa na zwrotki: nowa zwrotka zaczyna się na indeksie i, gdy i > 0
 * i poprzednie słowo ma verse_break (koniec poprzedniej zwrotki).
 */
export function buildVerseRanges(words: AlignedWord[]): VerseRange[] {
  if (words.length === 0) return [];
  const ranges: VerseRange[] = [];
  let start = 0;
  for (let i = 1; i <= words.length; i++) {
    const atEnd = i === words.length;
    const breakAfterPrev = !atEnd && words[i - 1]!.verse_break === true;
    if (atEnd || breakAfterPrev) {
      ranges.push({ start, end: i - 1 });
      start = i;
    }
  }
  return ranges;
}
