import { Box, Text as InkText } from "ink";
import type { ILeaderStateView } from "@co/contracts";

interface Props {
  tasks: ILeaderStateView["pending_tasks"];
  maxItems: number;
}

const PRIO_COLOR: Record<number, string> = {
  0: "red",
  1: "yellow",
};

const PRIO_LABEL: Record<number, string> = {
  0: "HIGH",
  1: "MED",
  2: "LOW",
};

export default function PendingPanel({ tasks, maxItems }: Props) {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText bold>PENDING</InkText>
      <InkText dimColor>{"─".repeat(15)}</InkText>
      {tasks.length === 0 ? (
        <InkText dimColor>No pending tasks</InkText>
      ) : (
        tasks.slice(0, maxItems).map((t) => {
          const prioLabel = PRIO_LABEL[t.priority] ?? "LOW";
          return (
            <Box key={t.id} flexDirection="row">
              {t.link ? (
                <InkText color="cyan">
                  [{t.link.charAt(0).toUpperCase() + t.link.slice(1)}]{" "}
                </InkText>
              ) : null}
              <InkText color={PRIO_COLOR[t.priority]}>{prioLabel}</InkText>
              <InkText> {t.title}</InkText>
            </Box>
          );
        })
      )}
    </Box>
  );
}
