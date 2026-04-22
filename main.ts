import {
	App,
	Editor,
	Modal,
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
	ffmpegPath: string;
	captureArgs: string;
	realtimeChunkSeconds: number;
	streamingCommand: string;
}

const DEFAULT_CAPTURE_ARGS =
	process.platform === "win32"
		? `-f dshow -i "audio=Stereo Mix"`
		: process.platform === "darwin"
		? "-f avfoundation -i :0"
		: "-f pulse -i default.monitor";

const DEFAULT_SETTINGS: WhisperSettings = {
	whisperPath: "whisper",
	model: "base",
	language: "",
	extraArgs: "",
	ffmpegPath: "ffmpeg",
	captureArgs: DEFAULT_CAPTURE_ARGS,
	realtimeChunkSeconds: 15,
	streamingCommand: "",
};

const MEDIA_EXTS = [".mp3", ".mp4", ".m4a", ".wav", ".webm", ".ogg", ".flac"];

interface Transcription {
	child: ChildProcess;
	loader: InlineLoader;
	cancelled: boolean;
}

interface RecordingHandle {
	child: ChildProcess;
	filePath: string;
	editor: Editor;
	loader: InlineLoader;
	getStderr: () => string;
}

interface RealtimeSession {
	child: ChildProcess;
	outDir: string;
	editor: Editor;
	loader: InlineLoader;
	pollHandle: ReturnType<typeof setInterval> | null;
	queue: string[];
	seen: Set<string>;
	transcribing: boolean;
	stopping: boolean;
	closed: boolean;
	closeResolve: (() => void) | null;
	startedAt: number;
	getStderr: () => string;
}

interface StreamingSession {
	ffmpeg: ChildProcess;
	streamer: ChildProcess;
	editor: Editor;
	loader: InlineLoader;
	stopping: boolean;
	getFfmpegStderr: () => string;
	getStreamerStderr: () => string;
}

export default class WhisperPlugin extends Plugin {
	settings: WhisperSettings;
	private active = new Set<Transcription>();
	private recording: RecordingHandle | null = null;
	private realtime: RealtimeSession | null = null;
	private streaming: StreamingSession | null = null;

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

		this.addCommand({
			id: "record-system-audio",
			name: "Start recording system audio",
			editorCallback: (editor) => this.startRecording(editor),
		});

		this.addCommand({
			id: "stop-recording-and-transcribe",
			name: "Stop recording and transcribe",
			callback: () => this.stopRecordingAndTranscribe(),
		});

		this.addCommand({
			id: "list-audio-devices",
			name: "List system audio devices (for capture args)",
			callback: () => this.listAudioDevices(),
		});

		this.addCommand({
			id: "realtime-start",
			name: "Start real-time transcription",
			editorCallback: (editor) => this.startRealtime(editor),
		});

		this.addCommand({
			id: "realtime-stop",
			name: "Stop real-time transcription",
			callback: () => this.stopRealtime(),
		});

		this.addSettingTab(new WhisperSettingTab(this.app, this));
	}

	onunload() {
		this.cancelAll(true);
		if (this.recording) {
			killChild(this.recording.child);
			this.recording = null;
		}
		if (this.realtime) {
			if (this.realtime.pollHandle) clearInterval(this.realtime.pollHandle);
			killChild(this.realtime.child);
			fs.rm(this.realtime.outDir, { recursive: true, force: true }).catch(
				() => {},
			);
			this.realtime = null;
		}
		if (this.streaming) {
			killChild(this.streaming.ffmpeg);
			killChild(this.streaming.streamer);
			this.streaming = null;
		}
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

	private async transcribeAndInsert(
		filePath: string,
		editor: Editor,
		reuseLoader?: InlineLoader,
	) {
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

		let loader: InlineLoader;
		if (reuseLoader) {
			loader = reuseLoader;
			loader.switchToTranscribing(
				path.basename(resolved),
				this.settings.model,
			);
		} else {
			loader = new InlineLoader(
				editor,
				path.basename(resolved),
				this.settings.model,
			);
			loader.start();
		}

		let handle: Transcription | null = null;
		const onLine = (line: string) => {
			if (handle?.cancelled) return;
			loader.appendTranscriptLine(line);
		};
		try {
			const { child, result } = await this.startWhisper(resolved, onLine);
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
		onStdoutLine?: (line: string) => void,
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

		const { child, done } = runProcess(
			this.settings.whisperPath,
			args,
			onStdoutLine,
		);
		const cleanup = () =>
			fs.rm(outDir, { recursive: true, force: true }).catch(() => {});

		const result = done.then(
			async (stdout) => {
				try {
					return await readTranscript(outDir, mediaPath, stdout);
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

	private async startRecording(editor: Editor) {
		if (this.recording) {
			new Notice(
				"Already recording. Run 'Whisper: Stop recording and transcribe' first.",
			);
			return;
		}

		const filePath = path.join(
			os.tmpdir(),
			`obsidian-whisper-rec-${Date.now()}.wav`,
		);
		const captureArgs = this.settings.captureArgs.trim();
		if (!captureArgs) {
			new Notice(
				"System audio capture args are empty. Configure them in plugin settings.",
			);
			return;
		}
		const args = [
			...splitArgs(captureArgs),
			"-ac",
			"1",
			"-ar",
			"16000",
			"-acodec",
			"pcm_s16le",
			"-y",
			filePath,
		];

		let child: ChildProcess;
		try {
			child = spawn(this.settings.ffmpegPath, args, { shell: false });
		} catch (err) {
			new Notice(
				`Failed to start ffmpeg: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		let stderr = "";
		child.stderr?.on("data", (c) => {
			stderr += c.toString();
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});

		const loader = new InlineLoader(editor, "system audio", "recording");
		loader.startRecording();

		const handle: RecordingHandle = {
			child,
			filePath,
			editor,
			loader,
			getStderr: () => stderr,
		};
		this.recording = handle;

		child.on("error", (err) => {
			if (this.recording === handle) {
				this.recording = null;
				loader.fail(`ffmpeg error: ${err.message}`);
			}
		});
		child.on("close", (code) => {
			if (this.recording === handle) {
				// Unexpected exit (not via stop command).
				this.recording = null;
				loader.fail(diagnoseFfmpegError(code, stderr, captureArgs));
			}
		});
	}

	private async startRealtime(editor: Editor) {
		if (this.realtime || this.streaming) {
			new Notice(
				"Real-time transcription already running. Stop it first.",
			);
			return;
		}
		const captureArgs = this.settings.captureArgs.trim();
		if (!captureArgs) {
			new Notice(
				"Configure 'Capture input arguments' in settings first.",
			);
			return;
		}
		// If a streaming command is configured, use true streaming (pipe).
		if (this.settings.streamingCommand.trim()) {
			return this.startStreaming(editor);
		}

		const outDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "obsidian-whisper-rt-"),
		);
		const pattern = path.join(outDir, "chunk_%05d.wav");
		const chunkSec = Math.max(
			5,
			Math.floor(this.settings.realtimeChunkSeconds || 15),
		);
		const args = [
			...splitArgs(captureArgs),
			"-ac",
			"1",
			"-ar",
			"16000",
			"-acodec",
			"pcm_s16le",
			"-f",
			"segment",
			"-segment_time",
			String(chunkSec),
			"-reset_timestamps",
			"1",
			"-y",
			pattern,
		];

		let child: ChildProcess;
		try {
			child = spawn(this.settings.ffmpegPath, args, { shell: false });
		} catch (err) {
			fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
			new Notice(
				`Failed to start ffmpeg: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		let stderr = "";
		child.stderr?.on("data", (c) => {
			stderr += c.toString();
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});

		const loader = new InlineLoader(editor, "system audio", "realtime");
		loader.startRealtime(chunkSec);

		const session: RealtimeSession = {
			child,
			outDir,
			editor,
			loader,
			pollHandle: null,
			queue: [],
			seen: new Set(),
			transcribing: false,
			stopping: false,
			closed: false,
			closeResolve: null,
			startedAt: Date.now(),
			getStderr: () => stderr,
		};

		session.pollHandle = setInterval(
			() => void this.pollRealtimeChunks(session),
			1500,
		);

		child.on("error", (err) =>
			this.terminateRealtime(session, `ffmpeg error: ${err.message}`),
		);
		child.on("close", (code) => {
			session.closed = true;
			session.closeResolve?.();
			if (!session.stopping && this.realtime === session) {
				this.terminateRealtime(
					session,
					diagnoseFfmpegError(code, stderr, captureArgs),
				);
			}
		});

		this.realtime = session;
	}

	private async pollRealtimeChunks(session: RealtimeSession) {
		if (this.realtime !== session && !session.stopping) return;
		let files: string[] = [];
		try {
			files = (await fs.readdir(session.outDir))
				.filter((f) => f.endsWith(".wav"))
				.sort();
		} catch {
			return;
		}
		// While ffmpeg is still running, the last file is being written — skip it.
		// After ffmpeg closes, everything is complete.
		const completed = session.closed ? files : files.slice(0, -1);
		for (const f of completed) {
			if (!session.seen.has(f)) {
				session.seen.add(f);
				session.queue.push(path.join(session.outDir, f));
			}
		}
		session.loader.updateRealtime(
			session.queue.length + (session.transcribing ? 1 : 0),
		);
		void this.pumpRealtimeQueue(session);
	}

	private async pumpRealtimeQueue(session: RealtimeSession) {
		if (session.transcribing) return;
		const next = session.queue.shift();
		if (!next) return;
		session.transcribing = true;
		session.loader.updateRealtime(
			session.queue.length + 1,
		);

		let streamed = false;
		try {
			const { result } = await this.startWhisper(next, (line) => {
				streamed = true;
				session.loader.appendTranscriptLine(line);
			});
			const transcript = await result;
			if (!streamed && transcript.trim()) {
				for (const l of transcript.split(/\r?\n/)) {
					const trimmed = l.trim();
					if (trimmed) session.loader.appendTranscriptLine(trimmed);
				}
			}
		} catch (err) {
			console.error(
				"whisper: chunk transcription failed:",
				next,
				err,
			);
			session.loader.appendTranscriptLine(
				`> [chunk failed: ${err instanceof Error ? err.message : String(err)}]`,
			);
		} finally {
			fs.rm(next, { force: true }).catch(() => {});
			session.transcribing = false;
			session.loader.updateRealtime(session.queue.length);
			// Drain more if available.
			void this.pumpRealtimeQueue(session);
		}
	}

	private async stopRealtime() {
		if (this.streaming) {
			return this.stopStreaming();
		}
		const session = this.realtime;
		if (!session) {
			new Notice("No real-time transcription in progress.");
			return;
		}
		session.stopping = true;

		// Ask ffmpeg to finalise cleanly.
		try {
			session.child.stdin?.write("q");
			session.child.stdin?.end();
		} catch {
			/* ignore */
		}

		// Wait up to 8s for close.
		if (!session.closed) {
			await new Promise<void>((resolve) => {
				session.closeResolve = resolve;
				setTimeout(resolve, 8000);
			});
		}
		if (!session.closed) {
			killChild(session.child);
			await new Promise<void>((resolve) => {
				session.closeResolve = resolve;
				setTimeout(resolve, 2000);
			});
		}

		session.loader.markFinalizing();

		// Pick up any final chunks.
		await this.pollRealtimeChunks(session);

		// Drain the queue.
		while (session.queue.length > 0 || session.transcribing) {
			await sleep(200);
		}

		if (session.pollHandle) clearInterval(session.pollHandle);
		fs.rm(session.outDir, { recursive: true, force: true }).catch(() => {});

		session.loader.finish("");
		if (this.realtime === session) this.realtime = null;
		new Notice("Real-time transcription stopped.");
	}

	private terminateRealtime(session: RealtimeSession, errorMsg: string) {
		if (this.realtime !== session) return;
		if (session.pollHandle) clearInterval(session.pollHandle);
		this.realtime = null;
		session.loader.fail(errorMsg);
		fs.rm(session.outDir, { recursive: true, force: true }).catch(() => {});
	}

	private async startStreaming(editor: Editor) {
		const captureArgs = this.settings.captureArgs.trim();
		const streamCmd = this.settings.streamingCommand.trim();
		if (!streamCmd) {
			new Notice("Configure 'Streaming command' in settings first.");
			return;
		}

		// ffmpeg: capture system audio → raw PCM (s16le mono 16 kHz) on stdout.
		const ffmpegArgs = [
			...splitArgs(captureArgs),
			"-ac",
			"1",
			"-ar",
			"16000",
			"-acodec",
			"pcm_s16le",
			"-f",
			"s16le",
			"-",
		];
		let ffmpeg: ChildProcess;
		try {
			ffmpeg = spawn(this.settings.ffmpegPath, ffmpegArgs, {
				shell: false,
			});
		} catch (err) {
			new Notice(
				`Failed to start ffmpeg: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		// Streaming command: reads raw PCM on stdin, prints transcript lines on stdout.
		const streamParts = splitArgs(streamCmd);
		if (streamParts.length === 0) {
			killChild(ffmpeg);
			new Notice("Streaming command is empty.");
			return;
		}
		const [streamBin, ...streamArgs] = streamParts;
		let streamer: ChildProcess;
		try {
			streamer = spawn(streamBin, streamArgs, {
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			killChild(ffmpeg);
			new Notice(
				`Failed to start streaming command: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		// Pipe ffmpeg.stdout → streamer.stdin (raw PCM bytes).
		if (ffmpeg.stdout && streamer.stdin) {
			ffmpeg.stdout.pipe(streamer.stdin);
			// Don't let a broken streamer pipe crash the process.
			ffmpeg.stdout.on("error", () => {});
			streamer.stdin.on("error", () => {});
		}

		let ffmpegStderr = "";
		let streamerStderr = "";
		ffmpeg.stderr?.on("data", (c) => {
			ffmpegStderr += c.toString();
			if (ffmpegStderr.length > 4000)
				ffmpegStderr = ffmpegStderr.slice(-4000);
		});
		streamer.stderr?.on("data", (c) => {
			streamerStderr += c.toString();
			if (streamerStderr.length > 4000)
				streamerStderr = streamerStderr.slice(-4000);
		});

		const loader = new InlineLoader(editor, "system audio", "streaming");
		loader.startStreaming();

		const session: StreamingSession = {
			ffmpeg,
			streamer,
			editor,
			loader,
			stopping: false,
			getFfmpegStderr: () => ffmpegStderr,
			getStreamerStderr: () => streamerStderr,
		};

		// Line-buffered stdout from the streamer.
		let pending = "";
		streamer.stdout?.on("data", (chunk) => {
			pending += chunk.toString();
			const parts = pending.split(/\r?\n/);
			pending = parts.pop() ?? "";
			for (const raw of parts) {
				const cleaned = cleanLine(raw);
				if (cleaned) loader.appendTranscriptLine(cleaned);
			}
		});

		// When either side exits unexpectedly, terminate the session.
		const terminate = (reason: string) => {
			if (this.streaming !== session) return;
			if (session.stopping) return;
			this.streaming = null;
			try {
				killChild(ffmpeg);
			} catch {
				/* ignore */
			}
			try {
				killChild(streamer);
			} catch {
				/* ignore */
			}
			loader.fail(reason);
		};

		ffmpeg.on("error", (err) =>
			terminate(`ffmpeg error: ${err.message}`),
		);
		streamer.on("error", (err) =>
			terminate(`Streaming command error: ${err.message}`),
		);
		ffmpeg.on("close", (code) => {
			if (session.stopping) return;
			if (code !== 0 && code !== null) {
				terminate(
					diagnoseFfmpegError(code, ffmpegStderr, captureArgs),
				);
			}
		});
		streamer.on("close", (code) => {
			if (session.stopping) return;
			if (code !== 0 && code !== null) {
				terminate(
					`Streaming command exited with code ${code}. ${streamerStderr.slice(-400) || "(no stderr)"}`,
				);
			}
		});

		this.streaming = session;
	}

	private async stopStreaming() {
		const session = this.streaming;
		if (!session) {
			new Notice("No streaming session in progress.");
			return;
		}
		this.streaming = null;
		session.stopping = true;

		session.loader.markFinalizing();

		// Ask ffmpeg to finish, which will close its stdout and EOF the streamer's stdin.
		try {
			session.ffmpeg.stdin?.write("q");
			session.ffmpeg.stdin?.end();
		} catch {
			/* ignore */
		}
		const ffmpegClosed = await waitForClose(session.ffmpeg, 5000);
		if (!ffmpegClosed) killChild(session.ffmpeg);

		// Streamer should flush remaining output and exit once its stdin closes.
		const streamerClosed = await waitForClose(session.streamer, 15000);
		if (!streamerClosed) killChild(session.streamer);

		session.loader.finish("");
		new Notice("Live streaming stopped.");
	}

	private async listAudioDevices() {
		const spec = listDevicesCommand(this.settings.ffmpegPath);
		if (!spec) {
			new Notice(
				"Device listing isn't supported on this platform. Consult your OS's audio tooling.",
			);
			return;
		}
		const notice = new Notice("Querying audio devices…", 0);
		let raw = "";
		try {
			raw = await captureCommand(spec.cmd, spec.args);
		} catch (err) {
			notice.hide();
			new Notice(
				`Failed to query devices (${spec.cmd}): ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}
		notice.hide();

		const devices = parseAudioDevices(spec.format, raw);
		new DeviceListModal(
			this.app,
			raw,
			devices,
			spec.format,
			async (device) => {
				this.settings.captureArgs = buildCaptureArgs(
					spec.format,
					device,
				);
				await this.saveSettings();
				new Notice(
					`Capture args set: ${this.settings.captureArgs}`,
				);
			},
		).open();
	}

	private async stopRecordingAndTranscribe() {
		const rec = this.recording;
		if (!rec) {
			new Notice("No recording in progress.");
			return;
		}
		this.recording = null;

		rec.loader.markFinalizing();

		// Ask ffmpeg to finish cleanly.
		try {
			rec.child.stdin?.write("q");
			rec.child.stdin?.end();
		} catch {
			/* ignore */
		}

		const closed = await waitForClose(rec.child, 8000);
		if (!closed) {
			killChild(rec.child);
			await waitForClose(rec.child, 2000);
		}

		// Verify the recording file exists and is non-empty.
		let size = 0;
		try {
			size = (await fs.stat(rec.filePath)).size;
		} catch {
			/* file missing */
		}
		if (size < 1024) {
			rec.loader.fail(
				`Recording produced no audio (${size} bytes). ffmpeg stderr: ${rec
					.getStderr()
					.slice(-400) || "(empty)"}`,
			);
			fs.rm(rec.filePath, { force: true }).catch(() => {});
			return;
		}

		try {
			await this.transcribeAndInsert(
				rec.filePath,
				rec.editor,
				rec.loader,
			);
		} finally {
			fs.rm(rec.filePath, { force: true }).catch(() => {});
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

type LoaderMode = "transcribing" | "recording" | "finalizing" | "realtime";

class InlineLoader {
	private editor: Editor;
	private marker: string;
	private prefix: string;
	private suffix: string;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private streamedAny = false;
	private mode: LoaderMode = "transcribing";
	private recordingStartedAt = 0;
	private realtimeChunkSec = 15;
	private realtimeQueue = 0;

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
		this.mode = "transcribing";
		this.insertInitial();
		this.interval = setInterval(() => this.tick(), 120);
	}

	startRecording() {
		this.mode = "recording";
		this.recordingStartedAt = Date.now();
		this.insertInitial();
		this.interval = setInterval(() => this.tick(), 500);
	}

	startRealtime(chunkSec: number) {
		this.mode = "realtime";
		this.recordingStartedAt = Date.now();
		this.realtimeChunkSec = chunkSec;
		this.realtimeQueue = 0;
		this.insertInitial();
		this.interval = setInterval(() => this.tick(), 500);
	}

	startStreaming() {
		this.mode = "realtime";
		this.recordingStartedAt = Date.now();
		this.realtimeChunkSec = 0; // 0 = true streaming, no chunks
		this.realtimeQueue = 0;
		this.insertInitial();
		this.interval = setInterval(() => this.tick(), 500);
	}

	updateRealtime(queueDepth: number) {
		this.realtimeQueue = queueDepth;
	}

	switchToTranscribing(filename: string, model: string) {
		this.mode = "transcribing";
		this.prefix = `> ⏳ Transcribing \`${filename}\` with \`${model}\` model… `;
		this.suffix = ` · run **Whisper: Cancel transcription** to stop`;
		this.restartTick(120);
	}

	markFinalizing() {
		this.mode = "finalizing";
		this.restartTick(200);
	}

	private insertInitial() {
		const cursor = this.editor.getCursor();
		const endOfLine = {
			line: cursor.line,
			ch: this.editor.getLine(cursor.line).length,
		};
		this.editor.replaceRange(`\n\n${this.buildLine()}`, endOfLine);
	}

	private restartTick(ms: number) {
		if (this.interval) clearInterval(this.interval);
		this.interval = setInterval(() => this.tick(), ms);
		this.tick();
	}

	appendTranscriptLine(line: string) {
		const loaderLine = this.findLoaderLine();
		if (loaderLine < 0) return;
		// Insert "<line>\n" at the start of the loader line — the loader slides down.
		this.editor.replaceRange(`${line}\n`, { line: loaderLine, ch: 0 });
		this.streamedAny = true;
	}

	finish(transcript: string) {
		if (this.streamedAny) {
			this.removeLoader();
		} else {
			this.replaceLoaderWith(transcript);
		}
	}

	fail(message: string) {
		this.replaceLoaderWith(`> ❌ Whisper failed: ${message}`);
	}

	cancel() {
		if (this.streamedAny) {
			this.stop();
			const loaderLine = this.findLoaderLine();
			if (loaderLine < 0) return;
			this.rewriteLine(loaderLine, `> ⚠️ Transcription cancelled.`);
		} else {
			this.replaceLoaderWith(`> ⚠️ Transcription cancelled.`);
		}
	}

	private removeLoader() {
		this.stop();
		const loaderLine = this.findLoaderLine();
		if (loaderLine < 0) return;
		const lastLine = this.editor.lineCount() - 1;
		if (loaderLine < lastLine) {
			// Remove this line and its trailing newline.
			this.editor.replaceRange(
				"",
				{ line: loaderLine, ch: 0 },
				{ line: loaderLine + 1, ch: 0 },
			);
		} else {
			// Last line of the doc — remove the preceding newline too.
			const prevEnd =
				loaderLine > 0
					? this.editor.getLine(loaderLine - 1).length
					: 0;
			this.editor.replaceRange(
				"",
				{ line: Math.max(0, loaderLine - 1), ch: prevEnd },
				{ line: loaderLine, ch: this.editor.getLine(loaderLine).length },
			);
		}
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
		if (this.mode === "recording") {
			const elapsed = Math.floor(
				(Date.now() - this.recordingStartedAt) / 1000,
			);
			const mm = Math.floor(elapsed / 60);
			const ss = (elapsed % 60).toString().padStart(2, "0");
			const dot = this.frame % 2 === 0 ? "🔴" : "⚫";
			return `> ${dot} Recording system audio… ${mm}:${ss} · run **Whisper: Stop recording and transcribe** to finish  ${this.marker}`;
		}
		if (this.mode === "realtime") {
			const elapsed = Math.floor(
				(Date.now() - this.recordingStartedAt) / 1000,
			);
			const mm = Math.floor(elapsed / 60);
			const ss = (elapsed % 60).toString().padStart(2, "0");
			const dot = this.frame % 2 === 0 ? "🔴" : "⚫";
			const label =
				this.realtimeChunkSec > 0
					? `chunks ${this.realtimeChunkSec}s`
					: `streaming`;
			const queue =
				this.realtimeQueue > 0
					? ` · ${this.realtimeQueue} pending`
					: "";
			return `> ${dot} Live transcription (${label})… ${mm}:${ss}${queue} · run **Whisper: Stop real-time transcription** to finish  ${this.marker}`;
		}
		if (this.mode === "finalizing") {
			return `> 💾 Finalising…  ${this.marker}`;
		}
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
	onStdoutLine?: (line: string) => void,
): { child: ChildProcess; done: Promise<string> } {
	const child = spawn(cmd, args, { shell: false });
	let stdout = "";
	let stderr = "";
	let pending = "";

	const emitLines = (flush: boolean) => {
		if (!onStdoutLine) return;
		const parts = pending.split(/\r?\n/);
		pending = flush ? "" : (parts.pop() ?? "");
		for (const raw of parts) {
			const cleaned = cleanLine(raw);
			if (cleaned) onStdoutLine(cleaned);
		}
	};

	child.stdout?.on("data", (chunk) => {
		const s = chunk.toString();
		stdout += s;
		pending += s;
		emitLines(false);
	});
	child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
	const done = new Promise<string>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			emitLines(true);
			if (code === 0) resolve(stdout);
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

function cleanLine(raw: string): string | null {
	// Strip ANSI escape sequences.
	let s = raw.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
	// Keep only the content after the last \r (tqdm overwrites).
	const parts = s.split("\r");
	s = parts[parts.length - 1];
	// Drop tqdm progress bar lines.
	if (/^\s*\d+%\|/.test(s)) return null;
	// Strip "[hh:mm:ss --> hh:mm:ss]" timestamp prefix.
	s = s.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, "");
	s = s.trim();
	return s || null;
}

async function readTranscript(
	outDir: string,
	mediaPath: string,
	stdout: string,
): Promise<string> {
	const files = await fs.readdir(outDir);
	const txts = files.filter((f) => f.toLowerCase().endsWith(".txt"));

	if (txts.length > 0) {
		const mediaBase = path
			.basename(mediaPath, path.extname(mediaPath))
			.toLowerCase();
		const exact = txts.find(
			(f) => path.basename(f, ".txt").toLowerCase() === mediaBase,
		);
		const chosen = exact ? [exact] : txts;

		const parts = await Promise.all(
			chosen.map((f) => fs.readFile(path.join(outDir, f), "utf8")),
		);
		const text = parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
		if (text) return text;
	}

	// No file written — fall back to the process's stdout.
	const fromStdout = cleanStdout(stdout);
	if (fromStdout) return fromStdout;

	throw new Error(
		`Whisper produced no transcript (no .txt file and stdout was empty). Output dir: ${files.join(", ") || "(empty)"}.`,
	);
}

function cleanStdout(s: string): string {
	if (!s) return "";
	return s
		.split(/\r?\n/)
		.map((l) => cleanLine(l))
		.filter((l): l is string => !!l)
		.join("\n");
}

function diagnoseFfmpegError(
	code: number | null,
	stderr: string,
	captureArgs: string,
): string {
	const tail = stderr.slice(-500).trim();
	const missingDevice =
		/Could not find (audio|video).*device with name/i.test(stderr) ||
		/Error opening input/i.test(stderr);
	const hasUnquotedSpaceInInput = /-i\s+[^"']*\S\s\S/.test(captureArgs);

	let hint = "";
	if (missingDevice && hasUnquotedSpaceInInput) {
		hint =
			`\n\nHint: your capture input looks unquoted. Values containing spaces must be quoted, e.g. -i "audio=Stereo Mix". Update the setting.`;
	} else if (missingDevice) {
		hint =
			`\n\nHint: the device name wasn't found. List DirectShow devices with:  ffmpeg -list_devices true -f dshow -i dummy  and copy the exact name into the capture args setting (wrap it in quotes).`;
	}

	return `ffmpeg exited with code ${code}. ${tail || "(no stderr)"}${hint}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForClose(
	child: ChildProcess,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode) {
			resolve(true);
			return;
		}
		let done = false;
		const t = setTimeout(() => {
			if (done) return;
			done = true;
			resolve(false);
		}, timeoutMs);
		child.once("close", () => {
			if (done) return;
			done = true;
			clearTimeout(t);
			resolve(true);
		});
	});
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

type CaptureFormat = "dshow" | "avfoundation" | "pulse";

interface ListDevicesSpec {
	cmd: string;
	args: string[];
	format: CaptureFormat;
}

interface AudioDevice {
	label: string;
	value: string;
}

function listDevicesCommand(ffmpegPath: string): ListDevicesSpec | null {
	if (process.platform === "win32") {
		return {
			cmd: ffmpegPath,
			args: [
				"-hide_banner",
				"-list_devices",
				"true",
				"-f",
				"dshow",
				"-i",
				"dummy",
			],
			format: "dshow",
		};
	}
	if (process.platform === "darwin") {
		return {
			cmd: ffmpegPath,
			args: [
				"-hide_banner",
				"-f",
				"avfoundation",
				"-list_devices",
				"true",
				"-i",
				"",
			],
			format: "avfoundation",
		};
	}
	// Assume PulseAudio/PipeWire on Linux.
	return { cmd: "pactl", args: ["list", "sources", "short"], format: "pulse" };
}

function captureCommand(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(cmd, args, { shell: false });
		} catch (err) {
			reject(err);
			return;
		}
		let buf = "";
		child.stdout?.on("data", (c) => (buf += c.toString()));
		child.stderr?.on("data", (c) => (buf += c.toString()));
		child.on("error", reject);
		child.on("close", () => resolve(buf));
	});
}

function parseAudioDevices(
	format: CaptureFormat,
	output: string,
): AudioDevice[] {
	const lines = output.split(/\r?\n/);
	if (format === "dshow") {
		const start = lines.findIndex((l) =>
			/DirectShow audio devices/i.test(l),
		);
		if (start < 0) return [];
		const devices: AudioDevice[] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const l = lines[i];
			if (/DirectShow .*devices/i.test(l)) break;
			if (/Alternative name/i.test(l)) continue;
			const m = l.match(/"([^"]+)"/);
			if (m) devices.push({ label: m[1], value: m[1] });
		}
		return devices;
	}
	if (format === "avfoundation") {
		const start = lines.findIndex((l) =>
			/AVFoundation audio devices/i.test(l),
		);
		if (start < 0) return [];
		const devices: AudioDevice[] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const m = lines[i].match(/\[(\d+)\]\s+(.+)$/);
			if (m) devices.push({ label: `[${m[1]}] ${m[2].trim()}`, value: m[1] });
		}
		return devices;
	}
	if (format === "pulse") {
		const devices: AudioDevice[] = [];
		for (const l of lines) {
			const cols = l.split("\t");
			const name = cols[1]?.trim();
			if (name) devices.push({ label: name, value: name });
		}
		return devices;
	}
	return [];
}

function buildCaptureArgs(
	format: CaptureFormat,
	device: AudioDevice,
): string {
	if (format === "dshow") return `-f dshow -i "audio=${device.value}"`;
	if (format === "avfoundation") return `-f avfoundation -i :${device.value}`;
	return `-f pulse -i ${device.value}`;
}

class DeviceListModal extends Modal {
	constructor(
		app: App,
		private raw: string,
		private devices: AudioDevice[],
		private format: CaptureFormat,
		private onPick: (d: AudioDevice) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("System audio devices");
		const { contentEl } = this;

		if (this.devices.length === 0) {
			contentEl.createEl("p", {
				text: "No audio devices detected. See the raw output below. On Windows you may need to enable 'Stereo Mix' in Sound settings, or install a virtual loopback driver such as VB-CABLE.",
			});
		} else {
			contentEl.createEl("p", {
				text: `Click a device to set it as your capture input (${this.format}):`,
			});
			const list = contentEl.createEl("div");
			list.style.display = "flex";
			list.style.flexDirection = "column";
			list.style.gap = "0.25em";
			list.style.marginBottom = "0.75em";
			for (const d of this.devices) {
				const btn = list.createEl("button", { text: d.label });
				btn.style.textAlign = "left";
				btn.addEventListener("click", async () => {
					await this.onPick(d);
					this.close();
				});
			}
		}

		const details = contentEl.createEl("details");
		details.createEl("summary", { text: "Raw output" });
		const pre = details.createEl("pre");
		pre.style.maxHeight = "20em";
		pre.style.overflow = "auto";
		pre.style.fontSize = "0.8em";
		pre.style.whiteSpace = "pre-wrap";
		pre.setText(this.raw || "(no output)");
	}

	onClose() {
		this.contentEl.empty();
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

		containerEl.createEl("h3", { text: "System audio recording" });

		new Setting(containerEl)
			.setName("FFmpeg executable")
			.setDesc(
				"Command or absolute path to ffmpeg. Required for 'Start recording system audio'.",
			)
			.addText((text) =>
				text
					.setPlaceholder("ffmpeg")
					.setValue(this.plugin.settings.ffmpegPath)
					.onChange(async (value) => {
						this.plugin.settings.ffmpegPath =
							value.trim() || "ffmpeg";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Capture input arguments")
			.setDesc(
				`FFmpeg input args for system audio loopback. IMPORTANT: quote any value that contains spaces. Windows: -f dshow -i "audio=Stereo Mix" (enable Stereo Mix in Sound control panel). macOS: -f avfoundation -i :N (requires BlackHole / Loopback as device N). Linux: -f pulse -i default.monitor. List Windows devices with: ffmpeg -list_devices true -f dshow -i dummy`,
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_CAPTURE_ARGS)
					.setValue(this.plugin.settings.captureArgs)
					.onChange(async (value) => {
						this.plugin.settings.captureArgs = value;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h3", { text: "Real-time transcription" });

		new Setting(containerEl)
			.setName("Chunk length (seconds)")
			.setDesc(
				"For chunked real-time mode (used when no streaming command is set). Smaller = lower latency, worse accuracy. 5–15 is a good range.",
			)
			.addText((text) =>
				text
					.setPlaceholder("15")
					.setValue(String(this.plugin.settings.realtimeChunkSeconds))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.realtimeChunkSeconds =
							Number.isFinite(n) && n > 0 ? n : 15;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Streaming command")
			.setDesc(
				"Optional. A command that reads raw PCM audio (s16le, mono, 16 kHz) from stdin and prints transcript lines on stdout. When set, the 'Start real-time transcription' command uses true streaming instead of chunked mode. Examples — whisper_streaming (ufal): whisper_online.py --backend faster-whisper --model base --min-chunk-size 1 --vac — or whisper.cpp with a stdin-reading fork — or your own faster-whisper wrapper. Leave empty to use chunked mode.",
			)
			.addText((text) =>
				text
					.setPlaceholder("(leave empty for chunked mode)")
					.setValue(this.plugin.settings.streamingCommand)
					.onChange(async (value) => {
						this.plugin.settings.streamingCommand = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
