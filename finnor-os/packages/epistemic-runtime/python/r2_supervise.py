#!/usr/bin/env python3
"""Physical one-child grant, original deadline, bounded output, orphan cleanup.

The durable owner owns the shared lease and retains this receipt. A missing
receipt after process death remains UNKNOWN; expiry does not assert zero cost.
"""
import ctypes
import json
import math
import os
import resource
import signal
import subprocess
import sys
import time

config = json.load(sys.stdin)
started = time.monotonic()
parent = os.getppid()
deadline = config['deadlineAtMs']/1000
maximum = config['outputBytes']
memory = config['memoryMiB']*1024*1024
cpu_seconds = max(1, math.ceil(config['cpuMs']/1000))
child = None
reason = None
peak = 0
aggregate_peak = 0
group_drained = False


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Node needs a large virtual reservation; observed resident memory is
    # independently bounded below. Linux native calls also get RLIMIT_AS.
    if sys.platform.startswith('linux') and not config.get('node', False):
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    if sys.platform.startswith('linux'):
        libc = ctypes.CDLL(None)
        libc.prctl(1, signal.SIGKILL)


def stop(sig=signal.SIGKILL):
    if child is not None:
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Darwin may refuse a signal to an already exited group. This
            # proves nothing about descendants: the independent group census
            # below must still observe release before a receipt can pass.
            if child.poll() is None:
                raise


def cancelled(signum, frame):
    global reason
    reason = 'CANCELLED'
    stop()


signal.signal(signal.SIGTERM, cancelled)
signal.signal(signal.SIGINT, cancelled)
try:
    with open(config['stdoutPath'], 'xb') as stdout, open(config['stderrPath'], 'xb') as stderr:
        # Node maps the trusted filter to descriptor 3 in this supervisor.
        # Preserve only that descriptor until bubblewrap consumes it; all
        # scientific/non-isolated children retain their three-descriptor ABI.
        seccomp_fd = config.get('seccompFd')
        if seccomp_fd is not None and (sys.platform != 'linux' or seccomp_fd != 3):
            raise ValueError('PHYSICAL_SECCOMP_DESCRIPTOR_INVALID')
        child = subprocess.Popen(config['argv'], cwd=config['cwd'], env=config['env'], stdin=subprocess.PIPE,
                                 stdout=stdout, stderr=stderr, start_new_session=True, preexec_fn=limits,
                                 pass_fds=() if seccomp_fd is None else (seccomp_fd,))
        # Input transfer must not block the deadline/orphan guardian if a
        # checker is stopped before draining its pipe.
        pending_input = memoryview(config.get('input', '').encode())
        input_offset = 0
        os.set_blocking(child.stdin.fileno(), False)
        if not pending_input:
            child.stdin.close()
        while child.poll() is None:
            if reason or time.time() >= deadline:
                reason = reason or 'ORIGINAL_DEADLINE'
                stop()
            elif os.getppid() != parent:
                reason = 'OWNER_PROCESS_DIED'
                stop()
            if input_offset < len(pending_input) and child.poll() is None:
                try:
                    input_offset += os.write(child.stdin.fileno(), pending_input[input_offset:input_offset+65536])
                    if input_offset == len(pending_input):
                        child.stdin.close()
                except BlockingIOError:
                    pass
                except BrokenPipeError:
                    child.stdin.close()
                    input_offset = len(pending_input)
            # Include the real owner process, supervisor, native child and all
            # descendants (including tsx/esbuild helpers and this ps sample).
            stat = subprocess.run(['/bin/ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss=', '-o', 'time='], capture_output=True,
                                  text=True, timeout=1, env={'PATH': '/usr/bin:/bin'})
            rows = [line.split() for line in stat.stdout.splitlines() if len(line.split()) == 4]
            require_owner = any(int(row[0]) == parent for row in rows)
            if not require_owner:
                reason = 'OWNER_PROCESS_DIED'
                stop()
            family = {parent}
            while True:
                extended = family | {int(row[0]) for row in rows if int(row[1]) in family}
                if extended == family:
                    break
                if len(extended) > 1024:
                    raise ValueError('PHYSICAL_FAMILY_ACCOUNTING_BOUND')
                family = extended
            child_row = next((row for row in rows if int(row[0]) == child.pid), None)
            observed = int(child_row[2] if child_row else '0')*1024
            clock = child_row[3] if child_row else '0:00.00'
            parts = clock.split(':')
            observed_cpu = sum(float(value)*60**i for i, value in enumerate(reversed(parts)))*1000
            if observed_cpu >= config['cpuMs']:
                reason = 'PHYSICAL_CPU_GRANT'
                stop()
            peak = max(peak, observed)
            aggregate = sum(int(row[2])*1024 for row in rows if int(row[0]) in family) + config.get('upstreamMemoryReservationBytes', 0)
            aggregate_peak = max(aggregate_peak, aggregate)
            if aggregate > memory:
                reason = 'PHYSICAL_MEMORY_GRANT'
                stop()
            if os.fstat(stdout.fileno()).st_size > maximum or os.fstat(stderr.fileno()).st_size > maximum:
                reason = 'OUTPUT_GRANT'
                stop()
            time.sleep(0.02)
        code = child.wait()
finally:
    stop()
    if child is not None:
        child.wait()
        # A Node producer may leave a helper after its main process exits.
        # Kill the owned group even then, and observe release before the receipt.
        cleanup_until = time.monotonic()+0.5
        while True:
            if sys.platform.startswith('linux'):
                try:
                    while os.waitpid(-1, os.WNOHANG)[0]:
                        pass
                except ChildProcessError:
                    pass
            scan = subprocess.run(['/bin/ps', '-A', '-o', 'pgid=', '-o', 'stat='], capture_output=True,
                                  text=True, timeout=1, env={'PATH': '/usr/bin:/bin'})
            active = [row for line in scan.stdout.splitlines() if len(row := line.split()) == 2 and
                      int(row[0]) == child.pid and not row[1].startswith('Z')]
            if not active:
                group_drained = True
                break
            if time.monotonic() >= cleanup_until:
                reason = 'PHYSICAL_GROUP_RELEASE_UNOBSERVED'
                break
            stop()
            time.sleep(0.02)
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    supervisor = resource.getrusage(resource.RUSAGE_SELF)
    receipt = {'schema': 'finnor.r2.physical-child.v1', 'pid': None if child is None else child.pid,
               'exitCode': None if child is None else child.returncode, 'termination': reason or 'EXITED',
               'physicalExitObserved': child is not None and child.poll() is not None and group_drained,
               'processGroupDrained': group_drained,
               'wallMs': (time.monotonic()-started)*1000,
               'cpuMs': (usage.ru_utime+usage.ru_stime+supervisor.ru_utime+supervisor.ru_stime)*1000,
               'peakMemoryBytes': max(peak, int(usage.ru_maxrss*(1 if sys.platform == 'darwin' else 1024))),
               'aggregatePeakMemoryBytes': aggregate_peak,
               'memoryAccountingScope': 'OWNER_AND_DESCENDANT_PROCESS_RSS_PLUS_ORIGINAL_API_ADMISSION_RESERVATION',
               'upstreamMemoryReservationBytes': config.get('upstreamMemoryReservationBytes', 0),
               'originalDeadlineAtMs': config['deadlineAtMs'], 'cpuReservationMs': config['cpuMs'],
               'memoryReservationMiB': config['memoryMiB'], 'money': None, 'moneyStatus': 'UNMETERED',
               'accountingScope': 'CHILD_PLUS_SUPERVISOR_AND_PS_CHILDREN_RUSAGE_ONCE',
               'samplingQualification': '20MS_RSS_CPU_BACKSTOP_WITH_CHILD_RUSAGE_PEAK; OS_SCHEDULING_OVERSHOOT_RETAINED'}
    with open(config['receiptPath'], 'x', encoding='utf8') as output:
        json.dump(receipt, output, separators=(',', ':'))
    print(json.dumps(receipt, separators=(',', ':')))
