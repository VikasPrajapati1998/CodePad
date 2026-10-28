/**
 * Feature loader. Feature scripts call `CodePadFeatures.register(name, { init(ctx) })` at load time; app.ts runs
 * every init once, in registration order, after Monaco and the editor exist.
 */
(() => {
  const features = new Map<string, CodePadFeatureDefinition>();

  function register(name: string, definition?: CodePadFeatureDefinition): void {
    if (typeof name !== 'string' || features.has(name)) {
      throw new Error(`Feature "${name}" is already registered or has no name.`);
    }
    features.set(name, definition || {});
  }

  /**
   * Runs every init(ctx) inside its own try/catch so one broken module cannot stop the others.
   * @param ctx The frozen feature context.
   * @returns Names of the modules whose init threw.
   */
  function initAll(ctx: CodePadCtx): string[] {
    const failed: string[] = [];
    features.forEach((definition, name) => {
      if (typeof definition.init !== 'function') {
        return;
      }
      try {
        definition.init(ctx);
      } catch (error) {
        console.error(`Feature "${name}" failed to start:`, error);
        failed.push(name);
      }
    });
    return failed;
  }

  window.CodePadFeatures = Object.freeze({ register, initAll });
})();
