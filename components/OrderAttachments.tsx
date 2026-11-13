'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFileDrop } from '@/lib/useFileDrop';
import { ocrStillRunning } from '@/lib/fileDrop';

type Attachment = { id: number; originalName: string; mimeType: string; createdAt: string; ocrStatus?: string | null; giftCardId?: number | null; cardLinks?: { giftCardId: number }[]; ccSends?: { reservationId: number; filename: string; cards: string; sentAt: string }[] };
type CardOption = { id: number; merchant: string; cardNumber: string };

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];

export default function OrderAttachments({ orderId }: { orderId: number }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [cards, setCards] = useState<CardOption[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ name: string; state: 'uploading' | 'done' | 'error'; error?: string }[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [matching, setMatching] = useState(false);
  const [matchNote, setMatchNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAttachments = useCallback(async (): Promise<Attachment[]> => {
    const r = await fetch(`/api/orders/${orderId}/attachments`);
    const list: Attachment[] = r.ok ? await r.json() : [];
    if (Array.isArray(list)) setAttachments(list);
    return Array.isArray(list) ? list : [];
  }, [orderId]);

  useEffect(() => {
    loadAttachments().catch(() => {});
    fetch(`/api/orders/${orderId}/gift-cards`).then(r => r.json()).then(d => { if (Array.isArray(d)) setCards(d); }).catch(() => {});
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [orderId, loadAttachments]);

  // New photos are read in the background and linked to this order's cards when
  // the read finishes. Refresh a few times so the card ticks show up on their own.
  const watchReads = useCallback((tries = 8) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      const list = await loadAttachments().catch(() => [] as Attachment[]);
      if (tries > 1 && list.some(a => ocrStillRunning(a.ocrStatus))) watchReads(tries - 1);
    }, 4000);
  }, [loadAttachments]);

  const dragging = useFileDrop(files => { upload(files); }, !preview);

  async function matchPhotos() {
    setMatching(true);
    setMatchNote(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/attachments/match`, { method: 'POST' });
      const d = res.ok ? await res.json() : null;
      if (!d) setMatchNote('Could not match photos, try again.');
      else if (d.ocrOff) setMatchNote('Photo reading is turned off, so tick the cards by hand.');
      else if (d.reading > 0) { setMatchNote(`Reading ${d.reading} photo${d.reading === 1 ? '' : 's'}; cards will tick when done.`); watchReads(); }
      else setMatchNote(d.linked > 0 ? `Linked ${d.linked} card${d.linked === 1 ? '' : 's'}.` : 'No new matches. Tick the cards by hand if a photo shows one.');
      await loadAttachments();
    } catch {
      setMatchNote('Could not match photos, try again.');
    } finally {
      setMatching(false);
    }
  }

  const linkedIds = (a: Attachment) => {
    const ids = new Set((a.cardLinks ?? []).map(l => l.giftCardId));
    if (a.giftCardId != null) ids.add(a.giftCardId);
    return ids;
  };

  async function toggleCard(att: Attachment, cardId: number) {
    const cur = linkedIds(att);
    if (cur.has(cardId)) cur.delete(cardId); else cur.add(cardId);
    const giftCardIds = [...cur];
    const res = await fetch(`/api/orders/${orderId}/attachments/${att.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ giftCardIds }),
    });
    if (res.ok) setAttachments(prev => prev.map(a => a.id === att.id
      ? { ...a, giftCardId: giftCardIds[0] ?? null, cardLinks: giftCardIds.map(giftCardId => ({ giftCardId })) }
      : a));
  }

  async function upload(files: File[] | FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    let sentImage = false;
    const fileList = Array.from(files);
    setUploadStatus(fileList.map(f => ({ name: f.name, state: 'uploading' as const })));
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`/api/orders/${orderId}/attachments`, { method: 'POST', body: fd });
        if (res.ok) {
          const att = await res.json();
          setAttachments(prev => prev.some(a => a.id === att.id) ? prev : [...prev, att]);
          if (String(att.mimeType ?? '').startsWith('image/') && !att.duplicate) sentImage = true;
          setUploadStatus(prev => prev.map((s, j) => j === i ? { ...s, state: 'done' } : s));
        } else {
          const text = await res.text().catch(() => `HTTP ${res.status}`);
          setUploadStatus(prev => prev.map((s, j) => j === i ? { ...s, state: 'error', error: text } : s));
        }
      } catch (e) {
        setUploadStatus(prev => prev.map((s, j) => j === i ? { ...s, state: 'error', error: String(e) } : s));
      }
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
    setTimeout(() => setUploadStatus([]), 4000);
    if (sentImage) watchReads();
  }

  async function remove(attachmentId: number) {
    await fetch(`/api/orders/${orderId}/attachments`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId }),
    });
    setAttachments(prev => prev.filter(a => a.id !== attachmentId));
    if (preview?.id === attachmentId) setPreview(null);
  }

  return (
    <div className="space-y-3">
      {dragging && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-blue-950/60 border-4 border-dashed border-blue-500">
          <div className="rounded-lg bg-gray-900/90 px-6 py-4 text-center">
            <p className="text-lg font-medium text-blue-200">Drop to attach to this order</p>
            <p className="text-xs text-gray-400 mt-1">Gift card photos are read and ticked to their cards automatically</p>
          </div>
        </div>
      )}
      <h3 className="text-sm font-medium text-gray-300">Attachments</h3>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map(a => {
            const isImage = IMAGE_TYPES.includes(a.mimeType);
            const url = `/api/orders/${orderId}/attachments/${a.id}`;
            return (
              <div key={a.id} className="relative group">
                {isImage ? (
                  <button onClick={() => setPreview(a)} className="block">
                    <img src={url} alt={a.originalName} className="h-20 w-20 object-cover rounded border border-gray-700 hover:border-blue-500 transition-colors" />
                  </button>
                ) : (
                  <a href={url} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 hover:border-blue-500 transition-colors max-w-[160px] truncate">
                    📎 {a.originalName}
                  </a>
                )}
                {isImage && cards.length > 0 && (
                  <div className="mt-1 w-24 space-y-0.5" title="Gift cards this photo shows (sent to CardCenter once, with those cards)">
                    {cards.map(c => (
                      <label key={c.id} className="flex items-center gap-1 text-[10px] text-gray-300">
                        <input type="checkbox" checked={linkedIds(a).has(c.id)} onChange={() => toggleCard(a, c.id)} />
                        …{c.cardNumber.replace(/[^A-Za-z0-9]/g, '').slice(-4)}
                      </label>
                    ))}
                  </div>
                )}
                {isImage && ocrStillRunning(a.ocrStatus) && (
                  <div className="text-[10px] text-gray-400">reading…</div>
                )}
                {isImage && (a.ccSends?.length ?? 0) > 0 && (
                  <div className="text-[10px] text-green-400" title={a.ccSends!.map(s => `${s.filename} (${s.cards})`).join('\n')}>sent to CardCenter</div>
                )}
                <button
                  onClick={() => remove(a.id)}
                  className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-5 h-5 bg-red-700 hover:bg-red-600 rounded-full text-white text-xs"
                >×</button>
              </div>
            );
          })}
        </div>
      )}
      <div className="space-y-1.5">
        {uploadStatus.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className={s.state === 'done' ? 'text-green-400' : s.state === 'error' ? 'text-red-400' : 'text-gray-400'}>
              {s.state === 'done' ? '✓' : s.state === 'error' ? '✕' : '↑'}
            </span>
            <span className="text-gray-300 truncate max-w-[200px]">{s.name}</span>
            {s.state === 'error' && <span className="text-red-400 truncate">{s.error}</span>}
          </div>
        ))}
        <input ref={inputRef} type="file" multiple accept="image/*,.pdf" className="hidden" onChange={e => upload(e.target.files)} />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-md transition-colors"
        >
          + Add File <span className="text-gray-500">(or drop files anywhere on this page)</span>
        </button>
        {cards.length > 0 && attachments.some(a => IMAGE_TYPES.includes(a.mimeType)) && (
          <button
            onClick={matchPhotos}
            disabled={matching}
            className="ml-2 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-400 px-3 py-1.5 rounded-md transition-colors"
          >
            {matching ? 'Matching…' : 'Match photos to cards'}
          </button>
        )}
        {matchNote && <p className="text-xs text-gray-400">{matchNote}</p>}
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setPreview(null)}>
          <div className="relative max-w-4xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img src={`/api/orders/${orderId}/attachments/${preview.id}`} alt={preview.originalName} className="max-w-full max-h-[90vh] object-contain rounded" />
            <button onClick={() => setPreview(null)} className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg">×</button>
            <p className="text-center text-xs text-gray-400 mt-2">{preview.originalName}</p>
          </div>
        </div>
      )}
    </div>
  );
}
