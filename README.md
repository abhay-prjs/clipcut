# ClipCut

A fast, browser-based UGC video editor built for talking-head content. Strips dead air, detects filler words, generates captions, and exports GPU-encoded clips — all from a single local desktop app with no cloud dependency.

![Stack](https://img.shields.io/badge/stack-Vanilla%20JS%20%2B%20Python-blue) ![GPU](https://img.shields.io/badge/export-h264__nvenc-green) ![License](https://img.shields.io/badge/license-private-lightgrey)

---

## What it does

- **Dead space removal** — ffmpeg silence detection + Silero VAD, combined with AND/OR logic
- **Filler word detection** — flags ums, uhs, likes from the transcript
- **WhisperX transcription** — word-level timestamps with forced Wav2Vec2 alignment; retake detection
- **AI script analysis** — sends transcript to OpenRouter (free models) or local Ollama; marks ad-libs, weak takes, highlights
- **AI chat** — natural language timeline control (cut, trim, seek, merge, apply)
- **Transcript editor** — click any word to seek; select words to cut or uncut them inline
- **GPU export** — h264_nvenc two-pass encode; multi-segment concat without re-encode
- **Caption export** — SRT/VTT with post-cut timestamp remapping

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML / CSS / JS — no framework, no build step |
| Desktop wrapper | [pywebview](https://pywebview.app/) — Python API exposed to JS |
| Transcription | faster-whisper (default) · WhisperX + Wav2Vec2 alignment (opt-in) |
| VAD | Silero VAD |
| AI | OpenRouter API · Ollama local fallback |
| Export | ffmpeg · h264_nvenc (RTX GPU) · libx264 CPU fallback |
| Audio analysis | Web Audio API (RMS waveform) |
| Waveform render | OffscreenCanvas + Web Worker |
| Playback loop | `requestVideoFrameCallback` |

---

## Requirements

- Python 3.11+
- CUDA 12.8 + RTX GPU (for GPU encode/transcription — CPU fallback works)
- ffmpeg on system PATH
- Node/npm — not required (no build step)

### Python dependencies

```bash
pip install pywebview faster-whisper silero-vad
pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cu128

# Optional: WhisperX for ms-accurate word alignment + retake detection
pip install whisperx --no-deps && pip install transformers ctranslate2
```

---

## Setup

**1. Clone**
```bash
git clone https://github.com/abhay-prjs/clipcut.git
cd clipcut
```

**2. Create config**
```bash
cp config.example.json config.json
```
Edit `config.json` and add your [OpenRouter API key](https://openrouter.ai/keys) (free tier works).

**3. Run**
```bash
python serve.py
```
Opens a 1920×1080 desktop window. Chrome DevTools available at `chrome://inspect` (port 9222).

---

## Config

| Key | Default | Description |
|---|---|---|
| `openrouter_key` | — | OpenRouter API key |
| `openrouter_model` | `meta-llama/llama-4-scout:free` | Model for AI analysis |
| `whisper_backend` | `faster-whisper` | `faster-whisper` or `whisperx` |
| `whisperx_model` | `distil-large-v3` | WhisperX model size |
| `whisperx_batch_size` | `16` | GPU batch size (reduce to `8` on OOM) |
| `silence_threshold` | `-35` | dB threshold for silence detection |
| `silence_min_duration` | `0.5` | Minimum silence length in seconds |
| `ollama_url` | `http://localhost:11434` | Local Ollama endpoint |

Config hot-reloads every 2 seconds — no restart needed after editing.

---

## Project structure

```
clipcut/
├── clipcut.html          # HTML structure
├── clipcut.css           # All styles
├── serve.py              # pywebview desktop app + Python API
├── waveform.worker.js    # OffscreenCanvas waveform renderer
├── config.example.json   # Config template (copy → config.json)
└── js/
    ├── core/             # logger, state, history
    ├── config/           # config loader
    ├── captions/         # WhisperX transcription, caption export
    ├── detection/        # silence, VAD, AI analysis, waveform
    ├── media/            # import, export
    ├── playback/         # rVFC playback loop
    ├── timeline/         # timeline render, trim, split
    ├── ui/               # modals, tabs, settings, keyboard shortcuts
    └── main.js           # init
```

---

## Workflow

1. **Import** — drag a video onto the app or use the native file picker
2. **Transcribe** — hit `⚡ Load Whisper Model` then `Transcribe` in the Captions tab
3. **Detect** — run Silence, Dead Spaces, and/or Filler detection
4. **Review** — click any finding to seek to it; toggle cuts on/off individually
5. **AI** — paste your script into the AI tab and run Script Analysis for ad-lib/retake flagging
6. **Apply** — `Apply Selected Cuts` removes flagged sections from the timeline
7. **Export** — GPU-encoded MP4 via native save dialog

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `←` / `→` | Seek ±5s |
| `Q` | Trim Before playhead |
| `W` | Trim After playhead |
| `Ctrl+B` | Split at playhead |
| `Ctrl+Z` | Undo |
| `+` / `-` | Zoom timeline in/out |
| `H` | Flip horizontal |
| `V` | Flip vertical |
| `Delete` | Delete selected clip |

---

## Notes

- Video files stream via `http://localhost:8080/video?path=...` — `file://` URLs are blocked by the browser when served from HTTP
- `config.json` is gitignored — never commit it
- `face_landmarker.task` (MediaPipe model) is gitignored — auto-downloaded on first use if needed
- Backups live in `_backups/` (also gitignored) — one snapshot per session
