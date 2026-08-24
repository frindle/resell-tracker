'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';

type UploadStatus = { name: string; file: File; state: 'uploading' | 'done' | 'error'; error?: string };

export default function BulkUploadPage() {
  const [uploading, setUploading] = useState(false);
  const [statuses, setStatuses] = useState<UploadStatus[]>([]);
  const [totalDone, setTotalDone] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // One request per file, not one giant multi-file request -- confirmed
  // live 2026-08-24: a single request carrying ~40 real phone photos never
  // completed (stuck on every file's status forever, zero files/DB rows
  // ever landing), almost certainly the tunnel-routed domain's proxy
  // timeout (this codebase already hit the same class of failure once
  // before, see sync-reservations' Cloudflare ~100s comment). Matches the
  // existing per-order OrderAttachments.tsx upload pattern, which already
  // does this correctly.
  //
  // The File object is kept in each status entry so a failed upload can be
  // retried with a tap -- on iOS there's no practical way to find "IMG_3459"
  // in the Photos app to reselect it by hand.
  async function uploadOne(index: number, file: File) {
    setStatuses(prev => prev.map((s, j) => j === index ? { ...s, state: 'uploading' as const, error: undefined } : s));
    try {
      const fd = new FormData();
      fd.append('files', file);
      const res = await fetch('/api/orders/attachments/bulk', { method: 'POST', body: fd });
      if (res.ok) {
        setStatuses(prev => prev.map((s, j) => j === index ? { ...s, state: 'done' as const } : s));
        setTotalDone(prev => prev + 1);
      } else {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        setStatuses(prev => prev.map((s, j) => j === index ? { ...s, state: 'error' as const, error: text } : s));
      }
    } catch (e) {
      setStatuses(prev => prev.map((s, j) => j === index ? { ...s, state: 'error' as const, error: String(e) } : s));
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    const fileList = Array.from(files);
    setStatuses(fileList.map(f => ({ name: f.name, file: f, state: 'uploading' as const })));

    for (let i = 0; i < fileList.length; i++) {
      await uploadOne(i, fileList[i]);
    }

    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function retry(index: number) {
    const entry = statuses[index];
    if (!entry) return;
    setUploading(true);
    await uploadOne(index, entry.file);
    setUploading(false);
  }

  async function retryAllFailed() {
    setUploading(true);
    for (let i = 0; i < statuses.length; i++) {
      if (statuses[i].state === 'error') await uploadOne(i, statuses[i].file);
    }
    setUploading(false);
  }

  const failedCount = statuses.filter(s => s.state === 'error').length;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Bulk Photo Upload</h1>
        <Link href="/orders" className="text-sm text-gray-400 hover:text-white">← Orders</Link>
      </div>

      <p className="text-sm text-gray-400">
        Drop in gift card, receipt, or packaging photos here. They land in an unassigned queue —
        sort them onto specific orders afterward on the{' '}
        <Link href="/orders/sort-assign" className="text-blue-400 hover:underline">sort &amp; assign</Link> page.
      </p>

      <div
        className={`rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          isDragging ? 'border-blue-500 bg-blue-500/5' : 'border-gray-700'
        }`}
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={e => { e.preventDefault(); setIsDragging(false); upload(e.dataTransfer.files); }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,.pdf"
          className="hidden"
          onChange={e => upload(e.target.files)}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-300 px-4 py-2 rounded-md transition-colors"
        >
          {uploading ? 'Uploading…' : 'Choose Photos'}
        </button>
        <p className="text-xs text-gray-500 mt-2">or drag &amp; drop — multiple files at once</p>
      </div>

      {statuses.length > 0 && (
        <div className="space-y-1.5">
          {!uploading && failedCount > 0 && (
            <button
              onClick={retryAllFailed}
              className="text-xs bg-red-900/30 hover:bg-red-900/50 border border-red-800 text-red-300 px-3 py-1.5 rounded-md transition-colors"
            >
              Retry {failedCount} failed photo{failedCount === 1 ? '' : 's'}
            </button>
          )}
          {statuses.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={s.state === 'done' ? 'text-green-400' : s.state === 'error' ? 'text-red-400' : 'text-gray-400'}>
                {s.state === 'done' ? '✓' : s.state === 'error' ? '✕' : '↑'}
              </span>
              <span className="text-gray-300 truncate max-w-[260px]">{s.name}</span>
              {s.state === 'error' && <span className="text-red-400 truncate">{s.error}</span>}
              {s.state === 'error' && !uploading && (
                <button
                  onClick={() => retry(i)}
                  className="text-blue-400 hover:text-blue-300 underline shrink-0"
                >
                  Retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {totalDone > 0 && (
        <div className="rounded-md border border-green-800 bg-green-900/20 px-4 py-3 text-sm text-green-300">
          {totalDone} photo{totalDone === 1 ? '' : 's'} uploaded.{' '}
          <Link href="/orders/sort-assign" className="underline hover:text-green-200">Go sort them onto orders →</Link>
        </div>
      )}
    </div>
  );
}
