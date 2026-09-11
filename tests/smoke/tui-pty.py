#!/usr/bin/env python3
"""Run one command with a controlling PTY and proxy bytes to/from stdin/stdout."""

import errno
import os
import pty
import selectors
import signal
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: tui-pty.py COMMAND [ARG ...]", file=sys.stderr)
        return 2

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    def terminate_child(_signum: int, _frame: object) -> None:
        try:
            os.kill(child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, terminate_child)
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.buffer, selectors.EVENT_READ)
    selector.register(master_fd, selectors.EVENT_READ)
    child_status: int | None = None

    try:
        while True:
            waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
            if waited_pid:
                child_status = status
            for key, _ in selector.select(timeout=0.1):
                if key.fileobj is sys.stdin.buffer:
                    data = os.read(sys.stdin.fileno(), 8192)
                    if data:
                        os.write(master_fd, data)
                    else:
                        selector.unregister(sys.stdin.buffer)
                else:
                    try:
                        data = os.read(master_fd, 8192)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b""
                    if not data:
                        selector.unregister(master_fd)
                    else:
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
            if child_status is not None and master_fd not in selector.get_map():
                break
            if master_fd not in selector.get_map() and child_status is None:
                _, child_status = os.waitpid(child_pid, 0)
                break
    finally:
        selector.close()
        try:
            os.close(master_fd)
        except OSError:
            pass

    if os.WIFEXITED(child_status):
        return os.WEXITSTATUS(child_status)
    if os.WIFSIGNALED(child_status):
        return 128 + os.WTERMSIG(child_status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
