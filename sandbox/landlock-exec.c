/*
 * landlock-exec — apply Landlock LSM filesystem restrictions then exec a command.
 *
 * Usage:
 *   landlock-exec <worktree> <home-dir> [extra-rw-path ...] -- <command> [args...]
 *
 * Grants:
 *   read+write: worktree, <home-dir>/.claude, /tmp, any extra-rw-paths
 *   read-only:  /usr /lib /lib64 /bin /sbin /etc /proc /run /var/lib/dpkg
 *
 * Falls back gracefully (logs + execs without restriction) when Landlock is
 * not supported by the kernel.  Requires Linux >= 5.13 for any restriction.
 *
 * Build:  gcc -O2 -static -o landlock-exec sandbox/landlock-exec.c
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

/* ---------- syscall wrappers (not in glibc yet) -------------------------- */

static inline int ll_create_ruleset(const struct landlock_ruleset_attr *a,
                                    size_t sz, __u32 flags) {
    return (int)syscall(__NR_landlock_create_ruleset, a, sz, flags);
}
static inline int ll_add_rule(int rfd, enum landlock_rule_type t,
                              const void *attr, __u32 flags) {
    return (int)syscall(__NR_landlock_add_rule, rfd, t, attr, flags);
}
static inline int ll_restrict_self(int rfd, __u32 flags) {
    return (int)syscall(__NR_landlock_restrict_self, rfd, flags);
}

/* ---------- access-right sets -------------------------------------------- */

/* All bits available in ABI v1 (kernel 5.13). */
#define FS_ALL_V1 (                       \
    LANDLOCK_ACCESS_FS_EXECUTE          | \
    LANDLOCK_ACCESS_FS_WRITE_FILE       | \
    LANDLOCK_ACCESS_FS_READ_FILE        | \
    LANDLOCK_ACCESS_FS_READ_DIR         | \
    LANDLOCK_ACCESS_FS_REMOVE_DIR       | \
    LANDLOCK_ACCESS_FS_REMOVE_FILE      | \
    LANDLOCK_ACCESS_FS_MAKE_CHAR        | \
    LANDLOCK_ACCESS_FS_MAKE_DIR         | \
    LANDLOCK_ACCESS_FS_MAKE_REG         | \
    LANDLOCK_ACCESS_FS_MAKE_SOCK        | \
    LANDLOCK_ACCESS_FS_MAKE_SYM         | \
    LANDLOCK_ACCESS_FS_MAKE_BLOCK       | \
    LANDLOCK_ACCESS_FS_MAKE_FIFO)

#define FS_RO (LANDLOCK_ACCESS_FS_EXECUTE | \
               LANDLOCK_ACCESS_FS_READ_FILE | \
               LANDLOCK_ACCESS_FS_READ_DIR)

#define FS_RW FS_ALL_V1

/* ---------- helpers ------------------------------------------------------- */

static int add_rule(int rfd, const char *path, __u64 access) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) return 0;  /* path absent — skip silently */
    struct landlock_path_beneath_attr attr = {
        .allowed_access = access,
        .parent_fd = fd,
    };
    int ret = ll_add_rule(rfd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0);
    close(fd);
    return ret;
}

/* ---------- main ---------------------------------------------------------- */

int main(int argc, char *argv[]) {
    /* Parse: landlock-exec <worktree> <home-dir> [extra-rw...] -- <cmd>... */
    if (argc < 4) {
        fprintf(stderr, "usage: landlock-exec <worktree> <home-dir>"
                        " [extra-rw-path ...] -- <cmd> [args...]\n");
        return 1;
    }

    /* Locate '--' separator */
    int sep = -1;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) { sep = i; break; }
    }
    if (sep < 0 || sep + 1 >= argc) {
        fprintf(stderr, "landlock-exec: missing '--' separator or command\n");
        return 1;
    }

    const char *worktree = argv[1];
    const char *home_dir = argv[2];

    /* Build .claude path from home_dir */
    char claude_dir[4096];
    snprintf(claude_dir, sizeof(claude_dir), "%s/.claude", home_dir);

    /* ---- Create ruleset ------------------------------------------------- */
    struct landlock_ruleset_attr ra = { .handled_access_fs = FS_ALL_V1 };
    int rfd = ll_create_ruleset(&ra, sizeof(ra), 0);
    if (rfd < 0) {
        if (errno == ENOSYS || errno == EOPNOTSUPP) {
            fprintf(stderr, "[landlock-exec] not supported by kernel"
                            " — running without isolation\n");
            goto do_exec;
        }
        perror("[landlock-exec] landlock_create_ruleset");
        return 1;
    }

    /* ---- RW rules ------------------------------------------------------- */
    add_rule(rfd, worktree,    FS_RW);  /* session worktree  */
    add_rule(rfd, claude_dir,  FS_RW);  /* ~/.claude         */
    add_rule(rfd, "/tmp",      FS_RW);  /* scratch space     */

    /* Extra RW paths passed between home-dir and '--' */
    for (int i = 3; i < sep; i++) {
        add_rule(rfd, argv[i], FS_RW);
    }

    /* Device nodes that must be opened O_RDWR (git, bash, etc.)           */
    add_rule(rfd, "/dev/null",    FS_RW);
    add_rule(rfd, "/dev/zero",    FS_RW);
    add_rule(rfd, "/dev/urandom", FS_RW);
    add_rule(rfd, "/dev/tty",     FS_RW);

    /* ---- RO rules ------------------------------------------------------- */
    static const char *ro_paths[] = {
        "/usr", "/lib", "/lib64", "/bin", "/sbin",
        "/etc", "/proc", "/run",
        "/var/lib/dpkg",   /* dpkg db — some tools query it */
        "/dev",            /* /dev/null, /dev/tty, /dev/urandom etc */
        "/sys",            /* sysfs — some Node.js internals read it */
        NULL,
    };
    for (int i = 0; ro_paths[i]; i++) {
        add_rule(rfd, ro_paths[i], FS_RO);
    }

    /* ---- Enforce -------------------------------------------------------- */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        perror("[landlock-exec] prctl(NO_NEW_PRIVS)");
        close(rfd);
        return 1;
    }
    if (ll_restrict_self(rfd, 0) < 0) {
        perror("[landlock-exec] landlock_restrict_self");
        close(rfd);
        return 1;
    }
    close(rfd);

do_exec:
    execvp(argv[sep + 1], &argv[sep + 1]);
    perror("[landlock-exec] execvp");
    return 1;
}
