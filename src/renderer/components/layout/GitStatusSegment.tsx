/**
 * Title-bar git segment (plan/20 P1): the pane's checkout branch plus its
 * dirty counters, mirroring the TUI `gitSegment` — `*N` unstaged, `+N` staged,
 * `?N` untracked, zero counts omitted. A checkout that is not a repo, and a
 * detached HEAD (no branch to name), render nothing. Clicking refetches
 * immediately: the 2.5s poll tracks background drift, not your own commit.
 *
 * The title bar is this GUI's status line (run state + session metrics) and,
 * unlike the composer toolbar, has slack for a chip — the toolbar is already
 * at its wrapping width at a default window size.
 */

import { GitBranch } from "lucide-react";
import { useGitStatus } from "../../hooks/use-git-status";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";

export function GitStatusSegment() {
	const t = useT();
	const cwd = useSessionStore(s => s.cwd);
	const { status, refresh } = useGitStatus();
	const branch = status?.branch;
	if (!status?.isRepo || !branch) return null;
	const { staged, unstaged, untracked } = status;
	const label = `${t("gitSegment.branch")}: ${branch}`;
	const title = `${label}\n${t("gitSegment.counts", { staged, unstaged, untracked })}\n${cwd}\n${t("gitSegment.refresh")}`;

	return (
		<button
			type="button"
			onClick={refresh}
			title={title}
			aria-label={label}
			data-git-segment
			className="omp-pressable no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-omp-sm text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
		>
			<GitBranch size={11} aria-hidden className="shrink-0 text-[var(--omp-dim)]" />
			<span className="max-w-40 truncate font-mono text-[var(--omp-text)]">{branch}</span>
			{unstaged > 0 && <span className="font-mono text-[var(--omp-warning)]">*{unstaged}</span>}
			{staged > 0 && <span className="font-mono text-[var(--omp-success)]">+{staged}</span>}
			{untracked > 0 && <span className="font-mono text-[var(--omp-dim)]">?{untracked}</span>}
		</button>
	);
}
