import { afterEach, describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import {
	parseSgrMouse,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectListMouseTarget,
	type SgrMouseEvent,
} from "@oh-my-pi/pi-tui/mouse";
import { VirtualTerminal } from "./virtual-terminal";

afterEach(() => setKittyProtocolActive(false));

describe("parseSgrMouse", () => {
	it("returns null for non-mouse input", () => {
		expect(parseSgrMouse("a")).toBeNull();
		expect(parseSgrMouse("\x1b[A")).toBeNull();
		expect(parseSgrMouse("\x1b[<bogus")).toBeNull();
	});

	it("decodes left clicks with 0-based coordinates", () => {
		const event = parseSgrMouse("\x1b[<0;5;9M");
		expect(event).toEqual({
			button: 0,
			col: 4,
			row: 8,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
			shift: false,
			alt: false,
			ctrl: false,
		});
	});

	it("decodes releases as non-clicks", () => {
		const event = parseSgrMouse("\x1b[<0;5;9m");
		expect(event?.release).toBe(true);
		expect(event?.leftClick).toBe(false);
	});

	it("decodes wheel direction from the low button bit", () => {
		expect(parseSgrMouse("\x1b[<64;1;1M")?.wheel).toBe(-1);
		expect(parseSgrMouse("\x1b[<65;1;1M")?.wheel).toBe(1);
		expect(parseSgrMouse("\x1b[<65;1;1M")?.leftClick).toBe(false);
	});

	it("decodes motion reports without treating them as clicks", () => {
		const event = parseSgrMouse("\x1b[<35;10;3M");
		expect(event?.motion).toBe(true);
		expect(event?.leftClick).toBe(false);
		expect(event?.wheel).toBeNull();
	});

	it("decodes modifier keys in button code", () => {
		const altClick = parseSgrMouse("\x1b[<8;5;9M");
		expect(altClick?.alt).toBe(true);
		expect(altClick?.shift).toBe(false);
		expect(altClick?.ctrl).toBe(false);
		expect(altClick?.leftClick).toBe(true);

		const shiftClick = parseSgrMouse("\x1b[<4;5;9M");
		expect(shiftClick?.shift).toBe(true);
		expect(shiftClick?.alt).toBe(false);

		const ctrlAltClick = parseSgrMouse("\x1b[<24;5;9M");
		expect(ctrlAltClick?.ctrl).toBe(true);
		expect(ctrlAltClick?.alt).toBe(true);
		expect(ctrlAltClick?.shift).toBe(false);
	});
});

describe("routeSgrMouseInput", () => {
	it("returns false and does not call the handler for non-mouse input", () => {
		let called = false;
		const handled = routeSgrMouseInput("a", () => {
			called = true;
			return true;
		});
		expect(handled).toBe(false);
		expect(called).toBe(false);
	});

	it("decodes and forwards an SGR mouse report", () => {
		let received: SgrMouseEvent | null = null;
		const handled = routeSgrMouseInput("\x1b[<0;2;3M", event => {
			received = event;
			return true;
		});
		expect(handled).toBe(true);
		if (received === null) throw new Error("expected routeSgrMouseInput to forward an event");
		const event: SgrMouseEvent = received;
		expect(event.row).toBe(2);
		expect(event.col).toBe(1);
		expect(event.leftClick).toBe(true);
	});
});

describe("routeSelectListMouse", () => {
	function makeTarget(hit: number | undefined) {
		const calls: string[] = [];
		const target: SelectListMouseTarget = {
			handleWheel: delta => calls.push(`wheel:${delta}`),
			hitTest: () => hit,
			setHoverIndex: index => calls.push(`hover:${index}`),
			clickItem: index => calls.push(`click:${index}`),
		};
		return { target, calls };
	}

	const baseEvent: SgrMouseEvent = {
		button: 0,
		col: 0,
		row: 0,
		release: false,
		wheel: null,
		motion: false,
		leftClick: false,
	};

	it("forwards wheel notches", () => {
		const { target, calls } = makeTarget(undefined);
		const handled = routeSelectListMouse(target, { ...baseEvent, wheel: 1 }, 0);
		expect(handled).toBe(true);
		expect(calls).toEqual(["wheel:1"]);
	});

	it("hovers the hit-tested row on motion", () => {
		const { target, calls } = makeTarget(4);
		const handled = routeSelectListMouse(target, { ...baseEvent, motion: true }, 0);
		expect(handled).toBe(true);
		expect(calls).toEqual(["hover:4"]);
	});

	it("clears hover when motion misses a row", () => {
		const { target, calls } = makeTarget(undefined);
		const handled = routeSelectListMouse(target, { ...baseEvent, motion: true }, 0);
		expect(handled).toBe(true);
		expect(calls).toEqual(["hover:null"]);
	});

	it("clicks the hit-tested row", () => {
		const { target, calls } = makeTarget(2);
		const handled = routeSelectListMouse(target, { ...baseEvent, leftClick: true }, 0);
		expect(handled).toBe(true);
		expect(calls).toEqual(["click:2"]);
	});

	it("ignores release events", () => {
		const { target, calls } = makeTarget(2);
		const handled = routeSelectListMouse(target, { ...baseEvent, release: true }, 0);
		expect(handled).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe("TUI mouse tracking lifecycle", () => {
	class RecordingTerminal extends VirtualTerminal {
		writes: string[] = [];
		override write(data: string): void {
			this.writes.push(data);
			super.write(data);
		}
	}

	it("defaults normal-mode mouse reporting to disabled", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal, false);

		tui.start();
		expect(terminal.writes.join("")).not.toContain("\x1b[?1000h");
		expect(terminal.writes.join("")).not.toContain("\x1b[?1006h");
		tui.stop();
	});

	it("delays normal-mode mouse reporting until enableInput when input is deferred", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal, false, { mouseTracking: true });
		tui.start({ deferInput: true });
		const startWrites = terminal.writes.join("");
		expect(startWrites).not.toContain("\x1b[?1000h");
		expect(startWrites).not.toContain("\x1b[?1006h");

		tui.enableInput();
		const afterEnable = terminal.writes.join("");
		expect(afterEnable).toContain("\x1b[?1000h");
		expect(afterEnable).toContain("\x1b[?1006h");

		tui.stop();
		const afterStop = terminal.writes.join("");
		expect(afterStop).toContain("\x1b[?1000l");
		expect(afterStop).toContain("\x1b[?1006l");
	});

	it("keeps explicit fullscreen tracking independent from disabled normal mode", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal, false, { mouseTracking: false });

		tui.start();
		expect(terminal.writes.join("")).not.toContain("\x1b[?1000h");

		const overlay = {
			render: () => ["modal line"],
		};
		tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
		terminal.writes.length = 0;
		await terminal.waitForRender(() => terminal.writes.some(w => w.includes("\x1b[?1049h")));

		const modalWrites = terminal.writes.join("");
		expect(modalWrites).toContain("\x1b[?1049h");
		expect(modalWrites).toContain("\x1b[?1000h");
		expect(modalWrites).toContain("\x1b[?1003h");
		expect(modalWrites).toContain("\x1b[?1006h");

		terminal.writes.length = 0;
		tui.setMouseTracking(true);
		tui.setMouseTracking(false);
		const toggledWrites = terminal.writes.join("");
		expect(toggledWrites).not.toContain("\x1b[?1000l");
		expect(toggledWrites).not.toContain("\x1b[?1003l");
		expect(toggledWrites).not.toContain("\x1b[?1006l");

		tui.stop();
	});

	it("honors explicit mouseTracking: false in fullscreen overlays", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal, false);
		tui.start();

		tui.showOverlay({ render: () => ["modal line"] }, { fullscreen: true, mouseTracking: false });
		terminal.writes.length = 0;
		await terminal.waitForRender(() => terminal.writes.some(write => write.includes("\x1b[?1049h")));

		const modalWrites = terminal.writes.join("");
		expect(modalWrites).not.toContain("\x1b[?1000h");
		expect(modalWrites).not.toContain("\x1b[?1003h");
		expect(modalWrites).not.toContain("\x1b[?1006h");
		tui.stop();
	});

	it("lets listeners rewrite wheel input before consumed hotkeys reset the viewport", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal, false, { mouseTracking: true });
		let scrolled = false;
		let resets = 0;
		let rewriteWheel = true;
		const received: string[] = [];
		const focused = {
			render: () => [""],
			handleInput: (data: string) => received.push(data),
		};
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: [""] }),
			acknowledgeHistory: () => {},
			scrollViewport: () => {
				scrolled = true;
				return true;
			},
			resetViewport: () => {
				if (!scrolled) return false;
				scrolled = false;
				resets++;
				return true;
			},
		});
		tui.addInputListener(data => {
			if (rewriteWheel && data.startsWith("\x1b[<")) return { data: "a" };
			return data === "\x0f" ? { consume: true } : undefined;
		});
		tui.addInputListener(data => (data === "a" ? { consume: true } : undefined));
		tui.addChild(focused);
		tui.setFocus(focused);
		tui.start();
		terminal.sendInput("\x1b[<64;1;1M");
		expect(scrolled).toBeFalse();
		expect(received).toEqual([]);
		rewriteWheel = false;

		terminal.sendInput("\x1b[<64;1;1M");
		expect(scrolled).toBeTrue();
		rewriteWheel = true;
		terminal.sendInput("\x1b[<64;1;1M");
		expect(scrolled).toBeFalse();
		expect(resets).toBe(1);

		rewriteWheel = false;
		terminal.sendInput("\x1b[<64;1;1M");
		expect(scrolled).toBeTrue();
		tui.setMouseTracking(false);
		expect(scrolled).toBeFalse();
		expect(resets).toBe(2);

		tui.setMouseTracking(true);
		terminal.sendInput("\x1b[<64;1;1M");
		expect(scrolled).toBeTrue();
		terminal.sendInput("\x0f");
		expect(scrolled).toBeFalse();
		expect(resets).toBe(3);
		tui.stop();
	});

	it("forwards opted-in key releases without resetting a scrolled provider", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TUI(terminal, false, { mouseTracking: true });
		let scrolled = false;
		let resets = 0;
		let rewriteRelease = false;
		const received: string[] = [];
		const focused = {
			wantsKeyRelease: true,
			render: () => [""],
			handleInput: (data: string) => received.push(data),
		};
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: [""] }),
			acknowledgeHistory: () => {},
			scrollViewport: () => {
				scrolled = true;
				return true;
			},
			resetViewport: () => {
				scrolled = false;
				resets++;
				return true;
			},
		});
		tui.addInputListener(data => {
			received.push(`listener:${data}`);
			return rewriteRelease ? { data: "a" } : undefined;
		});
		tui.addChild(focused);
		tui.setFocus(focused);
		tui.start();

		terminal.sendInput("\x1b[<64;1;1M");
		terminal.sendInput("\x1b[97;1:3u");
		expect(scrolled).toBeTrue();
		expect(resets).toBe(0);
		expect(received).toEqual(["listener:\x1b[<64;1;1M", "listener:\x1b[97;1:3u", "\x1b[97;1:3u"]);

		received.length = 0;
		setKittyProtocolActive(true);
		terminal.sendInput("\x1b[97;1:3u");
		expect(scrolled).toBeTrue();
		expect(resets).toBe(0);
		expect(received).toEqual(["listener:\x1b[97;1:3u", "\x1b[97;1:3u"]);

		received.length = 0;
		rewriteRelease = true;
		terminal.sendInput("\x1b[97;1:3u");
		expect(scrolled).toBeFalse();
		expect(resets).toBe(1);
		expect(received).toEqual(["listener:\x1b[97;1:3u", "a"]);
		tui.stop();
	});
});
