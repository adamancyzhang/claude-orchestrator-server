import { Box, Text as InkText } from "ink";
import type { WorkerActivityEntry, WorkerInfo } from "@co/contracts";

interface Props {
  worker: WorkerInfo | undefined;
}

function formatActionDetail(entry: WorkerActivityEntry): string {
  if (entry.action === "thinking") return "thinking…";
  return entry.detail;
}

export default function WorkerMessagesPanel({ worker }: Props) {
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

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText bold>
        WORKER MESSAGES — {worker.name} ({worker.preset_role})
      </InkText>
      <InkText dimColor>{"─".repeat(20)}</InkText>

      {isWorking ? (
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
      ) : worker.last_completed_task ? (
        <Box>
          <InkText dimColor>◇ idle — last: {worker.last_completed_task}</InkText>
        </Box>
      ) : (
        <Box>
          <InkText dimColor>◇ idle</InkText>
        </Box>
      )}

      {worker.activity_history.length > 0 ? (
        <Box flexDirection="column">
          <InkText bold>Done (recent):</InkText>
          {worker.activity_history
            .slice(-5)
            .reverse()
            .map((entry, idx) => (
              <Box key={`${entry.timestamp}-${idx}`} flexDirection="row" paddingLeft={2}>
                <InkText dimColor>{entry.timestamp.slice(11, 19)} </InkText>
                <InkText color="magenta">{entry.phase}/{entry.action} </InkText>
                <InkText dimColor wrap="wrap">{formatActionDetail(entry)}</InkText>
              </Box>
            ))}
        </Box>
      ) : null}

      {worker.message_history.length > 0 ? (
        <Box flexDirection="column">
          <InkText bold>History:</InkText>
          {worker.message_history
            .slice(-5)
            .reverse()
            .map((entry) => (
              <Box key={entry.message_id} flexDirection="column" paddingLeft={2}>
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
            ))}
        </Box>
      ) : null}
    </Box>
  );
}
