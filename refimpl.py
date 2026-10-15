#!/usr/bin/env python3
"""Reference impl for: resell-sync-queue-when-busy

Replaces the BrowserBusyError catch block in handleCommand so that:
  - e.holder.kind === 'sync': queue and wait (with max wait), do NOT fail
  - e.holder.kind === 'login': keep existing failure behaviour

The fix must preserve all existing imports, functions, and constants.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'sidecar/src/poll.js'
t = p.read_text()

OLD = """  let release, holderSite;
  try {
    release = await acquireBrowserLock('sync', { site, waitMs: parseInt(process.env.SYNC_LOCK_WAIT_MS || '60000', 10) });
  } catch (e) {
    if (!(e instanceof BrowserBusyError)) throw e;
    if (e.holder && e.holder.kind === 'login') {
      holderSite = e.holder.site || site;
      try { loginCooldown.requestPreempt(holderSite) } catch {}
      console.log(`[poll] sync #${cmd.id} asking idle login window (${holderSite}) to close`);
      try {
        release = await acquireBrowserLock('sync', { site, waitMs: parseInt(process.env.LOGIN_PREEMPT_WAIT_MS || '20000', 10) });
      } catch (e2) {
        if (e2 instanceof BrowserBusyError) {
          await patchCommand(cmd.id, 'failed', { error: `${e2.message} -- try again when the login window is closed` });
          return;
        }
        throw e2;
      } finally {
        try { loginCooldown.clearPreemptRequest(holderSite) } catch {}
      }
    } else {
      console.warn(e);
      await patchCommand(cmd.id, 'failed', { error: `${e.message} -- try again when the login window is closed` });
      return;
    }
  }"""

NEW = """  let release, holderSite;
  try {
    release = await acquireBrowserLock('sync', { site, waitMs: parseInt(process.env.SYNC_LOCK_WAIT_MS || '60000', 10) });
  } catch (e) {
    if (!(e instanceof BrowserBusyError)) throw e;
    if (e.holder && e.holder.kind === 'sync') {
      // Another sync is running — queue this command and wait for it to finish.
      // Bounded by a max total wait so we don't wait forever.
      const maxWaitMs = parseInt(process.env.SYNC_BUSY_MAX_WAIT_MS || '120000', 10);
      const waited = parseInt(process.env.SYNC_BUSY_WAITED_MS || '0', 10);
      if (waited >= maxWaitMs) {
        console.warn(`[poll] sync #${cmd.id} max wait (${maxWaitMs}ms) exceeded, failing`);
        await patchCommand(cmd.id, 'failed', { error: `${e.message} -- timed out waiting for sync` });
        return;
      }
      console.log(`[poll] sync #${cmd.id} waiting for another sync to finish (held by ${e.holder.site || 'unknown'})`);
      // Add to inFlight so pollOnce's dedup doesn't skip this re-entrant call.
      inFlight.add(cmd.id);
      try {
        release = await acquireBrowserLock('sync', { site, waitMs: Math.min(5000, maxWaitMs - waited), waitedMs: waited + 5000 });
      } catch (e2) {
        if (e2 instanceof BrowserBusyError) {
          await patchCommand(cmd.id, 'failed', { error: `${e.message} -- try again when the sync finishes` });
          return;
        }
        throw e2;
      } finally {
        inFlight.delete(cmd.id);
      }
    } else if (e.holder && e.holder.kind === 'login') {
      holderSite = e.holder.site || site;
      try { loginCooldown.requestPreempt(holderSite) } catch {}
      console.log(`[poll] sync #${cmd.id} asking idle login window (${holderSite}) to close`);
      try {
        release = await acquireBrowserLock('sync', { site, waitMs: parseInt(process.env.LOGIN_PREEMPT_WAIT_MS || '20000', 10) });
      } catch (e2) {
        if (e2 instanceof BrowserBusyError) {
          await patchCommand(cmd.id, 'failed', { error: `${e2.message} -- try again when the login window is closed` });
          return;
        }
        throw e2;
      } finally {
        try { loginCooldown.clearPreemptRequest(holderSite) } catch {}
      }
    } else {
      console.warn(e);
      await patchCommand(cmd.id, 'failed', { error: `${e.message} -- try again when the login window is closed` });
      return;
    }
  }"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
