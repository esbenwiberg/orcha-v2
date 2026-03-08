# Task Pipeline — Autonomous Task Queue for Orcha-v2

## Overview

Add a task queue that lets users submit rough ideas and have them autonomously investigated, enriched, and executed — all without human interaction. Extends Orcha-v2's existing session infrastructure (worktrees, credentials, MCP servers, validate MCP) with a non-interactive pipeline.

**Core flow**: rough idea → investigate → rate → enrich → execute → PR with preview URL.

## User Experience

1. User opens Tasks tab, clicks "New Task"
2. Fills in: repo, title, rough description
3. Toggles:
   - **Auto-investigate & enrich** — run investigation + enrichment before execution
   - **Self-validate** — agent hosts the app via validate MCP, adds preview URL to PR
4. Selects MCP servers (checkboxes, same pattern as sessions/presets)
5. Submits → task enters the pipeline
6. User comes back later to find: enrichment cards showing what was analyzed, a PR link, and optionally a live preview URL

## Task States

```
                        ┌──────────┐
                        │  draft   │
                        └────┬─────┘
                             │
                    ┌────────┴────────┐
                    │                 │
              auto-enrich ON    auto-enrich OFF
                    │                 │
                    ▼                 │
             ┌──────────────┐        │
             │ investigating│        │
             └──────┬───────┘        │
                    │                │
              ┌─────┴─────┐         │
              │           │         │
         reject/weak   viable+      │
              │           │         │
              ▼           ▼         │
        ┌──────────┐ ┌──────────┐   │
        │ rejected │ │ enriching│   │
        └──────────┘ └────┬─────┘   │
                          │         │
                          ▼         │
                     ┌────────┐     │
                     │ queued │◄────┘
                     └───┬────┘
                         │
                         ▼
                   ┌───────────┐
                   │ executing │
                   └─────┬─────┘
                         │
                   ┌─────┴─────┐
                   │           │
                   ▼           ▼
              ┌────────┐  ┌────────┐
              │  done  │  │ failed │
              └────────┘  └────────┘

        (cancelled possible from any non-terminal state)
```

| Status           | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| `draft`          | Just created, not yet picked up by queue processor             |
| `investigating`  | Claude CLI reading codebase + web, evaluating the idea         |
| `rejected`       | Investigation rated it `reject` or `weak` — reasoning stored   |
| `enriching`      | Claude CLI reading codebase, rewriting description, mapping files |
| `queued`         | Ready for execution, waiting for worker slot                   |
| `executing`      | Claude Code session running in isolated worktree               |
| `done`           | Completed — branch pushed, PR created, optional preview URL    |
| `failed`         | Error during any phase                                         |
| `cancelled`      | User cancelled                                                 |

## Investigation Phase

**Purpose**: Evaluate whether the rough idea is worth pursuing before spending execution tokens.

**Invocation**: Claude CLI non-interactive mode in the repo directory.

```bash
claude --print \
  --allowedTools "Read,Glob,Grep,WebSearch,WebFetch" \
  --output-format json \
  --max-turns 15 \
  --cwd <repo-worktree-path> \
  "<system prompt + user's rough idea>"
```

**What the agent does**:
1. Reads relevant code to understand current architecture
2. Searches the web if the idea involves external tech/patterns/best practices
3. Evaluates feasibility, complexity, impact, and conflicts with existing code
4. Returns structured verdict

**System prompt instructs**:
- Explore the codebase thoroughly before judging
- Consider: Does this already exist? Does it conflict with existing patterns? Is it technically feasible? What's the effort?
- Be honest — reject bad ideas early to save execution cost

**Output** (`InvestigationResult`):

```typescript
interface InvestigationResult {
  rating: 'reject' | 'weak' | 'viable' | 'good' | 'excellent';
  summary: string;           // 2-3 sentence verdict
  reasoning: string;         // Detailed analysis
  pros: string[];
  cons: string[];
  filesExamined: string[];   // What it actually looked at
  webResearch?: string;      // Summary of web findings, if any
}
```

**Rating scale**:

| Rating      | Meaning                                     | Action              |
| ----------- | ------------------------------------------- | -------------------- |
| `reject`    | Bad idea — conflicts, already exists, harmful | → `rejected`        |
| `weak`      | Significant issues, needs major rethinking   | → `rejected`        |
| `viable`    | Could work, some concerns to address         | → `enriching`       |
| `good`      | Solid idea, clear implementation path        | → `enriching`       |
| `excellent` | High impact, straightforward to implement    | → `enriching`       |

User can manually override a `rejected` task and force it to `enriching` or `queued`.

## Enrichment Phase

**Purpose**: Transform the rough idea into a detailed, actionable task description using deep codebase understanding. LLM-only — no external tools or APIs.

**Invocation**: Claude CLI non-interactive, read-only codebase access.

```bash
claude --print \
  --allowedTools "Read,Glob,Grep" \
  --output-format json \
  --max-turns 20 \
  --cwd <repo-worktree-path> \
  "<system prompt + original idea + investigation results>"
```

**What the agent does**:
1. Deep-reads the files identified during investigation
2. Reads related files (tests, configs, types) to understand the full picture
3. Understands patterns, conventions, and architecture from the codebase
4. Rewrites the rough idea into a proper, detailed task description
5. Maps every affected file with change type and reason
6. Produces a step-by-step implementation approach
7. Identifies risks with severity and mitigation strategies
8. Defines acceptance criteria (what "done" looks like)

**System prompt instructs**:
- Read the actual code, don't guess — cite specific files and line numbers
- Follow the codebase's existing conventions and patterns
- The improved description should be self-contained: an agent executing this task should need nothing else
- Think about edge cases, error handling, and test coverage
- Estimate complexity honestly

**Output** (`EnrichmentResult`):

```typescript
interface EnrichmentResult {
  improvedDescription: string;
  affectedFiles: Array<{
    path: string;
    reason: string;
    changeType: 'modify' | 'create' | 'delete';
  }>;
  approach: Array<{
    step: number;
    description: string;
    files: string[];
  }>;
  risks: Array<{
    description: string;
    severity: 'low' | 'medium' | 'high';
    mitigation: string;
  }>;
  complexity: 'trivial' | 'small' | 'medium' | 'large';
  acceptanceCriteria: string[];
  relatedCode: Array<{
    path: string;
    lines: string;
    relevance: string;
  }>;
}
```

The enriched description replaces the original as the execution prompt. The original is preserved for reference.

## Execution Phase

Reuses Orcha-v2's existing session infrastructure, but non-interactive.

**Steps**:
1. Create isolated worktree on feature branch (existing `WorktreeManager`)
2. Provision credentials (existing `CredentialManager`)
3. Write Claude settings.json with:
   - User-selected MCP servers (from task's `mcpServerIds`)
   - **Always include validate MCP** (same as sessions do today at `sessions.ts:323`)
4. Spawn Claude Code session with enriched description as the prompt
5. On completion: commit, push branch, create PR via `gh pr create`
6. Store PR URL on the task
7. If `selfValidate` is on: the execution prompt includes instructions to use validate MCP tools

**Self-validate flow** (when toggle is on):
- The execution system prompt appends instructions telling Claude to:
  1. After implementing, call `validate_start` to host the app
  2. Call `validate_browse` to navigate and visually verify
  3. Call `validate_screenshot` to capture proof
  4. Include the preview URL in the PR description
  5. Leave the preview running (Orcha-v2's cleanup handles timeout)
- The preview URL is stored on the task record and shown in the UI
- The PR description includes a "Preview" section with the URL for human validation

## MCP Server Selection

Follows the exact same pattern as sessions and presets:

- Task creation form shows checkboxes for all registered MCP servers
- Selected IDs stored as JSON array in `mcp_server_ids` column
- During execution, `McpServerStore.getSettingsEntries(ids)` resolves them to Claude settings
- Validate MCP is **always injected** regardless of selection (not shown as a checkbox — it's implicit)
- Additional MCP servers give the execution agent extra capabilities (e.g., Tavily for web search, GitHub MCP for issue linking)

## Database Schema

### Migration: `017_tasks.sql`

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  display_id      INTEGER NOT NULL UNIQUE,
  repo_id         TEXT NOT NULL REFERENCES repos(id),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',

  -- Toggles
  auto_enrich     INTEGER NOT NULL DEFAULT 0,
  self_validate   INTEGER NOT NULL DEFAULT 0,
  mcp_server_ids  TEXT,                              -- JSON string[]

  -- Investigation
  investigation_rating  TEXT,                        -- enum: reject|weak|viable|good|excellent
  investigation_result  TEXT,                        -- JSON (InvestigationResult)
  investigated_at       TEXT,

  -- Enrichment
  enriched_description  TEXT,                        -- rewritten task description
  enrichment_result     TEXT,                        -- JSON (EnrichmentResult)
  enriched_at           TEXT,

  -- Execution
  session_id      TEXT REFERENCES sessions(id),
  branch          TEXT,
  pr_url          TEXT,
  preview_url     TEXT,

  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  error_message   TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  note            TEXT
);

CREATE TABLE IF NOT EXISTS task_transcript (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase           TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_transcript_task_phase ON task_transcript(task_id, phase, seq);
```

### Display ID

Auto-incrementing user-facing ID (like sessions). Generated via:
```sql
SELECT COALESCE(MAX(display_id), 0) + 1 FROM tasks
```

## Task Store

`src/db/task-store.ts` — follows the existing store pattern:

```typescript
export class TaskStore {
  #db: Database.Database;

  constructor(db: Database.Database) { ... }

  // Core CRUD
  createTask(input: CreateTaskInput): Task;
  getTask(id: string): Task | undefined;
  listTasks(filter?: { status?: TaskStatus; repoId?: string }): Task[];
  updateTask(id: string, patch: UpdateTaskInput): Task;
  deleteTask(id: string): void;

  // Pipeline queries
  getNextActionable(): Task | undefined;  // oldest draft/investigating/enriching/queued
  transition(id: string, to: TaskStatus, note?: string): void;  // + task_events insert

  // Investigation/enrichment updates
  setInvestigation(id: string, result: InvestigationResult): void;
  setEnrichment(id: string, result: EnrichmentResult): void;
  setExecution(id: string, data: { sessionId?: string; branch?: string; prUrl?: string; previewUrl?: string }): void;
}
```

## Queue Processor

`src/tasks/task-processor.ts` — background loop that drives the pipeline.

```typescript
export class TaskProcessor {
  #store: TaskStore;
  #sessionManager: SessionManager;
  #mcpServerStore: McpServerStore;
  #interval: ReturnType<typeof setInterval> | undefined;
  #processing = false;

  constructor(deps: { db: Database.Database; sessionManager: SessionManager }) { ... }

  start(intervalMs = 10_000): void {
    this.#interval = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.#interval);
  }

  async tick(): Promise<void> {
    if (this.#processing) return;  // prevent overlap
    this.#processing = true;
    try {
      const task = this.#store.getNextActionable();
      if (!task) return;

      switch (task.status) {
        case 'draft':
          if (task.autoEnrich) {
            this.#store.transition(task.id, 'investigating');
            await this.#investigate(task);
          } else {
            this.#store.transition(task.id, 'queued');
          }
          break;
        case 'investigating':
          await this.#investigate(task);
          break;
        case 'enriching':
          await this.#enrich(task);
          break;
        case 'queued':
          await this.#execute(task);
          break;
      }
    } finally {
      this.#processing = false;
    }
  }

  async #investigate(task: Task): Promise<void> {
    // 1. Spawn claude --print with read + web tools
    // 2. Parse InvestigationResult from JSON output
    // 3. Store result via taskStore.setInvestigation()
    // 4. If rating >= viable: transition to 'enriching'
    // 5. If rating < viable: transition to 'rejected'
    // 6. On error: transition to 'failed' with error_message
  }

  async #enrich(task: Task): Promise<void> {
    // 1. Spawn claude --print with read-only tools
    // 2. Pass original description + investigation results
    // 3. Parse EnrichmentResult from JSON output
    // 4. Store result via taskStore.setEnrichment()
    // 5. Transition to 'queued'
    // 6. On error: transition to 'failed'
  }

  async #execute(task: Task): Promise<void> {
    // 1. Build execution prompt:
    //    - Use enriched_description if available, else original description
    //    - If selfValidate: append self-validate instructions
    //    - Append verification suffix (self-audit)
    //    - Include PR creation instructions
    // 2. Call SessionManager.createSession() with:
    //    - repo, branch (auto-slugified or user-specified)
    //    - prompt (the built execution prompt)
    //    - mcpServerIds (user-selected + validate MCP always injected)
    //    - credentials from task's repo
    // 3. Store session_id on the task, transition to 'executing'
    // 4. Listen for session exit:
    //    - On success (exit 0): extract PR URL from output, transition to 'done'
    //    - On failure: transition to 'failed' with error
    // Note: session infra handles worktree, credentials, MCP settings, PTY
  }
}
```

## Self-Validate Prompt Suffix

When `selfValidate` is on, append to the execution prompt:

```
## Post-Implementation Validation

After completing the implementation:

1. Use the `validate_start` tool to host the application
2. Use `validate_browse` to navigate to the main page and verify it loads
3. Use `validate_browse` to navigate to any pages affected by your changes
4. Use `validate_screenshot` to capture visual proof of the working implementation
5. Note the preview URL from validate_start

When creating the PR, include a "## Preview" section in the description with:
- The preview URL for human validation
- Screenshots of key pages
- Any validation findings

Leave the validation environment running — it will auto-stop after timeout.
```

## Verification Suffix

Always appended to the execution prompt (inspired by Claude Code Studio):

```
## Self-Verification

Before marking this task complete, audit your own work:

1. Re-read the task requirements (original + enriched description)
2. Verify every acceptance criterion is met
3. Run any relevant build/test commands
4. Check for:
   - Missing error handling at system boundaries
   - Untested edge cases
   - Files you changed but didn't save
   - Import statements that reference non-existent modules
5. If anything is incomplete, fix it before finishing
```

## Web Routes

### Pages

| Route | Description |
| ----- | ----------- |
| `GET /tasks` | Tasks list page (filterable by status) |

### HTMX Partials (mounted before API router)

| Route | Description |
| ----- | ----------- |
| `GET /tasks/new-form` | Render task creation form |
| `POST /tasks` | Create task, return 200 or 422 with re-rendered form |
| `GET /tasks/:id` | Task detail view (investigation cards, enrichment cards, execution info) |
| `POST /tasks/:id/cancel` | Cancel a task |
| `POST /tasks/:id/retry` | Retry a failed task (re-enter pipeline from current phase) |
| `POST /tasks/:id/force-enrich` | Override rejected → enriching |
| `POST /tasks/:id/force-queue` | Override rejected → queued (skip enrichment) |
| `DELETE /tasks/:id` | Delete a task |

### SSE Events

Task status changes published to event bus for live UI updates:
- `task-status-<taskId>` — status badge swap
- `task-list-refresh` — trigger list reload

## UI Design

### Task List

Column layout: Display ID | Title | Repo | Status badge | Rating badge | Created | Actions

Status badges follow the existing session badge pattern (color-coded pills).

Rating badges:
- `reject` — red
- `weak` — orange
- `viable` — yellow
- `good` — green
- `excellent` — emerald

### Task Detail — PR-Style Cards

The detail view renders investigation and enrichment data as distinct card sections:

```
┌─────────────────────────────────────────────────────────┐
│ TASK-7  Fix race condition in auth middleware            │
│ ● Excellent  ◆ Small  ⏱ 3 min ago                      │
│ Repo: orcha-v2  Branch: task/fix-auth-race              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ┌─ Original Idea ─────────────────────────────────────┐ │
│ │ "there's a race condition when two requests hit the │ │
│ │  auth middleware at the same time, fix it"           │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Investigation ─────────────────────────────────────┐ │
│ │ Rating: ★★★★★ Excellent                             │ │
│ │                                                     │ │
│ │ "Clear bug with straightforward fix. The mutex      │ │
│ │  pattern is already used elsewhere in the           │ │
│ │  codebase (src/utils/concurrency.ts)."              │ │
│ │                                                     │ │
│ │ ✓ Race condition confirmed in session.ts:142        │ │
│ │ ✓ Existing AsyncMutex utility available             │ │
│ │ ✓ Only two files need changes                       │ │
│ │ ✗ Needs careful lock ordering with DB pool          │ │
│ │                                                     │ │
│ │ Files examined: session.ts, middleware.ts,           │ │
│ │ concurrency.ts, session.test.ts                     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Enriched Description ──────────────────────────────┐ │
│ │ Wrap the session refresh call in withMutex() to     │ │
│ │ prevent concurrent token refreshes. Use the         │ │
│ │ existing AsyncMutex from                            │ │
│ │ src/utils/concurrency.ts. Add a per-session lock    │ │
│ │ key to prevent cross-session blocking...            │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Affected Files ────────────────────────────────────┐ │
│ │ ✏️  src/auth/session.ts       race in refreshToken  │ │
│ │ ✏️  src/auth/middleware.ts    add lock acquisition   │ │
│ │ ➕ src/auth/__tests__/race.test.ts  new test case   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Implementation Approach ───────────────────────────┐ │
│ │ 1. Import AsyncMutex into session.ts                │ │
│ │    → session.ts                                     │ │
│ │ 2. Create per-session lock in refreshToken()        │ │
│ │    → session.ts, middleware.ts                       │ │
│ │ 3. Add concurrent refresh test                      │ │
│ │    → race.test.ts                                   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Risks ─────────────────────────────────────────────┐ │
│ │ 🟡 Medium — Lock ordering with DB connection pool   │ │
│ │   Mitigation: acquire mutex before DB connection    │ │
│ │                                                     │ │
│ │ 🟢 Low — Mutex timeout if session crashes mid-lock  │ │
│ │   Mitigation: 30s timeout with auto-release         │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Acceptance Criteria ───────────────────────────────┐ │
│ │ ☐ No concurrent token refreshes per session         │ │
│ │ ☐ Cross-session refreshes still parallel            │ │
│ │ ☐ Test covers concurrent refresh scenario           │ │
│ │ ☐ No deadlocks under load                           │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─ Execution ─────────────────────────────────────────┐ │
│ │ Session: #42  Status: done                          │ │
│ │ Branch: task/fix-auth-race                          │ │
│ │ PR: github.com/org/repo/pull/87                     │ │
│ │ Preview: https://orcha.example.com/preview/task-7   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [▶ Execute]  [✏️ Edit]  [↻ Retry]  [✕ Cancel]          │
└─────────────────────────────────────────────────────────┘
```

### Task Creation Form

```
┌─ New Task ────────────────────────────────────────────┐
│                                                       │
│ Repository     [▼ Select repo          ]              │
│ Title          [                       ]              │
│ Description    [                       ]              │
│                [  rough idea goes here ]              │
│                [                       ]              │
│                                                       │
│ ┌─ Options ─────────────────────────────────────────┐ │
│ │ [✓] Auto-investigate & enrich                     │ │
│ │     Agent evaluates feasibility and rewrites the  │ │
│ │     description using codebase context before     │ │
│ │     executing.                                    │ │
│ │                                                   │ │
│ │ [✓] Self-validate                                 │ │
│ │     Agent hosts the app after implementing and    │ │
│ │     adds a preview URL to the PR for human        │ │
│ │     validation.                                   │ │
│ └───────────────────────────────────────────────────┘ │
│                                                       │
│ ┌─ MCP Servers ─────────────────────────────────────┐ │
│ │ [✓] tavily-search                                 │ │
│ │ [ ] github                                        │ │
│ │ [ ] filesystem                                    │ │
│ │                                                   │ │
│ │ ℹ Validate MCP is always included.                │ │
│ └───────────────────────────────────────────────────┘ │
│                                                       │
│                              [Cancel]  [Create Task]  │
└───────────────────────────────────────────────────────┘
```

## File Structure

New files to create:

```
src/
  db/
    migrations/
      017_tasks.sql               # Schema
    task-store.ts                  # CRUD + pipeline queries
  domain/
    task-types.ts                  # TaskStatus, InvestigationResult, EnrichmentResult, etc.
  tasks/
    task-processor.ts             # Background queue loop
    investigate.ts                # Investigation agent (claude --print wrapper)
    enrich.ts                     # Enrichment agent (claude --print wrapper)
    execute.ts                    # Execution orchestrator (worktree + session + PR)
    prompts.ts                    # System prompts for investigation/enrichment/verification
  web/
    routes/
      tasks.ts                    # HTMX routes for task CRUD + actions
    views/
      pages/
        tasks-page.html           # Task list page
      partials/
        task-card.html            # Task list item
        task-detail.html          # Full detail view with enrichment cards
        task-transcript.html      # Real-time + post-completion transcript view
        new-task-form.html        # Creation form
```

Modified files:

```
src/
  web/
    app.ts                        # Mount task routes (before API router)
    views/
      layout.html                 # Add "Tasks" to navigation
  web/
    start-server.ts               # Initialize TaskProcessor, start tick loop
```

## Implementation Order

### Phase 1: Foundation
1. `task-types.ts` — type definitions
2. `017_tasks.sql` — migration
3. `task-store.ts` — CRUD + queries

### Phase 2: Pipeline Agents
4. `prompts.ts` — system prompts for investigation, enrichment, verification
5. `investigate.ts` — spawn claude CLI, parse investigation result
6. `enrich.ts` — spawn claude CLI, parse enrichment result

### Phase 3: Execution
7. `execute.ts` — worktree + MCP settings + session spawn + PR creation

### Phase 4: Queue Processor
8. `task-processor.ts` — background loop driving the pipeline

### Phase 5: Web UI
9. `tasks.ts` routes — CRUD + actions
10. `new-task-form.html` — creation form with toggles + MCP checkboxes
11. `task-card.html` — list item with status/rating badges
12. `task-detail.html` — full detail with enrichment cards
13. `tasks-page.html` — list page
14. Wire into `app.ts`, `layout.html`, `start-server.ts`

### Phase 6: Polish
15. SSE events for live status updates
16. Error handling, retry logic, graceful shutdown
17. Task cleanup (old worktrees, expired previews)

## Session Transcript (Real-time + Post-completion)

Full visibility into what Claude is doing — both live (while executing) and after (for debugging, auditing, learning).

**Two transcript modes** (matching the hybrid execution model):
- **Investigation & Enrichment** (`--print` phases): Captured via `--output-format stream-json`. Parsed into structured events, stored in `task_transcript`, displayed as rich cards.
- **Execution** (headless PTY): Real-time terminal output via the existing session WS bridge. User clicks "Open Terminal" on the task detail page to watch live. Post-completion, the output buffer is available for review.

### Approach: Streaming JSON Capture (Investigation & Enrichment)

Uses `claude --output-format stream-json` for the `--print` phases. This emits newline-delimited JSON events:

```jsonl
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me read the auth middleware..."}]}}
{"type":"tool_use","tool":{"name":"Read","input":{"file_path":"src/auth/middleware.ts"}}}
{"type":"tool_result","result":{"content":"..."}}
{"type":"result","result":{"type":"text","text":"Done. Created PR #87."}}
```

### Storage

New table for transcript entries:

```sql
CREATE TABLE IF NOT EXISTS task_transcript (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL,            -- 'investigate' | 'enrich' | 'execute'
  seq         INTEGER NOT NULL,         -- ordering within phase
  event_type  TEXT NOT NULL,            -- 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'error' | 'system'
  data        TEXT NOT NULL,            -- raw JSON event
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_transcript_task_phase ON task_transcript(task_id, phase, seq);
```

### Real-time Streaming

1. **During execution**: The task processor reads stdout line-by-line from the `claude` subprocess
2. Each JSON event is parsed, inserted into `task_transcript`, and **published to the SSE event bus**
3. The task detail page subscribes to `task-transcript-<taskId>` SSE events
4. New events are rendered incrementally into the transcript view (appended to DOM via HTMX `hx-swap="beforeend"`)

```typescript
// In task processor, during any phase:
const proc = spawn('claude', args, { cwd: worktreePath });

let seq = 0;
const rl = readline.createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  const event = JSON.parse(line);
  taskStore.appendTranscript(task.id, phase, seq++, event);
  eventBus.publish(`task-transcript-${task.id}`, { phase, seq, event });
});
```

### Post-completion Viewing

After the task completes, the full transcript is always available:
- `TaskStore.getTranscript(taskId, phase?)` returns all events ordered by phase + seq
- The task detail view renders it as a collapsible timeline per phase

### Transcript UI

Rendered in the task detail page below the enrichment cards:

```
┌─ Transcript ──────────────────────────────────────────┐
│                                                       │
│ ▸ Investigation (15 events, 23s)                      │
│ ▸ Enrichment (28 events, 45s)                         │
│ ▾ Execution (142 events, 3m 12s)          ● LIVE      │
│                                                       │
│   🤖 Let me read the auth middleware to understand    │
│      the current session handling...                  │
│                                                       │
│   🔧 Read src/auth/middleware.ts                      │
│   ┌─────────────────────────────────────────────────┐ │
│   │ const session = await getSession(req);          │ │
│   │ if (!session) return res.status(401)...         │ │
│   └─────────────────────────────────────────────────┘ │
│                                                       │
│   🤖 I can see the race condition. Two concurrent    │
│      requests can both trigger refreshToken()...      │
│                                                       │
│   🔧 Edit src/auth/session.ts                        │
│   ┌─────────────────────────────────────────────────┐ │
│   │ - await refreshToken(session);                  │ │
│   │ + await withMutex(session.id, () =>             │ │
│   │ +   refreshToken(session)                       │ │
│   │ + );                                            │ │
│   └─────────────────────────────────────────────────┘ │
│                                                       │
│   🔧 Bash: npm test                                   │
│   ┌─────────────────────────────────────────────────┐ │
│   │ ✓ 47 tests passed                              │ │
│   └─────────────────────────────────────────────────┘ │
│                                                       │
│   🤖 All tests pass. Creating PR...                   │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Each event type has a distinct rendering:
- `assistant` → agent text with 🤖 prefix
- `tool_use` → tool name with 🔧 prefix, collapsible input
- `tool_result` → collapsible output block (truncated by default)
- `result` → final summary
- `error` → red-highlighted error message

### Impact on File Structure

Add to new files:
```
src/
  web/
    views/
      partials/
        task-transcript.html      # Transcript view component
```

Add to `task-store.ts`:
```typescript
appendTranscript(taskId: string, phase: string, seq: number, event: unknown): void;
getTranscript(taskId: string, phase?: string): TranscriptEntry[];
```

## Design Decisions

Discussed and decided interactively:

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | **Concurrency** — shared or separate worker pools? | **Shared pool** | Single `maxConcurrent` limit for sessions + tasks. Simpler, no config duplication. |
| 2 | **Execution model** — `--print`, headless PTY, or SDK? | **Headless PTY session** | Reuses existing session infra (SessionManager, output buffer, WS bridge). User can attach mid-flight to watch or interact. Real-time terminal view works out of the box. Investigation + enrichment still use `claude --print` (lightweight, structured JSON). |
| 3 | **Branch naming** | **Auto from title, optional override** | Slugify title → `task/fix-auth-race-condition`. Form has optional branch field — if left blank, auto-generated. |
| 4 | **PR creation** | **Agent creates PR** | Part of the execution prompt. Agent writes rich PR description with context from its work. More natural than templated post-processing. |
| 5 | **Notifications** | **SSE only (dashboard)** | Live badge updates when browser is open. Keep it simple for v1 — webhook/Telegram can be added later. |

### Execution Model Detail

The hybrid approach:

- **Investigation** (`--print`): Lightweight, structured JSON output is easy to parse into `InvestigationResult`. Stored in `task_transcript` via stream-json capture. No need for real-time viewing — runs for ~30s.
- **Enrichment** (`--print`): Same as investigation. Structured JSON output parsed into `EnrichmentResult`. Runs for ~1-2 min.
- **Execution** (headless PTY): Task processor calls `SessionManager.createSession()` with the enriched prompt. This creates a real session with worktree, credentials, MCP settings — identical to interactive sessions. The difference:
  - No terminal tab opened automatically
  - Task links to `session_id` — user can click through to watch the terminal live
  - Session exit handler updates the task status (done/failed)
  - Task detail page shows an "Open Terminal" button that connects to the session's WS

This means the execution transcript is the **actual terminal output** — same as watching an interactive session. The investigation/enrichment transcripts use the parsed JSON approach (richer, card-style display).
