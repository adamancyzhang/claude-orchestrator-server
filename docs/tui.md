# TUI Layout Reference

## Why Ink terminal layout differs from web React

| | Web React (DOM) | Ink (Terminal) |
|---|---|---|
| Viewport | Infinite scroll | Fixed rows × cols character grid |
| Layout engine | Browser CSS | Yoga (C++ flexbox, React Native) |
| Overflow | `overflow: auto` → native scrollbar | `overflow: hidden` → clip; no scroll |
| Units | Pixels | Character cells |
| Scrolling | Free from browser | Manually implemented (array slicing) |

Yoga needs explicit dimensions for the character grid. There is no `flex: 1` + `overflow: auto` — you must calculate every panel's height and manually slice data arrays to simulate scrolling. Every `borderStyle="round"` box consumes exactly 2 rows (top + bottom border characters).

## Overall layout structure

```
outer Box padding={1} height={rows} overflow="hidden" flexDirection="column"
│
├── [1] TEAM           borderStyle="round"  height=teamH  flexShrink=0
├── [2] TASKS ROW      height=tasksH        flexShrink=0  flexDirection="row"
│    ├── PENDING       borderStyle="round"  flexGrow=1
│    └── IN PROGRESS   borderStyle="round"  flexGrow=1
├── [3] WORKER MSGS    borderStyle="round"  height=msgsH  flexShrink=0
├── [4] EVENT LOG      borderStyle="round"  height=logH   flexShrink=0
├── [5] INPUT          borderStyle="round"  height=3      flexShrink=0
└── [6] FOOTER                              paddingLeft=1 flexShrink=0
```

## Height allocation math

### Constants

```
MIN_COLS         = 80
MIN_ROWS         = 35
FIXED_OVERHEAD   = 6    (outer padding 2 + input 3 + footer 1)
                           Border rows are NOT here — they're inside panel heights.

MIN_TEAM         = 11   (border 2 + title 1 + separator 1 + header 1 + 6 workers)
MIN_TASKS        = 5    (border 2 + title 1 + separator 1 + 1 task/item)
MIN_MSGS         = 6    (border 2 + title 1 + separator 1 + status line + 1 history)
MIN_LOG          = 7    (border 2 + title 1 + separator 1 + 3 events)
```

### Proportional allocation (extra rows beyond minimums)

```
PROPS.team     = 0.15
PROPS.tasks    = 0.22
PROPS.messages = 0.28
// event log gets the remainder
```

### Derivation (runs every render)

```
contentRows = max(4, rows - FIXED_OVERHEAD)     // = rows - 6
minTotal    = MIN_TEAM + MIN_TASKS + MIN_MSGS + MIN_LOG  // = 29
extra       = max(0, contentRows - minTotal)

teamH   = MIN_TEAM   + round(extra * PROPS.team)      // includes its 2 border rows
tasksH  = MIN_TASKS  + round(extra * PROPS.tasks)     // includes 2×2 border rows (pending + in-progress)
msgsH   = MIN_MSGS   + round(extra * PROPS.messages)  // includes its 2 border rows
logH    = max(MIN_LOG, contentRows - teamH - tasksH - msgsH)  // remainder, includes its 2 border rows
```

**Guarantee:** `teamH + tasksH + msgsH + logH = contentRows = rows - 6`, so vertical space sums to exactly `rows`:

```
outer padding(2) + teamH + tasksH + msgsH + logH + input(3) + footer(1) = rows
```

### Worked example: 50-row terminal

```
contentRows = 50 - 6 = 44
extra = 44 - 29 = 15

teamH   = 11 + round(15 × 0.15) = 11 + 2 = 13
tasksH  =  5 + round(15 × 0.22) =  5 + 3 =  8
msgsH   =  6 + round(15 × 0.28) =  6 + 4 = 10
logH    = 44 - 13 - 8 - 10      =        13

Verify: 13 + 8 + 10 + 13 = 44 = contentRows ✓
Layout: 2 + 13 + 8 + 10 + 13 + 3 + 1 = 50 = rows ✓
```

## Panel-by-panel breakdown

### 1. Team Panel (`panels/team.tsx`)

**Props:** `workers`, `selectedIndex`, `maxWorkers`, `scrollOffset`

| Row | Content |
|-----|---------|
| 1 | `TEAM` (bold title) |
| 2 | `────` (separator) |
| 3 | `Name    Role    Worktree  Branch    PID    Status` (column headers) |
| 4–9+ | Worker rows (up to `maxWorkers` per page) |
| last* | `Page 2/3 (15 workers)` (page indicator, only when pages > 1) |

**Content formula:** `maxWorkers = max(6, teamH - 5)` where `5 = 2 border + 3 header rows`

**Pagination:**
- Page size = `maxWorkers`
- `scrollOffset` tracks current page (auto-scrolls to keep selected worker visible)
- `workers.slice(start, start + pageSize)` per page

**Color coding:**
- Selected worker: cyan bold with `>` marker
- Active role (`current_role`): magenta with `◀` suffix
- Status `idle`: green, `busy`: yellow
- Worktree/Branch columns: dim

### 2a. Pending Panel (`panels/pending.tsx`)

**Props:** `tasks`, `maxItems`

| Row | Content |
|-----|---------|
| 1 | `PENDING` (bold title) |
| 2 | `────` (separator) |
| 3+ | Task rows: `[Link] PRIO Title` |

**Content formula:** `maxItems = max(1, tasksH - 4)` where `4 = 2 border + 2 header rows`

**Color coding:**
- Priority 0: red `HIGH`, priority 1: yellow `MED`, else `LOW`
- Link prefix: cyan `[Plan]`, `[Execute]`, etc.

### 2b. In Progress Panel (`panels/in-progress.tsx`)

**Props:** `tasks`, `maxItems`

| Row | Content |
|-----|---------|
| 1 | `IN PROGRESS` (bold title) |
| 2 | `────` (separator) |
| 3+ | Task rows: `worker_id Title` |

**Content formula:** `maxItems = max(1, tasksH - 4)` (same derivation as Pending)

**Color coding:** Worker ID in blue

### 3. Worker Messages Panel (`panels/worker-messages.tsx`)

**Props:** `worker` (single `WorkerInfo | undefined`)

| Row | Content |
|-----|---------|
| 1 | `WORKER MESSAGES — name (role)` (bold title) |
| 2 | `────` (separator) |
| 3 | Status: `◆ Working (timestamp) [link]` or `◇ idle` |
| 4+ | Current message content (wrapped) |
| — | Blank separator line |
| — | `History:` header |
| — | Last 5 history entries (newest first), reversed |

**No formula in app.tsx** — renders full content; `height={msgsH}` with `overflow="hidden"` clips excess.

### 4. Event Log (`panels/event-log.tsx`)

**Props:** `events`, `scrollOffset`, `maxVisible`

| Row | Content |
|-----|---------|
| 1 | `EVENT LOG` (bold title) |
| 2 | `────` (separator) |
| — | `-- ↑ N more --` (when scrolled up) |
| 3+ | Event messages (up to `maxVisible` lines) |
| — | `-- ↓ N more (PgUp/PgDn/↑/↓) --` (when scrolled up) |

**Content formula:** `maxVisible = max(1, logH - 4)` where `4 = 2 border + 2 header rows`

**Scrolling:** Manual via `scrollOffset` state. When at bottom (`scrollOffset=0`), auto-scrolls to show newest events. User scrolls up with arrow keys to freeze position.

### 5. Input Line (`panels/input-line.tsx`)

**Props:** `buffer`, `pendingInput`, `sentAt`, `nowMs`

| Row | Content |
|-----|---------|
| 1 | `> text█` (input prompt with cursor) |
| 2 | Hint text or sent confirmation |

**Fixed height:** `3` (border 2 + content 1). Content alternates between:
- Normal: `> text█` + hint `"Type a message and press Enter to send"`
- Sent: `> text█` + green `✓ sent: message` (for 2 seconds)

### 6. Footer (`panels/footer.tsx`)

**Props:** `leaderName`, `magicMode`, `magicMaxChains`

| Row | Content |
|-----|---------|
| 1 | `Leader: name` `[MAGIC] (max=N)` `| Tab=next worker | [/]=page | 1-9 jump | Ctrl+C quit` |

**Fixed height:** 1 row, no border.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Next worker |
| `Shift+Tab` | Previous worker |
| `1`–`9` | Jump to worker at that index |
| `[` / `]` | Team panel page prev/next |
| `↑` / `↓` | Scroll event log ±1 |
| `PgUp` / `PgDn` | Scroll event log ±10 |
| `Backspace` / `Delete` | Delete last input character |
| `Escape` | Clear input buffer |
| `Enter` | Send input message |
| `Ctrl+C` | Exit orchestrator |

## State diagram (per-render cycle)

```
useWindowSize() → rows, columns
       │
       ├── rows < MIN_ROWS or cols < MIN_COLS → "Terminal too small" screen
       │
       └── Normal render:
              │
              ├── Calculate: contentRows, extra, teamH, tasksH, msgsH, logH
              ├── Calculate: pendingMax, inProgressMax, maxWorkers, maxVisible
              │
              ├── useLeaderSnapshot(store) → snapshot
              │     └── Triggers re-render when LeaderState changes
              │
              └── Render 6 panels with calculated props
```

## How to tune the layout

All tunable constants are at the top of `packages/leader/src/tui/app.tsx`:

| What to change | Where | Effect |
|---------------|-------|--------|
| Minimum panel heights | `MIN_TEAM`, `MIN_TASKS`, `MIN_MSGS`, `MIN_LOG` | Raises/lowers per-panel minimums; affects `MIN_ROWS` |
| Extra row distribution | `PROPS.team/tasks/messages` | Changes which panels grow faster with terminal size |
| Minimum terminal size | `MIN_ROWS`, `MIN_COLS` | Must be `FIXED_OVERHEAD + sum(MIN_*)` to not overflow |
| Header row count per panel | `-5` / `-4` in maxItems formulas | Must match actual header rows (title + separator + optional sub-header) in the panel component |

### Changing a panel's internal structure

If you add/remove rows inside a panel (e.g., add a sub-header in the Pending panel), you must update:

1. The panel component itself (the JSX)
2. The `maxItems` formula in `app.tsx` (the `-N` offset must match border + header row count)
3. The panel's `MIN_*` constant (ensure at least 1 content row at minimum)
4. `MIN_ROWS` (recalculate: `FIXED_OVERHEAD + sum(MIN_*)`)
5. The hardcoded `minTotal = 11 + 5 + 6 + 7` in both the auto-scroll `useEffect` and the `[`/`]` key handler
