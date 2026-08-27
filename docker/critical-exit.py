#!/usr/bin/env python3
"""supervisord event listener: take the container down when a program that
must never die keeps dying.

supervisord on its own will happily sit there `nodaemon`-ing forever with the
Next.js app in FATAL, which from the outside looks like a healthy container
serving nothing. Docker's `restart: unless-stopped` only helps if the
container actually EXITS, and non-zero so the failure is visible in
`docker ps -a` / `docker events` rather than looking like a clean stop.

Semantics of "keeps dying", which are supervisord's and are exactly right
here: a program only reaches FATAL after failing to STAY UP for `startsecs`,
`startretries` times in a row. A process that runs for hours and then crashes
once is restarted and its retry counter resets -- that never triggers this.

Programs are opted in via CRITICAL_PROGRAMS (whitespace-separated) in the
environment. Anything not listed is left to supervisord's own retry policy;
in particular giftcard-ocr is NOT critical -- it ships dormant
(GIFTCARD_OCR_ENABLED=false) and must never be able to take the dashboard
down with it.
"""

import os
import signal
import sys
import time

from supervisor import childutils

CRITICAL = set(os.environ.get("CRITICAL_PROGRAMS", "app xvfb").split())
GRACE_SECONDS = float(os.environ.get("CRITICAL_EXIT_GRACE", "10"))
SELF = os.environ.get("SUPERVISOR_PROCESS_NAME", "critical-exit")

# supervisord's stdout is this listener's event protocol channel, so all of
# our own output has to go to stderr -- which supervisord is configured to
# point at the container's stderr, so it lands in `docker logs`.
def log(msg):
    sys.stderr.write("[critical-exit] %s\n" % msg)
    sys.stderr.flush()


def bring_down(name):
    log("PROGRAM %r REACHED FATAL -- it failed to stay up through every "
        "start retry. Taking the container down so Docker restarts it." % name)

    # Best-effort graceful stop of everything else first, so the app gets to
    # close its SQLite handles and Chrome gets a chance to exit, rather than
    # being torn down with the namespace. Fired non-blocking (wait=False) for
    # every program at once, then one flat grace window -- serialising a
    # blocking stop per program could take stopwaitsecs * N.
    try:
        rpc = childutils.getRPCInterface(os.environ)
        for info in rpc.supervisor.getAllProcessInfo():
            pname = info.get("name")
            # Never ask supervisord to stop US: it would SIGTERM this process
            # before it gets to the kill below.
            if pname == SELF:
                continue
            try:
                rpc.supervisor.stopProcess(pname, False)
            except Exception as exc:  # already stopped, or racing us
                log("stopProcess(%r) ignored: %s" % (pname, exc))
        time.sleep(GRACE_SECONDS)
    except Exception as exc:
        log("graceful stop failed (%s) -- killing supervisord anyway" % exc)

    # SIGKILL, not SIGTERM. supervisord exits 0 on a normal shutdown, and a
    # zero exit code is indistinguishable from `docker stop`. Killing PID 1
    # makes the container exit 137, which is unambiguously a failure in
    # `docker ps -a`, `docker inspect .State.ExitCode` and `docker events`.
    ppid = os.getppid()
    log("SIGKILL -> supervisord (pid %d); container will exit 137" % ppid)
    os.kill(ppid, signal.SIGKILL)
    # If supervisord somehow survives, do not keep processing events.
    time.sleep(30)
    os._exit(1)


def main():
    # If the graceful pass above ever does reach us, do not die mid-shutdown.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    log("watching for FATAL on: %s" % (", ".join(sorted(CRITICAL)) or "(nothing)"))

    while True:
        headers, payload = childutils.listener.wait(sys.stdin, sys.stdout)
        try:
            if headers.get("eventname") == "PROCESS_STATE_FATAL":
                pheaders = childutils.get_headers(payload)
                name = pheaders.get("processname", "")
                if name in CRITICAL:
                    bring_down(name)
                else:
                    log("%r reached FATAL but is not critical -- leaving the "
                        "container up" % name)
        finally:
            childutils.listener.ok(sys.stdout)


if __name__ == "__main__":
    main()
