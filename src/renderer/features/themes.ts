(function () {
  'use strict';

  // Extra editor themes. Palettes are original selections of colours, not
  // copies of third-party theme files. Workbench (UI) variables for each id
  // live in themes.css; this file supplies the Monaco part and the commands.

  interface ThemePalette {
    bg: string; fg: string; sel: string; line: string; cursor: string;
    lineNo: string; lineNoActive: string; ws: string; widget: string;
    comment: string; string: string; keyword: string; number: string;
    type: string; tag: string; attr: string; regexp: string;
  }

  interface ThemeSource {
    id: string;
    label: string;
    base: 'vs' | 'vs-dark';
    p: ThemePalette;
  }

  const THEMES: ThemeSource[] = [
    {
      id: 'monokai', label: 'Monokai', base: 'vs-dark',
      p: {
        bg: '#272822', fg: '#f8f8f2', sel: '#49483e', line: '#3e3d32', cursor: '#f8f8f0',
        lineNo: '#90908a', lineNoActive: '#c2c2bc', ws: '#464741', widget: '#1e1f1c',
        comment: '#75715e', string: '#e6db74', keyword: '#f92672', number: '#ae81ff',
        type: '#66d9ef', tag: '#f92672', attr: '#a6e22e', regexp: '#fd971f'
      }
    },
    {
      id: 'solarized-dark', label: 'Solarized Dark', base: 'vs-dark',
      p: {
        bg: '#002b36', fg: '#93a1a1', sel: '#0a4a5a', line: '#073642', cursor: '#93a1a1',
        lineNo: '#586e75', lineNoActive: '#93a1a1', ws: '#0d4655', widget: '#00252f',
        comment: '#586e75', string: '#2aa198', keyword: '#859900', number: '#d33682',
        type: '#b58900', tag: '#268bd2', attr: '#93a1a1', regexp: '#cb4b16'
      }
    },
    {
      id: 'solarized-light', label: 'Solarized Light', base: 'vs',
      p: {
        bg: '#fdf6e3', fg: '#586e75', sel: '#e0dac1', line: '#eee8d5', cursor: '#586e75',
        lineNo: '#93a1a1', lineNoActive: '#586e75', ws: '#e0dac1', widget: '#eee8d5',
        comment: '#93a1a1', string: '#2aa198', keyword: '#859900', number: '#d33682',
        type: '#b58900', tag: '#268bd2', attr: '#586e75', regexp: '#cb4b16'
      }
    },
    {
      id: 'zenburn', label: 'Zenburn', base: 'vs-dark',
      p: {
        bg: '#3f3f3f', fg: '#dcdccc', sel: '#5f5f5f', line: '#4a4a4a', cursor: '#dcdccc',
        lineNo: '#8f8f8f', lineNoActive: '#dcdccc', ws: '#505050', widget: '#383838',
        comment: '#7f9f7f', string: '#cc9393', keyword: '#f0dfaf', number: '#8cd0d3',
        type: '#dfdfbf', tag: '#e3ceab', attr: '#dfaf8f', regexp: '#dc8cc3'
      }
    },
    {
      id: 'obsidian', label: 'Obsidian', base: 'vs-dark',
      p: {
        bg: '#293134', fg: '#e0e2e4', sel: '#3e5a66', line: '#2f3a3e', cursor: '#e0e2e4',
        lineNo: '#7f8c91', lineNoActive: '#cfd3d6', ws: '#3b474b', widget: '#232a2d',
        comment: '#66747b', string: '#ec7600', keyword: '#93c763', number: '#ffcd22',
        type: '#678cb1', tag: '#8cbbad', attr: '#678cb1', regexp: '#d39745'
      }
    },
    {
      id: 'hc-black', label: 'High Contrast', base: 'vs-dark',
      p: {
        bg: '#000000', fg: '#ffffff', sel: '#264f78', line: '#1a1a1a', cursor: '#ffffff',
        lineNo: '#ffffff', lineNoActive: '#ffffff', ws: '#6fc3df', widget: '#000000',
        comment: '#7ca668', string: '#ce9178', keyword: '#569cd6', number: '#b5cea8',
        type: '#4ec9b0', tag: '#569cd6', attr: '#9cdcfe', regexp: '#d16969'
      }
    }
  ];

  // Built-in themes registered by core; only their commands are added here.
  const CORE_THEME_IDS = ['dark', 'light'];

  /**
   * Expand a flat palette into Monaco `colors` and token `rules`.
   * @param p Palette, see THEMES.
   */
  function toMonaco(p: ThemePalette): { colors: monaco.editor.IColors; rules: monaco.editor.ITokenThemeRule[] } {
    const strip = (color: string): string => color.slice(1);
    return {
      colors: {
        'editor.background': p.bg,
        'editor.foreground': p.fg,
        'editor.selectionBackground': p.sel,
        'editor.inactiveSelectionBackground': p.sel,
        'editor.lineHighlightBackground': p.line,
        'editorCursor.foreground': p.cursor,
        'editorLineNumber.foreground': p.lineNo,
        'editorLineNumber.activeForeground': p.lineNoActive,
        'editorWhitespace.foreground': p.ws,
        'editorIndentGuide.background1': p.ws,
        'editorIndentGuide.activeBackground1': p.lineNo,
        'editorWidget.background': p.widget,
        'editorSuggestWidget.background': p.widget,
        'minimap.background': p.bg
      },
      rules: [
        { token: '', foreground: strip(p.fg) },
        { token: 'comment', foreground: strip(p.comment), fontStyle: 'italic' },
        { token: 'string', foreground: strip(p.string) },
        { token: 'string.escape', foreground: strip(p.regexp) },
        { token: 'keyword', foreground: strip(p.keyword) },
        { token: 'number', foreground: strip(p.number) },
        { token: 'type', foreground: strip(p.type) },
        { token: 'tag', foreground: strip(p.tag) },
        { token: 'attribute.name', foreground: strip(p.attr) },
        { token: 'attribute.value', foreground: strip(p.string) },
        { token: 'regexp', foreground: strip(p.regexp) },
        { token: 'delimiter', foreground: strip(p.fg) }
      ]
    };
  }

  THEMES.map((theme) => theme.id).concat(CORE_THEME_IDS).forEach((id) => {
    CodePadCommands.register({
      id: `view.theme.${id}`,
      run: (ctx) => ctx.settings.set('ui.theme', id)
    });
  });

  CodePadCommands.register({
    id: 'view.theme.pick',
    async run(ctx) {
      const items = ctx.themes.list().map((theme) => ({ label: theme.label, value: theme.id }));
      const id = await ctx.ui.pick({ title: 'Choose Theme', items });
      if (id) {
        ctx.settings.set('ui.theme', id);
      }
    }
  });

  CodePadFeatures.register('themes', {
    init(ctx) {
      THEMES.forEach((theme) => {
        ctx.themes.register({
          id: theme.id,
          label: theme.label,
          base: theme.base,
          monaco: toMonaco(theme.p)
        });
      });
    }
  });
})();
