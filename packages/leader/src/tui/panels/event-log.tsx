import { Box, Text as InkText } from "ink";
import type { LeaderEvent } from "@co/contracts";

interface Props {
  events: readonly LeaderEvent[];
  scrollOffset: number;
  maxVisible: number;
}

function eventToString(event: LeaderEvent): string {
  switch (event.type) {
    case "worker_joined":
      return `${event.instance.name} joined (${event.instance.role})`;
    case "worker_left":
      return `${event.name} left`;
    case "worker_status_changed":
      return `worker ${event.instance_id.slice(0, 8)}: ${event.status}`;
    case "worker_message_received":
      return `${event.instance_id.slice(0, 8)} msg: ${event.content}`;
    case "task_created":
      return `task created: ${event.task.title}`;
    case "task_claimed":
      return `task ${event.task_id} claimed by ${event.instance_id.slice(0, 8)}`;
    case "task_completed":
      return `task ${event.task_id} completed`;
    case "task_blocked":
      return `task ${event.task_id} blocked: ${event.reason}`;
    case "task_failed":
      return `task ${event.task_id} failed: ${event.reason}`;
    case "task_recovered":
      return `task ${event.task_id} recovered (retry ${event.retry_count})`;
    case "task_dependency_resolved":
      return `task ${event.task_id} unblocked`;
    case "message_sent":
      return `message ${event.message_type} ${event.from.slice(0, 8)} -> ${event.to?.slice(0, 8) ?? "all"}`;
    case "message_received":
      return `message from ${event.from.slice(0, 8)}: ${event.content}`;
    case "message_processed":
      return `message ${event.message_id} processed`;
    case "chain_activated":
      return `chain ${event.chain_id} activated`;
    case "chain_closed":
      return `chain ${event.chain_id} closed`;
    case "chain_merge_failed": {
      const branches = event.failures.map((f) => f.branch).join(", ");
      return `MERGE_FAILED chain ${event.chain_id}: ${event.failures.length} branch(es) [${branches}] — retry tasks pushed`;
    }
    case "chain_spawned":
      return `chain_spawned ${event.parent_chain_id} → ${event.child_chain_id} (depth=${event.chain_depth})`;
    case "magic_depth_exhausted":
      return `[debug] magic loop depth ${event.chain_depth} reached --magic-max-chains=${event.max_chains}: spawn_chain demoted to close_chain (chain ${event.chain_id})`;
    case "magic_mode_configured":
      return event.magic_mode
        ? `magic mode enabled (max_chains=${event.magic_max_chains ?? "unlimited"})`
        : `magic mode disabled`;
    case "debug_info":
      return `[debug] ${event.message}`;
    case "stream_chunk":
      return "";
  }
}

export default function EventLog({ events, scrollOffset, maxVisible }: Props) {
  const messages = events.map(eventToString).filter((s) => s.length > 0);
  const totalMessages = messages.length;
  const visibleCount = Math.max(1, maxVisible);

  // When scrolled up, slice the window from the top; otherwise show the tail.
  let visible: string[];
  if (scrollOffset > 0) {
    const endIdx = Math.max(0, totalMessages - scrollOffset);
    const startIdx = Math.max(0, endIdx - visibleCount);
    visible = messages.slice(startIdx, endIdx);
  } else {
    visible = messages.slice(-visibleCount);
  }

  const hiddenAbove = scrollOffset > 0
    ? totalMessages - visible.length - scrollOffset
    : Math.max(0, totalMessages - visible.length);
  const hiddenBelow = scrollOffset;

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText bold>EVENT LOG</InkText>
      <InkText dimColor>{"─".repeat(20)}</InkText>
      {hiddenAbove > 0 ? (
        <InkText dimColor>-- ↑ {hiddenAbove} more --</InkText>
      ) : null}
      {visible.map((m, i) => (
        <InkText key={i} wrap="wrap">
          {m}
        </InkText>
      ))}
      {hiddenBelow > 0 ? (
        <InkText dimColor>
          -- ↓ {hiddenBelow} more (PgUp/PgDn/↑/↓) --
        </InkText>
      ) : null}
    </Box>
  );
}
