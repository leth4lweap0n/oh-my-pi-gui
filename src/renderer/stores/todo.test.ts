/**
 * Todo store snapshot archive: the first setPhases after a reset is session
 * hydration (never a change), later identical re-applies (every agent_end
 * re-pulls state) dedupe by semantic fingerprint, and only real edits append
 * transcript snapshots — capped so the archive keeps the newest entries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodoPhase } from "../../shared/rpc-types";
import { DOCK_FINISHED_HIDE_MS } from "./dock-finished";
import { selectTodoDockVisible, useTodoStore } from "./todo";

// The store schedules its completed-plan grace period on window; the node test
// environment has no window, and the global timers stand in for it.
Object.assign(globalThis, { window: globalThis });

function phase(name: string, ...tasks: Array<[string, string]>): TodoPhase {
	return {
		name,
		tasks: tasks.map(([content, status]) => ({ content, status: status as TodoPhase["tasks"][number]["status"] })),
	};
}

afterEach(() => {
	useTodoStore.getState().reset();
	vi.useRealTimers();
});

describe("todo snapshot archive", () => {
	it("treats the first setPhases as hydration and records no snapshot", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		expect(useTodoStore.getState().history).toEqual([]);
		expect(useTodoStore.getState().historyHydrated).toBe(true);
	});

	it("appends a snapshot only when the phases semantically change", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "pending"])]);
		// Every agent_end re-pulls state with identical phases — no archive noise.
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		expect(useTodoStore.getState().history).toEqual([]);

		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"], ["wire", "in_progress"])]);
		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(1);
		expect(history[0]?.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	it("updates one snapshot while the same todo list progresses", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"], ["wire", "pending"])]);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "in_progress"], ["wire", "pending"])]);
		const id = useTodoStore.getState().history[0]?.id;
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"], ["wire", "completed"])]);

		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(1);
		expect(history[0]?.id).toBe(id);
		expect(history[0]?.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "completed"]);
	});

	it("records an explicit clear transition as an empty snapshot", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		useTodoStore.getState().setPhases([]);
		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(1);
		expect(history[0]?.phases).toEqual([]);
	});

	it("caps the archive at the newest entries", () => {
		for (let i = 0; i < 35; i++) {
			useTodoStore.getState().setPhases([phase("Build", [`task-${i}`, "pending"])]);
		}
		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(30);
		expect(history.at(-1)?.phases[0]?.tasks[0]?.content).toBe("task-34");
	});

	it("resets the archive with the session", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		expect(useTodoStore.getState().history).toHaveLength(1);
		useTodoStore.getState().reset();
		expect(useTodoStore.getState().history).toEqual([]);
		expect(useTodoStore.getState().historyHydrated).toBe(false);
	});
});

describe("todo dock visibility", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("stays for outstanding work and drops out after the completed grace period", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "pending"])]);
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS * 3);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(true);

		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS - 1);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(true);

		vi.advanceTimersByTime(1);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
	});

	it("returns and re-hides when a task reopens and completes again", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);

		store.setPhases([phase("Build", ["scaffold", "in_progress"])]);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(true);

		// The reopened task completing starts a fresh grace period, not the one
		// that already elapsed.
		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS - 1);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(true);
		vi.advanceTimersByTime(1);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
	});

	it("keeps the plan docked while a reminder is open, and re-arms after dismissing it", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		store.showReminder([{ content: "scaffold", status: "pending" }]);
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS * 4);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(true);

		store.clearReminder();
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
	});

	it("drops a pending hide when the session resets", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		store.reset();
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS * 2);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
		expect(useTodoStore.getState().phases).toEqual([]);
	});

	it("is not restarted by an identical re-hydration of the same finished plan", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		// Every agent_end re-pulls the finished plan, so an identical re-apply must
		// not restart the clock — that would keep the card up for the whole session.
		for (let elapsed = 0; elapsed < DOCK_FINISHED_HIDE_MS * 2; elapsed += 2000) {
			store.setPhases([phase("Build", ["scaffold", "completed"])]);
			vi.advanceTimersByTime(2000);
		}
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
	});

	it("never shows a plan that was already finished at hydration — no grace period", () => {
		const store = useTodoStore.getState();
		store.reset();
		store.setPhases([phase("Build", ["scaffold", "completed"], ["wire", "completed"])]);
		// No timer advance: the card must never render, not even for 10 seconds.
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS * 2);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
		expect(useTodoStore.getState().phases).toHaveLength(1);
	});

	it("still shows a plan that arrives unfinished and hides it only after the grace period", () => {
		const store = useTodoStore.getState();
		store.reset();
		store.setPhases([phase("Build", ["scaffold", "in_progress"])]);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(true);
		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		vi.advanceTimersByTime(DOCK_FINISHED_HIDE_MS - 1);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(true);
		vi.advanceTimersByTime(1);
		expect(selectTodoDockVisible(useTodoStore.getState())).toBe(false);
	});
});
