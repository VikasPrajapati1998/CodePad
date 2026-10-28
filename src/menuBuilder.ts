import { Menu, MenuItem, app } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { errorMessage } from './errorUtils';

// The shared schema is a UMD script (also loaded by the renderer), so main loads it with require.
const schema: CodePadSettingsSchemaApi = require('./shared/settingsSchema');

/** A command table entry with its defaults filled in and the table it came from. */
export interface TableEntry extends CommandEntry {
  order: number;
  when: 'any' | 'text';
  palette: boolean;
  module: string;
  index: number;
}

/** A submenu level of the menu tree (the roots have no `group`). */
interface MenuGroup {
  group?: string;
  children: MenuNode[];
}
interface MenuLeaf {
  entry: TableEntry;
}
type MenuNode = MenuGroup | MenuLeaf;

/** What `buildMenu` needs from main. */
export interface MenuContext {
  keybindings: Record<string, string>;
  values: SettingsValues;
  recent: CpRecentItem[];
  sendCommand: (id: string) => void;
  openRecent: (index: number) => void;
}

// One static table per module; main only ever sends ids from these tables to the renderer.
const TABLE_MODULES = ['core', 'search', 'text', 'view', 'tabs', 'ai'];
const ROOTS = [
  ['File', '&File'],
  ['Edit', '&Edit'],
  ['Search', '&Search'],
  ['View', '&View'],
  ['Encoding', 'E&ncoding'],
  ['Tools', '&Tools'],
  ['AI', '&AI'],
  ['Macro', '&Macro'],
  ['Window', '&Window'],
  ['Help', '&Help'],
];
const SUBMENU_GROUP_ORDER = 0;

let table: TableEntry[] | null = null;

/** Loads every command table once; a missing or broken table is logged and skipped so the app still starts. */
function loadTable(): TableEntry[] {
  if (table) {
    return table;
  }
  const seen = new Set<string>();
  const loaded: TableEntry[] = [];
  table = loaded;
  TABLE_MODULES.forEach((name) => {
    let entries: CommandEntry[];
    try {
      entries = require(`./shared/commands/${name}.commands.js`);
    } catch (error) {
      console.warn(`Command table "${name}" could not be loaded: ${errorMessage(error)}`);
      return;
    }
    entries.forEach((entry) => {
      if (!entry || typeof entry.id !== 'string' || typeof entry.title !== 'string' || seen.has(entry.id)) {
        console.warn(`Ignored invalid or duplicate command: ${entry && entry.id}`);
        return;
      }
      seen.add(entry.id);
      loaded.push({ order: 100, when: 'text', palette: true, ...entry, module: name, index: loaded.length });
    });
  });
  return loaded;
}

/** True when the id is a command in one of the tables. */
function isKnownCommand(id: unknown): boolean {
  return typeof id === 'string' && loadTable().some((entry) => entry.id === id);
}

function effectiveAccelerator(entry: CommandEntry, keybindings: Record<string, string> | undefined): string {
  if (keybindings && Object.hasOwn(keybindings, entry.id)) {
    return keybindings[entry.id] || '';
  }
  return entry.accelerator || '';
}

/**
 * The command table as the renderer sees it (keybinding overrides applied; Electron roles are left out).
 * @param keybindings The `keybindings` setting.
 */
function effectiveTable(keybindings: Record<string, string>): CpCommandInfo[] {
  return loadTable()
    .filter((entry) => !entry.role)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      menu: entry.menu || '',
      accelerator: effectiveAccelerator(entry, keybindings),
      defaultAccelerator: entry.accelerator || '',
      when: entry.when,
      palette: entry.palette !== false,
    }));
}

/** Groups table entries into a tree of submenus keyed by the '/'-separated menu path. */
function buildTree(entries: TableEntry[]): Map<string, MenuGroup> {
  const roots = new Map<string, MenuGroup>(ROOTS.map(([name]) => [name, { children: [] }]));
  entries.forEach((entry) => {
    if (!entry.menu) {
      return;
    }
    const segments = entry.menu.split('/');
    let node: MenuGroup | undefined = roots.get(segments[0]);
    if (!node) {
      console.warn(`Command ${entry.id} uses the unknown menu "${entry.menu}".`);
      return;
    }
    for (const segment of segments.slice(1)) {
      let child: MenuGroup | undefined = node.children.find((item): item is MenuGroup => 'children' in item && item.group === segment);
      if (!child) {
        child = { group: segment, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ entry });
  });
  return roots;
}

/** Sort key of a node: leaves use their own order, a submenu the smallest order beneath it. */
function nodeOrder(node: MenuNode): number {
  if ('entry' in node) {
    return node.entry.order;
  }
  // Submenus never sort before the shell's own items (orders below 10).
  return Math.max(10, Math.min(...node.children.map(nodeOrder)));
}

function sortNodes(nodes: MenuNode[]): MenuNode[] {
  return nodes
    .map((node, index) => ({ node, index, key: nodeOrder(node), group: 'group' in node && node.group ? SUBMENU_GROUP_ORDER : 1 }))
    .sort((a, b) => a.key - b.key || a.group - b.group || a.index - b.index)
    .map((item) => item.node);
}

/** What the installed menu was built from (see `buildMenu`). */
let installedSignature = '';

function safeItem(options: MenuItemConstructorOptions): MenuItem {
  try {
    return new MenuItem(options);
  } catch (error) {
    console.warn(`Menu item "${options.label}" dropped its accelerator: ${errorMessage(error)}`);
    const { accelerator: _ignored, ...rest } = options;
    return new MenuItem(rest);
  }
}

function makeMenu(items: MenuItem[]): Menu {
  const menu = new Menu();
  items.forEach((item) => menu.append(item));
  return menu;
}

/** A recent path as a menu label: control/bidi characters removed and `&` doubled so it is not read as a mnemonic. */
function recentLabel(filePath: string): string {
  return (
    filePath
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
      .replace(/&/g, '&&')
  );
}

/**
 * Builds and installs the native menu.
 */
function buildMenu(context: MenuContext): void {
  const { keybindings, values, recent, sendCommand, openRecent } = context;
  const entries = loadTable().filter(
    (entry) => (!entry.devOnly || !app.isPackaged) && (!entry.platforms || entry.platforms.includes(process.platform)),
  );

  function leaf(entry: TableEntry): MenuItem[] {
    if (entry.role) {
      return [safeItem({ role: entry.role })];
    }
    if (entry.dynamic === 'recent') {
      const items = recent.length
        ? recent.map((item, index) => ({ label: recentLabel(item.path), click: () => openRecent(index) }))
        : [{ label: 'No recent files', enabled: false }];
      return [
        safeItem({
          label: entry.title,
          submenu: [
            ...items,
            { type: 'separator' },
            { label: 'Clear Recent Files List', enabled: recent.length > 0, click: () => sendCommand('files.clearRecent') },
          ],
        }),
      ];
    }
    const accelerator = effectiveAccelerator(entry, keybindings);
    const options: MenuItemConstructorOptions = {
      label: entry.title,
      accelerator: schema.ACCELERATOR.test(accelerator) ? accelerator : undefined,
      click: () => sendCommand(entry.id),
    };
    if (entry.checkedSetting) {
      options.type = 'checkbox';
      options.checked = values[entry.checkedSetting] === true;
    }
    return [safeItem(options)];
  }

  function toItems(nodes: MenuNode[]): MenuItem[] {
    const items: MenuItem[] = [];
    sortNodes(nodes).forEach((node) => {
      if ('entry' in node && node.entry.separatorBefore && items.length > 0) {
        items.push(new MenuItem({ type: 'separator' }));
      }
      if ('entry' in node) {
        items.push(...leaf(node.entry));
      } else {
        items.push(safeItem({ label: node.group, submenu: makeMenu(toItems(node.children)) }));
      }
    });
    return items;
  }

  // Installing a menu closes one the user has open, so an unchanged menu is left alone.
  const signature = JSON.stringify([
    keybindings,
    entries.map((entry) => (entry.checkedSetting ? values[entry.checkedSetting] === true : null)),
    recent.map((item) => item.path),
  ]);
  if (signature === installedSignature) {
    return;
  }
  installedSignature = signature;

  const roots = buildTree(entries);
  const template: MenuItem[] = [];
  if (process.platform === 'darwin') {
    template.push(new MenuItem({ role: 'appMenu' }));
  }
  ROOTS.forEach(([name, label]) => {
    const node = roots.get(name);
    if (!node) {
      return;
    }
    const items = node.children.length ? toItems(node.children) : [];
    if (items.length > 0) {
      template.push(new MenuItem({ label, submenu: makeMenu(items) }));
    }
  });
  Menu.setApplicationMenu(makeMenu(template));
  console.info('[menu] installed');
}

export { loadTable, isKnownCommand, effectiveTable, buildMenu };
