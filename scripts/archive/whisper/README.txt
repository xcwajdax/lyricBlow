Archiwum (2026-04): eksperymenty OpenAI Whisper vs referencyjny lyrics.txt.
Nie jest częścią głównego produktu — zachowane do odtworzenia benchmarków.

Uruchomienie z katalogu głównego repozytorium (lyric):
  pip install openai-whisper torch
  python scripts/archive/whisper/compare_whisper_lyrics.py "assets/nagranie.mp3"
  python scripts/archive/whisper/whisper_benchmark_matrix.py

Wagi .pt: domyślnie Z:\MODELS\Whisper (override: --model-dir).
