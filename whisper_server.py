#!/usr/bin/env python3
"""
Lokalny serwer Whisper dla LyricFlow.

Uruchomienie:
    pip install -r requirements-whisper.txt
    python whisper_server.py [--model large-v3] [--port 5001] [--device cuda]

Modele (od najszybszego do najdokładniejszego):
    tiny, base, small, medium, large-v2, large-v3 (rekomendowany)
"""

import argparse
import io
import tempfile
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

# ── Argumenty ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="LyricFlow Whisper Server")
parser.add_argument("--model", default="large-v3", help="Nazwa modelu Whisper")
parser.add_argument("--port", type=int, default=5001)
parser.add_argument("--device", default="cuda", help="cuda lub cpu")
parser.add_argument("--compute-type", default="float16",
                    help="float16 (GPU), int8 (CPU), float32")
args = parser.parse_args()

# ── Model (ładowany raz przy starcie) ────────────────────────────────────────

model: Optional[WhisperModel] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    print(f"[Whisper] Ładuję model '{args.model}' na urządzeniu '{args.device}'...")
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
        )
        print(f"[Whisper] Model gotowy.")
    except Exception as e:
        print(f"[Whisper] BŁĄD ładowania modelu: {e}")
        print("[Whisper] Spróbuj --device cpu --compute-type int8")
    yield
    model = None


# ── Aplikacja ─────────────────────────────────────────────────────────────────

app = FastAPI(title="LyricFlow Whisper Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "model": args.model, "device": args.device}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
):
    if model is None:
        raise HTTPException(status_code=503, detail="Model Whisper nie jest załadowany")

    audio_bytes = await file.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Pusty plik audio")

    # Zapisz do pliku tymczasowego (faster-whisper wymaga ścieżki)
    suffix = os.path.splitext(file.filename or "audio.bin")[1] or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        kwargs = {
            "word_timestamps": True,
            "beam_size": 5,
            "vad_filter": True,
        }
        if language:
            kwargs["language"] = language

        segments, info = model.transcribe(tmp_path, **kwargs)

        words_out = []
        for segment in segments:
            if segment.words:
                for w in segment.words:
                    words_out.append({
                        "word": w.word.strip(),
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                    })

        return JSONResponse({
            "words": words_out,
            "language": info.language,
            "duration": round(info.duration, 2),
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd transkrypcji: {e}") from e
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port)
