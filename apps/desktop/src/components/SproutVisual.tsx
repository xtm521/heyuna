import { useEffect, useRef, useState } from 'react';
import SproutMark from './SproutMark';
import { mayAnimate, registerEffect, stopVisualEffects } from './effects';
export default function SproutVisual({ known, contributing, taskRunning, busy, enabled }: { known: boolean; contributing: boolean; taskRunning: boolean; busy: boolean; enabled: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true);
  const allowed = mayAnimate({ known, contributing, taskRunning, busy, enabled, focused, visible, reducedMotion });
  useEffect(() => {
    const focus = () => setFocused(document.hasFocus() && !document.hidden);
    const blur = () => { stopVisualEffects(); setFocused(false); };
    const visibility = () => { if (document.hidden) blur(); else focus(); };
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)'); const reduced = () => setReduced(mq?.matches ?? true);
    window.addEventListener('focus', focus); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility); mq?.addEventListener('change', reduced);
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false), { threshold: .1 }) : null;
    if (host.current) observer?.observe(host.current);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); mq?.removeEventListener('change', reduced); observer?.disconnect(); };
  }, []);
  useEffect(() => {
    if (!allowed || !host.current) return;
    const element = host.current; let cancelled = false; let dispose: (() => void) | undefined;
    const release = () => { cancelled = true; dispose?.(); element.classList.remove('has-scene'); };
    const unregister = registerEffect(release);
    void import('./sproutScene').then(({ createSproutScene }) => { if (!cancelled) { try { dispose = createSproutScene(element); element.classList.add('has-scene'); } catch { release(); } } }).catch(release);
    return () => { release(); unregister(); };
  }, [allowed]);
  return <div className="sprout-visual" ref={host} data-motion={allowed ? 'eligible' : 'static'}><SproutMark className="sprout-fallback" /></div>;
}
