import { useEffect, useRef, useState } from "react";
import type { RpcGitStatus } from "../../shared/rpc-types";
import { useTabRpc } from "../lib/tab-rpc";
import { useSessionStore } from "../stores/session";

const POLL_INTERVAL_MS = 2500;

/**
 * Live git state for the title bar's git segment (plan/20): polls the tab this
 * component renders inside via the tab-scoped RPC (so a consumer in a split
 * pane reports the checkout that pane's agent actually edits, not the globally
 * active tab's) every 2.5s — porcelain is ~10-30ms. Resets when the cwd or the
 * rpc client changes (no stale cross-tab flash) and refetches on the streaming
 * true→false edge — a finished run likely touched files. Off a tab runtime it
 * degrades to the active tab.
 */
export function useGitStatus(): { status: RpcGitStatus | null; refresh: () => void } {
	const tabRpc = useTabRpc();
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const [status, setStatus] = useState<RpcGitStatus | null>(null);
	const refreshRef = useRef<() => void>(() => {});

	useEffect(() => {
		// No session cwd yet: the sidecar has no checkout to report on, and asking
		// it now would race its own cwd.
		if (!cwd) {
			refreshRef.current = () => {};
			setStatus(null);
			return;
		}
		let cancelled = false;
		const refresh = async () => {
			try {
				const response = await tabRpc.getGitStatus();
				if (!cancelled) setStatus(response.success ? (response.data as RpcGitStatus) : null);
			} catch {
				if (!cancelled) setStatus(null);
			}
		};
		refreshRef.current = () => void refresh();
		setStatus(null);
		void refresh();
		const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [cwd, tabRpc]);

	const wasStreaming = useRef(false);
	useEffect(() => {
		if (wasStreaming.current && !isStreaming) refreshRef.current();
		wasStreaming.current = isStreaming;
	}, [isStreaming]);

	return { status, refresh: () => refreshRef.current() };
}
