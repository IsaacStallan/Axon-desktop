// `export {}` makes this file a module, which is required for
// `declare global` augmentations to be legal in TypeScript.
export {};

declare global {
  interface Window {
    axon: {
      onStateChange: (cb: (state: string) => void) => void;
      onMessage:     (cb: (msg: string) => void) => void;
      tapOrb:        () => void;
      ready:         () => void;
    };
  }
}

const core = document.getElementById('core')!;

// ── Tap handler ──────────────────────────────────────────────────────────────
core.addEventListener('click', () => {
  window.axon.tapOrb();
});

// ── State changes from main process ─────────────────────────────────────────
window.axon.onStateChange((state: string) => {
  document.body.className = state;
});

// ── Signal renderer is ready ─────────────────────────────────────────────────
window.axon.ready();
