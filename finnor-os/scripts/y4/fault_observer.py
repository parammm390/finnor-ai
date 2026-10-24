"""Fault injection restricted to native descendants of this E2E invocation."""
import ctypes
import errno
import os
import signal
import time
from pathlib import Path


def descendants(parent):
    pending, found = [parent], set()
    while pending:
        current = pending.pop()
        try:
            children = (Path("/proc") / str(current) / "task" / str(current) / "children").read_text()
        except FileNotFoundError:
            continue
        for child in map(int, children.split()):
            if child not in found:
                found.add(child)
                pending.append(child)
    return found


def native_descendants(parent, backend, states, session):
    found = {}
    executable = str(backend.resolve() / "mascot-party.x")
    for pid in descendants(parent):
        proc = Path("/proc") / str(pid)
        try:
            argv = proc.joinpath("cmdline").read_bytes().decode().rstrip("\0").split("\0")
            if executable not in argv or "-p" not in argv:
                continue
            player = int(argv[argv.index("-p") + 1])
            if player < 0 or player >= len(states) or player in found:
                raise ValueError("FAULT_TARGET_INVALID_OR_DUPLICATE_PLAYER")
            expected = states[player].resolve() / "sessions" / session
            if proc.joinpath("cwd").resolve(strict=True) != expected or os.getpgid(pid) != pid:
                raise ValueError("FAULT_TARGET_NOT_OWN_SESSION")
            found[player] = pid
        except (FileNotFoundError, ProcessLookupError):
            continue
    return found


def signal_native(parent, backend, states, session, player, expected, sig):
    if native_descendants(parent, backend, states, session).get(player) != expected:
        raise ValueError("FAULT_TARGET_CHANGED")
    descriptor = os.pidfd_open(expected)
    try:
        if native_descendants(parent, backend, states, session).get(player) != expected:
            raise ValueError("FAULT_TARGET_CHANGED")
        signal.pidfd_send_signal(descriptor, sig)
    finally:
        os.close(descriptor)


class Registers(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "r15", "r14", "r13", "r12", "rbp", "rbx", "r11", "r10", "r9", "r8",
        "rax", "rcx", "rdx", "rsi", "rdi", "orig_rax", "rip", "cs", "eflags",
        "rsp", "ss", "fs_base", "gs_base", "ds", "es", "fs", "gs")]


def corrupt_tls_record(pid, until, owns_pid):
    """Alter ciphertext, not plaintext or keys, on an owned native socket."""
    if os.uname().machine != "x86_64":
        raise ValueError("FAULT_OBSERVER_REQUIRES_PINNED_X86_64_HOST")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.ptrace.restype = ctypes.c_long
    libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]

    def trace(operation, tid, address=0, data=0):
        ctypes.set_errno(0)
        result = libc.ptrace(operation, tid, address, data)
        error = ctypes.get_errno()
        if result == -1 and error:
            raise OSError(error, "OWN_NATIVE_TRACE_REFUSED")
        return result

    def stopped_before(tid, limit):
        while time.monotonic() < limit:
            observed, status = os.waitpid(tid, os.WNOHANG | 0x40000000)
            if observed:
                if os.WIFSTOPPED(status):
                    return status
                return None
            time.sleep(0.002)
        raise TimeoutError("NATIVE_TRACE_STOP_NOT_OBSERVED")

    descriptor = os.pidfd_open(pid)
    attached, observed_threads = {}, set()
    try:
        while time.monotonic() < until:
            if not owns_pid():
                raise ValueError("FAULT_TARGET_CHANGED")
            # MP-SPDZ delegates TLS sends to its own Sender threads. Observe
            # only this verified process's task directory, not other PIDs.
            for task in (Path("/proc") / str(pid) / "task").iterdir():
                tid = int(task.name)
                if tid in attached:
                    continue
                if not owns_pid():
                    raise ValueError("FAULT_TARGET_CHANGED")
                try:
                    trace(0x4206, tid, 0, 1)  # SEIZE / TRACESYSGOOD, no policy change.
                    attached[tid] = False
                    observed_threads.add(tid)
                    trace(0x4207, tid)  # INTERRUPT, not a persistent group SIGSTOP.
                except OSError as error:
                    if error.errno != errno.ESRCH:
                        raise
                    attached.pop(tid, None)
            for tid in list(attached):
                try:
                    observed, status = os.waitpid(tid, os.WNOHANG | 0x40000000)
                except ChildProcessError:
                    attached.pop(tid, None)
                    continue
                if not observed:
                    continue
                if not os.WIFSTOPPED(status):
                    attached.pop(tid, None)
                    continue
                attached[tid] = True
                sig = os.WSTOPSIG(status)
                if sig == signal.SIGTRAP | 0x80:
                    registers = Registers()
                    trace(12, tid, 0, ctypes.byref(registers))
                else:
                    registers = None
                if registers is not None and registers.rax == 2 ** 64 - 38 \
                        and registers.orig_rax in (1, 44) and registers.rdx >= 8:
                    try:
                        socket_name = os.readlink(f"/proc/{pid}/task/{tid}/fd/{registers.rdi}")
                    except FileNotFoundError:
                        socket_name = ""
                    if socket_name.startswith("socket:["):
                        word = trace(2, tid, registers.rsi) & (2 ** 64 - 1)
                        # TLS application-data record header followed by
                        # encrypted bytes. Do not corrupt a plaintext record.
                        if word & 0xffffff == 0x030317 and ((word >> 24) & 0xffff) != 0:
                            trace(5, tid, registers.rsi, word ^ (1 << 40))
                            return {"injected": True, "target": "OWN_NATIVE_TLS_CIPHERTEXT_RECORD",
                                    "tracedOwnedNativeThreads": len(observed_threads),
                                    "privatePlaintextOrKeysRead": False, "securityPolicyChanged": False}
                trace(24, tid, 0, 0 if sig in (signal.SIGTRAP | 0x80, signal.SIGSTOP, signal.SIGTRAP) else sig)
                attached[tid] = False
            time.sleep(0.002)
        raise TimeoutError("LIVE_NATIVE_TLS_WRITE_NOT_OBSERVED")
    finally:
        cleanup_errors = []
        try:
            for tid, stopped in attached.items():
                try:
                    if not stopped:
                        trace(0x4207, tid)
                        if stopped_before(tid, time.monotonic() + 3) is None:
                            continue
                    trace(17, tid)
                except (ProcessLookupError, ChildProcessError):
                    pass
                except BaseException as error:
                    cleanup_errors.append(type(error).__name__)
        finally:
            os.close(descriptor)
        if cleanup_errors:
            raise ValueError("OWN_NATIVE_TRACE_CLEANUP_UNPASSED")


def inject(child, kind, backend, states, session, original_deadline):
    until = min(original_deadline, time.monotonic() + 600)
    try:
        while time.monotonic() < until and child.poll() is None:
            native = native_descendants(child.pid, backend, states, session)
            if len(native) == len(states):
                time.sleep(0.1)
                native = native_descendants(child.pid, backend, states, session)
                if len(native) != len(states):
                    continue
                observed = list(native.values())
                if kind == "dropout":
                    signal_native(child.pid, backend, states, session, 1, native[1], signal.SIGKILL)
                    fault = {"injected": True, "target": "OWN_NATIVE_PARTICIPANT_DROPOUT"}
                elif kind == "message":
                    fault = corrupt_tls_record(native[1], min(until, time.monotonic() + 45),
                        lambda: native_descendants(child.pid, backend, states, session).get(1) == native[1])
                elif kind == "cancel":
                    child.terminate()
                    fault = {"injected": True, "target": "OWN_COORDINATOR_PHYSICAL_CANCEL"}
                else:
                    raise ValueError("UNKNOWN_NATIVE_FAULT")
                return fault, observed
            time.sleep(0.05)
        raise TimeoutError("FAULT_DID_NOT_REACH_ALL_NATIVE_PARTICIPANTS")
    except BaseException:
        if child.poll() is None:
            child.terminate()
        raise
