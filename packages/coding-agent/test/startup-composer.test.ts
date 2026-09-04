import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { COMPOSER_DEFAULTS, Composer, type ComposerPreferences } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { Text } from "@oh-my-pi/pi-tui";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	applyStartupComposerPreferences,
	beginStartupComposer,
	ComposerLease,
	setStartupComposerLspServers,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession } from "./utilities";

class CountingTerminal extends VirtualTerminal {
	starts = 0;
	stops = 0;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.starts += 1;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stops += 1;
		super.stop();
	}
}

class ThrowingStartTerminal extends CountingTerminal {
	override start(): void {
		this.starts += 1;
		throw new Error("terminal start failed");
	}
}
class InputTrackingTerminal extends CountingTerminal {
	startOptions: { deferInput?: boolean } | undefined;
	inputEnables = 0;
	override start(
		onInput: (data: string) => void,
		onResize: () => void,
		_onDisconnect?: () => void,
		options?: { deferInput?: boolean },
	): void {
		this.startOptions = options;
		super.start(onInput, onResize);
	}

	enableInput(): void {
		this.inputEnables += 1;
	}
}

describe("Composer prepaint", () => {
	let settings: Settings;

	let config: ComposerPreferences;
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: settings.get("startup.quiet"),
			composerShape: settings.get("composer.shape") ?? "box",
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			mouse: settings.get("tui.mouse"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
		setKittyProtocolActive(false);
	});

	it("keeps one live editor and terminal across handoff", () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		const submit = vi.fn();
		composer.editor.onSubmit = submit;

		composer.start();
		terminal.sendInput("alpha");
		terminal.sendInput("\r");

		expect(composer.editor.getExpandedText()).toBe("alpha");
		expect(submit).not.toHaveBeenCalled();
		expect(terminal.starts).toBe(1);

		composer.transfer();
		composer.stop();
		terminal.sendInput(" beta");

		expect(composer.editor.getExpandedText()).toBe("alpha beta");
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(0);

		composer.ui.stop();
		expect(terminal.stops).toBe(1);
	});

	it("adopts the live draft with final theme, keybindings, and submit behavior", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		terminal.sendInput("alpha ");
		terminal.sendInput("\x1b[200~one\ntwo\x1b[201~");
		terminal.sendInput(" omega");
		terminal.sendInput("\x1b[D");

		const expectedDraft = composer.editor.getExpandedText();
		const expectedCursor = composer.editor.getCursor();
		const lease = new ComposerLease(composer);
		const adoptedComposer = lease.composer;
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: { symbolPreset: "ascii" },
		});
		let mode: InteractiveMode | undefined;

		try {
			await initTheme(false, "ascii");
			settings.set("composer.shape", "box");
			vi.spyOn(KeybindingsManager, "create").mockReturnValue(KeybindingsManager.inMemory({ "app.clear": "ctrl+x" }));
			mode = new InteractiveMode(
				testSession.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				adoptedComposer,
			);
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			await mode.init({ suppressWelcomeIntro: true });

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			expect(mode.editor.getCursor()).toEqual(expectedCursor);
			expect(terminal.starts).toBe(1);
			const adoptedEditor = Bun.stripANSI(mode.editor.render(40).join("\n"));
			expect(adoptedEditor.startsWith("+")).toBe(true);
			expect(adoptedEditor).not.toContain("╭");

			terminal.sendInput("\x03");
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			terminal.sendInput("\x18");
			expect(mode.editor.getExpandedText()).toBe("");
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("ready");
			expect(mode.editor.getExpandedText()).toBe("ready");

			const submitted = mode.getUserInput();
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			expect(await submitted).toEqual(expect.objectContaining({ text: "ready" }));
			expect(mode.editor.getExpandedText()).toBe("");
			expect(terminal.starts).toBe(1);
		} finally {
			mode?.stop();
			await testSession.cleanup();
			vi.restoreAllMocks();
			await initTheme();
		}
	});

	it("keeps submit gated during initialization, then dispatches with steer", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		const enteredInit = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		vi.spyOn(mode, "refreshSlashCommandState").mockImplementation(async () => {
			enteredInit.resolve();
			await releaseInit.promise;
		});
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(testSession.session, "maybeStartTitleGeneration").mockImplementation(() => {});
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			const initializing = mode.init({ suppressWelcomeIntro: true });
			await enteredInit.promise;
			terminal.sendInput("alpha");
			terminal.sendInput("\r");

			expect(prompt).not.toHaveBeenCalled();
			expect(mode.editor.getExpandedText()).toBe("alpha");
			expect(mode.editor.disableSubmit).toBe(true);

			releaseInit.resolve();
			await initializing;
			// Init wired the submit pipeline and lifted the gate: an Enter before
			// the input loop's first getUserInput dispatches directly with steer
			// instead of being silently dropped.
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length === 0; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("alpha", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");
		} finally {
			releaseInit.resolve();
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("accepts input while the initial CLI prompt's first turn is still running", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(testSession.session, "maybeStartTitleGeneration").mockImplementation(() => {});
		const turn = Promise.withResolvers<boolean>();
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			await mode.init({ suppressWelcomeIntro: true });

			// The `omp "prompt"` launch shape: the CLI message is dispatched after
			// init and its first turn is still in flight when the user types. The
			// input loop has not reached getUserInput yet.
			prompt.mockReturnValueOnce(turn.promise);
			const initialTurn = testSession.session.prompt("count to 25", { streamingBehavior: "steer" });

			terminal.sendInput("also add tests");
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length < 2; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("also add tests", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");

			turn.resolve(true);
			await initialTurn;
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("tracks terminal ownership until a lease is adopted", () => {
		const abandonedTerminal = new CountingTerminal();
		const abandonedComposer = new Composer({ preferences: config, terminal: abandonedTerminal });
		abandonedComposer.start();
		const abandonedLease = new ComposerLease(abandonedComposer);
		abandonedLease.dispose();
		abandonedLease.dispose();
		expect(abandonedTerminal.stops).toBe(1);

		const adoptedTerminal = new CountingTerminal();
		const adoptedComposer = new Composer({ preferences: config, terminal: adoptedTerminal });
		adoptedComposer.start();
		const adoptedLease = new ComposerLease(adoptedComposer);
		adoptedLease.adopt();
		adoptedLease.dispose();
		expect(adoptedTerminal.stops).toBe(0);
		adoptedLease.composer.ui.stop();
		expect(adoptedTerminal.stops).toBe(1);
	});

	it("restores a partially started terminal and leaves no pending owner", () => {
		const terminal = new ThrowingStartTerminal();
		expect(() => beginStartupComposer({ preferences: config, terminal, cache: false })).toThrow(
			"terminal start failed",
		);
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(1);
		expect(takeStartupComposerLease()).toBeUndefined();
	});

	it("bounds a tall startup draft after adoption in a short terminal", async () => {
		const terminal = new CountingTerminal(80, 8);
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		for (let index = 0; index < 18; index += 1) {
			terminal.sendInput(`line-${index}`);
			if (index < 17) terminal.sendInput("\n");
		}
		const draft = composer.editor.getExpandedText();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

		try {
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();
			expect(mode.editor.getExpandedText()).toBe(draft);
			expect(draft.split("\n")).toHaveLength(18);
			expect(mode.editor.render(80).length).toBeLessThanOrEqual(4);
			expect(terminal.getViewport().join("\n")).not.toContain("Starting OMP");
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("restores the terminal before an early double interrupt exits", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		let now = 1_000;
		const composer = new Composer({ preferences: config, terminal, exit, now: () => now });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x03");
		expect(composer.editor.getExpandedText()).toBe("");
		now += 100;
		terminal.sendInput("\x03");

		expect(terminal.stops).toBe(1);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("uses standard emergency exit before interactive keybindings load", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});
	it("keeps emergency exit live after adoption until interactive handlers replace it", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();
		const lease = new ComposerLease(composer);
		lease.adopt();

		// InputController.setupKeyHandlers() has not run yet; a stalled startup must
		// still honor Ctrl+D so a raw-mode user can abort.
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});

	it("first frame mirrors the canonical settings-schema defaults", () => {
		expect(COMPOSER_DEFAULTS).toEqual({
			quiet: getDefault("startup.quiet"),
			composerShape: getDefault("composer.shape") ?? "box",
			showHardwareCursor: getDefault("showHardwareCursor"),
			maxInlineImages: getDefault("tui.maxInlineImages"),
			resizeScrollback: getDefault("tui.resizeScrollback"),
			imeSafeCursor: getDefault("tui.imeSafeCursor"),
			mouse: getDefault("tui.mouse"),
			autocompleteMaxVisible: getDefault("autocompleteMaxVisible"),
			spellingTypoDetection: getDefault("spelling.typoDetection"),
			spellingAutocomplete: getDefault("spelling.autocomplete"),
			spellingAutocorrect: getDefault("spelling.autocorrect"),
		});
	});
	it("renders the complete interactive welcome scene on the first frame", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			welcome: {
				version: "9.9.9",
				recentSessions: [{ name: "prior work", timeAgo: "5m ago" }],
			},
		});
		composer.start();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).toContain("Welcome back!");
		expect(output).toContain("omp");
		expect(output).toContain("9.9.9");
		expect(output).toContain("prior work");
		expect(output).not.toContain("Starting OMP");
		expect(output).toContain("╭");
		const initialEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╭"));
		composer.updateWelcome({
			modelName: "provider/model-with-an-authoritative-name-that-is-longer-than-the-left-column",
			providerName: "provider-with-a-long-name",
			lspServers: [{ name: "rust-analyzer", status: "connecting", fileTypes: [".rs"] }],
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("rust-analyzer")),
		);
		const updatedEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╭"));
		expect(updatedEditorRow).toBe(initialEditorRow);
		composer.stop();
	});

	it("adopted welcome survives handoff with authoritative data", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			welcome: {
				version: "9.9.9",
				modelName: "Claude Fable 5",
				providerName: "anthropic",
				recentSessions: [{ name: "prior work", timeAgo: "5m ago" }],
			},
		});
		composer.start();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);
		const prepaintRows = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(prepaintRows.join("\n")).toContain("Claude Fable 5");
		expect(prepaintRows.join("\n")).toContain("anthropic");
		const prepaintEditorRow = prepaintRows.findLastIndex(row => row.startsWith("╭"));

		terminal.sendInput("draft message");
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		let mode: InteractiveMode | undefined;

		try {
			mode = new InteractiveMode(
				testSession.session,
				"9.9.9",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				lease.composer,
			);
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
			const realTopBorder = vi
				.spyOn(mode.statusLine, "getTopBorder")
				.mockReturnValue({ content: "real status bar", width: 15, revision: 1 });
			terminal.sendInput(" between");
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			await terminal.waitForRender();
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();

			expect(terminal.starts).toBe(1);
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			const output = terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n");
			const modelName = testSession.session.model?.name ?? "";
			expect(output).toContain(modelName);
			realTopBorder.mockReturnValue({ content: "real status bar *18 ?5", width: 21, revision: 2 });
			mode.ui.requestRender();
			await terminal.waitForRender(() =>
				terminal.getViewport().some(row => Bun.stripANSI(row).includes("real status bar *18 ?5")),
			);
			const welcomeMatches = (output.match(/Welcome back!/g) || []).length;
			expect(welcomeMatches).toBe(1);
			const adoptedEditorRow = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.findLastIndex(row => row.startsWith("╭"));
			expect(adoptedEditorRow).toBe(prepaintEditorRow);
		} finally {
			mode?.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("preferences feed applies quiet mode", async () => {
		const terminal = new CountingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);
		expect(
			terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n"),
		).toContain("Welcome back!");

		applyStartupComposerPreferences({
			quiet: true,
			composerShape: "box",
			showHardwareCursor: config.showHardwareCursor,
			maxInlineImages: config.maxInlineImages,
			resizeScrollback: config.resizeScrollback,
			imeSafeCursor: config.imeSafeCursor,
			autocompleteMaxVisible: config.autocompleteMaxVisible,
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
			theme: {},
		});
		await terminal.waitForRender();

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).not.toContain("Welcome back!");

		terminal.sendInput("still editable");
		await terminal.waitForRender();
		expect(
			terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n"),
		).toContain("still editable");
	});

	it("LSP feed fills the welcome rows", async () => {
		const terminal = new CountingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);

		setStartupComposerLspServers([{ name: "rust-analyzer", status: "connecting", fileTypes: [".rs"] }]);
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("rust-analyzer")),
		);

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).toContain("rust-analyzer");
	});
	it("transfers the in-flight recent-session load across composer ownership", async () => {
		const terminal = new CountingTerminal(80, 32);
		const load = Promise.withResolvers<Array<{ name: string; timeAgo: string }>>();
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
			recentSessions: () => load.promise,
		});

		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		const rows = [{ name: "already loading", timeAgo: "just now" }];
		load.resolve(rows);
		expect(await lease?.recentSessions).toEqual(rows);
		lease?.dispose();
	});
	it("defers raw input until resolved settings arrive, adoption as fallback", async () => {
		// Regression contract: losing the deferral re-blinds typing during the
		// startup module-load stall; losing the enable leaves the keyboard dead
		// for the whole session.
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({ preferences: config, terminal, version: "9.9.9", cache: false });
		expect(terminal.startOptions?.deferInput).toBeTrue();
		expect(terminal.inputEnables).toBe(0);

		applyStartupComposerPreferences({ ...config, theme: {} });
		expect(terminal.inputEnables).toBe(1);

		// Adoption after preferences must not double-enable…
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});

	it("adoption enables raw input when settings never resolved", () => {
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({ preferences: config, terminal, version: "9.9.9", cache: false });
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});

	it("positions cursor when clicking in the composer prompt entry box", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const composer = new Composer({
			preferences: { ...config, composerShape: "box" },
			terminal,
		});
		composer.editor.setText("Hello world prompt");
		composer.start();

		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Hello world prompt")),
		);

		composer.ui.resetDisplay();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Hello world prompt")),
		);

		const textRow = terminal.getViewport().findIndex(row => Bun.stripANSI(row).includes("Hello world prompt"));
		expect(textRow).toBeGreaterThanOrEqual(0);
		const row1Based = textRow + 1;

		terminal.sendInput(`\x1b[<0;10;${row1Based}M`);
		expect(composer.editor.getCursor()).toEqual({ line: 0, col: 6 });

		terminal.sendInput(`\x1b[<0;1;${row1Based}M`);
		expect(composer.editor.getCursor()).toEqual({ line: 0, col: 0 });

		terminal.sendInput(`\x1b[<0;50;${row1Based}M`);
		expect(composer.editor.getCursor()).toEqual({ line: 0, col: 18 });
		composer.stop();
	});

	it("scrolls transcript on wheel while mouse tracking is enabled", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const composer = new Composer({
			preferences: { ...config, quiet: true, composerShape: "box" },
			terminal,
		});
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 12; index++) {
			transcript.addChild(new Text(`history ${index}`, 0, 0));
		}
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start({ playWelcomeIntro: false });

		for (let index = 0; index < 3; index++) {
			await terminal.waitForRender();
		}
		const initialViewport = terminal.getViewport().join("\n");
		expect(initialViewport).toContain("history 11");
		expect(initialViewport).not.toContain("history 0");

		for (let index = 0; index < 8; index++) {
			terminal.sendInput("\x1b[<64;1;1M");
		}
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("history 0");

		terminal.sendInput("\x1b[6;16;8t");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("history 0");

		setKittyProtocolActive(true);
		terminal.sendInput("\x1b[97;1:3u");
		expect(terminal.getViewport().join("\n")).toContain("history 0");

		const frozenViewport = terminal.getViewport();
		transcript.addChild(new Text("streamed after scroll", 0, 0));
		composer.ui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport()).toEqual(frozenViewport);

		for (let index = 0; index < 8; index++) {
			terminal.sendInput("\x1b[<65;1;1M");
		}
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("streamed after scroll")),
		);

		for (let index = 0; index < 8; index++) {
			terminal.sendInput("\x1b[<64;1;1M");
		}
		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("history 0")));

		composer.setEditor(composer.editor);
		composer.ui.requestRender();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("streamed after scroll")),
		);
		expect(terminal.getViewport().join("\n")).not.toContain("history 0");

		terminal.sendInput("x");
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("x")));
		composer.stop();
	});

	it("positions the caret on the first click into a partially visible scrolled editor", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const composer = new Composer({
			preferences: { ...config, quiet: true, composerShape: "box" },
			terminal,
		});
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 12; index++) {
			transcript.addChild(new Text(`history ${index}`, 0, 0));
		}
		composer.editor.setText("line 0\nline 1\nline 2\nline 3\nline 4");
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start({ playWelcomeIntro: false });

		for (let index = 0; index < 3; index++) {
			await terminal.waitForRender();
		}
		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		const textRow = terminal.getViewport().findIndex(row => Bun.stripANSI(row).includes("line 0"));
		expect(textRow).toBeGreaterThanOrEqual(0);

		terminal.sendInput(`\x1b[<0;6;${textRow + 1}M`);
		expect(composer.editor.getCursor()).toEqual({ line: 0, col: 2 });
		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("line 4")));
		composer.stop();
	});

	it("ignores transcript clicks while the scrolled editor is fully hidden", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const composer = new Composer({
			preferences: { ...config, quiet: true, composerShape: "box" },
			terminal,
		});
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 12; index++) {
			transcript.addChild(new Text(`history ${index}`, 0, 0));
		}
		composer.editor.setText("draft 0\ndraft 1\ndraft 2\ndraft 3\ndraft 4\ndraft 5");
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start({ playWelcomeIntro: false });

		for (let index = 0; index < 3; index++) {
			await terminal.waitForRender();
		}
		for (let index = 0; index < 8; index++) {
			terminal.sendInput("\x1b[<64;1;1M");
		}
		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("history 0")));

		expect(composer.editor.getRenderedScreenRow()).toBeNull();
		const cursor = composer.editor.getCursor();
		const staleCursorRow = composer.ui.hardwareCursorRow;
		const transcriptRow = staleCursorRow - 5;
		expect(transcriptRow).toBeGreaterThanOrEqual(0);
		expect(Bun.stripANSI(terminal.getViewport()[transcriptRow] ?? "")).toContain("history");

		terminal.sendInput(`\x1b[<0;4;${transcriptRow + 1}M`);
		expect(composer.editor.getCursor()).toEqual(cursor);
		composer.stop();
	});

	it("flushes finalized transcript rows when stopped from a scrolled viewport", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const composer = new Composer({
			preferences: { ...config, quiet: true, composerShape: "box" },
			terminal,
		});
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 12; index++) {
			transcript.addChild(new Text(`history ${index}`, 0, 0));
		}
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start({ playWelcomeIntro: false });

		for (let index = 0; index < 3; index++) {
			await terminal.waitForRender();
		}
		for (let index = 0; index < 8; index++) {
			terminal.sendInput("\x1b[<64;1;1M");
		}
		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("history 0")));

		transcript.addChild(new Text("late finalized", 0, 0));
		composer.ui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getScrollBuffer().join("\n")).not.toContain("late finalized");

		composer.stop();
		expect(terminal.getScrollBuffer().join("\n")).toContain("late finalized");
	});

	it("preserves signed editor origin when the editor top is clipped above the viewport", async () => {
		const terminal = new VirtualTerminal(80, 8);
		const composer = new Composer({
			preferences: { ...config, composerShape: "box" },
			terminal,
		});
		// Set multi-line text: top border + 6 lines of text + bottom border = 8 rows total
		// Plus header rows (2) -> total composed rows (10) > terminal rows (8)
		composer.editor.setText("line 0\nline 1\nline 2\nline 3\nline 4\nline 5");
		composer.start();

		await terminal.waitForRender(() => terminal.getViewport().some(row => Bun.stripANSI(row).includes("line 5")));

		const renderedScreenRow = composer.editor.getRenderedScreenRow();
		expect(renderedScreenRow).toBeDefined();
		// Viewport shows bottom 8 rows; top of editor is pushed above the viewport (negative or 0)
		expect(typeof renderedScreenRow).toBe("number");

		composer.stop();
	});
});
