# Storage Strategy

This document describes how Orcha persists data, why specific storage technologies were chosen for the Azure Container Apps deployment, and what happens when the persistent volume is absent.

## /data directory layout

All persistent state lives under a single root directory, defaulting to `/data` (overridable via `ORCHA_DATA_DIR`):

```
/data
├── orcha.db          # SQLite database (WAL mode)
├── bare-repos/       # Bare git repository clones (one per upstream repo)
│   └── github.com/
│       └── org/
│           └── repo/ # bare clone: objects, refs, config, HEAD
├── worktrees/        # Active git worktrees (ephemeral, reconstructed on demand)
│   └── <session-id>/ # checked-out working tree linked to bare repo
└── logs/             # Application and session log files
```

These paths are computed once at startup by `src/storage/paths.ts` and shared across all modules.

## Why Azure Files is ruled out

Git relies on POSIX advisory locks (`flock`) for safe concurrent access to its object store, index files, and ref databases. Azure Files (SMB-backed) does not implement POSIX `flock` semantics on Linux — lock calls either succeed silently without exclusion or fail with `ENOSYS`. This causes data corruption when multiple git operations run concurrently, and breaks SQLite's WAL mode which also depends on POSIX locks.

## Bare-repo-on-blob hybrid rationale

The chosen strategy separates the git object store from the working tree:

1. **Bare repository on Azure Blob Storage (via blobfuse2)** — The bare repo contains only git objects (blobs, trees, commits) and refs. Git operations on a bare repo do not require a work-tree lock, reducing the locking surface to pack-file writes which are atomic rename-based. blobfuse2 mounts Azure Blob containers as a local FUSE filesystem, providing sequential-write semantics that are sufficient for bare repo operations.

2. **Ephemeral worktrees on local (ephemeral) storage** — Working trees are cheap to reconstruct from the bare repo via `git worktree add`. They live on the container's local filesystem for maximum speed. If the container restarts, worktrees are recreated from the persisted bare repo.

This avoids the POSIX locking problems of Azure Files while keeping working-tree I/O fast and local.

## Ephemeral worktree reconstruction flow

On a cold start or after a container restart:

1. Orcha starts and reads storage paths from `ORCHA_DATA_DIR` (or `/data`).
2. The SQLite database is opened from `/data/orcha.db`. Sessions in `running` or `starting` status are detected and transitioned to `failed` by the startup cleanup pass.
3. When a new session is requested with a `repoUrl`, `WorktreeManager.ensureBareRepo(repoUrl)` is called. If the bare repo already exists under `/data/bare-repos/<slug>`, it is used as-is. Otherwise a `git clone --bare` is performed.
4. `WorktreeManager.addWorktree(sessionId, branch)` creates a new linked worktree under `/data/worktrees/<session-id>` pointing into the bare repo's object store.
5. The PTY session starts with its working directory set to the worktree path.

## Fallback behaviour when /data is not mounted

If the container starts without a persistent volume mounted at `/data`, Orcha will still start but will emit a warning in logs:

```
WARNING: /data is not a persistent mount — SQLite and worktrees will be lost on container restart
```

This warning is produced by `checkVolumeMount('/data')` in `src/storage/volume-check.ts`, which inspects `/proc/mounts` on Linux to determine whether `/data` is a distinct mount point. On non-Linux hosts (local development on macOS or Windows) the check is skipped entirely to avoid false alarms.

In the unmounted case all state is written to the container overlay filesystem and is lost when the container is replaced or restarted. This is acceptable for local development but must not be used in production.
