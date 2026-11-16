// Best-effort push so a freshly queued command is claimed by the sidecar
// immediately, instead of waiting on its POLL_INTERVAL_MS poll tick (see
// /poll-now in startVncRefreshServer, sidecar/src/poll.js). Never let a
// kick failure fail the caller -- the 60s poll covers that.
export function kickSidecarPoll(): void {
  fetch('http://127.0.0.1:6081/poll-now', {
    method: 'POST',
    headers: { 'X-Sidecar-Secret': process.env.SIDECAR_SHARED_SECRET ?? '' },
  }).catch(() => {});
}
