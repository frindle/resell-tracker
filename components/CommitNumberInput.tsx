'use client';

import { useEffect, useState } from 'react';

// Number input that keeps its own draft string while focused and only commits
// on blur or Enter.
//
// Why not `<input type="number" value={n} onChange={e => set(parseInt(e.target.value) || 1)}>`:
// that coerces the empty string back to a number on every keystroke, so
// selecting the sole digit and deleting it (or backspacing it) instantly
// snaps the field back to "1" and stomps the caret — the user has to type the
// new digit FIRST and delete the old one after. Holding the raw string lets
// the field legitimately be empty mid-edit; coercion happens once, at commit.
//
// Also stops the parent list from re-rendering on every keystroke, which
// makes long lists jump under the cursor.
export default function CommitNumberInput({
  value, onCommit, className, placeholder, step, min, integer, title,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  className?: string;
  placeholder?: string;
  step?: string;
  min?: number;
  integer?: boolean;
  title?: string;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [focused, setFocused] = useState(false);
  // Sync external changes in only while not actively editing.
  useEffect(() => { if (!focused) setDraft(value == null ? '' : String(value)); }, [value, focused]);
  function commit() {
    const raw = draft.trim() === '' ? null : parseFloat(draft);
    if (raw == null || isNaN(raw)) { onCommit(null); return; }
    const rounded = integer ? Math.round(raw) : raw;
    onCommit(min != null ? Math.max(min, rounded) : rounded);
  }
  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      onWheel={e => e.currentTarget.blur()}
      className={className}
      placeholder={placeholder}
      step={step}
      min={min}
      title={title}
    />
  );
}
