// Pure helpers for dropping photos onto order pages (useFileDrop.ts holds the
// React side). Kept free of React and the DOM so node --test can cover them.

/** True when a drag carries files from the desktop, not text or a link dragged inside the page. */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
  return false;
}

/**
 * dragenter/dragleave fire for every child element the pointer crosses, so a
 * plain boolean flickers. Count enters minus leaves; the page is "dragging"
 * while the count is above zero. A drop always resets it.
 */
export function nextDragDepth(depth: number, event: 'enter' | 'leave' | 'drop'): number {
  if (event === 'drop') return 0;
  if (event === 'enter') return depth + 1;
  return Math.max(0, depth - 1);
}

const IMAGE_NAME = /\.(jpe?g|png|webp|gif|heic|heif)$/i;

/** Photos only: some browsers leave the type empty for HEIC, so fall back to the name. */
export function isPhotoFile(f: { type?: string; name?: string }): boolean {
  if (f.type && f.type.startsWith('image/')) return true;
  return !f.type && IMAGE_NAME.test(f.name ?? '');
}

export type BulkUploadResult = {
  created?: number;
  duplicates?: number;
  rejected?: { name: string; error: string }[];
  attachments?: { id: number }[];
  existing?: { id: number; orderId: number | null }[];
};

/**
 * What a drop on the new-order form does with the bulk upload's answer:
 * new photos and already-uploaded photos still waiting to be sorted are added
 * to the order; photos already on another order are left where they are.
 */
export function planDroppedPhotos(res: BulkUploadResult, skippedNonPhotos = 0): { addIds: number[]; note: string | null } {
  const addIds: number[] = [];
  for (const a of res.attachments ?? []) if (!addIds.includes(a.id)) addIds.push(a.id);
  let onOtherOrders = 0;
  for (const e of res.existing ?? []) {
    if (e.orderId == null) { if (!addIds.includes(e.id)) addIds.push(e.id); }
    else onOtherOrders++;
  }
  const notes: string[] = [];
  if (onOtherOrders) notes.push(`${onOtherOrders} photo${onOtherOrders === 1 ? ' is' : 's are'} already on another order, so ${onOtherOrders === 1 ? 'it was' : 'they were'} not added`);
  const rejected = res.rejected?.length ?? 0;
  if (rejected) notes.push(`${rejected} file${rejected === 1 ? '' : 's'} could not be read as a photo`);
  if (skippedNonPhotos) notes.push(`${skippedNonPhotos} file${skippedNonPhotos === 1 ? ' is not a photo' : 's are not photos'} (add PDFs on the order page after saving)`);
  return { addIds, note: notes.length ? notes.join('. ') + '.' : null };
}

/** OCR states that will still change, so the form waits for them before filling fields in. */
export function ocrStillRunning(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}
