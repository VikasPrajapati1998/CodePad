/**
 * Theme registry (ctx.themes). A theme is { id, label, base: 'vs'|'vs-dark', monaco?: {colors, rules}, ui?: {cssVar: value} }.
 * The built-in `dark` and `light` map to Monaco's own themes; every other theme is defined in Monaco as `cp-<id>`,
 * so a custom theme can never replace one of Monaco's built-ins (such as its own `hc-black`).
 */
(() => {
  const FALLBACK_ID = 'dark';

  const themes = new Map<string, CodePadThemeEntry>();
  let monacoNs: typeof monaco | null = null;
  let currentId = FALLBACK_ID;
  let appliedVars: string[] = [];

  function define(theme: CodePadThemeEntry): void {
    if (monacoNs && theme.monaco && theme.monacoName.startsWith('cp-')) {
      monacoNs.editor.defineTheme(theme.monacoName, {
        base: theme.base,
        inherit: true,
        rules: theme.monaco.rules || [],
        colors: theme.monaco.colors || {},
      });
    }
  }

  /** Adds a theme; registering an id again replaces it. */
  function register(definition: CodePadThemeDefinition): void {
    if (!definition || typeof definition.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(definition.id)) {
      throw new TypeError('A theme needs an id made of lowercase letters, digits and dashes.');
    }
    const base = definition.base === 'vs' ? 'vs' : 'vs-dark';
    const builtIn = definition.id === 'dark' || definition.id === 'light';
    const theme: CodePadThemeEntry = {
      id: definition.id,
      label: String(definition.label || definition.id),
      base,
      monaco: definition.monaco,
      ui: definition.ui,
      monacoName: builtIn ? base : `cp-${definition.id}`,
    };
    themes.set(theme.id, theme);
    define(theme);
  }

  /** Gives the registry the Monaco namespace; themes registered earlier are defined now. */
  function setMonaco(namespace: typeof monaco): void {
    monacoNs = namespace;
    themes.forEach(define);
  }

  const list = (): CodePadThemeSummary[] => [...themes.values()].map(({ id, label, base }) => ({ id, label, base }));
  const get = (id: string): CodePadThemeEntry | null => themes.get(id) || null;

  /** The theme for an id, falling back to dark (registered below, so always present). */
  function themeOrFallback(id: string): CodePadThemeEntry {
    const theme = themes.get(id) ?? themes.get(FALLBACK_ID);
    if (!theme) {
      throw new Error('The fallback theme is not registered.');
    }
    return theme;
  }

  /** 'light' or 'dark' for the document editors, which only know those two. */
  const kindOf = (id: string): 'light' | 'dark' => (themeOrFallback(id).base === 'vs' ? 'light' : 'dark');

  /**
   * Applies a theme to the page and to Monaco; an unknown id falls back to dark.
   * @returns The id that was applied.
   */
  function apply(id: string): string {
    const theme = themeOrFallback(id);
    currentId = theme.id;
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    appliedVars.forEach((name) => root.style.removeProperty(name));
    const ui = theme.ui || {};
    appliedVars = Object.keys(ui).filter((name) => /^--[A-Za-z0-9-]+$/.test(name));
    appliedVars.forEach((name) => root.style.setProperty(name, String(ui[name])));
    if (monacoNs) {
      monacoNs.editor.setTheme(theme.monacoName);
    }
    return theme.id;
  }

  register({ id: 'dark', label: 'Dark', base: 'vs-dark' });
  register({ id: 'light', label: 'Light', base: 'vs' });

  window.CodePadThemes = Object.freeze({
    register,
    list,
    get,
    kindOf,
    apply,
    current: () => currentId,
    internal: Object.freeze({ setMonaco }),
  });
})();
