import os
import signal
import sys


pid = int(sys.argv[1])
start_token = sys.argv[2]
config_path = os.fsencode(sys.argv[3])

process_fd = os.open(f"/proc/{pid}", os.O_RDONLY | os.O_DIRECTORY)
try:
    with os.fdopen(os.open("stat", os.O_RDONLY, dir_fd=process_fd), "rb") as stat:
        fields = stat.read().rsplit(b")", 1)[1].split()
    with os.fdopen(os.open("cmdline", os.O_RDONLY, dir_fd=process_fd), "rb") as cmdline:
        args = cmdline.read().split(b"\0")
    if fields[19] != start_token.encode() or not any(
        args[index : index + 2] == [b"--pions-worker-config", config_path]
        for index in range(len(args) - 1)
    ):
        raise SystemExit("owned Worker process identity changed")
    signal.pidfd_send_signal(process_fd, signal.SIGKILL)
finally:
    os.close(process_fd)
