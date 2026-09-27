import os
import select
import signal
import sys


prompt = os.fsencode("@" + sys.argv[1])
extension = os.fsencode(sys.argv[2])
candidates = []
for name in os.listdir("/proc"):
    if not name.isdecimal():
        continue
    pid = int(name)
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as source:
            args = source.read().split(b"\0")
        if not (prompt in args and extension in args and b"--no-session" in args):
            continue
        with open(f"/proc/{pid}/stat", "rb") as source:
            token = source.read().rsplit(b")", 1)[1].split()[19]
        candidates.append((pid, token))
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue

if len(candidates) != 1:
    raise SystemExit(f"expected exactly one owned Pi parent, found {len(candidates)}")

pid, token = candidates[0]
process_fd = os.pidfd_open(pid)
try:
    with open(f"/proc/{pid}/cmdline", "rb") as source:
        args = source.read().split(b"\0")
    with open(f"/proc/{pid}/stat", "rb") as source:
        observed = source.read().rsplit(b")", 1)[1].split()[19]
    exited = select.poll()
    exited.register(process_fd, select.POLLIN)
    if (
        prompt not in args
        or extension not in args
        or b"--no-session" not in args
        or token != observed
        or exited.poll(0)
    ):
        raise SystemExit("owned Pi parent process identity changed")
    signal.pidfd_send_signal(process_fd, signal.SIGKILL)
    if not exited.poll(5_000):
        raise SystemExit("owned Pi parent stop was not confirmed")
finally:
    os.close(process_fd)
