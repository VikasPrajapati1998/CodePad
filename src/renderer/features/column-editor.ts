'use strict';

// Column editor: inserts the same text, or a number sequence, at every selected
// line position in a single undo step.
(() => {
  interface NumberOptions {
    initial: number;
    step: number;
    repeat: number;
    base: number;
    zeroPad: boolean;
    upper: boolean;
  }

  /** An insertion point; `pad` = spaces needed to reach a column past the line end. */
  interface Target {
    range: monaco.IRange;
    pad: number;
  }

  interface NumberForm {
    initial: HTMLInputElement;
    step: HTMLInputElement;
    repeat: HTMLInputElement;
    zeroPad: HTMLInputElement;
    upper: HTMLInputElement;
    base: HTMLSelectElement;
  }

  type ColumnMode = 'text' | 'number';

  const BASES = [
    { value: 10, label: 'Decimal' },
    { value: 16, label: 'Hexadecimal' },
    { value: 8, label: 'Octal' },
    { value: 2, label: 'Binary' },
  ];

  // Remembered between invocations (memory only).
  const last: {
    mode: ColumnMode; text: string; initial: string; step: string; repeat: string;
    zeroPad: boolean; base: number; upper: boolean;
  } = { mode: 'text', text: '', initial: '1', step: '1', repeat: '1', zeroPad: false, base: 10, upper: false };

  /**
   * Insertion targets for the current selections, in document order.
   */
  function collectTargets(editor: monaco.editor.IStandaloneCodeEditor): Target[] {
    const model = editor.getModel();
    const selections = editor.getSelections() || [];
    if (!model || selections.length === 0) return [];
    const sorted = selections.slice().sort((a, b) => a.getStartPosition().isBefore(b.getStartPosition()) ? -1 : 1);
    if (sorted.length > 1) return sorted.map((range) => ({ range, pad: 0 }));

    const sel = sorted[0];
    if (sel.startLineNumber === sel.endLineNumber) return [{ range: sel, pad: 0 }];

    const targets: Target[] = [];
    const lastLine = sel.endColumn === 1 ? sel.endLineNumber - 1 : sel.endLineNumber;
    for (let line = sel.startLineNumber; line <= lastLine; line += 1) {
      const max = model.getLineMaxColumn(line);
      const column = Math.min(sel.startColumn, max);
      targets.push({
        range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
        pad: Math.max(0, sel.startColumn - max),
      });
    }
    return targets;
  }

  function formatNumber(n: number, base: number, upper: boolean): { sign: string; digits: string } {
    const digits = Math.abs(n).toString(base);
    return { sign: n < 0 ? '-' : '', digits: upper ? digits.toUpperCase() : digits };
  }

  function buildNumbers(count: number, opts: NumberOptions): string[] {
    const parts: { sign: string; digits: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      parts.push(formatNumber(opts.initial + Math.floor(i / opts.repeat) * opts.step, opts.base, opts.upper));
    }
    const width = opts.zeroPad ? Math.max(...parts.map((p) => p.digits.length)) : 0;
    return parts.map((p) => p.sign + p.digits.padStart(width, '0'));
  }

  function parseInteger(value: string, min: number): number | null {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= min ? n : null;
  }

  /** Reads the number options from the form, or returns an error message. */
  function readNumberOptions(form: NumberForm): NumberOptions | { error: string } {
    const initial = parseInteger(form.initial.value, -Number.MAX_SAFE_INTEGER);
    const step = parseInteger(form.step.value, -Number.MAX_SAFE_INTEGER);
    const repeat = parseInteger(form.repeat.value, 1);
    if (initial === null) return { error: 'Initial number must be a whole number.' };
    if (step === null) return { error: 'Increment must be a whole number.' };
    if (repeat === null) return { error: 'Repeat must be a whole number of at least 1.' };
    return {
      initial,
      step,
      repeat,
      base: Number(form.base.value),
      zeroPad: form.zeroPad.checked,
      upper: form.upper.checked,
    };
  }

  function field(labelText: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'cp-text-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    label.append(span, control);
    return label;
  }

  function input(type: 'text' | 'radio', value: string): HTMLInputElement;
  function input(type: 'checkbox', value: boolean): HTMLInputElement;
  function input(type: string, value: string | boolean): HTMLInputElement {
    const el = document.createElement('input');
    el.type = type;
    if (typeof value === 'boolean') el.checked = value;
    else el.value = value;
    return el;
  }

  function openDialog(ctx: CodePadCtx): void {
    const editor = ctx.editor;
    if (!editor || !editor.getModel()) return;
    if (editor.getOption(ctx.monaco.editor.EditorOption.readOnly)) {
      ctx.status.set('This tab is read-only.');
      return;
    }

    const body = document.createElement('div');
    body.className = 'cp-text-colform';

    const modeRow = document.createElement('div');
    modeRow.className = 'cp-text-row';
    const modes = {} as Record<ColumnMode, HTMLInputElement>;
    const modeChoices: [ColumnMode, string][] = [['text', 'Text to insert'], ['number', 'Number to insert']];
    for (const [mode, text] of modeChoices) {
      const radio = input('radio', '');
      radio.name = 'cp-column-mode';
      radio.value = mode;
      radio.checked = last.mode === mode;
      modes[mode] = radio;
      modeRow.append(field(text, radio));
    }

    const textInput = input('text', last.text);
    const textGroup = document.createElement('div');
    textGroup.className = 'cp-text-group';
    textGroup.append(field('Text', textInput));

    const form: NumberForm = {
      initial: input('text', last.initial),
      step: input('text', last.step),
      repeat: input('text', last.repeat),
      zeroPad: input('checkbox', last.zeroPad),
      upper: input('checkbox', last.upper),
      base: document.createElement('select'),
    };
    for (const base of BASES) {
      const option = document.createElement('option');
      option.value = String(base.value);
      option.textContent = base.label;
      option.selected = base.value === last.base;
      form.base.append(option);
    }
    const numberGroup = document.createElement('div');
    numberGroup.className = 'cp-text-group';
    numberGroup.append(
      field('Initial number', form.initial),
      field('Increment by', form.step),
      field('Repeat', form.repeat),
      field('Format', form.base),
      field('Leading zeros', form.zeroPad),
      field('Upper-case hex digits', form.upper),
    );

    const message = document.createElement('div');
    message.className = 'cp-text-message';
    const buttons = document.createElement('div');
    buttons.className = 'cp-text-buttons';
    const okButton = document.createElement('button');
    okButton.type = 'button';
    okButton.textContent = 'Insert';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = 'Cancel';
    buttons.append(okButton, cancelButton);
    body.append(modeRow, textGroup, numberGroup, message, buttons);

    const isNumber = () => modes.number.checked;
    const refresh = () => {
      textGroup.hidden = isNumber();
      numberGroup.hidden = !isNumber();
      const count = collectTargets(ctx.editor).length;
      if (!isNumber()) {
        message.textContent = `${count} position${count === 1 ? '' : 's'}`;
        return;
      }
      const opts = readNumberOptions(form);
      message.textContent = 'error' in opts ? opts.error
        : `${count} position${count === 1 ? '' : 's'}: ${buildNumbers(Math.min(count, 3), opts).join(', ')}${count > 3 ? ', ...' : ''}`;
    };
    body.addEventListener('input', refresh);
    body.addEventListener('change', refresh);

    const modal = ctx.ui.modal({ title: 'Column Editor', body, buttons: [] });

    const apply = () => {
      const current = ctx.editor;
      const targets = collectTargets(current);
      if (targets.length === 0) return;
      let values: string[];
      if (isNumber()) {
        const opts = readNumberOptions(form);
        if ('error' in opts) {
          message.textContent = opts.error;
          return;
        }
        values = buildNumbers(targets.length, opts);
        Object.assign(last, {
          mode: 'number', initial: form.initial.value, step: form.step.value, repeat: form.repeat.value,
          zeroPad: opts.zeroPad, base: opts.base, upper: opts.upper,
        });
      } else {
        values = targets.map(() => textInput.value);
        Object.assign(last, { mode: 'text', text: textInput.value });
      }
      const edits = targets.map((target, i) => ({ range: target.range, text: ' '.repeat(target.pad) + values[i] }));
      current.pushUndoStop();
      current.executeEdits('column-editor', edits);
      current.pushUndoStop();
      modal.close();
      current.focus();
    };

    okButton.addEventListener('click', apply);
    cancelButton.addEventListener('click', () => {
      modal.close();
      ctx.editor.focus();
    });
    body.addEventListener('keydown', (event) => {
      const target = event.target;
      if (event.key === 'Enter' && target instanceof HTMLInputElement && target.type !== 'checkbox') {
        event.preventDefault();
        apply();
      }
    });

    refresh();
    (isNumber() ? form.initial : textInput).focus();
  }

  CodePadCommands.register({
    id: 'text.columnEditor',
    run: (ctx) => openDialog(ctx),
  });
})();
