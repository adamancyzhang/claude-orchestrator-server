import type { ReactNode } from "react";
import { Box, Text as InkText } from "ink";
import type { WorkerActivityEntry, WorkerInfo } from "@co/contracts";

interface Props {
  worker: WorkerInfo | undefined;
  scrollOffset: number;
  maxVisible: number;
}

function formatActionDetail(entry: WorkerActivityEntry): string {
  if (entry.action === "thinking") return "thinking…";
  return entry.detail;
}

export default function WorkerMessagesPanel({ worker, scrollOffset, maxVisible }: Props) {
  if (!worker) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <InkText bold>WORKER MESSAGES</InkText>
        <InkText dimColor>{"─".repeat(20)}</InkText>
        <InkText dimColor>No workers</InkText>
      </Box>
    );
  }

  const isWorking = Boolean(worker.current_phase || worker.current_message);
  const nowText = worker.current_action === "thinking"
    ? "thinking…"
    : worker.current_detail;

  // Build the list of content rows for the scrollable section.
  // Structure: [working-status, activity-header, activity-entries..., message-header, message-entries...]
  type ContentRow = { key: string; element: ReactNode };
  const rows: ContentRow[] = [];

  if (isWorking) {
    rows.push({
      key: "working",
      element: (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <InkText color="green">◆ </InkText>
            <InkText bold>Working</InkText>
            {worker.current_message_time ? (
              <InkText dimColor> ({worker.current_message_time})</InkText>
            ) : null}
            {worker.current_message_link ? (
              <InkText color="cyan"> [{worker.current_message_link}]</InkText>
            ) : null}
          </Box>

          {worker.current_phase ? (
            <Box flexDirection="column" paddingLeft={3}>
              <Box flexDirection="row">
                <InkText dimColor>Phase: </InkText>
                <InkText color="magenta">[{worker.current_phase}]</InkText>
                {worker.current_action ? (
                  <InkText dimColor> {worker.current_action}</InkText>
                ) : null}
              </Box>
              {nowText ? (
                <Box flexDirection="row">
                  <InkText dimColor>Now:   </InkText>
                  <InkText wrap="wrap">{nowText}</InkText>
                </Box>
              ) : null}
              {worker.next_hint ? (
                <Box flexDirection="row">
                  <InkText dimColor>Next:  </InkText>
                  <InkText wrap="wrap">{worker.next_hint}</InkText>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {worker.current_message ? (
            <Box paddingLeft={3}>
              <InkText wrap="wrap">{worker.current_message}</InkText>
            </Box>
          ) : null}
          <InkText> </InkText>
        </Box>
      ),
    });
  } else {
    rows.push({
      key: "idle",
      element: (
        <Box>
          <InkText dimColor>
            {worker.last_completed_task
              ? `◇ idle — last: ${worker.last_completed_task}`
              : "◇ idle"}
          </InkText>
        </Box>
      ),
    });
  }

  if (worker.activity_history.length > 0) {
    rows.push({
      key: "act-header",
      element: <InkText bold>Done (recent):</InkText>,
    });
    worker.activity_history
      .slice(-5)
      .reverse()
      .forEach((entry, idx) => {
        rows.push({
          key: `act-${entry.timestamp}-${idx}`,
          element: (
            <Box flexDirection="row" paddingLeft={2}>
              <InkText dimColor>{entry.timestamp.slice(11, 19)} </InkText>
              <InkText color="magenta">{entry.phase}/{entry.action} </InkText>
              <InkText dimColor wrap="wrap">{formatActionDetail(entry)}</InkText>
            </Box>
          ),
        });
      });
  }

  if (worker.message_history.length > 0) {
    rows.push({
      key: "msg-header",
      element: <InkText bold>History:</InkText>,
    });
    worker.message_history
      .slice(-5)
      .reverse()
      .forEach((entry) => {
        rows.push({
          key: `msg-${entry.message_id}`,
          element: (
            <Box flexDirection="column" paddingLeft={2}>
              <Box flexDirection="row">
                <InkText dimColor>{entry.timestamp}</InkText>
                {entry.link ? (
                  <InkText color="cyan"> [{entry.link}]</InkText>
                ) : null}
              </Box>
              <Box paddingLeft={2}>
                <InkText dimColor wrap="wrap">
                  {entry.content}
                </InkText>
              </Box>
            </Box>
          ),
        });
      });
  }

  // Apply scroll window
  const totalRows = rows.length;
  const visibleCount = Math.max(1, maxVisible);
  let hiddenAbove = 0;
  let hiddenBelow = 0;
  let visibleRows: ContentRow[];

  if (scrollOffset > 0) {
    const endIdx = Math.max(0, totalRows - scrollOffset);
    const startIdx = Math.max(0, endIdx - visibleCount);
    hiddenAbove = startIdx;
    hiddenBelow = totalRows - endIdx;
    visibleRows = rows.slice(startIdx, endIdx);
  } else {
    hiddenBelow = Math.max(0, totalRows - visibleCount);
    visibleRows = rows.slice(-visibleCount);
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText bold>
        WORKER MESSAGES — {worker.name} ({worker.preset_role})
      </InkText>
      <InkText dimColor>{"─".repeat(20)}</InkText>

      {hiddenAbove > 0 ? (
        <InkText dimColor>-- ↑ {hiddenAbove} more --</InkText>
      ) : null}

      {visibleRows.map((row) => (
        <Box key={row.key}>{row.element}</Box>
      ))}

      {hiddenBelow > 0 ? (
        <InkText dimColor>
          -- ↓ {hiddenBelow} more (PgUp/PgDn) --
        </InkText>
      ) : null}
    </Box>
  );
}
