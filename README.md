# Obsidian Whisper

Transcribe local `mp3` / `mp4` (and other common audio/video) files into your notes using the [Whisper](https://github.com/openai/whisper) CLI.

## How it works

Two commands:

- **Transcribe media (choose file…)** — opens your OS file browser. Pick an mp3/mp4 file and the transcript is inserted at the cursor.
- **Transcribe media from current line** — reads the absolute path from the line under the cursor. If the line is empty, falls back to the file browser.

While `whisper` runs, an animated callout is rendered directly below the path showing the current model and a spinner. It is replaced by the transcript when the process completes (or an error line if it fails).

Supported extensions: `.mp3`, `.mp4`, `.m4a`, `.wav`, `.webm`, `.ogg`, `.flac`.

Markdown links (`[label](path)`), wiki-links (`[[path]]`), and quoted paths are all parsed.

## Requirements

- The [`whisper` CLI](https://github.com/openai/whisper) installed and on your `PATH` (or configure its absolute path in plugin settings).
- Desktop Obsidian (this plugin shells out to a local process and is not available on mobile).

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
