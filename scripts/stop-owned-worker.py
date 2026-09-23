import os
import select
import signal
import sys


pid = int(sys.argv[1])
start_token = sys.argv[2]
config_path = os.fsencode(sys.argv[3])

process_fd = os.pidfd_open(pid)
try:
    with open(f"/proc/{pid}/stat", "rb") as stat:
        fields = stat.read().rsplit(b")", 1)[1].split()
    with open(f"/proc/{pid}/cmdline", "rb") as cmdline:
        args = cmdline.read().split(b"\0")
    exited = select.poll()
    exited.register(process_fd, select.POLLIN)
    if fields[19] != start_token.encode() or not any(
        args[index : index + 2] == [b"--pions-worker-config", config_path]
        for index in range(len(args) - 1)
    ) or exited.poll(0):
        raise SystemExit("owned Worker process identity changed")
    signal.pidfd_send_signal(process_fd, signal.SIGKILL)
finally:
    os.close(process_fd)
