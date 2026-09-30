import { createStore } from "zustand/vanilla";
import type { SubagentFrame, SubagentSnapshot } from "../../shared/rpc-types";
import { createDockFinishedTimer } from "./dock-finished";
import { activeTabCommand, createScopedStoreHook, type TabCommand } from "./session-runtime-context";

export type SubagentNode = SubagentSnapshot;

export interface SubagentsStore {
	subagents: Map<string, SubagentNode>;
	/** Why the roster could not be read. Rows stay on screen when set; an empty
	    roster plus an error is "couldn't load", never "nothing spawned". */
	error: string | null;
	/** True once the finished grace period elapsed — the dock stops showing the roster. */
	completedHidden: boolean;
	applyFrame: (frame: SubagentFrame) => void;
	setSnapshots: (snapshots: SubagentNode[]) => void;
	/**
	 * Pull the full roster over get_subagents and MERGE it. Unlike
	 * setSnapshots this keeps local terminal rows: the RPC registry deletes
	 * completed/failed agents on their terminal lifecycle frame (AgentRegistry
	 * retains only parked/aborted refs), so a wholesale replace would make
	 * finished agents vanish from the UI on every poll. Best-effort — a
	 * failed fetch leaves frame-driven state untouched.
	 */
	refresh: (options?: { expect?: () => boolean }) => Promise<void>;
	reset: () => void;
}

/**
 * A roster whose every row has stopped working: terminal statuses (completed,
 * failed, abandoned, …) plus `parked` — a parked reviewer finished its review
 * and only waits for a follow-up, so it must not keep the dock card up. `stale`
 * stays live: the hub still owns that registration.
 */
function allAgentsFinished(nodes: Iterable<SubagentNode>): boolean {
	let count = 0;
	for (const node of nodes) {
		count++;
		if (LIVE_STATUSES[node.status] && node.status !== "parked") return false;
	}
	return count > 0;
}

/**
 * The dock shows the agents card while the roster has work in it, and drops it
 * once every row finished and the grace period elapsed — the same rule the todo
 * card follows, and the same rule for the dock region and the card itself.
 */
export function selectAgentsDockVisible(state: Pick<SubagentsStore, "subagents" | "completedHidden">): boolean {
	return state.subagents.size > 0 && !state.completedHidden;
}

/**
 * Live (non-terminal) wire statuses, mirror of statusMeta().live in
 * components/panels/subagent-graph (component layer — not importable here).
 * Rows absent from a refresh fetch are dropped when live (released) but kept
 * when terminal (the server forgets them; the user is still looking at them).
 */
const LIVE_STATUSES: Record<string, true> = {
	started: true,
	running: true,
	pending: true,
	idle: true,
	parked: true,
	// Stale registrations remain server-owned rows and must disappear after
	// hub cancel removes them; do not retain them as terminal history.
	stale: true,
};

function normalizeSnapshot(snapshot: SubagentNode): SubagentNode {
	return snapshot.status === "running" && snapshot.live === false ? { ...snapshot, status: "stale" } : snapshot;
}

/**
 * Merge one fetched row over the local one: the fetch wins EXCEPT it may never
 * blank a populated label/progress field. Server rows discovered late (bare
 * AgentRegistry refs) can lack task/assignment/description/progress/sessionFile
 * that a progress frame already delivered — replacing wholesale would blank
 * the card and lose durationMs mid-poll.
 */
function mergeFetchedSnapshot(fresh: SubagentNode, prev: SubagentNode): SubagentNode {
	return {
		...fresh,
		task: fresh.task ?? prev.task,
		assignment: fresh.assignment ?? prev.assignment,
		description: fresh.description ?? prev.description,
		progress: fresh.progress ?? prev.progress,
		sessionFile: fresh.sessionFile ?? prev.sessionFile,
	};
}

export const createSubagentsStore = (command: TabCommand = activeTabCommand) => {
	let refreshVersion = 0;
	const store = createStore<SubagentsStore>()((set, get) => {
		// One timer per store (each tab runtime owns one). Armed on the transition
		// into "every row finished", so the every-few-seconds roster poll while a
		// run streams cannot keep resetting it.
		const finishedTimer = createDockFinishedTimer(() => set({ completedHidden: true }));
		const syncFinished = (previous: Map<string, SubagentNode>, next: Map<string, SubagentNode>) => {
			if (!allAgentsFinished(next.values())) {
				finishedTimer.cancel();
				if (get().completedHidden) set({ completedHidden: false });
				return;
			}
			finishedTimer.arm(allAgentsFinished(previous.values()));
		};
		return {
			subagents: new Map<string, SubagentNode>(),
			error: null,
			completedHidden: false,
			applyFrame: frame => {
			// Copy-on-first-write: frames that match no known subagent leave the
			// map untouched and must not trigger a re-render.
			let subagents: Map<string, SubagentNode> | null = null;

			switch (frame.type) {
				case "subagent_lifecycle": {
					const p = frame.payload;
					subagents = new Map(get().subagents);
					const existing = subagents.get(p.id);
					subagents.set(p.id, {
						id: p.id,
						index: p.index,
						agent: p.agent,
						agentSource: p.agentSource,
						description: p.description ?? existing?.description,
						status: p.status === "started" ? "running" : p.status,
						task: existing?.task,
						assignment: existing?.assignment,
						sessionFile: p.sessionFile ?? existing?.sessionFile,
						lastUpdate: Date.now(),
						parentToolCallId: p.parentToolCallId ?? existing?.parentToolCallId,
						parentSubagentId: p.parentSubagentId ?? existing?.parentSubagentId,
						progress: existing?.progress,
						kind: existing?.kind ?? "sub",
					});
					break;
				}
				case "subagent_progress": {
					// Attribute by stable id, not the per-batch index. A progress
					// frame can be the first frame observed after a late subscription,
					// so materialize the row instead of silently dropping it.
					const progress = frame.payload.progress;
					if (!progress?.id) break;
					const existing = get().subagents.get(progress.id);
					subagents = new Map(get().subagents);
					subagents.set(progress.id, {
						id: progress.id,
						index: frame.payload.index,
						agent: frame.payload.agent,
						agentSource: frame.payload.agentSource,
						description: progress.description ?? existing?.description,
						status: progress.status,
						task: frame.payload.task,
						assignment: frame.payload.assignment ?? existing?.assignment,
						sessionFile: frame.payload.sessionFile ?? existing?.sessionFile,
						lastUpdate: Date.now(),
						parentToolCallId: frame.payload.parentToolCallId ?? existing?.parentToolCallId,
						parentSubagentId: frame.payload.parentSubagentId ?? existing?.parentSubagentId,
						kind: existing?.kind ?? "sub",
						progress,
					});
					break;
				}
				case "subagent_event": {
					const id = frame.payload.id;
					const existing = get().subagents.get(id);
					if (existing) {
						subagents = new Map(get().subagents);
						subagents.set(id, { ...existing });
					}
					break;
				}
			}

			if (subagents) {
				syncFinished(get().subagents, subagents);
				set({ subagents });
			}
		},
		setSnapshots: snapshots => {
			refreshVersion++;
			const subagents = new Map<string, SubagentNode>();
			for (const snap of snapshots) {
				const normalized = normalizeSnapshot(snap);
				subagents.set(normalized.id, normalized);
			}
			syncFinished(get().subagents, subagents);
			set({ subagents });
		},
		refresh: async options => {
			const version = ++refreshVersion;
			const before = get().subagents;
			try {
				const res = await command({ type: "get_subagents" });
				// Post-await guard: the poll may have been sent for a tab/session
				// that is no longer foreground — its snapshots must not merge into
				// the new session's store.
				if (version !== refreshVersion || (options?.expect && !options.expect())) return;
				if (!res.success) {
					set({ error: res.error });
					return;
				}
				const data = res.data as { subagents?: SubagentNode[] } | undefined;
				if (!data?.subagents) {
					set({ error: null });
					return;
				}
				const current = get().subagents;
				const fetched = new Set<string>();
				const subagents = new Map<string, SubagentNode>();
				for (const snap of data.subagents) {
					const normalized = normalizeSnapshot(snap);
					fetched.add(normalized.id);
					const prev = current.get(normalized.id);
					subagents.set(
						normalized.id,
						prev && prev !== before.get(normalized.id)
							? prev
							: prev
								? mergeFetchedSnapshot(normalized, prev)
								: normalized,
					);
				}
				// Terminal rows the server has forgotten survive the merge — see the
				// refresh docstring (RPC registry deletes completed/failed agents).
				for (const [id, node] of current) {
					if (!fetched.has(id) && (!LIVE_STATUSES[node.status] || node !== before.get(id)))
						subagents.set(id, node);
				}
				syncFinished(current, subagents);
				set({ subagents, error: null });
			} catch (cause) {
				// Best-effort poll: frames + hydration remain authoritative. The
				// failure is still recorded so the empty roster can name it.
				if (version !== refreshVersion || (options?.expect && !options.expect())) return;
				set({ error: cause instanceof Error ? cause.message : String(cause) });
			}
		},
		reset: () => {
			refreshVersion++;
			finishedTimer.cancel();
			set({ subagents: new Map<string, SubagentNode>(), error: null, completedHidden: false });
		},
	};
	});
	return store;
};

const defaultSubagentsStore = createSubagentsStore();
export const useSubagentsStore = createScopedStoreHook("subagents", defaultSubagentsStore);
