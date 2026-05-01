# Archiwum konwersacji — wizualizer + Sonauto + Whisper (2026-04-12)

Notatka zapisana na prośbę: podsumowanie ustaleń z dyskusji o projekcie wizualizera piosenek (Three.js, tekst na żywo) oraz ścieżek z danymi z Sonauto i lokalnym Whisperem.

---

## Kontekst projektu

- **Cel:** wizualizer utworów z **tekstem zsynchronizowanym z odtwarzaniem** w **Three.js**.
- **Źródło muzyki:** utwory generowane przez AI, m.in. przez **[Sonauto](https://sonauto.ai/)**.

---

## Sonauto — skąd brać tekst i czasy (bez ręcznego przepisywania)

- **Strona www:** zwykle dostępne jest **audio**; **gotowy eksport napisów z timestampami** (np. LRC/SRT) nie jest oczywisty — wygodniejsza jest **integracja przez API**.
- **API (przegląd):**
  - `GET /v1/generations/{task_id}` — m.in. **`lyrics`** (tekst użyty przy generacji) oraz **`song_paths`** (URL-e audio; **linki wygasają** po ok. tygodniu — warto pobrać plik lokalnie).
  - Przy generacji (v2/v3): **`align_lyrics: true`** uruchamia **wyrównanie tekstu do nagrania**; status: `GET /generations/status/{task_id}?include_alignment=true` (`alignment_status` aż do sukcesu).
  - **`POST /lyrics/align`** — audio + znany tekst → odpowiedź z **`aligned_lyrics`** (np. słowo + `start_time` / `end_time`) — wygodne pod podświetlanie słów w czasie `audio.currentTime`.
- **Dokumentacja:** [Sonauto Developers](https://sonauto.ai/developers).

---

## Czy API jest obowiązkowe? Czy to płatne?

- **Nie jest ścisłym wymogiem**, ale **API** to praktyczna droga do **pewnego tekstu** i **timestampów**.
- Rozliczenia: model **kredytów** (endpoint salda itd. w dokumentacji). **Zakup kredytów** jest jedną z opcji; ewentualne **kredyty startowe** zależą od aktualnej oferty w panelu.
- **Uwaga z docs:** przy `align_lyrics` kredyty mogą być pobrane nawet jeśli alignment się nie powiedzie, a sama generacja się udała — warto to mieć na uwadze przy testach.

---

## Przykładowe pliki „od Sonauto” przed zakupem kredytów

- **Oficjalny pakiet plików** (sample audio + gotowy JSON alignment) **nie wynika** z publicznych materiałów — repozytorium [Sonauto/sonauto-api-examples](https://github.com/Sonauto/sonauto-api-examples) to **skrypty pod API**, nadal z kluczem i zużyciem kredytów.
- **Na start bez zakupu:** własne **fixture’y** — dowolne krótkie audio + **mock JSON** w oczekiwanym kształcie (np. jak `aligned_lyrics`), albo **minimalne** użycie darmowych kredytów na jednorazowy „zrzut” prawdziwej odpowiedzi API.

---

## Whisper Large (lokalnie)

- Może **wystarczyć do prototypu**, jeśli **wokal jest wyraźny** — transkrypcja + **segmenty** (czasem **słowa**, zależnie od narzędzia: faster-whisper, WhisperX itd.).
- **Śpiew i gęsty miks** zwiększają błędy tekstu i przesunięcia czasów względem idealnego alignmentu.
- **Gdy tekst jest już znany** (np. ten sam co w generatorze): sensownie rozważyć **forced alignment** (tekst + audio) zamiast polegać wyłącznie na „zgadywaniu” słów przez Whispera.

---

## Testy w repozytorium (audio + tekst)

- Struktura typu: `tests/fixtures/` — **plik audio** + **`lyrics.txt`** + opcjonalnie **referencyjny `aligned.json`** (porównania z **tolerancją czasową**, bo wyniki bywają niestabilne).
- **Model Whisper** — zwykle **nie** commituje się do repo (rozmiar); lepiej instalacja/cache lokalnie + opis w zależnościach; duże binaria → **Git LFS** lub hosting poza Gitem.
- **Prawa do utworu:** do repo tylko materiały, do których jest podstawa prawna.

---

## Stan na koniec dnia (2026-04-12)

- Dodany **folder z modelami Whisper** (w środowisku roboczym m.in. `Z:\MODELS\Whisper`) — modele jako zasoby lokalne, niekoniecznie w tym samym repozytorium co kod aplikacji.

---

## Odłożone na później (świadomie nie robione w tej turze)

- Zasady projektu: **wersjonowanie**, **changelog**, **zbieranie sugestii rozwoju**.
- Plik / dokumentacja typu **„jak wszystko działa”** (architektura, przepływ danych).

---

## Linki zewnętrzne

- [Sonauto](https://sonauto.ai/)
- [Sonauto — Developer API](https://sonauto.ai/developers)
- [Sonauto — przykłady API (GitHub)](https://github.com/Sonauto/sonauto-api-examples)
