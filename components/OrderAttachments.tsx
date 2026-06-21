'use client';

import { useEffect, useRef, useState } from 'react';

type Attachment = { id: number; originalName: string; mimeType: string; createdAt: string };

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];

export default function OrderAttachments({ orderId }: { orderId: number }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ name: string; state: 'uploading' | 'done' | 'error'; error?: string }[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/orders/${orderId}/attachments`).then(r => r.json()).then(setAttachments);
  }, [orderId]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
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
          setAttachments(prev => [...prev, att]);
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
          + Add File
        </button>
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
