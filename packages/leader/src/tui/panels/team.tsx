import { Box, Text as InkText } from "ink";
import type { ILeaderStateView } from "@co/contracts";

interface Props {
  workers: ILeaderStateView["workers"];
  selectedIndex: number;
  maxWorkers: number;
  scrollOffset: number;
}

const STATUS_COLOR: Record<string, string> = {
  idle: "green",
  busy: "yellow",
};

export default function TeamPanel({ workers, selectedIndex, maxWorkers, scrollOffset }: Props) {
  const pageSize = Math.max(1, maxWorkers);
  const totalPages = Math.max(1, Math.ceil(workers.length / pageSize));
  const start = scrollOffset * pageSize;
  const pageWorkers = workers.slice(start, start + pageSize);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText bold>TEAM</InkText>
      <InkText dimColor>{"─".repeat(20)}</InkText>
      {workers.length === 0 ? (
        <InkText dimColor>No workers online</InkText>
      ) : (
        <>
          <InkText bold>
            {"Name".padEnd(8)}
            {"Role".padEnd(8)}
            {"Worktree".padEnd(10)}
            {"Branch".padEnd(10)}
            {"PID".padEnd(7)}
            {"Status".padEnd(8)}
          </InkText>
          {pageWorkers.map((w, i) => {
            const globalIdx = start + i;
            const sel = globalIdx === selectedIndex;
            const marker = sel ? ">" : " ";
            const name = ` ${w.name}`.padEnd(8);
            const role = w.current_role
              ? `${w.current_role}◀`.padEnd(8)
              : w.preset_role.padEnd(8);
            const wt = (w.worktree_name ?? w.name).slice(0, 9).padEnd(10);
            const branch = (w.worktree_branch ?? "-").slice(0, 9).padEnd(10);
            const pid = (w.pid !== null ? String(w.pid) : "-").padEnd(7);
            const status = w.status.padEnd(8);
            const sc = STATUS_COLOR[w.status] ?? undefined;

            return (
              <Box key={w.id} flexDirection="row">
                <InkText color={sel ? "cyan" : undefined} bold={sel}>
                  {marker}
                </InkText>
                <InkText color={sel ? "cyan" : undefined} bold={sel}>
                  {name}
                </InkText>
                <InkText color={w.current_role ? "magenta" : undefined}>
                  {role}
                </InkText>
                <InkText dimColor>{wt}</InkText>
                <InkText dimColor>{branch}</InkText>
                <InkText>{pid}</InkText>
                <InkText color={sc}>{status}</InkText>
              </Box>
            );
          })}
          {totalPages > 1 && (
            <InkText dimColor>
              Page {scrollOffset + 1}/{totalPages} ({workers.length} workers)
            </InkText>
          )}
        </>
      )}
    </Box>
  );
}
