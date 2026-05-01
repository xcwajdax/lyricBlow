import type { AlignedWord } from "./alignment";
import type { WhisperWord } from "./whisper-types";

// Mapa normalizacji polskich znaków → łacińskie (dla lepszego dopasowania)
const PL_MAP: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n",
  ó: "o", ś: "s", ź: "z", ż: "z",
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .split("")
    .map((c) => PL_MAP[c] ?? c)
    .join("");
}

/** Edycja-dystans (Levenshtein) między dwoma słowami znormalizowanymi. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

type Cell = { cost: number; from: "match" | "skipUser" | "skipWhisper" };

/**
 * Globalne wyrównanie (Needleman-Wunsch uproszczone) między słowami użytkownika
 * a słowami Whispera. Zwraca mapę: userIdx → whisperIdx (lub -1 jeśli brak dopasowania).
 */
function globalAlign(
  userNorm: string[],
  whisperNorm: string[],
): number[] {
  const U = userNorm.length;
  const W = whisperNorm.length;
  const GAP = 1.2; // koszt pominięcia słowa

  const dp: Cell[][] = Array.from({ length: U + 1 }, (_, i) =>
    Array.from({ length: W + 1 }, (_, j): Cell => ({
      cost: i === 0 ? j * GAP : j === 0 ? i * GAP : 0,
      from: i === 0 ? "skipWhisper" : "skipUser",
    })),
  );
  dp[0]![0]!.from = "match";

  for (let i = 1; i <= U; i++) {
    for (let j = 1; j <= W; j++) {
      const dist = editDistance(userNorm[i - 1]!, whisperNorm[j - 1]!);
      const maxLen = Math.max(userNorm[i - 1]!.length, whisperNorm[j - 1]!.length, 1);
      const matchCost = dp[i - 1]![j - 1]!.cost + dist / maxLen;
      const skipUser = dp[i - 1]![j]!.cost + GAP;
      const skipWhisper = dp[i]![j - 1]!.cost + GAP;

      if (matchCost <= skipUser && matchCost <= skipWhisper) {
        dp[i]![j] = { cost: matchCost, from: "match" };
      } else if (skipUser <= skipWhisper) {
        dp[i]![j] = { cost: skipUser, from: "skipUser" };
      } else {
        dp[i]![j] = { cost: skipWhisper, from: "skipWhisper" };
      }
    }
  }

  // Traceback
  const mapping = new Array<number>(U).fill(-1);
  let i = U, j = W;
  while (i > 0 || j > 0) {
    const cell = dp[i]![j]!;
    if (cell.from === "match" && i > 0 && j > 0) {
      const dist = editDistance(userNorm[i - 1]!, whisperNorm[j - 1]!);
      const maxLen = Math.max(userNorm[i - 1]!.length, whisperNorm[j - 1]!.length, 1);
      if (dist / maxLen < 0.6) {
        mapping[i - 1] = j - 1;
      }
      i--;
      j--;
    } else if (cell.from === "skipUser" && i > 0) {
      i--;
    } else {
      j--;
    }
  }

  return mapping;
}

/**
 * Dopasowuje timings Whispera do słów użytkownika za pomocą DP alignment.
 * Słowa bez dopasowania otrzymują interpolowane czasy między sąsiadami.
 * Nie mutuje oryginałów.
 */
export function alignWhisperToLyrics(
  userWords: AlignedWord[],
  whisperWords: WhisperWord[],
): AlignedWord[] {
  const userNorm = userWords.map((w) => normalize(w.word));
  const whisperNorm = whisperWords.map((w) => normalize(w.word));
  const mapping = globalAlign(userNorm, whisperNorm);

  const result: AlignedWord[] = userWords.map((w) => ({ ...w }));

  // Pierwsza pętla: zastosuj bezpośrednie dopasowania
  for (let i = 0; i < userWords.length; i++) {
    const wi = mapping[i];
    if (wi !== undefined && wi >= 0) {
      const ww = whisperWords[wi]!;
      result[i]!.start_time = ww.start;
      result[i]!.end_time = ww.end;
    }
  }

  // Druga pętla: interpoluj niesparowane słowa
  for (let i = 0; i < result.length; i++) {
    if (mapping[i] !== undefined && mapping[i]! >= 0) continue;

    // Znajdź poprzednie i następne dopasowane
    let prevT = 0;
    let nextT = result[result.length - 1]!.end_time;

    for (let k = i - 1; k >= 0; k--) {
      if (mapping[k] !== undefined && mapping[k]! >= 0) {
        prevT = result[k]!.end_time;
        break;
      }
    }
    let nextIdx = result.length;
    for (let k = i + 1; k < result.length; k++) {
      if (mapping[k] !== undefined && mapping[k]! >= 0) {
        nextT = result[k]!.start_time;
        nextIdx = k;
        break;
      }
    }

    // Policz ile niesparowanych słów w tym ciągłym fragmencie
    const gapWords: number[] = [];
    for (let k = i; k < nextIdx; k++) {
      if (mapping[k] === undefined || mapping[k]! < 0) gapWords.push(k);
    }
    const n = gapWords.length;
    const slotDur = (nextT - prevT) / (n + 1);

    for (let g = 0; g < gapWords.length; g++) {
      const start = prevT + slotDur * (g + 1);
      const end = Math.min(nextT, start + slotDur * 0.85);
      result[gapWords[g]!]!.start_time = Math.round(start * 1000) / 1000;
      result[gapWords[g]!]!.end_time = Math.round(end * 1000) / 1000;
    }
    // Pomiń do końca fragmentu
    i = nextIdx - 1;
  }

  return result;
}
