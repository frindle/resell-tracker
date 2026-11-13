'use client';

import { useEffect, useRef, useState } from 'react';
import { dragHasFiles, nextDragDepth } from '@/lib/fileDrop';

/**
 * Page-wide file drop: while enabled, dragging files from the desktop anywhere
 * over the page reports `dragging` (for an overlay) and dropping hands the
 * files to `onFiles`. Drags that carry no files (text, links) are ignored, and
 * a dropped file never makes the browser navigate away to open it.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    const step = (e: DragEvent, kind: 'enter' | 'leave' | 'drop') => {
      depth.current = nextDragDepth(depth.current, kind);
      setDragging(depth.current > 0);
    };
    const onEnter = (e: DragEvent) => { if (dragHasFiles(e.dataTransfer?.types)) step(e, 'enter'); };
    const onLeave = (e: DragEvent) => { if (dragHasFiles(e.dataTransfer?.types)) step(e, 'leave'); };
    const onOver = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      step(e, 'drop');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) handler.current(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);

  return dragging;
}
