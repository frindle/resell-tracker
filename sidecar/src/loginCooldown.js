'use strict';

const fs = require('fs');
const path = require('path');

/* ── helpers ─────────────────────────────────────────────── */

function stateFilePath() {
  return path.join(process.env.DATA_DIR || '/data', 'login-cooldown.json');
}

/** Load the entire cooldown-state object from disk. Returns {} on missing / corrupt files. */
function loadState() {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

/** Write state atomically: write a temp file in the same dir then rename. */
function saveState(state) {
  try {
    const filePath = stateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_) {}
  const tmpPath = stateFilePath() + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state));
  fs.renameSync(tmpPath, stateFilePath());
}

/* ── recordThrottle internals (shared) ───────────────────── */

function computeAndSetThrottle(state, site, now) {
  if (!state[site]) state[site] = {};
  const entry = state[site];
  entry.throttleCount = (entry.throttleCount || 0) + 1;

  var base = Number(process.env.LOGIN_THROTTLE_COOLDOWN_MIN) || 45;
  var max  = Number(process.env.LOGIN_THROTTLE_MAX_COOLDOWN_MIN) || 240;
  const durationMin = Math.min(base * (Math.pow(2, entry.throttleCount - 1)), max);

  entry.throttleUntil = now + durationMin * 60 * 1000;
}

/* ── exported API ─────────────────────────────────────── */

/** recordThrottle(site, {now?, status?}) -> {until, count}. */
function recordThrottle(site, opts) {
  if (!opts || typeof opts.now !== 'number') opts = {};
  const now   = (typeof opts.now === 'number') ? opts.now : Date.now();
  const status = (opts.status != null) ? opts.status : 429;

  var state = loadState();
  computeAndSetThrottle(state, site, now);
  state[site].reason   = 'throttle';
  state[site].status   = status;
  saveState(state);

  return { until: state[site].throttleUntil, count: state[site].throttleCount };
}

/** recordIdleTimeout(site, {now?}) -> null | {until, count}. */
function recordIdleTimeout(site, opts) {
  if (!opts || typeof opts.now !== 'number') opts = {};
  const now = (typeof opts.now === 'number') ? opts.now : Date.now();

  var state = loadState();
  if (!state[site]) state[site] = {};
  const entry = state[site];

  // increment idleCount (start from persisted or 0)
  entry.idleCount = (entry.hasOwnProperty('idleCount') ? entry.idleCount : 0) + 1;

  if (entry.idleCount >= 2) {
    computeAndSetThrottle(state, site, now);
    state[site].reason = 'idle';
    saveState(state);
    return { until: state[site].throttleUntil, count: entry.idleCount };
  }

  // first idle timeout (count == 1): just persist and return null
  delete state[site].reason;        // ensure no stale reason from a prior throttle
  saveState(state);
  return null;
}

/** recordActiveTimeout(site) -> void. Resets idleCount to 0, persists. */
function recordActiveTimeout(site) {
  var state = loadState();
  if (!state[site]) return;         // do not create an empty entry for a new site
  state[site].idleCount = 0;        // reset counter (create property even if absent)
  saveState(state);
}

/** recordPreempt(site, {now?}) -> {until}. */
function recordPreempt(site, opts) {
  if (!opts || typeof opts.now !== 'number') opts = {};
  const now   = (typeof opts.now === 'number') ? opts.now : Date.now();
  var preemptMin = Number(process.env.LOGIN_PREEMPT_COOLDOWN_MIN) || 5;

  var state = loadState();
  if (!state[site]) state[site] = {};
  const entry = state[site];
  entry.preemptUntil = now + preemptMin * 60 * 1000;
  saveState(state);

  return { until: entry.preemptUntil };
}

/** getCooldown(site, [now]) -> null | {until, message, reason}. */
function getCooldown(site) {
  const argsLen = arguments.length;
  let now;
  if (argsLen >= 2 && typeof arguments[1] === 'number') {
    now = arguments[1];
  } else {
    now = Date.now();
  }

  var state = loadState();
  const entry = state[site];
  if (!entry) return null;

  // max of throttleUntil and preemptUntil (if either exists)
  let untilVal = -Infinity;
  let reason   = '';
  let status   = undefined;

  if (typeof entry.throttleUntil === 'number' && entry.throttleUntil > now) {
    untilVal = Math.max(untilVal, entry.throttleUntil);
    reason = entry.reason || 'throttle';
    status = entry.status;
  }
  if (typeof entry.preemptUntil === 'number' && entry.preemptUntil > now) {
    // preempt wins on tie? The spec says "pick the message of whichever cooldown supplies the max until"
    const pVal = entry.preemptUntil;
    if (!entry.hasOwnProperty('throttleUntil') || pVal >= (entry.throttleUntil || -Infinity)) {
      untilVal = Math.max(untilVal, pVal);
      reason   = 'preempt';
    } else {
      // throttle already has a higher or equal value; keep it unless preempt is strictly greater? 
      // Actually the spec says max(throttleUntil, preemptUntil) <= now -> null. Otherwise use the max.
      if (pVal > untilVal || !entry.hasOwnProperty('throttleUntil')) {
        untilVal = pVal;
        reason   = 'preempt';
      } else {
        // throttle is higher or equal — keep throttle's info, unless preempt provides a strictly greater value
        if (!hasOwnProperty(entry, 'reason') && typeof entry.reason === 'string' || true) {} 
        // Keep the existing (higher-or-equal) reason from throttle
      }
    }
  }

  /* Simplify: just find whichever is max */
  let tUntil = (typeof entry.throttleUntil === 'number') ? entry.throttleUntil : -Infinity;
  let pUntil = (typeof entry.preemptUntil === 'number') ? entry.preemptUntil : -Infinity;
  
  if (tUntil <= now && pUntil <= now) return null;

  const maxUntil = Math.max(tUntil, pUntil);
  
  // determine reason based on which supplied the max
  let messageReason;
  if (pUntil >= tUntil || !entry.hasOwnProperty('throttleUntil')) {
    /* preempt is equal or greater — use its info */
    messageReason = 'preempt';
  } else {
    /* throttle wins */
    messageReason = entry.reason || 'throttle';
  }

  const dateObj       = new Date(maxUntil);
  const hhmm          = ('0' + (dateObj.getHours() < 10 ? '0' : '')).slice(-2) 
                      + ':' + String(dateObj.getMinutes()).padStart(2, '0');

  let message;
  if (messageReason === 'preempt') {
    message = site + ' login window closed for a sync, retry after ' + hhmm;
  } else if (messageReason === 'idle') {
    message = site + ' login window timed out with no activity, retry after ' + hhmm;
  } else {
    /* throttle */
    const st = entry.status != null ? String(entry.status) : '';
    message   = site + ' throttled by sign-in service (' + st + '), retry after ' + hhmm;
  }

  return { until: maxUntil, message: message, reason: messageReason };
}

/** clearCooldown(site) -> void. Deletes the entire entry for a site and persists. */
function clearCooldown(site) {
  var state = loadState();
  delete state[site];
  saveState(state);
}

/* ── preempt-request helpers (per-site files, NEVER touch login-cooldown.json) ─── */

/** requestPreempt(site, {now?}) -> writes per-site request file. */
function requestPreempt(site, opts) {
  if (!opts || typeof opts.now !== 'number') opts = {};
  const now   = (typeof opts.now === 'number') ? opts.now : Date.now();

  try {
    fs.mkdirSync(process.env.DATA_DIR || '/data', { recursive: true });
  } catch (_) {}
  const filePath = preemptRequestFile(site);
  // write atomically within same dir
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify({ requestedAt: now }));
  try { fs.renameSync(tmpPath, filePath); } catch (_) {}
}

/** isPreemptRequested(site, [now]) -> boolean. */
function isPreemptRequested(site) {
  const argsLen = arguments.length;
  let now;
  if (argsLen >= 2 && typeof arguments[1] === 'number') {
    now = arguments[1];
  } else {
    now = Date.now();
  }

  try {
    const filePath   = preemptRequestFile(site);
    const raw        = fs.readFileSync(filePath, 'utf8');
    const parsed     = JSON.parse(raw);
    if (typeof parsed.requestedAt !== 'number') return false;
    return now - parsed.requestedAt >= 0 && now - parsed.requestedAt <= 60 * 1000;
  } catch (_) {
    return false;
  }
}

/** clearPreemptRequest(site) -> void. Removes the request file, ignoring ENOENT. */
function clearPreemptRequest(site) {
  try { fs.unlinkSync(preemptRequestFile(site)); } catch (e) {}
}

/* ── exports ─────────────────────────────────────────────── */

module.exports = {
  recordThrottle:       recordThrottle,
  recordIdleTimeout:    recordIdleTimeout,
  recordActiveTimeout:  recordActiveTimeout,
  recordPreempt:        recordPreempt,
  getCooldown:          getCooldown,
  clearCooldown:        clearCooldown,
  requestPreempt:       requestPreempt,
  isPreemptRequested:   isPreemptRequested,
  clearPreemptRequest:  clearPreemptRequest,
};

/* ── private helper (used internally) ─────────────────────── */
function preemptRequestFile(site) {
  return path.join(process.env.DATA_DIR || '/data', 'login-preempt-' + site + '.json');
}
