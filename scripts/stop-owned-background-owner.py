import os
import select
import signal
import sys


entry = os.fsencode(sys.argv[1])
request = os.fsencode(sys.argv[2])
candidates = []
for name in os.listdir("/proc"):
    if not name.isdecimal():
        continue
    pid = int(name)
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as source:
            args = source.read().split(b"\0")
        if len(args) >= 3 and args[1:3] == [entry, request]:
            with open(f"/proc/{pid}/stat", "rb") as source:
                token = source.read().rsplit(b")", 1)[1].split()[19]
            candidates.append((pid, token))
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue

if len(candidates) != 1:
    raise SystemExit(f"expected exactly one owned background process, found {len(candidates)}")

pid, token = candidates[0]
process_fd = os.pidfd_open(pid)
try:
    with open(f"/proc/{pid}/cmdline", "rb") as source:
        args = source.read().split(b"\0")
    with open(f"/proc/{pid}/stat", "rb") as source:
        observed = source.read().rsplit(b")", 1)[1].split()[19]
    exited = select.poll()
    exited.register(process_fd, select.POLLIN)
    if args[1:3] != [entry, request] or token != observed or exited.poll(0):
        raise SystemExit("background owner process identity changed")
    signal.pidfd_send_signal(process_fd, signal.SIGKILL)
    if not exited.poll(5_000):
        raise SystemExit("background owner stop was not confirmed")
finally:
    os.close(process_fd)
