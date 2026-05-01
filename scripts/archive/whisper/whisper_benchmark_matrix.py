#!/usr/bin/env python3
"""
Seria transkrypcji Whisper z różnymi modelami i opcjami; jedna tabela z czasem i podobieństwem do referencji.
(Zarchiwizowane — zobacz README.txt w tym katalogu.)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


def strip_section_markers(text: str) -> str:
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


@dataclass
class Case:
    name: str
    model: str
    language: str | None
    transcribe_kwargs: dict[str, Any]


def build_cases(initial_prompt: str | None) -> list[Case]:
    base: list[Case] = []
    for m in ("tiny", "small", "medium"):
        base.append(Case(f"{m}-lang-auto", m, None, {}))
        base.append(Case(f"{m}-lang-en", m, "en", {}))

    extra = [
        Case(
            "medium-en-beam10",
            "medium",
            "en",
            {"beam_size": 10},
        ),
        Case(
            "medium-en-greedy-temp0",
            "medium",
            "en",
            {"beam_size": None, "temperature": (0.0,)},
        ),
        Case(
            "medium-en-no-prev-context",
            "medium",
            "en",
            {"condition_on_previous_text": False},
        ),
    ]
    if initial_prompt:
        extra.append(
            Case(
                "medium-en-initial-prompt",
                "medium",
                "en",
                {"initial_prompt": initial_prompt},
            )
        )
    return base + extra


def main() -> int:
    # scripts/archive/whisper/this_file.py → katalog główny repozytorium
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    default_audio = repo_root / "assets" / "Appstain Logic - Tiny Hands Tiny Plans - Sonauto.mp3"
    default_lyrics = repo_root / "assets" / "lyrics.txt"
    default_model_dir = Path(r"Z:\MODELS\Whisper")

    p = argparse.ArgumentParser(description="Macierz testów Whisper vs lyrics")
    p.add_argument("--audio", type=Path, default=default_audio)
    p.add_argument("--lyrics", type=Path, default=default_lyrics)
    p.add_argument("--model-dir", type=Path, default=default_model_dir)
    p.add_argument(
        "--no-initial-prompt-test",
        action="store_true",
        help="Pomiń test z initial_prompt z początku referencji",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="Wypisz wyniki jako JSON (tablica obiektów)",
    )
    args = p.parse_args()

    if not args.audio.is_file():
        print(f"Brak audio: {args.audio}", file=sys.stderr)
        return 1
    if not args.lyrics.is_file():
        print(f"Brak lyrics: {args.lyrics}", file=sys.stderr)
        return 1

    try:
        import torch
        import whisper
    except ImportError:
        print("Wymagane: pip install openai-whisper torch", file=sys.stderr)
        return 1

    ref = strip_section_markers(
        args.lyrics.read_text(encoding="utf-8", errors="replace")
    )
    prompt = None
    if not args.no_initial_prompt_test:
        prompt = ref[:220].strip() if ref else None

    cases = build_cases(prompt)
    for c in cases:
        pt = args.model_dir / f"{c.model}.pt"
        if not pt.is_file():
            print(f"Brak modelu {pt} — pomijam przypadki z {c.model}", file=sys.stderr)
            return 1

    fp16 = torch.cuda.is_available()
    device = "cuda" if fp16 else "cpu"
    rows: list[dict[str, Any]] = []
    loaded_name: str | None = None
    model = None

    for c in cases:
        if c.model != loaded_name:
            if model is not None:
                del model
            t_load = time.perf_counter()
            model = whisper.load_model(
                c.model,
                download_root=str(args.model_dir),
                device=device,
            )
            load_s = time.perf_counter() - t_load
            loaded_name = c.model
            if not args.json:
                print(f"[load] {c.model} ({device}) {load_s:.1f}s", flush=True)

        kw: dict[str, Any] = {
            "fp16": fp16,
            "verbose": False,
        }
        if c.language:
            kw["language"] = c.language
        for k, v in c.transcribe_kwargs.items():
            if k == "beam_size" and v is None:
                continue
            kw[k] = v

        t0 = time.perf_counter()
        result = model.transcribe(str(args.audio), **kw)
        elapsed = time.perf_counter() - t0
        hyp = (result.get("text") or "").strip()
        sim = word_similarity(ref, hyp)
        rows.append(
            {
                "case": c.name,
                "model": c.model,
                "language": c.language or "auto",
                "extra": {
                    k: v
                    for k, v in c.transcribe_kwargs.items()
                    if v is not None and v != {}
                },
                "time_sec": round(elapsed, 2),
                "similarity": round(sim, 4),
                "hyp_chars": len(hyp),
                "hyp_preview": hyp[:180].replace("\n", " ") + ("…" if len(hyp) > 180 else ""),
            }
        )
        if not args.json:
            print(
                f"  {c.name:32} sim={sim:.3f} time={elapsed:.1f}s len={len(hyp)}",
                flush=True,
            )

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print()
        print("| case | model | lang | time (s) | similarity |")
        print("|---|---|---:|---:|---:|")
        for r in rows:
            print(
                f"| {r['case']} | {r['model']} | {r['language']} | {r['time_sec']} | {r['similarity']} |"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
