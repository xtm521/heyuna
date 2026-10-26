import { useRef, type Dispatch, type SetStateAction } from 'react';
export default function ResizeHandle({ label, value, setValue, min, max, reverse = false }: { label: string; value: number; setValue: Dispatch<SetStateAction<number>>; min: number; max: number; reverse?: boolean }) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  return <div className="resize-handle" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0}
    onPointerDown={event => { start.current = { x: event.clientX, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (start.current) setValue(clamp(start.current.value + (event.clientX - start.current.x) * (reverse ? -1 : 1))); }}
    onPointerUp={event => { start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { start.current = null; }}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setValue(clamp(value + (event.key === 'ArrowLeft' ? -16 : 16) * (reverse ? -1 : 1))); } if (event.key === 'Home') setValue(min); if (event.key === 'End') setValue(max); }} />;
}
