import {
	App,
	Editor,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

interface WhisperSettings {
	whisperPath: string;
	model: string;
	language: string;
	extraArgs: string;
}

const DEFAULT_SETTINGS: WhisperSettings = {
	whisperPath: "whisper",
	model: "base",
	language: "",
	extraArgs: "",
};

const MEDIA_EXTS = [".mp3", ".mp4", ".m4a", ".wav", ".webm", ".ogg", ".flac"];

interface Transcription {
	child: ChildProcess;
	loader: InlineLoader;
	cancelled: boolean;
}

export default class WhisperPlugin extends Plugin {
	settings: WhisperSettings;
	private active = new Set<Transcription>();

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "transcribe-from-current-line",
			name: "Transcribe media from current line",
			editorCallback: (editor) =>
				this.transcribeFromCurrentLine(editor),
		});

		this.addCommand({
			id: "transcribe-choose-file",
			name: "Transcribe media (choose file…)",
			editorCallback: async (editor) => {
				const picked = await pickMediaFile();
				if (!picked) return;
				await this.transcribeAndInsert(picked, editor);
			},
		});

		this.addCommand({
			id: "cancel-transcription",
			name: "Cancel transcription",
			callback: () => this.cancelAll(),
		});

		this.addSettingTab(new WhisperSettingTab(this.app, this));
	}

	onunload() {
		this.cancelAll(true);
	}

	private cancelAll(silent = false) {
		if (this.active.size === 0) {
			if (!silent) new Notice("No transcription in progress.");
			return;
		}
		for (const t of Array.from(this.active)) {
			t.cancelled = true;
			killChild(t.child);
		}
		if (!silent) new Notice("Transcription cancelled.");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async transcribeFromCurrentLine(editor: Editor) {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		let filePath = extractPath(line);
		if (!filePath) {
			filePath = await pickMediaFile();
			if (!filePath) return;
		}
		await this.transcribeAndInsert(filePath, editor);
	}

	private async transcribeAndInsert(filePath: string, editor: Editor) {
		const resolved = path.resolve(filePath.trim());
		try {
			await fs.access(resolved);
		} catch {
			new Notice(`File not found: ${resolved}`);
			return;
		}

		const ext = path.extname(resolved).toLowerCase();
		if (!MEDIA_EXTS.includes(ext)) {
			new Notice(
				`Unsupported extension '${ext}'. Expected one of: ${MEDIA_EXTS.join(", ")}`,
			);
			return;
		}

		const loader = new InlineLoader(
			editor,
			path.basename(resolved),
			this.settings.model,
		);
		loader.start();

		let handle: Transcription | null = null;
		try {
			const { child, result } = await this.startWhisper(resolved);
			handle = { child, loader, cancelled: false };
			this.active.add(handle);
			const transcript = await result;
			if (handle.cancelled) return;
			loader.finish(transcript);
			new Notice("Transcription complete.");
		} catch (err) {
			if (handle?.cancelled) {
				loader.cancel();
			} else {
				console.error("Whisper failed:", err);
				const msg =
					err instanceof Error ? err.message : String(err);
				loader.fail(msg);
				new Notice(`Whisper failed: ${msg}`);
			}
		} finally {
			if (handle) this.active.delete(handle);
		}
	}

	private async startWhisper(
		mediaPath: string,
	): Promise<{ child: ChildProcess; result: Promise<string> }> {
		const outDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "obsidian-whisper-"),
		);
		const args = [
			mediaPath,
			"--model",
			this.settings.model,
			"--output_format",
			"txt",
			"--output_dir",
			outDir,
		];
		if (this.settings.language.trim()) {
			args.push("--language", this.settings.language.trim());
		}
		if (this.settings.extraArgs.trim()) {
			args.push(...splitArgs(this.settings.extraArgs.trim()));
		}

		const { child, done } = runProcess(this.settings.whisperPath, args);
		const cleanup = () =>
			fs.rm(outDir, { recursive: true, force: true }).catch(() => {});

		const result = done.then(
			async () => {
				try {
					const base = path.basename(
						mediaPath,
						path.extname(mediaPath),
					);
					const outFile = path.join(outDir, `${base}.txt`);
					return (await fs.readFile(outFile, "utf8")).trim();
				} finally {
					cleanup();
				}
			},
			(err) => {
				cleanup();
				throw err;
			},
		);
		return { child, result };
	}
}

function extractPath(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	const md = trimmed.match(/\[[^\]]*\]\(([^)]+)\)/);
	if (md) return md[1];

	const wiki = trimmed.match(/\[\[([^\]]+?)(?:\|[^\]]+)?\]\]/);
	if (wiki) return wiki[1];

	const quoted = trimmed.match(/^["'`](.+)["'`]$/);
	if (quoted) return quoted[1];

	return trimmed;
}

const SPINNER_FRAMES = [
	"\u280B",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283C",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280F",
];

class InlineLoader {
	private editor: Editor;
	private marker: string;
	private prefix: string;
	private suffix: string;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;

	constructor(editor: Editor, filename: string, model: string) {
		this.editor = editor;
		const id =
			Date.now().toString(36) +
			Math.random().toString(36).slice(2, 8);
		this.marker = `<!-- whisper-loader:${id} -->`;
		this.prefix = `> ⏳ Transcribing \`${filename}\` with \`${model}\` model… `;
		this.suffix = ` · run **Whisper: Cancel transcription** to stop`;
	}

	start() {
		const cursor = this.editor.getCursor();
		const endOfLine = {
			line: cursor.line,
			ch: this.editor.getLine(cursor.line).length,
		};
		this.editor.replaceRange(`\n\n${this.buildLine()}`, endOfLine);
		this.interval = setInterval(() => this.tick(), 120);
	}

	finish(transcript: string) {
		this.replaceLoaderWith(transcript);
	}

	fail(message: string) {
		this.replaceLoaderWith(`> ❌ Whisper failed: ${message}`);
	}

	cancel() {
		this.replaceLoaderWith(`> ⚠️ Transcription cancelled.`);
	}

	private tick() {
		this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
		const line = this.findLoaderLine();
		if (line < 0) {
			this.stop();
			return;
		}
		this.rewriteLine(line, this.buildLine());
	}

	private replaceLoaderWith(text: string) {
		this.stop();
		const line = this.findLoaderLine();
		if (line < 0) {
			const last = this.editor.lineCount() - 1;
			const endCh = this.editor.getLine(last).length;
			this.editor.replaceRange(`\n\n${text}\n`, { line: last, ch: endCh });
			return;
		}
		this.rewriteLine(line, text);
	}

	private buildLine(): string {
		return `${this.prefix}${SPINNER_FRAMES[this.frame]}${this.suffix}  ${this.marker}`;
	}

	private findLoaderLine(): number {
		for (let i = 0; i < this.editor.lineCount(); i++) {
			if (this.editor.getLine(i).includes(this.marker)) return i;
		}
		return -1;
	}

	private rewriteLine(line: number, content: string) {
		const current = this.editor.getLine(line);
		this.editor.replaceRange(
			content,
			{ line, ch: 0 },
			{ line, ch: current.length },
		);
	}

	private stop() {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

function runProcess(
	cmd: string,
	args: string[],
): { child: ChildProcess; done: Promise<void> } {
	const child = spawn(cmd, args, { shell: false });
	let stderr = "";
	child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
	const done = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`exit ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`,
					),
				);
		});
	});
	return { child, done };
}

function killChild(child: ChildProcess) {
	if (child.killed || child.exitCode !== null) return;
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			windowsHide: true,
		});
	} else {
		child.kill();
	}
}

function splitArgs(s: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		out.push(m[1] ?? m[2] ?? m[3]);
	}
	return out;
}

async function pickMediaFile(): Promise<string | null> {
	// Preferred path: Electron's native Open dialog.
	const viaDialog = await pickViaElectronDialog();
	if (viaDialog !== undefined) return viaDialog;

	// Fallback: hidden <input type="file"> + webUtils.getPathForFile.
	return pickViaHtmlInput();
}

/**
 * Returns `string | null` on success (null == user cancelled),
 * or `undefined` when the Electron dialog API isn't reachable — in which
 * case the caller should try the HTML input fallback.
 */
async function pickViaElectronDialog(): Promise<string | null | undefined> {
	try {
		// @ts-ignore — window.require exists only inside Electron.
		const req: NodeRequire | undefined = (window as any).require;
		if (!req) return undefined;

		let dialog: any;
		try {
			dialog = req("@electron/remote").dialog;
		} catch {
			try {
				dialog = req("electron").remote?.dialog;
			} catch {
				/* ignore */
			}
		}
		if (!dialog?.showOpenDialog) return undefined;

		const extensions = MEDIA_EXTS.map((e) => e.replace(/^\./, ""));
		const result = await dialog.showOpenDialog({
			title: "Select media file to transcribe",
			properties: ["openFile"],
			filters: [
				{ name: "Audio / video", extensions },
				{ name: "All files", extensions: ["*"] },
			],
		});
		if (result.canceled || !result.filePaths?.[0]) return null;
		return result.filePaths[0] as string;
	} catch (err) {
		console.warn("whisper: electron dialog failed, falling back", err);
		return undefined;
	}
}

function pickViaHtmlInput(): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = MEDIA_EXTS.join(",");
		input.style.display = "none";
		document.body.appendChild(input);

		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(value);
		};

		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				finish(null);
				return;
			}
			const resolved = resolveFilePath(file);
			if (!resolved) {
				new Notice(
					"Could not resolve the file's absolute path. Try the 'Transcribe media from current line' command with a pasted path instead.",
				);
				finish(null);
				return;
			}
			finish(resolved);
		});
		input.addEventListener("cancel", () => finish(null));

		input.click();
	});
}

function resolveFilePath(file: File): string | null {
	// Older Electron exposed `.path` directly.
	const legacy = (file as unknown as { path?: string }).path;
	if (legacy) return legacy;

	// Electron 32+ requires webUtils.getPathForFile().
	try {
		// @ts-ignore — window.require exists only inside Electron.
		const electron = (window as any).require?.("electron");
		const p = electron?.webUtils?.getPathForFile?.(file);
		if (typeof p === "string" && p) return p;
	} catch {
		/* ignore */
	}
	return null;
}

class WhisperSettingTab extends PluginSettingTab {
	plugin: WhisperPlugin;

	constructor(app: App, plugin: WhisperPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Whisper executable")
			.setDesc(
				"Command or absolute path to the whisper CLI. On Windows, use the full path if 'whisper' is not on PATH.",
			)
			.addText((text) =>
				text
					.setPlaceholder("whisper")
					.setValue(this.plugin.settings.whisperPath)
					.onChange(async (value) => {
						this.plugin.settings.whisperPath =
							value.trim() || "whisper";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc(
				"Whisper model (tiny, base, small, medium, large, large-v3, etc.).",
			)
			.addText((text) =>
				text
					.setPlaceholder("base")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim() || "base";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Language")
			.setDesc("Language code (e.g. 'en', 'zh'). Leave blank to auto-detect.")
			.addText((text) =>
				text
					.setPlaceholder("(auto)")
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Extra CLI arguments")
			.setDesc(
				"Additional flags passed to whisper, e.g. '--task translate --device cuda'.",
			)
			.addText((text) =>
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.extraArgs)
					.onChange(async (value) => {
						this.plugin.settings.extraArgs = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
