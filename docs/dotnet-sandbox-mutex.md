# Dotnet Build Failure in Sandboxed Sessions

## Symptom

Running `dotnet build` inside a Landlock-sandboxed Orcha session fails with:

```
System.IO.IOException: The system cannot open the device or file specified. : 'NuGet-Migrations'
```

## Root Cause

.NET's named mutex implementation on Linux creates shared memory files at a **hardcoded** path:

```
/tmp/.dotnet/shm/session{SID}/NuGet-Migrations
```

- Uses `open()` + `mmap()` + `pthread_mutex_init(PTHREAD_PROCESS_SHARED)` on regular files
- Has nothing to do with `/dev/shm` (POSIX shared memory) — the "shm" directory name is just a convention
- The base path `/tmp/` is hardcoded in the runtime (`SharedMemoryManager.Unix.cs` line 416). No env var changes it on Linux
- `TMPDIR` does **not** affect named mutexes — intentionally hardcoded so cross-process mutexes use a well-known path

The `NuGet-Migrations` mutex is created by NuGet's `MigrationRunner.Run()` during dotnet's first-run experience.

## Why Landlock Isn't the Problem

`/tmp` is already granted full RW access in `sandbox/landlock-exec.c` (line 123). The sandbox config is not blocking file creation under `/tmp/.dotnet/shm/`.

The likely failure cause is one of:

1. **Permission mismatch** — `/tmp/.dotnet/shm/` created by a different user (root vs orcha) and the session user can't access it
2. **`HOME=/tmp` overlap** — setting `HOME=/tmp` may cause dotnet to conflict with its own `/tmp/.dotnet` paths
3. **Stale lock files** — previous crashed sessions holding `flock()` locks on the shm files

## Env Vars That Don't Help

| Env Var | Why It Doesn't Work |
|---|---|
| `TMPDIR` | Does not affect named mutex paths (hardcoded to `/tmp/`) |
| `COMPlus_EnableDiagnostics=0` | Only disables diagnostic ports/sockets, not named mutexes |
| `DOTNET_EnableDiagnostics=0` | Same as above |
| `DOTNET_SHARED_MEMORY_APPLICATION_GROUP_ID` | Apple-only (macOS/iOS) |

## Fix

**`DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`** — skips `MigrationRunner.Run()` entirely, which is the code path that creates the `NuGet-Migrations` mutex. No mutex creation, no failure.

`DOTNET_NOLOGO=true` may also help by skipping first-run behavior.

## How to Verify

Exec into the running container:

```bash
az containerapp exec \
  --name orcha \
  --resource-group orcha \
  --container orcha \
  --command "/bin/sh"
```

Then run diagnostics:

```bash
# Check current state
ls -la /tmp/.dotnet/
stat /tmp/.dotnet/shm/ 2>/dev/null
whoami

# Reproduce the failure
HOME=/tmp dotnet build <project.csproj> --no-restore 2>&1 | tail -10

# Test the fix
DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 dotnet build <project.csproj> --no-restore 2>&1 | tail -10
```

Or test locally with the same Docker image:

```bash
docker build -t orcha-test .
docker run --rm -it orcha-test /bin/bash
```

## References

- [dotnet/runtime#91987](https://github.com/dotnet/runtime/issues/91987) — NuGet-Migrations IOException
- [dotnet/runtime#80619](https://github.com/dotnet/runtime/issues/80619) — IOException during dotnet CLI first run
- [dotnet/runtime#9926](https://github.com/dotnet/runtime/issues/9926) — Named mutex creation fails in Docker
- [SharedMemoryManager.Unix.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/SharedMemoryManager.Unix.cs)
- [NamedMutex.Unix.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/NamedMutex.Unix.cs)

## Status

**Unresolved** — fix identified but not yet tested in the container. Needs verification via `az containerapp exec` before implementing.
