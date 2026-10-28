/**
 * Panels host (ctx.panels): the tab strip of the left sidebar and the bottom panel. Visibility, the active panel
 * and the sizes live in the settings store (ui.*), so this module only reflects them in the DOM and writes them back.
 */
(() => {
  const settings = window.CodePadSettings;
  const bus = window.CodePadBus;
  const LOCATION_IDS: Location[] = ['left', 'bottom'];
  const MIN_SIDEBAR = 150;
  const MAX_SIDEBAR = 600;
  const MIN_BOTTOM = 80;
  const MAX_BOTTOM = 800;

  type Location = 'left' | 'bottom';

  interface LocationConfig {
    visibleKey: 'ui.sidebar' | 'ui.bottomPanel';
    activeKey: 'ui.activeLeft' | 'ui.activeBottom';
    root(): HTMLElement;
    tabs(): HTMLElement;
    body(): HTMLElement;
  }

  interface Panel {
    id: string;
    title: string;
    location: Location;
    order: number;
    render: CodePadPanelDefinition['render'];
    container: HTMLElement;
    button: HTMLElement;
    badge: HTMLElement;
    instance: CodePadPanelInstance | null;
    shown: boolean;
  }

  /** An element the page must contain (index.html); a missing one is a broken page, not a recoverable state. */
  function byId(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (!node) {
      throw new Error(`The page has no #${id} element.`);
    }
    return node;
  }

  const LOCATIONS: Record<Location, LocationConfig> = {
    left: {
      visibleKey: 'ui.sidebar',
      activeKey: 'ui.activeLeft',
      root: () => byId('sidebar'),
      tabs: () => byId('sidebar-tabs'),
      body: () => byId('sidebar-body'),
    },
    bottom: {
      visibleKey: 'ui.bottomPanel',
      activeKey: 'ui.activeBottom',
      root: () => byId('bottom-panel'),
      tabs: () => byId('bottom-tabs'),
      body: () => byId('bottom-body'),
    },
  };

  const panels = new Map<string, Panel>();
  let context: CodePadCtx | null = null;
  let started = false;

  const inLocation = (location: Location): Panel[] =>
    [...panels.values()].filter((panel) => panel.location === location).sort((a, b) => a.order - b.order);

  /** The panel that is (or would be) shown in a location: the saved active one, else the first registered. */
  function activePanel(location: Location): Panel | null {
    const list = inLocation(location);
    const wanted = settings.get(LOCATIONS[location].activeKey);
    return list.find((panel) => panel.id === wanted) || list[0] || null;
  }

  function ensureRendered(panel: Panel): void {
    if (panel.instance === null) {
      panel.instance = {};
      try {
        if (!context) {
          throw new Error('The panels host has not been started.');
        }
        panel.instance = panel.render(panel.container, context) || {};
      } catch (error) {
        console.error(`Panel "${panel.id}" failed to render:`, error);
        panel.container.textContent = 'This panel could not be loaded.';
      }
    }
  }

  function setShown(panel: Panel, shown: boolean): void {
    if (panel.shown === shown) {
      return;
    }
    panel.shown = shown;
    panel.container.hidden = !shown;
    if (shown) {
      ensureRendered(panel);
    }
    const hook = panel.instance && (shown ? panel.instance.onShow : panel.instance.onHide);
    if (typeof hook === 'function') {
      try {
        hook.call(panel.instance);
      } catch (error) {
        console.error(`Panel "${panel.id}" failed:`, error);
      }
    }
  }

  /** Brings the DOM in line with the settings. */
  function applyLayout(): void {
    LOCATION_IDS.forEach((location) => {
      const config = LOCATIONS[location];
      const root = config.root();
      const visible = settings.get(config.visibleKey);
      const active = activePanel(location);
      root.classList.toggle('hidden', !visible || !active);
      inLocation(location).forEach((panel) => {
        const isActive = panel === active;
        panel.button.classList.toggle('active', isActive);
        panel.button.setAttribute('aria-selected', String(isActive));
        setShown(panel, visible && isActive);
      });
    });
    byId('sidebar').style.width = `${settings.get('ui.sidebarWidth')}px`;
    byId('bottom-panel').style.height = `${settings.get('ui.bottomHeight')}px`;
    bus.emit('layout:changed');
  }

  /**
   * Adds a panel.
   * @param definition `container` lets app.ts adopt an element that already exists in the page.
   */
  function register(definition: CodePadPanelDefinition): void {
    const { id, title, location, render } = definition;
    if (!LOCATIONS[location] || typeof id !== 'string' || typeof render !== 'function' || panels.has(id)) {
      throw new Error(`Panel "${id}" is invalid or already registered.`);
    }
    const config = LOCATIONS[location];
    const container = definition.container || document.createElement('div');
    container.classList.add('cp-panel');
    container.dataset.panel = id;
    container.hidden = true;
    if (!container.parentElement) {
      config.body().appendChild(container);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cp-panel-tab';
    button.setAttribute('role', 'tab');
    const label = document.createElement('span');
    label.textContent = title;
    const badge = document.createElement('span');
    badge.className = 'cp-panel-badge';
    badge.hidden = true;
    button.append(label, badge);
    button.addEventListener('click', () => show(id, { focus: true }));
    config.tabs().appendChild(button);
    panels.set(id, {
      id,
      title,
      location,
      order: definition.order !== undefined && Number.isFinite(definition.order) ? definition.order : 100,
      render,
      container,
      button,
      badge,
      instance: null,
      shown: false,
    });
    // Re-sort the strip so `order` decides the tab positions.
    inLocation(location).forEach((panel) => config.tabs().appendChild(panel.button));
    if (started) {
      applyLayout();
    }
  }

  function focusPanel(panel: Panel): void {
    const target = panel.container.querySelector<HTMLElement>('input, textarea, select, button, [tabindex]');
    if (target) {
      target.focus();
    }
  }

  /** Shows a panel (opening the sidebar or bottom area when needed). */
  function show(id: string, { focus = false }: { focus?: boolean } = {}): void {
    const panel = panels.get(id);
    if (!panel) {
      return;
    }
    const config = LOCATIONS[panel.location];
    settings.patch({ [config.activeKey]: id, [config.visibleKey]: true } as Partial<SettingsValues>).catch((error) => console.error(error));
    if (focus) {
      focusPanel(panel);
    }
  }

  /** Hides a panel; the area closes only when this panel is the one on display. */
  function hide(id: string): void {
    const panel = panels.get(id);
    if (panel && isVisible(id)) {
      settings.set(LOCATIONS[panel.location].visibleKey, false).catch((error) => console.error(error));
    }
  }

  function isVisible(id: string): boolean {
    const panel = panels.get(id);
    return panel !== undefined && panel.shown;
  }

  function toggle(id: string): void {
    if (isVisible(id)) {
      hide(id);
    } else {
      show(id, { focus: true });
    }
  }

  /** Id of the panel shown (or last shown) in a location, even while that area is hidden; null when none exists. */
  function active(location: Location): string | null {
    const panel = LOCATIONS[location] ? activePanel(location) : null;
    return panel ? panel.id : null;
  }

  /** Sets (or clears, with an empty text) the small badge on a panel's tab. */
  function setBadge(id: string, text?: string | number | null): void {
    const panel = panels.get(id);
    if (panel) {
      panel.badge.textContent = text === undefined || text === null ? '' : String(text);
      panel.badge.hidden = panel.badge.textContent === '';
    }
  }

  const has = (id: string): boolean => panels.has(id);

  /** Drag handle: resizes by `compute(event)` and stores the final size once. */
  function bindResizer(
    handle: HTMLElement,
    key: 'ui.sidebarWidth' | 'ui.bottomHeight',
    min: number,
    max: number,
    compute: (event: MouseEvent) => number,
    apply: (size: number) => void,
  ): void {
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      document.body.classList.add('cp-resizing');
      let size = settings.get(key);
      const onMove = (moveEvent: MouseEvent): void => {
        size = Math.max(min, Math.min(max, Math.round(compute(moveEvent))));
        apply(size);
        bus.emit('layout:changed');
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('cp-resizing');
        settings.set(key, size).catch((error) => console.error(error));
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /** Called by app.js after the settings are loaded and the page exists. */
  function start(ctx: CodePadCtx): void {
    context = ctx;
    started = true;
    bindResizer(
      byId('sidebar-resizer'),
      'ui.sidebarWidth',
      MIN_SIDEBAR,
      MAX_SIDEBAR,
      (event) => event.clientX,
      (size) => {
        byId('sidebar').style.width = `${size}px`;
      },
    );
    bindResizer(
      byId('bottom-resizer'),
      'ui.bottomHeight',
      MIN_BOTTOM,
      MAX_BOTTOM,
      (event) => byId('main').getBoundingClientRect().bottom - event.clientY,
      (size) => {
        byId('bottom-panel').style.height = `${size}px`;
      },
    );
    byId('bottom-close').addEventListener('click', () => {
      settings.set('ui.bottomPanel', false).catch((error) => console.error(error));
    });
    bus.on('settings:changed', ({ key }) => {
      if (key.startsWith('ui.')) {
        applyLayout();
      }
    });
    applyLayout();
  }

  window.CodePadPanels = Object.freeze({
    register,
    show,
    hide,
    toggle,
    isVisible,
    active,
    setBadge,
    has,
    internal: Object.freeze({ start }),
  });
})();
