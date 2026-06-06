import { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text as InkText, useInput, useApp, useWindowSize } from "ink";
import type { IMessageRouter, InstanceId } from "@co/contracts";
import type { LeaderState } from "../state.js";
import type { StateStore } from "./store.js";
import { useLeaderSnapshot } from "./hooks.js";
import TeamPanel from "./panels/team.js";
import PendingPanel from "./panels/pending.js";
import InProgressPanel from "./panels/in-progress.js";
import WorkerMessagesPanel from "./panels/worker-messages.js";
import EventLog from "./panels/event-log.js";
import InputLine from "./panels/input-line.js";
import Footer from "./panels/footer.js";

const MIN_COLS = 80;
const MIN_ROWS = 41;
const SENT_INDICATOR_MS = 2000;

interface Props {
  store: StateStore;
  state: LeaderState;
  messageRouter: IMessageRouter;
  leaderId: InstanceId;
  leaderName: string;
}

export default function App({
  store,
  state: leaderState,
  messageRouter,
  leaderId,
  leaderName,
}: Props) {
  const snapshot = useLeaderSnapshot(store);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();

  const [inputBuffer, setInputBuffer] = useState("");
  const [pendingInput, setPendingInput] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [logOffset, setLogOffset] = useState(0);
  const [teamScrollOffset, setTeamScrollOffset] = useState(0);
  const [workerMsgsScrollOffset, setWorkerMsgsScrollOffset] = useState(0);

  // 1-second tick for clearing sent indicator and timestamp refresh
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (sentAt !== null && now - sentAt > SENT_INDICATOR_MS) {
        setPendingInput(null);
        setSentAt(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sentAt]);

  // Auto-scroll event log when new events arrive (unless user scrolled up)
  const prevEventCount = useRef(snapshot.events.length);
  useEffect(() => {
    if (snapshot.events.length > prevEventCount.current && logOffset === 0) {
      // stay at bottom
    } else if (snapshot.events.length > prevEventCount.current) {
      const delta = snapshot.events.length - prevEventCount.current;
      setLogOffset((o) => o + delta);
    }
    prevEventCount.current = snapshot.events.length;
  }, [snapshot.events.length]);

  // Auto-scroll team panel to keep selected worker visible (page size = 6)
  useEffect(() => {
    const currentPage = Math.floor(snapshot.selected_worker_index / 6);
    setTeamScrollOffset(currentPage);
  }, [snapshot.selected_worker_index]);

  const sendMessage = useCallback(
    async (text: string) => {
      try {
        await messageRouter.send({
          type: "user_input",
          from_instance: leaderId,
          from_name: leaderName,
          from_role: "leader",
          to_instance: leaderId,
          content: text,
        });
      } catch {
        // Message send failures are logged by the orchestrator; TUI survives
      }
    },
    [messageRouter, leaderId, leaderName],
  );

  useInput((input, key) => {
    // Ctrl+C -> SIGINT (orchestrator cleanup handles shutdown)
    if (key.ctrl && input === "c") {
      exit();
      process.kill(process.pid, "SIGINT");
      return;
    }

    if (key.tab) {
      if (snapshot.workers.length > 0) {
        const delta = key.shift ? -1 : 1;
        const next =
          (snapshot.selected_worker_index + delta + snapshot.workers.length) %
          snapshot.workers.length;
        leaderState.setSelectedWorkerIndex(next);
        setWorkerMsgsScrollOffset(0);
      }
      return;
    }

    if (key.upArrow) {
      setLogOffset((o) => Math.min(o + 1, snapshot.events.length));
      return;
    }
    if (key.downArrow) {
      setLogOffset((o) => Math.max(o - 1, 0));
      return;
    }
    if (key.pageUp) {
      setLogOffset((o) => Math.min(o + 10, snapshot.events.length));
      return;
    }
    if (key.pageDown) {
      setLogOffset((o) => Math.max(o - 10, 0));
      return;
    }

    if (key.delete || key.backspace) {
      setInputBuffer((b) => (b.length > 0 ? b.slice(0, -1) : b));
      return;
    }

    if (key.escape) {
      setInputBuffer("");
      return;
    }

    if (key.return) {
      const text = inputBuffer.trim();
      setInputBuffer("");
      if (text) {
        setPendingInput(text);
        setSentAt(Date.now());
        void sendMessage(text);
      }
      return;
    }

    // Digits 1-9: jump to worker
    if (input >= "1" && input <= "9") {
      const idx = Number(input) - 1;
      if (idx < snapshot.workers.length) {
        leaderState.setSelectedWorkerIndex(idx);
        setWorkerMsgsScrollOffset(0);
      }
      return;
    }

    // Alt+Up/Alt+Down: scroll worker messages panel
    if (key.meta && key.upArrow) {
      setWorkerMsgsScrollOffset((o) => Math.min(o + 1, 50));
      return;
    }
    if (key.meta && key.downArrow) {
      setWorkerMsgsScrollOffset((o) => Math.max(o - 1, 0));
      return;
    }
    if (key.meta && key.pageUp) {
      setWorkerMsgsScrollOffset((o) => Math.min(o + 5, 50));
      return;
    }
    if (key.meta && key.pageDown) {
      setWorkerMsgsScrollOffset((o) => Math.max(o - 5, 0));
      return;
    }

    // [ / ] : team panel page navigation (6 workers per page)
    if (input === "[" || input === "]") {
      if (snapshot.workers.length > 0) {
        const pageSize = 6;
        const totalPages = Math.max(1, Math.ceil(snapshot.workers.length / pageSize));
        const delta = input === "[" ? -1 : 1;
        const newOffset = Math.max(0, Math.min(totalPages - 1, teamScrollOffset + delta));
        if (newOffset !== teamScrollOffset) {
          setTeamScrollOffset(newOffset);
          leaderState.setSelectedWorkerIndex(newOffset * pageSize);
        }
      }
      return;
    }

    // Regular character input (accept multi-char IME output)
    if (input.length > 0 && !key.ctrl && !key.meta) {
      setInputBuffer((b) => b + input);
    }
  });

  if (columns < MIN_COLS || rows < MIN_ROWS) {
    return (
      <Box flexDirection="column" padding={1} height={rows}>
        <InkText> </InkText>
        <InkText color="red" bold>
          Terminal too small
        </InkText>
        <InkText> </InkText>
        <InkText>Current size: {columns} x {rows}</InkText>
        <InkText>Required: {MIN_COLS} x {MIN_ROWS}</InkText>
        <InkText> </InkText>
        <InkText dimColor>Resize your terminal to continue.</InkText>
        <InkText> </InkText>
      </Box>
    );
  }

  // Fixed-height layout. Only the worker messages panel grows with the terminal.
  // borderStyle="round" eats 2 rows per panel; content rows = height - 2.
  //
  //   overhead(6) + team(11) + tasks(7) + log(11) + msgs(min 6) = 41 = MIN_ROWS
  const FIXED_OVERHEAD = 6; // outer padding(2) + input(3) + footer(1)
  const contentRows = Math.max(4, rows - FIXED_OVERHEAD);

  const teamH = 11;   // border(2) + title(1) + sep(1) + header(1) + workers(6)
  const tasksH = 7;   // border(2) + title(1) + sep(1) + items(3)
  const logH = 11;    // border(2) + title(1) + sep(1) + events(7)
  const MIN_MSGS = 6; // border(2) + title(1) + sep(1) + status(1) + history(1)
  const msgsH = Math.max(MIN_MSGS, contentRows - teamH - tasksH - logH);
  const msgsMaxVisible = Math.max(1, msgsH - 4); // border(2) + title(1) + sep(1)

  const pendingMax = Math.max(1, tasksH - 4);   // 3 items at height 7
  const inProgressMax = Math.max(1, tasksH - 4);

  return (
    <Box flexDirection="column" padding={1} height={rows} overflow="hidden">
      {/* ── TEAM ── */}
      <Box borderStyle="round" height={teamH} overflow="hidden" flexShrink={0}>
        <TeamPanel
          workers={snapshot.workers}
          selectedIndex={snapshot.selected_worker_index}
          maxWorkers={6}
          scrollOffset={teamScrollOffset}
        />
      </Box>

      {/* ── PENDING + IN PROGRESS ── */}
      <Box flexDirection="row" height={tasksH} flexShrink={0}>
        <Box
          flexGrow={1}
          borderStyle="round"
          marginRight={1}
          overflow="hidden"
        >
          <PendingPanel tasks={snapshot.pending_tasks} maxItems={pendingMax} />
        </Box>
        <Box flexGrow={1} borderStyle="round" overflow="hidden">
          <InProgressPanel
            tasks={snapshot.in_progress_tasks}
            maxItems={inProgressMax}
          />
        </Box>
      </Box>

      {/* ── WORKER MESSAGES ── */}
      <Box
        borderStyle="round"
        height={msgsH}
        overflow="hidden"
        flexShrink={0}
      >
        <WorkerMessagesPanel
          worker={snapshot.workers[snapshot.selected_worker_index]}
          scrollOffset={workerMsgsScrollOffset}
          maxVisible={msgsMaxVisible}
        />
      </Box>

      {/* ── EVENT LOG ── */}
      <Box borderStyle="round" height={logH} overflow="hidden" flexShrink={0}>
        <EventLog
          events={snapshot.events}
          scrollOffset={logOffset}
          maxVisible={Math.max(1, logH - 4)}
        />
      </Box>

      {/* ── INPUT ── */}
      <Box borderStyle="round" height={3} flexShrink={0}>
        <InputLine
          buffer={inputBuffer}
          pendingInput={pendingInput}
          sentAt={sentAt}
          nowMs={nowMs}
        />
      </Box>

      {/* ── FOOTER ── */}
      <Box flexShrink={0} paddingLeft={1}>
        <Footer
          leaderName={leaderName}
          magicMode={snapshot.magic_mode}
          magicMaxChains={snapshot.magic_max_chains}
        />
      </Box>
    </Box>
  );
}
