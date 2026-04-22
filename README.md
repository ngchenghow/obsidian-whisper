# Obsidian Whisper

Transcribe local `mp3` / `mp4` (and other common audio/video) files into your notes using the [Whisper](https://github.com/openai/whisper) CLI.

## How it works

Commands:

- **Transcribe media (choose file…)** — OS file browser, pick mp3/mp4, transcript inserted at cursor.
- **Transcribe media from current line** — reads the absolute path from the line under the cursor. Falls back to the file browser if empty.
- **Cancel transcription** — kills the running `whisper` process.
- **Start recording system audio** — begins capturing loopback audio via `ffmpeg` into a temp WAV.
- **Stop recording and transcribe** — stops the recording cleanly and pipes the WAV through whisper, streaming the transcript into the note.
- **Start real-time transcription** — captures system audio and transcribes it live. Uses true streaming when a streaming command is configured, otherwise falls back to chunked mode (fixed-length segments transcribed in the background).
- **Stop real-time transcription** — ends the live session cleanly, flushing the last chunk/buffer.
- **List system audio devices (for capture args)** — runs `ffmpeg -list_devices` and shows a pick-list that writes the correct capture args into settings.

While running, an animated callout is rendered directly below the path. Each line that whisper emits to stdout is appended live, so the transcript streams in as it's produced. On success the spinner line disappears; on cancel/failure it shows a clear message.

## System audio recording

Loopback capture is OS-specific; configure it once in plugin settings:

- **Windows** (default): `-f dshow -i audio=Stereo Mix` — enable "Stereo Mix" in the Sound control panel first. List your devices with `ffmpeg -list_devices true -f dshow -i dummy`.
- **macOS**: `-f avfoundation -i :N` where N is the index of [BlackHole](https://github.com/ExistentialAudio/BlackHole) or the Loopback app (macOS has no built-in system audio capture).
- **Linux**: `-f pulse -i default.monitor`.

Supported extensions: `.mp3`, `.mp4`, `.m4a`, `.wav`, `.webm`, `.ogg`, `.flac`.

Markdown links (`[label](path)`), wiki-links (`[[path]]`), and quoted paths are all parsed.

## Requirements

- The [`whisper` CLI](https://github.com/openai/whisper) on your `PATH` (or configure its absolute path in plugin settings).
- [`ffmpeg`](https://ffmpeg.org/) on `PATH` — only needed for the system-audio recording commands.
- Desktop Obsidian (this plugin shells out to local processes and is not available on mobile).

## Real-time transcription

Two modes, picked automatically by whether a **Streaming command** is configured:

1. **Chunked (default)** — `ffmpeg` writes fixed-length segments (see *Chunk length*), each segment is transcribed by the regular `whisper` CLI in the background, and lines are appended to the note as each chunk finishes. Simple, works with any stock whisper install, ~chunk-length of latency.
2. **True streaming** — `ffmpeg` pipes raw PCM (`s16le`, mono, 16 kHz) directly into a user-configured stdin-reading streaming transcriber; every line the tool emits on stdout is appended live. Much lower latency, requires a streaming-capable wrapper.

Example streaming commands:

- [`whisper_streaming`](https://github.com/ufal/whisper_streaming) — `python whisper_online.py --backend faster-whisper --model base --min-chunk-size 1 --vac` (or a small wrapper that reads stdin and feeds the server's `OnlineASRProcessor`).
- [`whisper.cpp`](https://github.com/ggerganov/whisper.cpp)'s `stream` binary, patched to read stdin instead of the mic.
- Your own `faster-whisper` / `insanely-fast-whisper` wrapper — just read 16-bit PCM from stdin and `print()` each finalized segment.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Whisper executable | `whisper` | Command name or absolute path to the CLI |
| Model | `base` | Whisper model (`tiny`, `base`, `small`, `medium`, `large`, …) |
| Language | *(auto)* | ISO code — e.g. `en`, `zh`. Blank = auto-detect |
| Extra CLI arguments | *(empty)* | Free-form flags, e.g. `--task translate --device cuda` |
| ffmpeg executable | `ffmpeg` | Command name or absolute path to ffmpeg (recording + real-time) |
| Capture args | OS-specific (see above) | ffmpeg input flags for loopback capture |
| Chunk length (seconds) | `15` | Segment length for chunked real-time mode |
| Streaming command | *(empty)* | When set, enables true-streaming real-time mode |

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm run build   # production build
```

Copy `main.js`, `manifest.json`, and (optionally) `styles.css` into `<vault>/.obsidian/plugins/obsidian-whisper/`.

## License

MIT
