'use client';

import { useEffect, useState } from 'react';

// Cross-page persisted toggle for "hide cashback rates" on the deal pages.
// Stored in localStorage so the choice survives reloads + applies across BFMR
// and BuyingGroup deal pages. Listens for both the storage event (other tab)
// and a custom event (same tab) so flipping the toggle on one page re-renders
// any other mounted consumers immediately.
const KEY = 'hide-cashback-rates';
const EVENT = 'hide-cashback-changed';

export function useHideCashback(): [boolean, (v: boolean) => void] {
  const [hide, setHide] = useState(false);

  useEffect(() => {
    setHide(localStorage.getItem(KEY) === '1');
    const onChange = () => setHide(localStorage.getItem(KEY) === '1');
    window.addEventListener('storage', onChange);
    window.addEventListener(EVENT, onChange);
    return () => {
      window.removeEventListener('storage', onChange);
      window.removeEventListener(EVENT, onChange);
    };
  }, []);

  const update = (v: boolean) => {
    localStorage.setItem(KEY, v ? '1' : '0');
    window.dispatchEvent(new Event(EVENT));
    setHide(v);
  };

  return [hide, update];
}
