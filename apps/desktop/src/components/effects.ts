// Synchronous resource barrier: call BEFORE submitting any compute request.
const disposers = new Set<() => void>();
export function registerEffect(dispose: () => void) { disposers.add(dispose); return () => disposers.delete(dispose); }
export function stopVisualEffects() { for (const dispose of [...disposers]) dispose(); }
export interface EffectState { known: boolean; contributing: boolean; taskRunning: boolean; busy: boolean; enabled: boolean; focused: boolean; visible: boolean; reducedMotion: boolean }
export function mayAnimate(state: EffectState) { return state.known && !state.contributing && !state.taskRunning && !state.busy && state.enabled && state.focused && state.visible && !state.reducedMotion; }
