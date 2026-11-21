import type { Terminal, ITerminalAddon, IEvent } from '@xterm/xterm';

/**
 * The user's renderer choice. WebGL draws the grid on the GPU, so full-screen redraws (scrolling,
 * TUI repaints) cost far less main-thread time than xterm's default DOM renderer.
 */
export type RendererPreference = 'webgl' | 'dom';
/** What is actually drawing: `dom-fallback` means WebGL was requested but is unavailable or failed. */
export type RendererState = 'webgl' | 'dom' | 'dom-fallback';

export function normalizeRenderer(value: unknown): RendererPreference {
  return value === 'dom' ? 'dom' : 'webgl';
}

export function rendererLabel(state: RendererState): string {
  return state === 'webgl' ? 'WebGL' : state === 'dom' ? 'DOM' : 'DOM (WebGL unavailable)';
}

type WebglLike = ITerminalAddon & { readonly onContextLoss: IEvent<void> };

/**
 * Switches the renderer of an opened terminal. Unloading the WebGL addon restores xterm's DOM
 * renderer, so every failure path (no WebGL2 context, activation error, GPU context loss) falls
 * back to DOM rendering instead of leaving a blank terminal.
 */
export function createRendererController(
  terminal: Pick<Terminal, 'loadAddon'>,
  createWebgl: () => WebglLike,
  onChange: (state: RendererState, problem?: string) => void = () => {},
) {
  let addon: WebglLike | undefined;
  let state: RendererState = 'dom';
  function unload(next: RendererState, problem?: string) {
    const current = addon;
    addon = undefined;
    try { current?.dispose(); } catch {}
    state = next;
    onChange(state, problem);
  }
  return {
    get state() { return state; },
    apply(preference: RendererPreference): RendererState {
      if (preference === 'dom') {
        if (addon || state !== 'dom') unload('dom');
        return state;
      }
      if (addon) return state;
      let created: WebglLike | undefined;
      try {
        created = createWebgl();
        terminal.loadAddon(created);
      } catch (error) {
        // A failed activate() leaves the addon registered; disposing it unregisters it.
        try { created?.dispose(); } catch {}
        state = 'dom-fallback';
        onChange(state, `WebGL rendering is unavailable (${error instanceof Error ? error.message : 'unknown error'}). Using DOM rendering.`);
        return state;
      }
      const active = created;
      addon = active;
      state = 'webgl';
      active.onContextLoss(() => {
        if (addon === active) unload('dom-fallback', 'The GPU rendering context was lost. Switched to DOM rendering; reopen the window to retry WebGL.');
      });
      onChange(state);
      return state;
    },
  };
}
