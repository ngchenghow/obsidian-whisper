import {
	App,
	Editor,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import { spawn } from "child_process";
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

export default class WhisperPlugin extends Plugin {
	settings: WhisperSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "transcribe-from-current-line",
			name: "Transcribe media from current line",
			editorCallback: (editor) =>
				this.transcribeFromCurrentLine(editor),
		});

		this.addCommand({
			id: "transcribe-from-prompt",
			name: "Transcribe media (prompt for path)",
			editorCallback: (editor) =>
				new PathPromptModal(this.app, async (filePath) => {
					await this.transcribeAndInsert(filePath, editor);
				}).open(),
		});

		this.addSettingTab(new WhisperSettingTab(this.app, this));
	}

	onunload() {}

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
		const filePath = extractPath(line);
		if (!filePath) {
			new Notice(
				"No media file path found on this line. Paste a path to an mp3/mp4 file and try again.",
			);
			return;
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

		const notice = new Notice(
			`Transcribing ${path.basename(resolved)}…`,
			0,
		);
		try {
			const transcript = await this.runWhisper(resolved);
			insertTranscriptBelowCursor(editor, transcript);
			new Notice("Transcription complete.");
		} catch (err) {
			console.error("Whisper failed:", err);
			new Notice(
				`Whisper failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			notice.hide();
		}
	}

	private async runWhisper(mediaPath: string): Promise<string> {
		const outDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "obsidian-whisper-"),
		);
		try {
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

			await runProcess(this.settings.whisperPath, args);

			const base = path.basename(
				mediaPath,
				path.extname(mediaPath),
			);
			const outFile = path.join(outDir, `${base}.txt`);
			const content = await fs.readFile(outFile, "utf8");
			return content.trim();
		} finally {
			fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
		}
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

function insertTranscriptBelowCursor(editor: Editor, transcript: string) {
	const cursor = editor.getCursor();
	const lineText = editor.getLine(cursor.line);
	const endOfLine = { line: cursor.line, ch: lineText.length };
	const insertion = `\n\n${transcript}\n`;
	editor.replaceRange(insertion, endOfLine);
	editor.setCursor({
		line: cursor.line + insertion.split("\n").length - 1,
		ch: 0,
	});
}

function runProcess(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { shell: false });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`exit ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
					),
				);
		});
	});
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

class PathPromptModal extends Modal {
	private onSubmit: (filePath: string) => void | Promise<void>;
	private value = "";

	constructor(
		app: App,
		onSubmit: (filePath: string) => void | Promise<void>,
	) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		this.titleEl.setText("Transcribe media file");
		const input = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Absolute path to mp3/mp4 file…",
		});
		input.style.width = "100%";
		input.addEventListener("input", (e) => {
			this.value = (e.target as HTMLInputElement).value;
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit();
			}
		});
		setTimeout(() => input.focus(), 10);

		const buttonRow = this.contentEl.createDiv();
		buttonRow.style.marginTop = "0.75em";
		buttonRow.style.display = "flex";
		buttonRow.style.justifyContent = "flex-end";
		buttonRow.style.gap = "0.5em";

		const cancel = buttonRow.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const submit = buttonRow.createEl("button", { text: "Transcribe" });
		submit.addClass("mod-cta");
		submit.addEventListener("click", () => this.submit());
	}

	private submit() {
		const v = this.value.trim();
		if (!v) return;
		this.close();
		void this.onSubmit(v);
	}

	onClose() {
		this.contentEl.empty();
	}
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
