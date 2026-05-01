# Lyric Visualizer (Local-First)

Lyric Visualizer is a browser SPA for syncing lyrics to music, editing word timings, and exporting subtitle formats for karaoke-style playback.

## Privacy & Local Processing

- The app runs locally in your browser.
- Projects are stored in your local IndexedDB.
- Audio files remain local as browser `Blob`s.
- Lyrics, timings, and edits are not sent to cloud services by default.
- Optional Whisper integration calls your own local server (for example `http://localhost:5001`) when you explicitly use it.

## Features

- Project picker with built-in fixtures and local project storage.
- Timing editor for word-level start/end times.
- Timeline editing with selection, zoom/pan, and waveform sync.
- Three lyric display modes: multiline, rail, full text.
- Live TAP mode for real-time keyboard tagging.
- Export to JSON, LRC, and enhanced LRC+.

## Quick Start

### 1) Install dependencies

```bash
npm install
```

### 2) Run dev server

```bash
npm run dev
```

The app runs at `http://localhost:5173`.

### 3) Build for production

```bash
npm run build
```

## Deploy on GitHub Pages

The repository now includes a workflow at `.github/workflows/deploy-pages.yml` that builds and deploys `dist/` to GitHub Pages on every push to `main`.

### One-time setup

1. Push the repository to GitHub.
2. Open repository settings: `Settings -> Pages`.
3. In **Build and deployment**, set **Source** to **GitHub Actions**.
4. Push to `main` (or run the workflow manually from the Actions tab).

After the workflow completes, your app will be live at the Pages URL shown in the deployment job.

## Live TAP Quick Start

1. Open or create a project with audio + lyrics.
2. Click `LiveTap` in the bottom HUD.
3. Press `Space` while audio plays to mark word timing.
4. Use `Backspace` to undo last tap.
5. Use `P/K` for play/pause and arrow keys for seek.
6. Save with `Ctrl+S`, then refine in Timeline/Timing Editor if needed.

## Optional Whisper Server

If you want automatic alignment support, run a local Whisper server and point the app to it.

```bash
pip install -r requirements-whisper.txt
python whisper_server.py
```

Then use the Whisper controls in the timing editor.

## Export Formats

- `JSON`: aligned words with start/end timestamps.
- `LRC`: line-level lyric timing.
- `LRC+`: word-level enhanced lyric timing.

## Tech Stack

- TypeScript
- Vite
- Canvas 2D rendering
- IndexedDB (local persistence)

## Roadmap

- Better first-run tutorials for project setup and Live TAP workflow.
- Additional import/export format compatibility.
- UX refinements for large lyric projects and faster batch edits.
