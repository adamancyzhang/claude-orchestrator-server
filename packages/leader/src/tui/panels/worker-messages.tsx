import { Box, Text as InkText } from "ink";
import type { WorkerInfo } from "@co/contracts";

interface Props {
  worker: WorkerInfo | undefined;
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

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText bold>
        WORKER MESSAGES — {worker.name} ({worker.preset_role})
      </InkText>
      <InkText dimColor>{"─".repeat(20)}</InkText>

      {worker.current_message ? (
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
          <Box paddingLeft={3}>
            <InkText wrap="wrap">{worker.current_message}</InkText>
          </Box>
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
