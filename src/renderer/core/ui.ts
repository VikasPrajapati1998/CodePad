/**
 * Small UI toolkit for the feature modules (ctx.ui): modal dialogs, prompt, confirm, filterable pick list and
 * context menus. All text is inserted with textContent; styles live in core.css.
 */
(() => {
  const MAX_PICK_ROWS = 500;
  const FOCUSABLE = 'input, select, textarea, button, [tabindex]:not([tabindex="-1"])';

  /** Open modals, topmost last (only the topmost reacts to Escape). */
  const modalStack: CodePadModalHandle[] = [];

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  document.addEventListener(
    'keydown',
    (event) => {
      const top = modalStack[modalStack.length - 1];
      if (top && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        top.close();
      }
    },
    true,
  );

  /**
   * Opens a modal dialog.
   * @param options A click handler returning `false` keeps the dialog open; with no buttons the dialog is closed
   *   with Escape or by its own controls.
   */
  function modal({ title, body, buttons = [], onClose }: CodePadModalOptions): CodePadModalHandle {
    const previousFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', 'cp-modal-backdrop');
    const dialog = el('div', 'cp-modal-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    const heading = el('div', 'cp-modal-title', title || '');
    const content = el('div', 'cp-modal-body');
    content.appendChild(body);
    dialog.append(heading, content);

    let closed = false;
    const handle: CodePadModalHandle = {
      element: dialog,
      close() {
        if (closed) {
          return;
        }
        closed = true;
        modalStack.splice(modalStack.indexOf(handle), 1);
        backdrop.remove();
        if (previousFocus && previousFocus.isConnected) {
          previousFocus.focus();
        }
        if (onClose) {
          onClose();
        }
      },
    };

    if (buttons.length > 0) {
      const row = el('div', 'cp-modal-buttons');
      buttons.forEach((definition) => {
        const button = el('button', `cp-button${definition.primary ? ' primary' : ''}`, definition.label);
        button.type = 'button';
        button.addEventListener('click', () => {
          if (!definition.onClick || definition.onClick(handle) !== false) {
            handle.close();
          }
        });
        row.appendChild(button);
      });
      dialog.appendChild(row);
    }

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    modalStack.push(handle);
    const first = content.querySelector<HTMLElement>(FOCUSABLE) || dialog.querySelector<HTMLElement>('.primary') || dialog;
    first.focus();
    return handle;
  }

  /**
   * Asks for a line of text.
   * @param options `validate` returns an error message, or null when the input is acceptable.
   * @returns The text, or null when cancelled.
   */
  function prompt({ title, label, value = '', validate }: CodePadPromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      const body = el('div', 'cp-prompt');
      if (label) {
        body.appendChild(el('label', 'cp-prompt-label', label));
      }
      const input = el('input', 'cp-input');
      input.type = 'text';
      input.value = value;
      const error = el('div', 'cp-prompt-error');
      body.append(input, error);
      let settled = false;

      const submit = (dialogHandle: CodePadModalHandle): boolean => {
        const problem = validate ? validate(input.value) : null;
        if (problem) {
          error.textContent = problem;
          input.focus();
          return false;
        }
        settled = true;
        resolve(input.value);
        dialogHandle.close();
        return true;
      };
      const handle = modal({
        title,
        body,
        buttons: [
          { label: 'OK', primary: true, onClick: submit },
          { label: 'Cancel' },
        ],
        onClose: () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit(handle);
        }
      });
      input.select();
    });
  }

  /**
   * Shows a message with buttons.
   * @returns Index of the clicked button, or -1 when dismissed with Escape.
   */
  function confirm({ title, message, buttons = ['OK', 'Cancel'] }: CodePadConfirmOptions): Promise<number> {
    return new Promise((resolve) => {
      let result = -1;
      const body = el('div', 'cp-confirm', message);
      modal({
        title: title || 'CodePad',
        body,
        buttons: buttons.map((button, index) => ({
          label: typeof button === 'string' ? button : button.label,
          primary: index === 0,
          onClick: () => {
            result = index;
          },
        })),
        onClose: () => resolve(result),
      });
    });
  }

  /**
   * Filterable list. Single mode resolves on click or Enter; multi mode shows check boxes and an OK button.
   * @returns The chosen value (any type, including 0), an array of values in multi mode, or null.
   */
  function pick<T>(options: { title: string; items: CodePadPickItem<T>[]; multi?: false }): Promise<T | null>;
  function pick<T>(options: { title: string; items: CodePadPickItem<T>[]; multi: true }): Promise<T[] | null>;
  function pick<T>({
    title,
    items,
    multi = false,
  }: {
    title: string;
    items: CodePadPickItem<T>[];
    multi?: boolean;
  }): Promise<T | T[] | null> {
    return new Promise((resolve) => {
      const body = el('div', 'cp-pick');
      const filter = el('input', 'cp-input');
      filter.type = 'text';
      filter.placeholder = 'Type to filter';
      const listEl = el('div', 'cp-pick-list');
      listEl.setAttribute('role', 'listbox');
      body.append(filter, listEl);

      const checked = new Set(items.filter((item) => item.checked).map((item) => item.value));
      let visible: CodePadPickItem<T>[] = [];
      let index = 0;
      let settled = false;
      let handle: CodePadModalHandle | null = null;

      function choose(position: number): void {
        const item = visible[position];
        if (!item) {
          return;
        }
        if (multi) {
          index = position;
          if (checked.has(item.value)) {
            checked.delete(item.value);
          } else {
            checked.add(item.value);
          }
          render();
        } else {
          settled = true;
          resolve(item.value);
          if (handle) {
            handle.close();
          }
        }
      }

      function render(): void {
        const needle = filter.value.trim().toLowerCase();
        visible = items
          .filter((item) => !needle || `${item.label} ${item.detail || ''}`.toLowerCase().includes(needle))
          .slice(0, MAX_PICK_ROWS);
        index = Math.min(index, Math.max(visible.length - 1, 0));
        listEl.replaceChildren();
        visible.forEach((item, position) => {
          const row = el('div', `cp-pick-row${position === index ? ' active' : ''}`);
          row.setAttribute('role', 'option');
          if (multi) {
            const box = el('input');
            box.type = 'checkbox';
            box.tabIndex = -1;
            box.checked = checked.has(item.value);
            row.appendChild(box);
          }
          row.appendChild(el('span', 'cp-pick-label', item.label));
          if (item.detail) {
            row.appendChild(el('span', 'cp-pick-detail', item.detail));
          }
          row.addEventListener('click', () => choose(position));
          listEl.appendChild(row);
        });
        const active = listEl.querySelector<HTMLElement>('.active');
        if (active) {
          active.scrollIntoView({ block: 'nearest' });
        }
      }

      const buttons: CodePadModalButton[] = multi
        ? [
            {
              label: 'OK',
              primary: true,
              onClick: () => {
                settled = true;
                resolve(items.filter((item) => checked.has(item.value)).map((item) => item.value));
              },
            },
            { label: 'Cancel' },
          ]
        : [{ label: 'Cancel' }];
      handle = modal({
        title,
        body,
        buttons,
        onClose: () => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
      });
      filter.addEventListener('input', () => {
        index = 0;
        render();
      });
      filter.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          index = Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
          render();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          choose(index);
        }
      });
      render();
    });
  }

  let openMenu: HTMLElement | null = null;

  function closeContextMenu(): void {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onMenuKey, true);
      window.removeEventListener('blur', closeContextMenu);
    }
  }

  function onOutside(event: MouseEvent): void {
    if (openMenu && !openMenu.contains(event.target as Node | null)) {
      closeContextMenu();
    }
  }

  function onMenuKey(event: KeyboardEvent): void {
    if (!openMenu) {
      return;
    }
    const rows = [...openMenu.querySelectorAll<HTMLElement>('.cp-menu-item:not(.disabled)')];
    const current = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeContextMenu();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      rows[(current + step + rows.length) % rows.length].focus();
    }
  }

  /**
   * Shows a context menu at client coordinates; it closes on any click, Escape or window blur.
   * @param x Client X.
   * @param y Client Y.
   * @param items Menu rows.
   */
  function contextMenu(x: number, y: number, items: CodePadContextMenuItem[]): void {
    closeContextMenu();
    const menu = el('div', 'cp-menu');
    menu.setAttribute('role', 'menu');
    items.forEach((item) => {
      if (item.separator) {
        menu.appendChild(el('div', 'cp-menu-separator'));
        return;
      }
      const row = el('button', `cp-menu-item${item.disabled ? ' disabled' : ''}`);
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.disabled = Boolean(item.disabled);
      row.appendChild(el('span', 'cp-menu-check', item.checked ? '✓' : ''));
      row.appendChild(el('span', 'cp-menu-label', item.label || ''));
      row.appendChild(el('span', 'cp-menu-accel', item.accelerator || ''));
      row.addEventListener('click', () => {
        closeContextMenu();
        if (item.run) {
          item.run();
        }
      });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    openMenu = menu;
    const left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 4));
    const top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('blur', closeContextMenu);
    const first = menu.querySelector<HTMLElement>('.cp-menu-item:not(.disabled)');
    if (first) {
      first.focus();
    }
  }

  /**
   * Shows text in the bottom `output` panel (the panel listens for `output:set`); falls back to a dialog when no
   * feature registered that panel.
   */
  function output(title: string, text: string): void {
    if (window.CodePadPanels.has('output')) {
      window.CodePadBus.emit('output:set', { title, text });
      window.CodePadPanels.show('output');
      return;
    }
    modal({ title, body: el('pre', 'cp-output-text', text), buttons: [{ label: 'Close' }] });
  }

  window.CodePadUI = Object.freeze({ modal, prompt, confirm, pick, contextMenu, output });
})();
