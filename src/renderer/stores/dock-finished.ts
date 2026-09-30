/**
 * Shared finish behavior for the center dock's live cards (todo plan, subagent
 * roster): once everything in a card is done, the card leaves the dock after a
 * short grace period instead of squatting above the composer.
 */

/**
 * Grace period between "everything finished" and the card leaving the dock:
 * long enough to read the final state, short enough that a done plan or a
 * finished fan-out does not occupy the composer for the rest of the session.
 */
export const DOCK_FINISHED_HIDE_MS = 10_000;

/**
 * One-shot timer for that grace period, armed on the TRANSITION into "finished".
 *
 * It must not restart on an identical re-pull: every `agent_end` re-hydrates the
 * same finished plan, and the roster polls `get_subagents` every few seconds
 * while a run streams — restarting there would keep the card on screen forever
 * (and would resurrect it on every app restart). `arm(wasFinished)` therefore
 * starts the clock only when the card was still live a moment ago.
 */
export function createDockFinishedTimer(onElapsed: () => void) {
	let timer: number | null = null;
	return {
		arm(wasFinished: boolean): void {
			if (wasFinished) return;
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				onElapsed();
			}, DOCK_FINISHED_HIDE_MS);
		},
		cancel(): void {
			if (timer === null) return;
			window.clearTimeout(timer);
			timer = null;
		},
	};
}
