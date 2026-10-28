/**
 * Renderer side of the settings store (ctx.settings). Main owns and validates the values; this module keeps a
 * synchronous copy so `get` is always cheap, applies valid changes immediately and reconciles with main's answer.
 */
(() => {
  const schema = window.CodePadSettingsSchema;
  const bus = window.CodePadBus;

  let values: SettingsValues = schema.defaults();
  let queue: Promise<void> = Promise.resolve();

  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  function applyLocal(next: Partial<SettingsValues>): void {
    (Object.keys(next) as SettingKey[]).forEach((key) => {
      const value = next[key] as SettingValue;
      if (!same(values[key], value)) {
        (values as Record<SettingKey, SettingValue>)[key] = value;
        bus.emit('settings:changed', { key, value });
      }
    });
  }

  /**
   * Loads the saved settings from main (without emitting change events).
   * @returns True when no settings file existed yet (first start).
   */
  async function load(): Promise<boolean> {
    const { values: stored, fresh } = await window.codepad.settings.get();
    values = { ...schema.defaults(), ...stored };
    return fresh === true;
  }

  const get = <K extends SettingKey>(key: K): SettingsValues[K] => values[key];
  const all = (): SettingsValues => ({ ...values });

  /**
   * Updates several settings. Locally valid values are visible to `get` at once; main's validated result then
   * replaces them (so an out-of-range value ends up at its default).
   * @param patchValues Key/value pairs.
   */
  function patch(patchValues: Partial<SettingsValues>): Promise<void> {
    const optimistic: Record<string, SettingValue> = {};
    Object.entries(patchValues).forEach(([key, value]) => {
      const result = schema.validate(key, value);
      if (result.ok) {
        optimistic[key] = result.value;
      }
    });
    applyLocal(optimistic as Partial<SettingsValues>);
    const run = queue.then(async () => {
      applyLocal(await window.codepad.settings.patch(patchValues));
    });
    queue = run.catch(() => {});
    return run;
  }

  const set = <K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<void> => patch({ [key]: value });

  /** Subscribes to changes: callback({key, value}). Returns an unsubscribe function. */
  const onChange = (callback: (change: { key: SettingKey; value: SettingValue }) => void): (() => boolean) =>
    bus.on('settings:changed', callback);

  window.CodePadSettings = Object.freeze({ load, get, set, patch, all, onChange });
})();
