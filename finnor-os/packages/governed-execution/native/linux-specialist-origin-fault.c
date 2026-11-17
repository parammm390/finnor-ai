/* Test-only finite actuator. Never installed in the production worker image.
 * The caller must already have qualified root/test authority. No signer,
 * command interpreter, role grant, observer or original is created here. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/vfs.h>
#include <linux/magic.h>
#include <time.h>
#include <unistd.h>

static int number(const char *s, unsigned long long *v) {
  char *end = NULL;
  if (!s || !*s || *s == '-' || *s == '+') return -1;
  errno = 0; *v = strtoull(s, &end, 10);
  return errno || !end || *end ? -1 : 0;
}
static int birth(pid_t pid, unsigned long long expected, pid_t parent) {
  char path[64], raw[4096];
  int n = snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  if (n <= 0 || (size_t)n >= sizeof(path)) return -1;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t count = read(fd, raw, sizeof(raw) - 1);
  close(fd);
  if (count <= 0 || (size_t)count >= sizeof(raw) - 1) return -1;
  raw[count] = '\0';
  char *p = strrchr(raw, ')'), *save = NULL;
  if (!p || p[1] != ' ') return -1;
  unsigned long long ticks = 0, ppid = 0;
  unsigned field = 3;
  for (char *word = strtok_r(p + 2, " ", &save); word; word = strtok_r(NULL, " ", &save), field++) {
    if (field == 3 && (word[0] == 'Z' || word[0] == 'X')) return -1;
    if (field == 4 && number(word, &ppid)) return -1;
    if (field == 22) { if (number(word, &ticks)) return -1; break; }
  }
  return ticks == expected && ppid == (unsigned long long)parent ? 0 : -1;
}
int main(int argc, char **argv) {
  if (geteuid() != 0) return 2;
  if (argc == 5 && !strcmp(argv[1], "--kill-original-guardian")) {
    unsigned long long p, ticks, parent;
    if (number(argv[2], &p) || number(argv[3], &ticks) || number(argv[4], &parent)
        || p <= 1 || p > INT_MAX || !ticks || parent <= 1 || parent > INT_MAX) return 2;
    int fd = (int)syscall(SYS_pidfd_open, (pid_t)p, 0);
    if (fd < 0) return 3;
    /* Open pidfd BEFORE checking birth. Numeric PID reuse cannot redirect it. */
    if (birth((pid_t)p, ticks, (pid_t)parent)
        || syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0)) { close(fd); return 3; }
    close(fd);
  } else if (argc == 5 && !strcmp(argv[1], "--change-original-cgroup-pids")) {
    unsigned long long device, inode;
    struct stat stat;
    struct statfs filesystem;
    if (argv[2][0] != '/' || number(argv[3], &device) || number(argv[4], &inode)) return 2;
    int directory = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) return 3;
    if (fstat(directory, &stat) || fstatfs(directory, &filesystem) || stat.st_uid != 0
        || (unsigned long long)stat.st_dev != device || (unsigned long long)stat.st_ino != inode
        || filesystem.f_type != CGROUP2_SUPER_MAGIC) { close(directory); return 3; }
    int control = openat(directory, "pids.max", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    close(directory);
    if (control < 0) return 3;
    char old[32];
    ssize_t count = read(control, old, sizeof(old) - 1);
    if (count != 3 || memcmp(old, "24\n", 3) || lseek(control, 0, SEEK_SET) < 0
        || write(control, "23\n", 3) != 3) { close(control); return 3; }
    close(control);
    /* Lower the already qualified test cgroup's actual kernel control. Never
     * creates/delegates a cgroup, moves a process, raises limits or grants caps. */
  } else if (argc == 2 && !strcmp(argv[1], "--step-isolated-realtime")) {
    const char *isolation = getenv("FINNOR_EXPLICIT_ISOLATED_CLOCK_FAULT");
    struct timespec now;
    if (!isolation || strcmp(isolation, "EXTERNALLY_AUTHORIZED_TEST_ONLY")
        || clock_gettime(CLOCK_REALTIME, &now)) return 2;
    /* Existing CAP_SYS_TIME is required. EPERM is unqualified, never a grant. */
    now.tv_sec += 1;
    if (clock_settime(CLOCK_REALTIME, &now)) return 3;
  } else return 2;
  if (fputs("{\"status\":\"ACTUAL_FAULT_APPLIED\"}\n", stdout) == EOF || fflush(stdout)) return 3;
  return 0;
}
