/**
 * Event bus shared by the app shell and the feature modules (ctx.events). Event names and payloads are declared in
 * CodePadEventMap (types/renderer-globals.d.ts); listeners run synchronously in subscription order and a throwing
 * listener never stops the others.
 */
(() => {
  type Listener = (...args: unknown[]) => void;

  const listeners = new Map<string, Set<Listener>>();

  /** Subscribes to an event; returns a function that removes the listener. */
  function on<K extends CodePadEventName>(name: K, callback: (...args: CodePadEventMap[K]) => void): () => boolean {
    if (typeof name !== 'string' || typeof callback !== 'function') {
      throw new TypeError('CodePadBus.on needs an event name and a callback.');
    }
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    const listener = callback as Listener;
    const subscribed = set;
    subscribed.add(listener);
    return () => subscribed.delete(listener);
  }

  /** Calls every listener of an event with the given arguments. */
  function emit<K extends CodePadEventName>(name: K, ...args: CodePadEventMap[K]): void {
    [...(listeners.get(name) || [])].forEach((callback) => {
      try {
        callback(...args);
      } catch (error) {
        console.error(`Listener for "${name}" failed:`, error);
      }
    });
  }

  window.CodePadBus = Object.freeze({ on, emit });
})();
