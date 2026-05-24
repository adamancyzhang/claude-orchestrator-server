import { Box, Text as InkText } from "ink";
import type { ILeaderStateView } from "@co/contracts";

interface Props {
  tasks: ILeaderStateView["in_progress_tasks"];
  maxItems: number;
}

export default function InProgressPanel({ tasks, maxItems }: Props) {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText bold>IN PROGRESS</InkText>
      <InkText dimColor>{"─".repeat(15)}</InkText>
      {tasks.length === 0 ? (
        <InkText dimColor>No tasks in progress</InkText>
      ) : (
        tasks.slice(0, maxItems).map((t) => {
          const who = t.claimed_by ? t.claimed_by.slice(0, 8) : "?";
          return (
            <Box key={t.id} flexDirection="row">
              <InkText color="blue">{who}</InkText>
              <InkText> {t.title}</InkText>
            </Box>
          );
        })
      )}
    </Box>
  );
}
