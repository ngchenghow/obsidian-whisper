# Obsidian Whisper

Transcribe local `mp3` / `mp4` (and other common audio/video) files into your notes using the [Whisper](https://github.com/openai/whisper) CLI.

## How it works

Commands:

- **Transcribe media (choose file…)** — OS file browser, pick mp3/mp4, transcript inserted at cursor.
- **Transcribe media from current line** — reads the absolute path from the line under the cursor. Falls back to the file browser if empty.
- **Cancel transcription** — kills the running `whisper` process.
- **Start recording system audio** — begins capturing loopback audio via `ffmpeg` into a temp WAV.
- **Stop recording and transcribe** — stops the recording cleanly and pipes the WAV through whisper, streaming the transcript into the note.

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

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Whisper executable | `whisper` | Command name or absolute path to the CLI |
| Model | `base` | Whisper model (`tiny`, `base`, `small`, `medium`, `large`, …) |
| Language | *(auto)* | ISO code — e.g. `en`, `zh`. Blank = auto-detect |
| Extra CLI arguments | *(empty)* | Free-form flags, e.g. `--task translate --device cuda` |

## Development

```bash
npm install
npm run dev     # watch build → main.js
npm run build   # production build
```

Copy `main.js`, `manifest.json`, and (optionally) `styles.css` into `<vault>/.obsidian/plugins/obsidian-whisper/`.

## License

MIT
