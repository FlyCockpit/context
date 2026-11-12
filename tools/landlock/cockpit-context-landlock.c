// SPDX-License-Identifier: MIT
// Copyright (c) 2026 FlyCockpit LLC
//
// cockpit-context-landlock: runs one language server inside a Landlock sandbox.
//
//   cockpit-context-landlock --probe
//   cockpit-context-landlock [--ro PATH]... [--rx PATH]... [--rw PATH]...
//                 [--env NAME=VALUE]... [--chdir DIR] -- /abs/command [arg]...
//
// The sandbox is an allowlist: after the restriction the process (and every
// process it starts, which inherits the Landlock domain) can only open what
// the arguments name, with the rights they name:
//
//   --ro PATH   read files and list directories beneath PATH
//   --rx PATH   --ro plus execute
//   --rw PATH   --ro plus create, write, truncate, rename and remove (no execute)
//
// Every filesystem access right the running kernel's Landlock ABI knows is
// handled, so anything not granted is denied. From ABI 4 TCP bind and connect
// are handled with no allow rule (all TCP is denied); from ABI 6 the process
// cannot signal processes outside its domain or reach abstract Unix sockets
// created outside it. Landlock also denies ptrace-mode access (for example
// /proc/<pid>/environ) to processes outside the domain.
//
// The command runs with exactly the --env variables (the inherited
// environment is dropped), in a new session, with every file descriptor above
// 2 closed, PR_SET_NO_NEW_PRIVS set and SIGKILL as its parent-death signal.
//
// FAIL CLOSED: any error before execve prints `cockpit-context-landlock: ...` on stderr
// and exits 125 without running the command. The command is never run
// unrestricted.
//
// --probe prints one JSON line: the ABI and which protections are active, and
// whether a restriction is actually enforced here (a forked child restricts
// itself and must then be denied reading "/"). Exit 0 when enforced, 1 when not.
//
// libc only. Landlock's constants and structs are defined below rather than
// taken from <linux/landlock.h>, so older kernel headers (Debian bookworm's
// are 6.1) still build every protection. Rights the running kernel does not
// know are masked by ABI before they are requested (the kernel rejects
// unknown bits).

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif
#ifndef SYS_close_range
#define SYS_close_range 436
#endif

#define COCKPIT_CONTEXT_CREATE_RULESET_VERSION (1U << 0)
#define COCKPIT_CONTEXT_RULE_PATH_BENEATH 1

#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REMOVE_DIR (1ULL << 4)
#define FS_REMOVE_FILE (1ULL << 5)
#define FS_MAKE_CHAR (1ULL << 6)
#define FS_MAKE_DIR (1ULL << 7)
#define FS_MAKE_REG (1ULL << 8)
#define FS_MAKE_SOCK (1ULL << 9)
#define FS_MAKE_FIFO (1ULL << 10)
#define FS_MAKE_BLOCK (1ULL << 11)
#define FS_MAKE_SYM (1ULL << 12)
#define FS_REFER (1ULL << 13)     /* ABI 2 */
#define FS_TRUNCATE (1ULL << 14)  /* ABI 3 */
#define FS_IOCTL_DEV (1ULL << 15) /* ABI 5 */

#define NET_BIND_TCP (1ULL << 0)    /* ABI 4 */
#define NET_CONNECT_TCP (1ULL << 1) /* ABI 4 */

#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0) /* ABI 6 */
#define SCOPE_SIGNAL (1ULL << 1)               /* ABI 6 */

/* Rights that apply to a file (not a directory) in a path-beneath rule. */
#define FS_FILE_RIGHTS (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV)

#define RIGHTS_RO (FS_READ_FILE | FS_READ_DIR)
#define RIGHTS_RX (RIGHTS_RO | FS_EXECUTE)
#define RIGHTS_RW                                                                         \
  (RIGHTS_RO | FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_DIR | FS_MAKE_REG | \
   FS_REFER | FS_TRUNCATE)

#define EXIT_SANDBOX_ERROR 125
#define MAX_RULES 256
#define MAX_ENV 64

struct cockpit_context_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net; /* ABI 4 */
  uint64_t scoped;             /* ABI 6 */
};

struct cockpit_context_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

struct rule {
  const char *path;
  uint64_t rights;
};

static void die(const char *format, ...) __attribute__((noreturn, format(printf, 1, 2)));

static void die(const char *format, ...) {
  va_list args;
  fputs("cockpit-context-landlock: ", stderr);
  va_start(args, format);
  vfprintf(stderr, format, args);
  va_end(args);
  fputs(" (the command was not started)\n", stderr);
  exit(EXIT_SANDBOX_ERROR);
}

static long landlock_abi(void) {
  return syscall(SYS_landlock_create_ruleset, NULL, 0, COCKPIT_CONTEXT_CREATE_RULESET_VERSION);
}

static const char *abi_error(int error) {
  if (error == ENOSYS) return "this kernel has no Landlock support (Linux 5.13 or later with CONFIG_SECURITY_LANDLOCK)";
  if (error == EOPNOTSUPP) return "Landlock is not enabled on this kernel (add landlock to the lsm= boot parameter)";
  if (error == EPERM) return "the landlock_create_ruleset syscall is blocked here (seccomp)";
  return strerror(error);
}

/* Every filesystem right the ABI knows. */
static uint64_t handled_fs_for(long abi) {
  uint64_t fs = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_READ_DIR | FS_REMOVE_DIR |
                FS_REMOVE_FILE | FS_MAKE_CHAR | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK |
                FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM;
  if (abi >= 2) fs |= FS_REFER;
  if (abi >= 3) fs |= FS_TRUNCATE;
  if (abi >= 5) fs |= FS_IOCTL_DEV;
  return fs;
}

/* A ruleset handling everything this ABI supports; returns its fd. */
static int create_ruleset(long abi, struct cockpit_context_ruleset_attr *attr) {
  size_t size = sizeof(attr->handled_access_fs);
  memset(attr, 0, sizeof(*attr));
  attr->handled_access_fs = handled_fs_for(abi);
  if (abi >= 4) {
    attr->handled_access_net = NET_BIND_TCP | NET_CONNECT_TCP;
    size = offsetof(struct cockpit_context_ruleset_attr, scoped);
  }
  if (abi >= 6) {
    attr->scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL;
    size = sizeof(*attr);
  }
  return (int)syscall(SYS_landlock_create_ruleset, attr, size, 0U);
}

static int probe(void) {
  long abi = landlock_abi();
  if (abi < 1) {
    int error = errno;
    printf("{\"landlock\":false,\"abi\":0,\"reason\":\"%s\"}\n", abi_error(error));
    return 1;
  }
  /* Prove the restriction: a child that handles READ_DIR with no rule must be denied "/". */
  pid_t child = fork();
  if (child < 0) {
    printf("{\"landlock\":false,\"abi\":%ld,\"reason\":\"fork failed: %s\"}\n", abi,
           strerror(errno));
    return 1;
  }
  if (child == 0) {
    struct cockpit_context_ruleset_attr attr;
    int ruleset = create_ruleset(abi, &attr);
    if (ruleset < 0) _exit(10);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) _exit(11);
    if (syscall(SYS_landlock_restrict_self, ruleset, 0U) != 0) _exit(12);
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd >= 0) _exit(13);
    _exit(errno == EACCES ? 0 : 14);
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) {
      status = -1;
      break;
    }
  }
  int code = (status >= 0 && WIFEXITED(status)) ? WEXITSTATUS(status) : -1;
  const char *reason = code == 0    ? NULL
                       : code == 10 ? "landlock_create_ruleset failed"
                       : code == 11 ? "PR_SET_NO_NEW_PRIVS failed"
                       : code == 12 ? "landlock_restrict_self failed"
                       : code == 13 ? "the restriction was not enforced"
                                    : "the restriction test failed";
  printf("{\"landlock\":true,\"abi\":%ld,\"filesystem\":true,\"tcp\":%s,\"scoping\":%s,"
         "\"enforced\":%s%s%s%s}\n",
         abi, abi >= 4 ? "true" : "false", abi >= 6 ? "true" : "false",
         reason ? "false" : "true", reason ? ",\"reason\":\"" : "", reason ? reason : "",
         reason ? "\"" : "");
  return reason ? 1 : 0;
}

static int valid_env(const char *entry) {
  const char *eq = strchr(entry, '=');
  if (!eq || eq == entry) return 0;
  for (const char *c = entry; c < eq; c++) {
    int ok = (*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') || *c == '_' ||
             (c != entry && *c >= '0' && *c <= '9');
    if (!ok) return 0;
  }
  return 1;
}

static void add_rule(int ruleset, uint64_t handled, const struct rule *rule) {
  int fd = open(rule->path, O_PATH | O_CLOEXEC);
  if (fd < 0) die("cannot open %s: %s", rule->path, strerror(errno));
  struct stat st;
  if (fstat(fd, &st) != 0) die("cannot stat %s: %s", rule->path, strerror(errno));
  uint64_t rights = rule->rights & handled;
  if (!S_ISDIR(st.st_mode)) rights &= FS_FILE_RIGHTS;
  if (rights == 0) die("no access right applies to %s", rule->path);
  struct cockpit_context_path_beneath_attr attr = {.allowed_access = rights, .parent_fd = fd};
  if (syscall(SYS_landlock_add_rule, ruleset, COCKPIT_CONTEXT_RULE_PATH_BENEATH, &attr, 0U) != 0) {
    die("landlock_add_rule %s: %s", rule->path, strerror(errno));
  }
  close(fd);
}

static void close_inherited_fds(void) {
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return;
  if (errno != ENOSYS) die("close_range: %s", strerror(errno));
  long max = sysconf(_SC_OPEN_MAX);
  if (max < 0 || max > 1048576) max = 1048576;
  for (long fd = 3; fd < max; fd++) close((int)fd);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return probe();

  static struct rule rules[MAX_RULES];
  static char *env[MAX_ENV + 1];
  size_t rule_count = 0;
  size_t env_count = 0;
  const char *chdir_to = NULL;
  int index = 1;
  for (; index < argc; index++) {
    const char *flag = argv[index];
    if (strcmp(flag, "--") == 0) {
      index++;
      break;
    }
    if (index + 1 >= argc) die("%s needs a value", flag);
    const char *value = argv[++index];
    if (strcmp(flag, "--ro") == 0 || strcmp(flag, "--rx") == 0 || strcmp(flag, "--rw") == 0) {
      if (value[0] != '/') die("%s %s: paths must be absolute", flag, value);
      if (rule_count >= MAX_RULES) die("more than %d paths", MAX_RULES);
      rules[rule_count].path = value;
      rules[rule_count].rights = flag[3] == 'o' ? RIGHTS_RO : flag[3] == 'x' ? RIGHTS_RX : RIGHTS_RW;
      rule_count++;
    } else if (strcmp(flag, "--env") == 0) {
      if (!valid_env(value)) die("--env %s: expected NAME=VALUE", value);
      if (env_count >= MAX_ENV) die("more than %d variables", MAX_ENV);
      env[env_count++] = (char *)value;
    } else if (strcmp(flag, "--chdir") == 0) {
      if (value[0] != '/') die("--chdir %s: the directory must be absolute", value);
      chdir_to = value;
    } else {
      die("unknown option %s", flag);
    }
  }
  env[env_count] = NULL;
  if (index >= argc) die("no command after --");
  const char *command = argv[index];
  if (command[0] != '/') die("the command %s must be an absolute path", command);

  pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) die("PR_SET_PDEATHSIG: %s", strerror(errno));
  if (getppid() != parent) die("the parent exited");
  if (setsid() < 0 && getsid(0) != getpid()) die("setsid: %s", strerror(errno));
  if (chdir_to && chdir(chdir_to) != 0) die("chdir %s: %s", chdir_to, strerror(errno));

  long abi = landlock_abi();
  if (abi < 1) die("%s", abi_error(errno));
  struct cockpit_context_ruleset_attr attr;
  int ruleset = create_ruleset(abi, &attr);
  if (ruleset < 0) die("landlock_create_ruleset: %s", strerror(errno));
  for (size_t i = 0; i < rule_count; i++) add_rule(ruleset, attr.handled_access_fs, &rules[i]);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die("PR_SET_NO_NEW_PRIVS: %s", strerror(errno));
  if (syscall(SYS_landlock_restrict_self, ruleset, 0U) != 0) {
    die("landlock_restrict_self: %s", strerror(errno));
  }
  close(ruleset);
  close_inherited_fds();

  execve(command, &argv[index], env);
  die("cannot execute %s: %s", command, strerror(errno));
}
