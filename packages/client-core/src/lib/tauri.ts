/**
 * Calls into the desktop app's Rust side. Tauri 2 only puts its API on
 * `window.__TAURI__` with `withGlobalTauri`; `window.__TAURI_INTERNALS__`
 * is always there, so everything goes through that.
 */

type TauriInternals = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  transformCallback: (cb: (event: { payload: unknown }) => void) => number;
};

type TauriGlobal = {
  core?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  event?: {
    listen?: <T>(
      event: string,
      cb: (ev: { payload: T }) => void,
    ) => Promise<() => void>;
  };
};

type TauriWindow = Window & {
  __TAURI__?: TauriGlobal;
  __TAURI_INTERNALS__?: TauriInternals;
};

function tauriWindow(): TauriWindow | null {
  return typeof window === "undefined" ? null : (window as TauriWindow);
}

/** Running inside the desktop app. */
export function isTauri(): boolean {
  const w = tauriWindow();
  return !!w && ("__TAURI_INTERNALS__" in w || "__TAURI__" in w);
}

export function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const w = tauriWindow();
  const internals = w?.__TAURI_INTERNALS__;
  if (internals) return internals.invoke<T>(cmd, args);
  const globalInvoke = w?.__TAURI__?.core?.invoke;
  if (globalInvoke) return globalInvoke<T>(cmd, args);
  return Promise.reject(new Error("Tauri invoke API is not available"));
}

/** Subscribes to an event from the Rust side; resolves to the unsubscribe. */
export async function tauriListen<T>(
  event: string,
  cb: (payload: T) => void,
): Promise<() => void> {
  const w = tauriWindow();
  const internals = w?.__TAURI_INTERNALS__;
  if (internals) {
    const handler = internals.transformCallback((ev) => cb(ev.payload as T));
    const eventId = await internals.invoke<number>("plugin:event|listen", {
      event,
      target: { kind: "Any" },
      handler,
    });
    return () => {
      void internals.invoke("plugin:event|unlisten", { event, eventId });
    };
  }
  const globalListen = w?.__TAURI__?.event?.listen;
  if (globalListen) return globalListen<T>(event, (ev) => cb(ev.payload));
  throw new Error("Tauri event API is not available");
}
