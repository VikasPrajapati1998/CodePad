'use strict';

(() => {
  const api = window.codepad;

  const baseUrl = new URL('..', window.location.href).href.replace(/\/$/, '');
  const monacoBase = `${baseUrl}/node_modules/monaco-editor/min`;

  // Monaco workers must be bootstrapped through a data: URL when loaded from file://.
  window.MonacoEnvironment = {
    getWorkerUrl: () =>
      `data:text/javascript;charset=utf-8,${encodeURIComponent(
        `self.MonacoEnvironment={baseUrl:${JSON.stringify(`${monacoBase}/`)}};` +
          `importScripts(${JSON.stringify(`${monacoBase}/vs/base/worker/workerMain.js`)});`,
      )}`,
  };

  const ENCODING_LABELS = {
    utf8: 'UTF-8',
    utf8bom: 'UTF-8 with BOM',
    utf16le: 'UTF-16 LE',
    utf16be: 'UTF-16 BE',
    latin1: 'Latin-1',
  };

  // Extensions Monaco has no language entry for, mapped to the closest one.
  const EXTRA_EXTENSIONS = {
    '.toml': 'ini',
    '.env': 'ini',
    '.vue': 'html',
    '.svelte': 'html',
  };

  const settings = {
    theme: localStorage.getItem('theme') || 'dark',
    minimap: localStorage.getItem('minimap') !== 'false',
    wordWrap: localStorage.getItem('wordWrap') === 'true',
    sidebar: localStorage.getItem('sidebar') !== 'false',
  };

  const els = {
    sidebar: document.getElementById('sidebar'),
    folderName: document.getElementById('folder-name'),
    fileTree: document.getElementById('file-tree'),
    tabs: document.getElementById('tabs'),
    editor: document.getElementById('editor'),
    welcome: document.getElementById('welcome'),
    message: document.getElementById('status-message'),
    pos: document.getElementById('status-pos'),
    eol: document.getElementById('status-eol'),
    encoding: document.getElementById('status-encoding'),
    lang: document.getElementById('status-lang'),
  };

  /** @type {{id:number,path:string|null,name:string,encoding:string,model:object,viewState:object|null,savedVersion:number,dirty:boolean}[]} */
  const tabs = [];
  let activeTab = null;
  let nextId = 1;
  let untitledCount = 0;
  let monaco = null;
  let editor = null;
  let extensionMap = new Map();
  let filenameMap = new Map();

  const baseName = (p) => p.split(/[\\/]/).pop();

  function setStatus(text) {
    els.message.textContent = text;
  }

  function detectLanguage(filePath) {
    const name = baseName(filePath).toLowerCase();
    if (filenameMap.has(name)) {
      return filenameMap.get(name);
    }
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';
    return extensionMap.get(ext) || EXTRA_EXTENSIONS[ext] || 'plaintext';
  }

  function buildLanguageIndex() {
    const languages = monaco.languages.getLanguages();
    extensionMap = new Map();
    filenameMap = new Map();
    languages.forEach((lang) => {
      (lang.extensions || []).forEach((ext) => extensionMap.set(ext.toLowerCase(), lang.id));
      (lang.filenames || []).forEach((file) => filenameMap.set(file.toLowerCase(), lang.id));
    });
    const options = languages
      .map((lang) => ({ id: lang.id, label: (lang.aliases && lang.aliases[0]) || lang.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    options.forEach(({ id, label }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      els.lang.appendChild(option);
    });
  }

  // ---------- Tabs ----------

  function renderTabs() {
    els.tabs.replaceChildren();
    tabs.forEach((tab) => {
      const item = document.createElement('div');
      item.className = `tab${tab === activeTab ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`;
      item.title = tab.path || tab.name;

      const label = document.createElement('span');
      label.textContent = tab.name;

      const close = document.createElement('span');
      close.className = 'close';
      close.innerHTML = '<span>×</span>';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab);
      });

      item.addEventListener('click', () => activateTab(tab));
      item.addEventListener('auxclick', (event) => {
        if (event.button === 1) {
          closeTab(tab);
        }
      });
      item.append(label, close);
      els.tabs.appendChild(item);
    });
    const active = els.tabs.querySelector('.tab.active');
    if (active) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    document.title = activeTab ? `${activeTab.name}${activeTab.dirty ? ' ●' : ''} - CodePad` : 'CodePad';
  }

  function activateTab(tab) {
    if (activeTab) {
      activeTab.viewState = editor.saveViewState();
    }
    activeTab = tab;
    editor.setModel(tab.model);
    if (tab.viewState) {
      editor.restoreViewState(tab.viewState);
    }
    editor.focus();
    updateEditorVisibility();
    updateStatusForModel();
    highlightTreeFile();
    renderTabs();
  }

  function updateEditorVisibility() {
    const hasTabs = tabs.length > 0;
    els.editor.classList.toggle('hidden', !hasTabs);
    els.welcome.classList.toggle('hidden', hasTabs);
  }

  function addTab(filePath, content, encoding = 'utf8') {
    const name = filePath ? baseName(filePath) : `Untitled-${++untitledCount}`;
    const language = filePath ? detectLanguage(filePath) : 'plaintext';
    const model = monaco.editor.createModel(
      content,
      language,
      filePath ? monaco.Uri.file(filePath) : undefined,
    );
    const tab = {
      id: nextId++,
      path: filePath,
      name,
      encoding,
      model,
      viewState: null,
      savedVersion: model.getAlternativeVersionId(),
      dirty: false,
    };
    model.onDidChangeContent(() => {
      const dirty = model.getAlternativeVersionId() !== tab.savedVersion;
      if (dirty !== tab.dirty) {
        tab.dirty = dirty;
        renderTabs();
      }
      if (tab === activeTab) {
        updateStatusForModel();
      }
    });
    tabs.push(tab);
    activateTab(tab);
    return tab;
  }

  /** Asks about unsaved changes. Returns true when it is safe to discard the tab. */
  async function confirmDiscard(tab) {
    if (!tab.dirty) {
      return true;
    }
    activateTab(tab);
    const choice = await api.confirmClose(tab.name);
    if (choice === 0) {
      return saveTab(tab);
    }
    return choice === 1;
  }

  async function closeTab(tab) {
    if (!(await confirmDiscard(tab))) {
      return;
    }
    const index = tabs.indexOf(tab);
    tabs.splice(index, 1);
    if (tab === activeTab) {
      activeTab = null;
      if (tabs.length > 0) {
        activateTab(tabs[Math.min(index, tabs.length - 1)]);
      } else {
        editor.setModel(null);
        updateEditorVisibility();
        updateStatusForModel();
        highlightTreeFile();
        renderTabs();
      }
    } else {
      renderTabs();
    }
    tab.model.dispose();
  }

  function cycleTab(step) {
    if (tabs.length < 2) {
      return;
    }
    const index = tabs.indexOf(activeTab);
    activateTab(tabs[(index + step + tabs.length) % tabs.length]);
  }

  // ---------- Files ----------

  async function openPath(filePath) {
    const existing = tabs.find((tab) => tab.path === filePath);
    if (existing) {
      activateTab(existing);
      return;
    }
    try {
      const result = await api.readFile(filePath);
      if (result.binary) {
        setStatus(`${baseName(filePath)} is a binary file and cannot be opened.`);
      } else if (result.tooLarge) {
        setStatus(`${baseName(filePath)} is larger than 20 MB and cannot be opened.`);
      } else {
        addTab(filePath, result.content, result.encoding);
        setStatus('');
      }
    } catch (error) {
      setStatus(`Could not open ${baseName(filePath)}: ${error.message}`);
    }
  }

  async function writeTab(tab, filePath) {
    try {
      await api.writeFile(filePath, tab.model.getValue(), tab.encoding);
    } catch (error) {
      setStatus(`Could not save ${baseName(filePath)}: ${error.message}`);
      return false;
    }
    tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.dirty = false;
    setStatus(`Saved ${baseName(filePath)}`);
    return true;
  }

  async function saveTab(tab) {
    if (!tab.path) {
      return saveTabAs(tab);
    }
    const ok = await writeTab(tab, tab.path);
    renderTabs();
    return ok;
  }

  async function saveTabAs(tab) {
    const filePath = await api.saveAsDialog(tab.path || tab.name);
    if (!filePath) {
      return false;
    }
    if (!(await writeTab(tab, filePath))) {
      return false;
    }
    tab.path = filePath;
    tab.name = baseName(filePath);
    monaco.editor.setModelLanguage(tab.model, detectLanguage(filePath));
    updateStatusForModel();
    highlightTreeFile();
    renderTabs();
    return true;
  }

  async function saveAll() {
    for (const tab of tabs.filter((item) => item.dirty)) {
      if (!(await saveTab(tab))) {
        return;
      }
    }
  }

  async function handleOpenFiles() {
    const paths = await api.openFiles();
    for (const filePath of paths) {
      await openPath(filePath);
    }
  }

  async function requestClose() {
    for (const tab of tabs.filter((item) => item.dirty)) {
      if (!(await confirmDiscard(tab))) {
        return;
      }
    }
    api.approveClose();
  }

  // ---------- File tree ----------

  async function renderDir(container, dirPath, depth) {
    let entries;
    try {
      entries = await api.readDir(dirPath);
    } catch (error) {
      setStatus(`Could not read ${baseName(dirPath)}: ${error.message}`);
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.dataset.path = entry.path;
      row.style.paddingLeft = `${8 + depth * 12}px`;

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = entry.isDirectory ? '▸' : '';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = entry.name;
      row.append(arrow, label);
      container.appendChild(row);

      if (!entry.isDirectory) {
        row.addEventListener('click', () => openPath(entry.path));
        return;
      }
      const children = document.createElement('div');
      container.appendChild(children);
      let loaded = false;
      row.addEventListener('click', async () => {
        const expanded = arrow.textContent === '▾';
        if (expanded) {
          arrow.textContent = '▸';
          children.hidden = true;
          return;
        }
        arrow.textContent = '▾';
        children.hidden = false;
        if (!loaded) {
          loaded = true;
          await renderDir(children, entry.path, depth + 1);
          highlightTreeFile();
        }
      });
    });
  }

  async function openFolder() {
    const dirPath = await api.openFolder();
    if (!dirPath) {
      return;
    }
    els.folderName.textContent = baseName(dirPath);
    els.fileTree.replaceChildren();
    await renderDir(els.fileTree, dirPath, 0);
    setSidebarVisible(true);
  }

  function highlightTreeFile() {
    els.fileTree.querySelectorAll('.tree-row.active').forEach((row) => row.classList.remove('active'));
    if (!activeTab || !activeTab.path) {
      return;
    }
    els.fileTree.querySelectorAll('.tree-row').forEach((row) => {
      if (row.dataset.path === activeTab.path) {
        row.classList.add('active');
      }
    });
  }

  // ---------- Status bar ----------

  function updateStatusForModel() {
    if (!activeTab) {
      els.pos.textContent = '';
      els.eol.textContent = '';
      els.encoding.textContent = '';
      els.lang.value = 'plaintext';
      return;
    }
    const model = activeTab.model;
    els.encoding.textContent = ENCODING_LABELS[activeTab.encoding];
    els.eol.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    els.lang.value = model.getLanguageId();
    updateCursorStatus();
  }

  function updateCursorStatus() {
    if (!activeTab) {
      return;
    }
    const position = editor.getPosition();
    if (position) {
      els.pos.textContent = `Ln ${position.lineNumber}, Col ${position.column}`;
    }
  }

  // ---------- View settings ----------

  function setSidebarVisible(visible) {
    settings.sidebar = visible;
    localStorage.setItem('sidebar', String(visible));
    els.sidebar.classList.toggle('hidden', !visible);
    editor.layout();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme;
    monaco.editor.setTheme(settings.theme === 'light' ? 'vs' : 'vs-dark');
    localStorage.setItem('theme', settings.theme);
  }

  function toggleSetting(key, option) {
    settings[key] = !settings[key];
    localStorage.setItem(key, String(settings[key]));
    editor.updateOptions(option(settings[key]));
  }

  function runEditorAction(actionId) {
    editor.focus();
    editor.trigger('menu', actionId, null);
  }

  const menuActions = {
    new: () => addTab(null, ''),
    open: handleOpenFiles,
    openFolder,
    save: () => activeTab && saveTab(activeTab),
    saveAs: () => activeTab && saveTabAs(activeTab),
    saveAll,
    closeTab: () => activeTab && closeTab(activeTab),
    palette: () => runEditorAction('editor.action.quickCommand'),
    gotoLine: () => runEditorAction('editor.action.gotoLine'),
    find: () => runEditorAction('actions.find'),
    replace: () => runEditorAction('editor.action.startFindReplace'),
    toggleSidebar: () => setSidebarVisible(!settings.sidebar),
    toggleMinimap: () => toggleSetting('minimap', (on) => ({ minimap: { enabled: on } })),
    toggleWordWrap: () => toggleSetting('wordWrap', (on) => ({ wordWrap: on ? 'on' : 'off' })),
    toggleTheme: () => {
      settings.theme = settings.theme === 'light' ? 'dark' : 'light';
      applyTheme();
    },
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
  };

  // ---------- Startup ----------

  function init() {
    monaco = window.monaco;
    editor = monaco.editor.create(els.editor, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: settings.minimap },
      wordWrap: settings.wordWrap ? 'on' : 'off',
      fontSize: 14,
      fontFamily: "Consolas, 'Cascadia Code', 'Courier New', monospace",
      fontLigatures: true,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      mouseWheelZoom: true,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      scrollBeyondLastLine: false,
    });

    buildLanguageIndex();
    applyTheme();
    els.sidebar.classList.toggle('hidden', !settings.sidebar);
    updateEditorVisibility();

    editor.onDidChangeCursorPosition(updateCursorStatus);
    els.lang.addEventListener('change', () => {
      if (activeTab) {
        monaco.editor.setModelLanguage(activeTab.model, els.lang.value);
        editor.focus();
      }
    });
    els.eol.addEventListener('click', () => {
      if (activeTab) {
        const crlf = activeTab.model.getEOL() === '\r\n';
        activeTab.model.pushEOL(
          crlf ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF,
        );
      }
    });

    api.onMenu((action) => {
      const handler = menuActions[action];
      if (handler) {
        handler();
      }
    });
    api.onRequestClose(requestClose);

    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', async (event) => {
      event.preventDefault();
      for (const file of event.dataTransfer.files) {
        try {
          await openPath(await api.approveDropped(file));
        } catch (error) {
          setStatus(`Could not open ${file.name}: ${error.message}`);
        }
      }
    });
  }

  window.require.config({ paths: { vs: `${monacoBase}/vs` } });
  window.require(['vs/editor/editor.main'], init);
})();
