import type { AlignedWord } from "./alignment";

export type LyricsKind = "json" | "text";

export type UserProject = {
  id: string;
  name: string;
  createdAt: number;
  /** Ustawiane przy każdym zapisie słów z edytora / LiveTap / timeline. */
  updatedAt?: number;
  audioBlob: Blob;
  audioFileName: string;
  lyricsKind: LyricsKind;
  alignedLyrics?: AlignedWord[];
  rawLyrics?: string;
};

const DB_NAME = "lyric-visualizer";
// v2: switched from FileSystemFileHandle to Blob for cross-browser support.
// Old v1 entries are dropped on upgrade (handles wouldn't be usable anyway).
const DB_VERSION = 2;
const STORE = "projects";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveProject(p: UserProject): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(p);
  await txDone(tx);
  db.close();
}

export async function listProjects(): Promise<UserProject[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).getAll();
  const items = await new Promise<UserProject[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as UserProject[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getProject(id: string): Promise<UserProject | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).get(id);
  const item = await new Promise<UserProject | undefined>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as UserProject | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return item ?? null;
}

export async function updateProjectLyrics(
  id: string,
  alignedLyrics: AlignedWord[],
): Promise<UserProject | null> {
  const existing = await getProject(id);
  if (!existing) return null;
  const updated: UserProject = {
    ...existing,
    lyricsKind: "json",
    alignedLyrics,
    updatedAt: Date.now(),
    // rawLyrics CELOWO zachowujemy — pozwala później odtworzyć strukturę
    // line/verse_break z oryginalnego tekstu (overlay przy ładowaniu).
    rawLyrics: existing.rawLyrics,
  };
  await saveProject(updated);
  return updated;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
  db.close();
}

export function pickAudioFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.mp3,.wav,.m4a,.flac,.ogg,.opus";
    input.addEventListener("change", () => {
      const f = input.files?.[0] ?? null;
      resolve(f);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
