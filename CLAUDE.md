# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # dev server at localhost:5173 (auto-opens browser)
npm run build      # tsc --noEmit type check, then vite build → dist/
npm run preview    # serve dist/ locally

# Whisper transcription server (optional, Python)
pip install -r requirements-whisper.txt
python whisper_server.py   # FastAPI on localhost:8000
```

There are no tests. Type-checking (`tsc --noEmit`) is the only automated correctness check — run it before building.

## Architecture

The app is a **browser-only SPA** (no backend required). All state lives in IndexedDB; audio is stored as Blobs. Entry point: `index.html` + `src/main.ts`.

### Core data type

Everything flows through `AlignedWord` ([src/alignment.ts](src/alignment.ts)):

```ts
{ word, start_time, end_time, kind?, line_break?, verse_break?, blank_line? }
```

`kind: "label"` marks structural labels (chorus, artist name) rendered differently. `line_break` / `verse_break` force line breaks regardless of timing gap. `blank_line` adds visual spacing without a section break.

### Module responsibilities

| Module | Role |
|---|---|
| `main.ts` | App bootstrap, project CRUD UI, audio playback, HUD, wires everything together |
| `projects.ts` | IndexedDB v2 CRUD — stores `UserProject` (metadata + audio Blob + `AlignedWord[]`) |
| `alignment.ts` | `AlignedWord` type, `findActiveWordIndex` (binary search), `parseAlignmentJson` |
| `lyric-groups.ts` | `buildLines()` — groups words into lines using `LINE_GAP_SEC=0.5` / explicit flags |
| `visualizer.ts` | Canvas 2D renderer; three display modes: **multiline**, **rail** (karaoke scroll), **full** |
| `timeline.ts` | Canvas 2D block editor — drag/resize word timing, lasso select, pan/zoom |
| `editor.ts` | Table-based timing editor; raw JSON view; import/export |
| `livetap.ts` | Real-time spacebar tapping to record word onsets during playback |
| `fuzzy-align.ts` | Needleman-Wunsch global alignment of Whisper output → user lyrics (Polish diacritics aware) |
| `whisper-client.ts` | HTTP client for the local Whisper FastAPI server |
| `lrc.ts` | Export to standard LRC and enhanced LRC (word-level, compatible with Spotify/Apple Music) |

### Data flow

```
Audio file + lyrics text/JSON
        ↓ (project creation)
   IndexedDB (UserProject)
        ↓ (open project)
  AlignedWord[] in memory
        ↓ (3 parallel paths)
  Visualizer  ←→  Timeline editor  ←→  LiveTap / Whisper alignment
        ↓
  Save → IndexedDB  |  Export → JSON / LRC / LRC+
```

### Lyrics input formats

- **JSON** (`lyricsKind: "json"`): `{ aligned_lyrics: AlignedWord[] }` — timings already present (e.g. from Sonauto API)
- **Text** (`lyricsKind: "text"`): plain lyrics; timings distributed evenly across audio duration on load; `rawLyrics` is always preserved even after Whisper alignment so line/verse structure can be reapplied

### Whisper integration

`whisper_server.py` is a local FastAPI server (not deployed anywhere). The browser sends audio via `POST /transcribe`, gets back word-level timestamps, then `fuzzy-align.ts` runs Needleman-Wunsch to map Whisper words → user lyric words. Unmatched words get their times interpolated between neighbours. The server supports models `tiny` through `large-v3` (default `large-v3`), CUDA or CPU.

### Line-breaking logic

`buildLines()` in `lyric-groups.ts` splits words into `LyricLine[]` when either:
1. gap between consecutive words ≥ `LINE_GAP_SEC` (0.5 s), or
2. previous word has `line_break: true` or `verse_break: true`

`verse_break` means a stronger visual section separator; `blank_line` is a pure visual hint (no structural effect on grouping).

### Three.js

`three` is listed as a dependency but the main visualization uses native Canvas 2D API. Three.js is imported but currently has minimal use — do not assume 3D rendering is active.
