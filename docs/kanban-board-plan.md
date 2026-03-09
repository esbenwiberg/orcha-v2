# Kanban Board — Implementation Plan

## Design Decisions (Agreed)

| Decision | Choice |
|----------|--------|
| Columns | 6 fixed: Inbox, Investigating, Review, Pipeline, Done, Failed |
| Pivoting | None — single status-based kanban only |
| Drag-and-drop | SortableJS, status view only |
| Card click | Centered modal dialog (replaces slide-in for task detail) |
| New task | Also a modal |
| Real-time | SSE animates cards between columns |
| Done/Failed | Collapsible + capped (last 10), "show all" links to table |
| Mobile | Horizontal scroll |
| Table view | Unchanged, toggled via view switcher |
| Slide-in panel | Stays for non-task uses (sessions, etc.) |
| SortableJS loading | UMD global via `/vendor/sortablejs.min.js` (same as htmx/xterm pattern) |
| Processor nudge | Not needed — 10s poll delay is acceptable |
| SSE reconnect | Full board re-fetch on reconnect (no stale state) |
| Card sort | Newest-first in Inbox, FIFO (oldest-first) in all other columns |
| Modal slot | Tasks page only (`#modal-slot` in `tasks-page.html`) |

## Column → Status Mapping

```
 Inbox         Investigating    Review         Pipeline              Done       Failed
 ─────         ─────────────    ──────         ────────              ────       ──────
 draft         investigating    rejected       enriching             done       failed
                                               queued                           cancelled
                                               executing
```

**Human-gated columns:** Inbox and Investigating. Nothing leaves these without a manual drag.

**Automated columns:** Pipeline runs automatically once a task enters it. Done/Failed are terminal.

**Review:** Tasks that investigation rated as `rejected` land here. User decides: drag to Pipeline (force-queue) or back to Inbox (retry).

## Drag-and-Drop Rules (State Machine)

| From → To | Action | Backend call |
|-----------|--------|-------------|
| Inbox → Investigating | Start investigation | `POST /tasks/:id/start-investigate` (new) |
| Inbox → Pipeline | Skip investigation, go straight to enrich/queue | `POST /tasks/:id/force-queue` |
| Investigating → Review | N/A (automatic on rejection) | — |
| Investigating → Pipeline | N/A (automatic on viable+) | — |
| Review → Pipeline | Override rejection, force enrich/queue | `POST /tasks/:id/force-enrich` or `force-queue` |
| Review → Inbox | Reset to draft for rework | `POST /tasks/:id/retry` |
| Failed → Inbox | Reset to draft | `POST /tasks/:id/retry` |
| Failed → Pipeline | Re-queue for execution | `POST /tasks/:id/retry-execute` |
| Failed → Done | Manually mark done | `POST /tasks/:id/mark-done` |

**Invalid drops** — visual "no-drop" cursor, card snaps back:
- Investigating only accepts drops from Inbox (not from other columns)
- Done → anywhere (terminal, use retry actions from modal)
- Pipeline → anywhere (automated, wait for it to finish or cancel from modal)

## ASCII Board Mockup

```
┌─ Tasks ──────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                              │
│  [◫ Board]  [☰ Table]                                                    [+ New Task]        │
│                                                                                              │
│  ┌─ Inbox (3) ──┐  ┌─ Investigating ┐  ┌─ Review (1) ──┐  ┌─ Pipeline (2) ┐  ┌─ Done ▸ ──┐  ┌─ Failed ▸ ─┐
│  │              │  │   (1)          │  │               │  │               │  │ collapsed │  │ collapsed  │
│  │ ┌──────────┐ │  │ ┌────────────┐ │  │ ┌───────────┐ │  │ ┌───────────┐ │  │   3 tasks │  │   1 task   │
│  │ │ #12      │ │  │ │ #9         │ │  │ │ #7        │ │  │ │ #10       │ │  │  [expand] │  │  [expand]  │
│  │ │ Add dark  │ │  │ │ Refactor   │ │  │ │ Add OAuth │ │  │ │ Fix nav   │ │  └──────────┘  └────────────┘
│  │ │ mode     │ │  │ │ auth layer │ │  │ │ login     │ │  │ │ z-index   │ │
│  │ │          │ │  │ │            │ │  │ │           │ │  │ │           │ │
│  │ │ orcha-v2 │ │  │ │ orcha-v2   │ │  │ │ orcha-v1  │ │  │ │ orcha-v2  │ │
│  │ │ 2h ago   │ │  │ │ ● invstgtg │ │  │ │ ✗ reject  │ │  │ │ executing │ │
│  │ └──────────┘ │  │ │ 45m ago    │ │  │ │ weak      │ │  │ │ ● PR open │ │
│  │              │  │ └────────────┘ │  │ │ 1d ago    │ │  │ │ 20m ago   │ │
│  │ ┌──────────┐ │  │               │  │ └───────────┘ │  │ └───────────┘ │
│  │ │ #11      │ │  │               │  │               │  │               │
│  │ │ Migrate  │ │  │               │  │               │  │ ┌───────────┐ │
│  │ │ to Bun   │ │  │               │  │               │  │ │ #8        │ │
│  │ │          │ │  │               │  │               │  │ │ Add tests │ │
│  │ │ orcha-v2 │ │  │               │  │               │  │ │ for auth  │ │
│  │ │ 5h ago   │ │  │               │  │               │  │ │           │ │
│  │ └──────────┘ │  │               │  │               │  │ │ orcha-v2  │ │
│  │              │  │               │  │               │  │ │ enriching │ │
│  │ ┌──────────┐ │  │               │  │               │  │ │ 35m ago   │ │
│  │ │ #13      │ │  │               │  │               │  │ └───────────┘ │
│  │ │ Add SSO  │ │  │               │  │               │  │               │
│  │ │ support  │ │  │               │  │               │  │               │
│  │ │          │ │  │               │  │               │  │               │
│  │ │ orcha-v1 │ │  │               │  │               │  │               │
│  │ │ just now │ │  │               │  │               │  │               │
│  │ └──────────┘ │  │               │  │               │  │               │
│  └──────────────┘  └───────────────┘  └───────────────┘  └───────────────┘
│                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Card Anatomy

```
┌─────────────────────────┐
│ #12           ⋯ (menu)  │  ← display ID + overflow menu (cancel, delete, retry)
│                         │
│ Add dark mode support   │  ← title (max 2 lines, truncated)
│ for all pages           │
│                         │
│ ┌────────┐  ┌────────┐  │  ← badges row
│ │orcha-v2│  │ viable │  │     repo pill + rating (if exists)
│ └────────┘  └────────┘  │
│                         │
│ ● executing  🔗 PR      │  ← sub-status + PR link (if exists)
│ medium       2h ago     │  ← complexity (if enriched) + time
│                         │
│ ████████░░ merged ✓     │  ← progress hint + merged badge (if applicable)
└─────────────────────────┘
```

### Badge Colors (matches existing design system)

| Element | Conditions | Class |
|---------|-----------|-------|
| Sub-status dot | investigating, enriching | `badge-warning badge-pulse` |
| Sub-status dot | executing | `badge-info badge-pulse` |
| Sub-status | queued | `badge-accent` |
| Rating | reject | `badge-error` |
| Rating | weak | `badge-warning` |
| Rating | viable | `badge-accent` |
| Rating | good, excellent | `badge-success` |
| Complexity | trivial, small | `badge-success` |
| Complexity | medium | `badge-accent` |
| Complexity | large | `badge-warning` |
| PR | open | `badge-info` |
| PR | merged | `badge-success` |

## Task Detail Modal

```
┌──────────────────────────────────────────────────────────┐
│                                                    [ ✕ ] │
│  #12 — Add dark mode support                            │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                          │
│  Status: ● executing     Repo: orcha-v2                  │
│  Rating: viable          Complexity: medium              │
│  Branch: feat/dark-mode  PR: #142 (open)                 │
│  Created: 2h ago         Updated: 5m ago                 │
│                                                          │
│  ┌─ Description ───────────────────────────────────────┐ │
│  │ Add dark mode toggle to all pages. Should respect   │ │
│  │ OS preference and persist choice in localStorage.   │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ Tabs ──────────────────────────────────────────────┐ │
│  │ [Investigation] [Enrichment] [Transcript] [Events]  │ │
│  │                                                     │ │
│  │  Rating: viable                                     │ │
│  │  Summary: Feasible change. Dark mode can be added   │ │
│  │  using CSS custom properties...                     │ │
│  │                                                     │ │
│  │  Pros:                                              │ │
│  │  • CSS variables already in use                     │ │
│  │  • Tailwind dark: variant available                 │ │
│  │                                                     │ │
│  │  Cons:                                              │ │
│  │  • 23 template files need updates                   │ │
│  │  • Some hardcoded colors in inline styles           │ │
│  │                                                     │ │
│  │  Files examined: 15                                 │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ Actions ───────────────────────────────────────────┐ │
│  │ [Retry] [Re-execute] [Cancel] [Delete]              │ │
│  │ [Check PR] [Address Feedback]                       │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## New Task Modal

```
┌──────────────────────────────────────────────────────────┐
│  New Task                                          [ ✕ ] │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                          │
│  Repository *        [▾ Select repo          ]           │
│  Title *             [                       ]           │
│  Description *       [                       ]           │
│                      [                       ]           │
│                      [                       ]           │
│  Branch (optional)   [                       ]           │
│                                                          │
│  ☐ Auto-enrich (skip manual investigation review)        │
│  ☐ Self-validate (agent hosts & previews after build)    │
│                                                          │
│  ▸ Advanced (credential profile, model, MCP servers)     │
│                                                          │
│                              [Cancel]  [Create Task]     │
└──────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Foundation — Kanban Layout + Cards
**Files: CSS + HTML templates**

1. **New CSS** — `src/web/css/orcha-kanban.css`
   - `.kanban-board` — horizontal flex container, `overflow-x: auto` for mobile
   - `.kanban-column` — flex column, fixed width (~280px), `overflow-y: auto`
   - `.kanban-column__header` — sticky top, title + count badge + collapse toggle
   - `.kanban-column--collapsed` — thin collapsed state (just header + count)
   - `.kanban-card` — card component extending existing `.task-card` tokens
   - `.kanban-card--dragging` — opacity + shadow during drag
   - `.kanban-card--drop-target` — glow/highlight on valid drop zone
   - `.kanban-card--no-drop` — red border flash on invalid drop
   - Transitions: `transform`, `opacity` for smooth card movement

2. **New template** — `src/web/views/partials/kanban-board.html`
   - Renders the 6-column board
   - Each column gets its tasks filtered by status mapping
   - Cards use a new `kanban-card.html` partial

3. **New template** — `src/web/views/partials/kanban-card.html`
   - Compact card with: #ID, title, repo pill, rating badge, sub-status, complexity, PR link, time ago
   - `data-task-id`, `data-task-status` attributes for SortableJS

4. **Update** — `src/web/views/tasks-page.html`
   - Add view toggle: Board (default) / Table
   - Board view loads `kanban-board.html`
   - Table view loads existing `task-list.html`
   - Persist preference in `localStorage`

5. **Update** — `src/web/routes/tasks.ts`
   - New endpoint: `GET /api/tasks/board` — returns kanban-board partial (tasks grouped by column)

### Phase 2: Modals — Task Detail + New Task
**Files: HTML templates + JS + routes**

1. **Modal shell** — `src/web/views/partials/modal-shell.html`
   - Reusable modal component: backdrop + centered panel + close button
   - Escape key and backdrop click to close
   - CSS transitions for open/close animation
   - `.modal-overlay` → fade in
   - `.modal-panel` → scale up from 95% + fade in

2. **Task detail modal** — `src/web/views/partials/task-detail-modal.html`
   - Adapted from existing `task-detail.html` content
   - Header: #ID, title, status, repo
   - Metadata grid: rating, complexity, branch, PR, timestamps
   - Tabbed sections: Investigation, Enrichment, Transcript, Events (HTMX lazy-loaded)
   - Action buttons: Retry, Re-execute, Cancel, Delete, Check PR, Address Feedback
   - Wider than slide-in panel (~720px max-width)

3. **New task modal** — `src/web/views/partials/new-task-modal.html`
   - Adapted from existing `new-task-form.html`
   - Collapsible "Advanced" section for credential/model/MCP
   - Form posts via HTMX, closes modal + triggers board refresh on success

4. **Update** — `src/web/routes/tasks.ts`
   - `GET /api/tasks/:id/modal` — returns task detail modal content
   - `GET /api/tasks/new-modal` — returns new task modal form
   - Existing endpoints continue to work (backwards compat for table view)

5. **Minimal JS** — `src/web/js/modal.js`
   - `openModal(url)` — fetches HTMX content into `#modal-slot`, adds `.is-open`
   - `closeModal()` — removes `.is-open`, clears slot after transition
   - Escape key listener
   - Backdrop click listener

### Phase 3: Drag-and-Drop
**Files: JS + routes + CSS**

1. **Install SortableJS** — `npm install sortablejs` + add to `scripts/vendor-assets.js` to copy UMD bundle to `/vendor/sortablejs.min.js`

2. **Drag-and-drop JS** — `src/web/js/kanban-drag.js`
   - Initialize SortableJS on each column's card container
   - `group: 'kanban'` to allow cross-column dragging
   - `onEnd` callback:
     - Read source column and destination column from `data-column` attributes
     - Look up valid transitions in a client-side map
     - If invalid: revert (SortableJS `cancel()`)
     - If valid: POST to the appropriate backend endpoint
     - On success: card stays in new column, trigger SSE refresh
     - On failure: revert card position, show toast error
   - Drag handle: entire card (or a grip icon, TBD)
   - Ghost styling: `.sortable-ghost` class → semi-transparent
   - Column highlight on dragover: `.kanban-column--active-drop`

3. **Transition map** (client-side JS):
   ```js
   const VALID_DROPS = {
     'inbox':         ['investigating', 'pipeline'],
     'review':        ['inbox', 'pipeline'],
     'failed':        ['inbox', 'pipeline', 'done'],
   };
   ```

4. **New backend endpoint** — `POST /api/tasks/:id/start-investigate`
   - Transitions `draft` → `investigating`
   - Needed for Inbox → Investigating drag

5. **CSS additions**:
   - `.sortable-ghost` — card placeholder styling during drag
   - `.sortable-chosen` — card picked up
   - `.kanban-column--drag-over` — column highlight
   - `.kanban-card--invalid-drop` — brief red flash animation

### Phase 4: Real-Time SSE Card Movement
**Files: SSE events + JS + templates**

1. **Extend SSE events** — `src/web/routes/events.ts`
   - New event type: `task-moved` with payload `{ taskId, fromStatus, toStatus }`
   - Fired whenever `TaskStore.transition()` is called (from processor or user action)

2. **SSE listener JS** — `src/web/js/kanban-sse.js`
   - Listen for `task-moved` events
   - On receive:
     - Find card DOM element by `data-task-id`
     - Calculate destination column from new status
     - Animate card out of source column (scale down + fade)
     - Move DOM node to destination column
     - Animate card in (scale up + fade)
     - Update column counts in headers
   - Listen for `task-created` events → prepend card to Inbox
   - Listen for `task-deleted` events → remove card with fade-out

3. **CSS animations**:
   ```css
   @keyframes card-enter { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
   @keyframes card-exit { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.95); } }
   .kanban-card--entering { animation: card-enter 0.3s ease-out; }
   .kanban-card--exiting { animation: card-exit 0.2s ease-in; }
   ```

4. **Update card content via SSE** — for badge updates within a column (e.g., "enriching" → "queued" within Pipeline), push a `task-updated` event that swaps just the card's inner HTML.

5. **Full board re-fetch on SSE reconnect** — when the EventSource reconnects after a dropped connection, fire a `GET /api/tasks/board` to replace the entire board, ensuring no stale state.

### Phase 5: Collapsed Done/Failed + Polish
**Files: CSS + JS + templates**

1. **Collapsed column state**:
   - Done and Failed columns render collapsed by default
   - Collapsed: shows header + task count + expand chevron
   - Expanded: shows last 10 cards + "View all in table →" link
   - Collapse state stored in `localStorage`

2. **Column header**:
   - Title + count badge
   - Collapse/expand toggle chevron
   - Subtle colored top border per column type:
     - Inbox: slate
     - Investigating: amber
     - Review: orange
     - Pipeline: blue
     - Done: green
     - Failed: red

3. **Empty column state**:
   - Subtle dashed border area with "No tasks" text
   - Still a valid drop target (for drag-and-drop columns)

4. **View toggle persistence**:
   - Board/Table toggle saves to `localStorage`
   - Remembered across page loads

5. **Polish**:
   - Card hover: slight elevation (shadow + translateY)
   - Smooth column width transitions
   - Loading skeleton for initial board render
   - Keyboard accessibility: Tab through cards, Enter to open modal

## File Inventory

### New files
| File | Purpose |
|------|---------|
| `src/web/css/orcha-kanban.css` | All kanban-specific styles |
| `src/web/views/partials/kanban-board.html` | Board layout with 6 columns |
| `src/web/views/partials/kanban-card.html` | Individual card template |
| `src/web/views/partials/task-detail-modal.html` | Task detail in modal |
| `src/web/views/partials/new-task-modal.html` | New task form in modal |
| `src/web/views/partials/modal-shell.html` | Reusable modal component |
| `src/web/js/modal.js` | Modal open/close logic |
| `src/web/js/kanban-drag.js` | SortableJS initialization + drop validation |
| `src/web/js/kanban-sse.js` | Real-time card movement via SSE |

### Modified files
| File | Changes |
|------|---------|
| `src/web/views/tasks-page.html` | Add view toggle, load board by default |
| `src/web/routes/tasks.ts` | New endpoints: `/board`, `/:id/modal`, `/new-modal`, `/:id/start-investigate` |
| `src/web/routes/events.ts` | New SSE event types: `task-moved`, `task-created`, `task-deleted`, `task-updated` |
| `src/web/css/main.css` | Import `orcha-kanban.css` |
| `src/web/css/orcha-components.css` | Modal component styles (or in kanban CSS) |
| `src/web/views/tasks-page.html` | Add `#modal-slot` div, view toggle, load board by default |
| `package.json` | Add `sortablejs` dependency |

### Dependencies
| Package | Purpose |
|---------|---------|
| `sortablejs` | Drag-and-drop between columns |

## Open Design Notes

- **Card overflow menu (⋯)**: Quick actions without opening the modal — Cancel, Delete, Retry. Appears on hover.
- **Column ordering**: Fixed left-to-right as the natural task lifecycle flow.
- **Max column width**: ~280px to fit 6 columns on a 1920px screen with sidebar. Responsive down to ~240px.
- **Card sort within column**: Inbox = newest-first (fresh ideas at top). All other columns = oldest-first / FIFO (first in, first out). Drag reordering within a column is not persisted (no priority field yet).
- **Accessibility**: Cards are focusable, Enter opens modal, keyboard drag TBD for later phase.
