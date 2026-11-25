// Online grammar check: AI > Check Grammar Online sends the selection (or the whole file) to the free LanguageTool
// service through main, which asks the user first, and shows the findings as squiggles with quick fixes. The markers
// disappear when the text is edited, because their positions would no longer match. Spelling stays with the offline
// checker (spellcheck.ts); this command needs the internet and says so when it is missing.
(() => {
  const OWNER = 'cp-grammar';
  const MARKER_SOURCE = 'Grammar';
  const MAX_CHARS = 20000;

  let busy = false;
  /** Replacement suggestions per marker position ("line:column:line:column"). */
  const replacements = new WeakMap<monaco.editor.ITextModel, Map<string, string[]>>();
  const watching = new WeakMap<monaco.editor.ITextModel, monaco.IDisposable>();

  const keyOf = (range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): string =>
    `${range.startLineNumber}:${range.startColumn}:${range.endLineNumber}:${range.endColumn}`;

  function clearMarkers(ctx: CodePadCtx, model: monaco.editor.ITextModel): void {
    ctx.monaco.editor.setModelMarkers(model, OWNER, []);
    replacements.delete(model);
    watching.get(model)?.dispose();
    watching.delete(model);
  }

  function showMatches(ctx: CodePadCtx, model: monaco.editor.ITextModel, base: number, matches: CpGrammarMatch[]): void {
    clearMarkers(ctx, model);
    const found = new Map<string, string[]>();
    const markers: monaco.editor.IMarkerData[] = matches.map((match) => {
      const start = model.getPositionAt(base + match.offset);
      const end = model.getPositionAt(base + match.offset + match.length);
      const marker: monaco.editor.IMarkerData = {
        severity: ctx.monaco.MarkerSeverity.Warning,
        message: match.message,
        source: MARKER_SOURCE,
        code: match.ruleId || undefined,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
      found.set(keyOf(marker), match.replacements);
      return marker;
    });
    ctx.monaco.editor.setModelMarkers(model, OWNER, markers);
    replacements.set(model, found);
    watching.set(model, model.onDidChangeContent(() => clearMarkers(ctx, model)));
  }

  function provideActions(ctx: CodePadCtx, model: monaco.editor.ITextModel, requested: monaco.Range): monaco.languages.CodeActionList {
    const actions: monaco.languages.CodeAction[] = [];
    const known = replacements.get(model);
    const ours = ctx.monaco.editor
      .getModelMarkers({ resource: model.uri, owner: OWNER })
      .filter((item) => requested.intersectRanges(new ctx.monaco.Range(item.startLineNumber, item.startColumn, item.endLineNumber, item.endColumn)));
    for (const marker of ours) {
      const range = new ctx.monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
      (known?.get(keyOf(marker)) ?? []).forEach((text, index) => {
        actions.push({
          title: text === '' ? 'Remove' : text,
          kind: 'quickfix',
          diagnostics: [marker],
          isPreferred: index === 0,
          edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range, text } }] },
        });
      });
    }
    return { actions, dispose: () => undefined };
  }

  CodePadCommands.register({
    id: 'grammar.checkOnline',
    async run(ctx) {
      const tab = ctx.tabs.active();
      if (!tab || tab.kind !== 'text') {
        ctx.status.set('Open a text file first.');
        return;
      }
      if (busy) {
        return;
      }
      const { model } = tab;
      const selection = ctx.editor.getSelection();
      const range = selection && !selection.isEmpty() ? selection : null;
      if (!range && ctx.large.isLarge(tab)) {
        ctx.status.set('Select the text first (large files work on the selection).');
        return;
      }
      const text = range ? model.getValueInRange(range) : model.getValue();
      if (text.length > MAX_CHARS) {
        ctx.status.set(`The free grammar service accepts at most ${MAX_CHARS} characters at a time. Select a smaller part.`);
        return;
      }
      const base = range ? model.getOffsetAt(range.getStartPosition()) : 0;
      busy = true;
      ctx.status.set('Checking grammar online...');
      try {
        const result = await window.codepad.grammar.check(text);
        if (!result.ok) {
          ctx.status.set(result.message);
        } else if (model.getValueLength() < base + text.length || model.isDisposed()) {
          ctx.status.set('The text changed while it was being checked. Run the check again.');
        } else if (result.matches.length === 0) {
          clearMarkers(ctx, model);
          ctx.status.set('No grammar issues found.');
        } else {
          showMatches(ctx, model, base, result.matches);
          ctx.status.set(`Grammar: ${result.matches.length} ${result.matches.length === 1 ? 'issue' : 'issues'} found. Hover a squiggle or press Ctrl+. for fixes.`);
        }
      } catch (error) {
        ctx.status.set(`The grammar check failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
      }
    },
  });

  CodePadFeatures.register('grammar-online', {
    init(ctx) {
      ctx.monaco.languages.registerCodeActionProvider('*', {
        provideCodeActions: (model, range) => provideActions(ctx, model, range),
      });
    },
  });
})();
