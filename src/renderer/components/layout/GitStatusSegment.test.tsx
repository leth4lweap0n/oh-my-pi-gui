/**
 * GitStatusSegment contract: the composer's git segment names the checkout's
 * branch and only its non-zero dirty counters (TUI `gitSegment` markers), stays
 * out of the way off-repo and on a detached HEAD, carries the full counts plus
 * the path in its tooltip, and refetches on click instead of waiting out the
 * 2.5s poll. Rendered with react-dom/client into a linkedom document.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcGitStatus, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { GitStatusSegment } from "./GitStatusSegment";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
// The hook drives window.setInterval; linkedom's window has no timer of its own.
window.setInterval = globalThis.setInterval.bind(globalThis) as unknown as typeof window.setInterval;
window.clearInterval = globalThis.clearInterval.bind(globalThis) as unknown as typeof window.clearInterval;

const getGitStatus = vi.fn<() => Promise<RpcResponse>>();
Object.assign(window, { omp: { rpc: { getGitStatus } } });

interface TestElement {
	textContent: string | null;
	getAttribute(name: string): string | null;
	querySelectorAll(selector: string): TestElement[];
	click(): void;
	remove(): void;
}

let container: TestElement;
let root: Root;

function reply(status: RpcGitStatus): void {
	getGitStatus.mockResolvedValue({ type: "response", command: "get_git_status", success: true, data: status });
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function segment(): TestElement | undefined {
	return container.querySelectorAll("button")[0];
}

function markerTexts(): string[] {
	return (segment()?.querySelectorAll("span") ?? []).map(span => span.textContent ?? "");
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useSessionStore.getState().reset();
	getGitStatus.mockReset();
});

describe("GitStatusSegment", () => {
	it("shows the branch and only the dirty counters that are non-zero", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		reply({ isRepo: true, branch: "omp/gui/fix-login", staged: 3, unstaged: 0, untracked: 1 });
		await mount(<GitStatusSegment />);

		expect(markerTexts()).toEqual(["omp/gui/fix-login", "+3", "?1"]);
	});

	it("stays hidden off a repo and on a detached HEAD", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		reply({ isRepo: false, branch: null, staged: 0, unstaged: 0, untracked: 0 });
		await mount(<GitStatusSegment />);
		expect(segment()).toBeUndefined();

		await act(async () => {
			root.unmount();
		});
		container.remove();
		// Dirty counters still arrive at a detached HEAD, but there is no branch to
		// name — a counters-only segment reads as a mislabeled one.
		reply({ isRepo: true, branch: null, staged: 0, unstaged: 2, untracked: 0 });
		await mount(<GitStatusSegment />);
		expect(segment()).toBeUndefined();
	});

	it("puts the full counts and the checkout path in the tooltip", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		reply({ isRepo: true, branch: "main", staged: 3, unstaged: 2, untracked: 1 });
		await mount(<GitStatusSegment />);

		expect(segment()?.getAttribute("title")).toBe("Branch: main\n3 staged, 2 unstaged, 1 untracked\n/work/app\nClick to refresh");
	});

	it("refetches on click instead of waiting out the poll interval", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		reply({ isRepo: true, branch: "main", staged: 0, unstaged: 1, untracked: 0 });
		await mount(<GitStatusSegment />);
		expect(getGitStatus).toHaveBeenCalledTimes(1);

		await act(async () => {
			segment()?.click();
		});
		await flush();
		expect(getGitStatus).toHaveBeenCalledTimes(2);
	});
});
