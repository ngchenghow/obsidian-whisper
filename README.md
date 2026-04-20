# Obsidian Whisper

Transcribe local `mp3` / `mp4` (and other common audio/video) files into your notes using the [Whisper](https://github.com/openai/whisper) CLI.

## How it works

1. In a note, paste the absolute path to an audio/video file on its own line — e.g.
   ```
   C:\Users\me\Recordings\meeting.mp4
   ```
2. Place the cursor on that line and run the command **"Transcribe media from current line"**.
3. The plugin invokes `whisper` on the file and inserts the transcript directly below the path.

Alternatively, run **"Transcribe media (prompt for path)"** to paste a path into a modal — the transcript is inserted at the cursor.

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
