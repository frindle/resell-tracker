'use client';

import { useEffect } from 'react';

// Defensive Firefox-only guard for password-manager autofill interference.
//
// User-reported behavior: in Firefox, typing a digit in many text/number
// inputs would "replace the last one" instead of appending — e.g. "5" then
// "0" yields "0" not "50". The root cause is password managers (1Password,
// LastPass, Bitwarden) and Firefox's own form autofill aggressively
// hooking inputs and overwriting values mid-keystroke when their heuristics
// decide a field is a "value" they own.
//
// Our React handlers correctly use functional setState (verified — no stale
// closures in the codebase), so the bug is browser-side. The standard
// mitigation is a set of opt-out data attributes that the password
// managers respect:
//
//   autocomplete="off"          (browser autofill)
//   data-1p-ignore              (1Password)
//   data-lpignore               (LastPass)
//   data-form-type="other"      (general hint that this isn't a login form)
//
// We tag every input/textarea on mount + on DOM additions, except for the
// explicit credentials on the login page (we want password managers to
// work there). Firefox-only so Chrome / Safari / mobile behavior is
// unchanged.
export default function FirefoxInputGuard() {
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!/Firefox/i.test(navigator.userAgent)) return;

    function tagInput(el: HTMLInputElement | HTMLTextAreaElement) {
      // Skip explicit credentials so the password manager keeps working on /login.
      if (el instanceof HTMLInputElement && el.type === 'password') return;
      if (el.name === 'email' || el.name === 'username' || el.name === 'password') return;
      // Allow specific inputs to opt OUT of the guard if a future case needs it.
      if (el.dataset.allowPasswordManager === 'true') return;
      // Idempotent — once tagged, skip.
      if (el.dataset.pmGuarded === '1') return;

      el.dataset.pmGuarded = '1';
      if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
      el.setAttribute('data-1p-ignore', 'true');
      el.setAttribute('data-lpignore', 'true');
      if (!el.getAttribute('data-form-type')) el.setAttribute('data-form-type', 'other');
    }

    function scan() {
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(tagInput);
    }

    scan();

    const observer = new MutationObserver(muts => {
      // Cheap pre-check: only re-scan when something that could be an input was added.
      for (const m of muts) {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLElement && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.querySelector?.('input, textarea'))) {
            scan();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
