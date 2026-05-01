import type { WhisperResponse, WhisperWord } from "./whisper-types";

export type { WhisperWord };

const WHISPER_URL_KEY = "lyricflow_whisper_url";

export function getWhisperUrl(): string {
  return localStorage.getItem(WHISPER_URL_KEY) ?? "http://localhost:5001";
}

export function saveWhisperUrl(url: string): void {
  localStorage.setItem(WHISPER_URL_KEY, url.trim());
}

/**
 * Wysyła blob audio do lokalnego serwera Whisper i zwraca word-level timestamps.
 * Rzuca Error jeśli serwer niedostępny lub odpowiedź zawiera błąd.
 */
export async function transcribeWithWhisper(
  audioBlob: Blob,
  serverUrl: string,
  onProgress?: (msg: string) => void,
  language: "pl" | "en" = "pl",
): Promise<WhisperWord[]> {
  const isEn = language === "en";
  onProgress?.(isEn ? "Uploading audio..." : "Wysyłanie audio...");

  const form = new FormData();
  form.append("file", audioBlob, "audio.bin");

  let resp: Response;
  try {
    resp = await fetch(`${serverUrl}/transcribe`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new Error(
      isEn
        ? `Whisper server unavailable at ${serverUrl}.\nRun server: python whisper_server.py`
        : `Serwer Whisper niedostępny pod adresem ${serverUrl}.\nUruchom serwer: python whisper_server.py`,
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(isEn ? `Whisper server error (${resp.status}): ${text}` : `Błąd serwera Whisper (${resp.status}): ${text}`);
  }

  onProgress?.(isEn ? "Parsing results..." : "Parsowanie wyników...");
  const data = (await resp.json()) as WhisperResponse;

  if (!Array.isArray(data.words)) {
    throw new Error(isEn ? "Server response does not contain 'words' field." : "Odpowiedź serwera nie zawiera pola 'words'.");
  }

  return data.words;
}
