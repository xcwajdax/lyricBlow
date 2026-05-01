# Test Fixtures

## aligned.json
Mock data - polski tekst, sztuczny timing.

## sample_sonauto.json + sample_sonauto.mp3
Real output z Sonauto API v3 z `align_lyrics: true`.
- Model: v3-preview
- Prompt: "a chill lofi beat for studying"
- Duration: ~49s (wersja z alignment; pełna ~3:20)
- Word count: ~150 słów z timestampami

Struktura:
```json
{
  "word_aligned_lyrics": [
    { "word": "tekst", "start_time": 0.0, "end_time": 0.5 }
  ]
}
```

Użyj tego jako reference do wizualizatora.