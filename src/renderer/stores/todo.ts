import { createStore } from "zustand/vanilla";
import type { TodoPhase, TodoTask } from "../../shared/rpc-types";
import { createDockFinishedTimer } from "./dock-finished";
import { createScopedStoreHook } from "./session-runtime-context";

export interface UiTodoTask extends TodoTask {
	id: string;
}

export interface UiTodoPhase extends Omit<TodoPhase, "tasks"> {
	id: string;
	tasks: UiTodoTask[];
}

/**
 * One archived todo state: appended whenever the phases actually change after
 * the session's first hydration, rendered as a transcript snapshot row. The
 * first setPhases after a reset is hydration (get_state pull), never a
 * change; later identical re-applies (every agent_end re-pulls state) are
 * deduped by semantic fingerprint so the archive only carries real edits.
 */
export interface TodoSnapshot {
	id: string;
	ts: number;
	phases: TodoPhase[];
}

/** Archive cap — the transcript keeps the newest snapshots, drops the oldest. */
const HISTORY_LIMIT = 30;

/** A phase with no tasks counts as done — an empty phase is a finished one. */
function allTasksCompleted(phases: readonly UiTodoPhase[]): boolean {
	return phases.length > 0 && phases.every(phase => phase.tasks.every(task => task.status === "completed"));
}

/**
 * The dock shows the todo card for any plan or pending reminder, and drops it
 * once the finished grace period elapses. One rule for both consumers (the
 * dock region and the card itself) — they must never disagree, or a hidden
 * card leaves an empty frame behind.
 */
export function selectTodoDockVisible(state: Pick<TodoStore, "phases" | "completedHidden" | "reminderVisible">): boolean {
	return (state.phases.length > 0 && !state.completedHidden) || state.reminderVisible;
}

export interface TodoStore {
	phases: UiTodoPhase[];
	reminderVisible: boolean;
	reminderTodos: TodoTask[];
	/** Change archive since the session's first hydration (transcript rows). */
	history: TodoSnapshot[];
	/** False until the first post-reset setPhases — that one is hydration, not a change. */
	historyHydrated: boolean;
	/** True once the finished grace period elapsed — the dock stops showing the plan. */
	completedHidden: boolean;
	setPhases: (phases: TodoPhase[]) => void;
	autoClearCompleted: () => void;
	showReminder: (todos: TodoTask[]) => void;
	clearReminder: () => void;
	reset: () => void;
}

const initialState = {
	phases: [] as UiTodoPhase[],
	reminderVisible: false,
	reminderTodos: [] as TodoTask[],
	history: [] as TodoSnapshot[],
	historyHydrated: false,
	completedHidden: false,
};

function normalizePhases(phases: TodoPhase[]): UiTodoPhase[] {
	return phases.map((phase, phaseIndex) => {
		const existingPhaseId = "id" in phase && typeof phase.id === "string" ? phase.id : null;
		const phaseId = existingPhaseId ?? `phase:${phaseIndex}:${phase.name}`;
		return {
			...phase,
			id: phaseId,
			tasks: phase.tasks.map((task, taskIndex) => ({
				...task,
				id: "id" in task && typeof task.id === "string" ? task.id : `${phaseId}:task:${taskIndex}`,
			})),
		};
	});
}

/** Semantic identity of a phase list — ids are UI-assigned and must not count as change. */
function fingerprintPhases(
	phases: readonly { name: string; tasks: readonly { content: string; status: string }[] }[],
): string {
	return JSON.stringify(phases.map(phase => [phase.name, phase.tasks.map(task => [task.content, task.status])]));
}

/** Todo identity without progress — status-only changes update one transcript row. */
function fingerprintTodo(phases: readonly { name: string; tasks: readonly { content: string }[] }[]): string {
	return JSON.stringify(phases.map(phase => [phase.name, phase.tasks.map(task => [task.content])]));
}

export const createTodoStore = () =>
	createStore<TodoStore>()((set, get) => {
		// One timer per store (each tab runtime owns one): a finished plan starts
		// its grace period here so the dock region and the card itself can never
		// disagree about whether the plan is showing.
		const finishedTimer = createDockFinishedTimer(() => set({ completedHidden: true }));
		/**
		 * A plan counts as finished only while nothing is pending: a reminder is
		 * the agent asking for attention and outranks the auto-hide. The grace
		 * period is armed on the TRANSITION into finished, so the identical
		 * re-pulls (every agent_end, every app restart) cannot keep resetting it.
		 */
		const isFinished = (phases: readonly UiTodoPhase[], reminderVisible: boolean) =>
			allTasksCompleted(phases) && !reminderVisible;
		const syncFinished = (previousFinished: boolean, nextFinished: boolean) => {
			if (!nextFinished) {
				finishedTimer.cancel();
				if (get().completedHidden) set({ completedHidden: false });
				return;
			}
			finishedTimer.arm(previousFinished);
		};

		return {
			...initialState,
			setPhases: phases => {
				const state = get();
				const next = normalizePhases(phases);
				if (!state.historyHydrated) {
					// Hydration is the first write after a session reset — including the
					// restart that re-pulls a plan the user already watched finish. It
					// gets NO grace period: nobody watched that plan complete, so
					// flashing the card on every reopen is noise. A plan that arrives
					// unfinished still shows, and its later completion arms the timer.
					const finishedOnArrival = isFinished(next, state.reminderVisible);
					finishedTimer.cancel();
					set({ phases: next, historyHydrated: true, completedHidden: finishedOnArrival });
					return;
				}
				if (fingerprintPhases(next) === fingerprintPhases(state.phases)) {
					set({ phases: next });
					syncFinished(isFinished(state.phases, state.reminderVisible), isFinished(next, state.reminderVisible));
					return;
				}
				const archivedPhases = next.map(phase => ({
					name: phase.name,
					tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
				}));
				const previous = state.history.at(-1);
				const snapshot: TodoSnapshot =
					previous && fingerprintTodo(previous.phases) === fingerprintTodo(archivedPhases)
						? { ...previous, phases: archivedPhases }
						: {
								id: `todo-snapshot-${Date.now()}-${state.history.length}`,
								ts: Date.now(),
								phases: archivedPhases,
							};
				const history =
					previous?.id === snapshot.id ? [...state.history.slice(0, -1), snapshot] : [...state.history, snapshot];
				if (history.length > HISTORY_LIMIT) history.shift();
				set({ phases: next, history, historyHydrated: true });
				syncFinished(isFinished(state.phases, state.reminderVisible), isFinished(next, state.reminderVisible));
			},
			autoClearCompleted: () => {
				finishedTimer.cancel();
				set({
					phases: [],
					reminderVisible: false,
					reminderTodos: [],
					historyHydrated: true,
				});
			},
			// A reminder is the agent asking for attention — it outranks the auto-hide.
			showReminder: todos => {
				const state = get();
				set({ reminderVisible: true, reminderTodos: todos });
				syncFinished(isFinished(state.phases, state.reminderVisible), isFinished(state.phases, true));
			},
			// Dismissed reminder over a finished plan: the grace period starts over.
			clearReminder: () => {
				const state = get();
				set({ reminderVisible: false, reminderTodos: [] });
				syncFinished(isFinished(state.phases, state.reminderVisible), isFinished(state.phases, false));
			},
			reset: () => {
				finishedTimer.cancel();
				set(initialState);
			},
		};
	});

const defaultTodoStore = createTodoStore();
export const useTodoStore = createScopedStoreHook("todo", defaultTodoStore);
