# Dotnet Build Failure in Sandboxed Sessions

## Symptom

Running `dotnet build` inside a Landlock-sandboxed Orcha session fails with:

```
System.IO.IOException: The system cannot open the device or file specified. : 'NuGet-Migrations'.
One or more system calls failed: stat("/tmp/.dotnet/shm", ...) == -1; errno == ENOENT;
  at System.Threading.Mutex.CreateMutexCore(...)
  at NuGet.Common.Migrations.MigrationRunner.Run(...)
  at Microsoft.DotNet.Configurer.DotnetFirstTimeUseConfigurer.Configure()
```

Also, without a writable `DOTNET_CLI_HOME`, dotnet fails earlier with:

```
System.UnauthorizedAccessException: Access to the path '/app/.dotnet' is denied.
```

## Root Cause

Two issues combine:

### 1. Named mutex needs `/tmp/.dotnet/shm/` to exist

.NET's named mutex implementation on Linux creates shared memory files at:

```
/tmp/.dotnet/shm/session{SID}/NuGet-Migrations
```

Under Landlock, dotnet **cannot create** the `/tmp/.dotnet/shm/` directory at runtime — even though `/tmp` is granted full RW access. The `mkdir` syscall that dotnet uses to create the shm directory is blocked by Landlock (likely due to how the runtime creates it via a path that crosses the Landlock boundary).

If the directory pre-exists before Landlock is applied, everything works fine.

### 2. `HOME=/app` is read-only

The orcha user's HOME is `/app` (the WORKDIR). Dotnet tries to create `$HOME/.dotnet/` for first-run config, but `/app` is read-only from the COPY steps.

## What Doesn't Work

| Approach | Why It Fails |
|---|---|
| `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1` | Does NOT skip `MigrationRunner.Run()` — the stack trace shows it still calls `DotnetFirstTimeUseConfigurer.Configure()` → `MigrationRunner.Run()` which creates the mutex |
| `TMPDIR` | Does not affect named mutex paths (hardcoded to `/tmp/`) |
| `COMPlus_EnableDiagnostics=0` | Only disables diagnostic ports/sockets, not named mutexes |
| `DOTNET_SHARED_MEMORY_APPLICATION_GROUP_ID` | Apple-only (macOS/iOS) |

## Fix (Applied)

Two changes in the Dockerfile:

### Pre-create the shm directory (before Landlock is applied)

```dockerfile
RUN mkdir -p /tmp/.dotnet/shm && chown -R orcha:orcha /tmp/.dotnet/shm
```

This is the critical fix. The directory exists before any session starts, so dotnet's named mutex code finds it via `stat()` and proceeds without needing to `mkdir`.

### Set `DOTNET_CLI_HOME` to a writable location

```dockerfile
ENV DOTNET_CLI_HOME=/tmp/dotnet-cli \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_NOLOGO=true \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
```

- `DOTNET_CLI_HOME` redirects `.dotnet` data away from read-only `/app`
- `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1` suppresses welcome banner (but doesn't prevent mutex creation)
- `DOTNET_NOLOGO=true` suppresses logo output
- `DOTNET_CLI_TELEMETRY_OPTOUT=1` disables telemetry in sandboxed sessions

## Verification (Tested 2026-03-09)

Tested inside the running container via `az containerapp exec`:

| Test | Condition | Result |
|------|-----------|--------|
| No fix, `HOME=/app` | Default | `UnauthorizedAccessException: /app/.dotnet` |
| `DOTNET_CLI_HOME=/tmp/x` only | Writable CLI home | Works (no landlock) |
| Landlock + writable HOME, shm pre-exists | Prior test created shm | Works |
| Landlock + writable HOME, **no shm dir** | Clean `/tmp/.dotnet/` | **`IOException: NuGet-Migrations` mutex failure** |
| `SKIP=1` + `CLI_HOME` under landlock, no shm | Env vars only | **Still fails** — SKIP doesn't prevent mutex |
| Pre-create `/tmp/.dotnet/shm/` + landlock | Directory exists before sandbox | **Works** |

## References

- [dotnet/runtime#91987](https://github.com/dotnet/runtime/issues/91987) — NuGet-Migrations IOException
- [dotnet/runtime#80619](https://github.com/dotnet/runtime/issues/80619) — IOException during dotnet CLI first run
- [dotnet/runtime#9926](https://github.com/dotnet/runtime/issues/9926) — Named mutex creation fails in Docker
- [SharedMemoryManager.Unix.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/SharedMemoryManager.Unix.cs)
- [NamedMutex.Unix.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/NamedMutex.Unix.cs)

## Status

**Resolved** — fix applied in Dockerfile. Pre-creating `/tmp/.dotnet/shm/` at image build time ensures the directory exists before Landlock is enforced.
