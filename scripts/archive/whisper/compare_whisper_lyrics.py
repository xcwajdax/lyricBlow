#!/usr/bin/env python3
"""
Transkrypcja audio przez OpenAI Whisper (lokalny .pt) i porównanie z referencyjnym tekstem.
(Zarchiwizowane — zobacz README.txt w tym katalogu.)

Przykład (z katalogu głównego repozytorium lyric):
  python scripts/archive/whisper/compare_whisper_lyrics.py "C:\\sciezka\\piosenka.mp3"
  python scripts/archive/whisper/compare_whisper_lyrics.py song.wav --lyrics assets/lyrics.txt
"""

from __future__ import annotations

import argparse
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path


def strip_section_markers(text: str) -> str:
    """Usuwa linie typu [Intro], [Refren] — Whisper ich nie wypowiada."""
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if re.match(r"^\[[^\]]+\]\s*$", s):
            continue
        if s:
            lines.append(s)
    return " ".join(lines)


def normalize(text: str) -> str:
    t = text.lower()
    t = re.sub(r"[^\w\s']+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def word_similarity(a: str, b: str) -> float:
    wa, wb = normalize(a).split(), normalize(b).split()
    if not wa and not wb:
        return 1.0
    if not wa or not wb:
        return 0.0
    return SequenceMatcher(None, wa, wb).ratio()


def main() -> int:
    # scripts/archive/whisper/this_file.py → katalog główny repozytorium
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    default_lyrics = repo_root / "assets" / "lyrics.txt"
    default_model_dir = Path(r"Z:\MODELS\Whisper")

    p = argparse.ArgumentParser(description="Whisper vs referencyjny lyrics.txt")
    p.add_argument("audio", type=Path, help="Plik audio (mp3, wav, m4a, …)")
    p.add_argument(
        "--lyrics",
        type=Path,
        default=default_lyrics,
        help=f"Referencja (domyślnie {default_lyrics})",
    )
    p.add_argument(
        "--model-dir",
        type=Path,
        default=default_model_dir,
        help=f"Katalog z medium.pt (domyślnie {default_model_dir})",
    )
    p.add_argument("--model", default="medium", help="Nazwa modelu bez .pt")
    p.add_argument(
        "--language",
        default=None,
        help="Kod języka Whisper, np. en (domyślnie: auto)",
    )
    p.add_argument("--device", default=None, help="cpu / cuda (domyślnie: auto)")
    args = p.parse_args()

    if not args.audio.is_file():
        print(f"Brak pliku audio: {args.audio}", file=sys.stderr)
        return 1
    if not args.lyrics.is_file():
        print(f"Brak pliku tekstowego: {args.lyrics}", file=sys.stderr)
        return 1

    pt = args.model_dir / f"{args.model}.pt"
    if not pt.is_file():
        print(f"Brak wag modelu: {pt}", file=sys.stderr)
        return 1

    try:
        import whisper
    except ImportError:
        print("Zainstaluj: pip install openai-whisper", file=sys.stderr)
        return 1

    ref_raw = args.lyrics.read_text(encoding="utf-8", errors="replace")
    ref_for_compare = strip_section_markers(ref_raw)

    print("Ładowanie modelu…")
    model = whisper.load_model(
        args.model,
        download_root=str(args.model_dir),
        device=args.device,
    )

    print("Transkrypcja (może chwilę potrwać)…")
    kwargs = {"fp16": False}
    if args.language:
        kwargs["language"] = args.language
    result = model.transcribe(str(args.audio), **kwargs)
    hyp = (result.get("text") or "").strip()

    sim = word_similarity(ref_for_compare, hyp)

    print()
    print("=== Hipoteza (Whisper) ===")
    print(hyp)
    print()
    print("=== Referencja (bez znaczników [Sekcja]) ===")
    print(ref_for_compare)
    print()
    print(f"Podobieństwo sekwencji słów (0–1, wyżej = bliżej referencji): {sim:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
