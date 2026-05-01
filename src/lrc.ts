import type { AlignedWord } from "./alignment";
import { buildLines } from "./lyric-groups";

function fmtLrc(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const mm = Math.floor(sec / 60);
  const ss = Math.floor(sec % 60);
  const xx = Math.floor((sec % 1) * 100);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(xx).padStart(2, "0")}`;
}

/**
 * Generuje plik LRC z timingami.
 *
 * enhanced=false → standard LRC: [MM:SS.xx] linia tekstu
 * enhanced=true  → enhanced LRC (Spotify/Apple Music): [MM:SS.xx] <MM:SS.xx>słowo1 <MM:SS.xx>słowo2 …
 */
export function generateLrc(words: AlignedWord[], enhanced: boolean): string {
  const lines = buildLines(words);
  const rows: string[] = [];
  for (const line of lines) {
    if (line.indices.length === 0) continue;
    const firstWord = words[line.indices[0]!]!;
    const lineTag = `[${fmtLrc(firstWord.start_time)}]`;
    if (enhanced) {
      const wordTags = line.indices
        .map((idx) => {
          const w = words[idx]!;
          return `<${fmtLrc(w.start_time)}>${w.word}`;
        })
        .join(" ");
      rows.push(`${lineTag} ${wordTags}`);
    } else {
      const text = line.indices.map((idx) => words[idx]!.word).join(" ");
      rows.push(`${lineTag} ${text}`);
    }
  }
  return rows.join("\n") + "\n";
}

export function downloadLrc(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
