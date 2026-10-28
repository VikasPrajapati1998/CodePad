'use strict';

// Hashes: MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 of the selection, the tab
// text, or a file on disk. Text hashes run here (Web Crypto + a small MD5);
// file hashes are streamed by the main process. Results go to the bottom
// "output" panel, which this module registers.
//
// md5 test vectors (RFC 1321): "" d41d8cd98f00b204e9800998ecf8427e,
// "abc" 900150983cd24fb0d6963f7d28e17f72,
// "message digest" f96b697d7cb7938d525a2f31aaf161d0.
(() => {
  interface HashAlgorithm {
    id: string;
    label: string;
    subtle: string | null;
  }

  type PickedFile = { path: string } | { recent: number };

  const ALGORITHMS: HashAlgorithm[] = [
    { id: 'md5', label: 'MD5', subtle: null },
    { id: 'sha1', label: 'SHA-1', subtle: 'SHA-1' },
    { id: 'sha256', label: 'SHA-256', subtle: 'SHA-256' },
    { id: 'sha384', label: 'SHA-384', subtle: 'SHA-384' },
    { id: 'sha512', label: 'SHA-512', subtle: 'SHA-512' },
  ];

  const MD5_SHIFTS = [
    ...Array(4).fill([7, 12, 17, 22]).flat(),
    ...Array(4).fill([5, 9, 14, 20]).flat(),
    ...Array(4).fill([4, 11, 16, 23]).flat(),
    ...Array(4).fill([6, 10, 15, 21]).flat(),
  ];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

  const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  /**
   * MD5 digest of a byte array (RFC 1321).
   * @param bytes Input bytes.
   * @returns lower-case hex digest
   */
  function md5(bytes: Uint8Array): string {
    const total = (((bytes.length + 8) >>> 6) + 1) * 64;
    const buffer = new Uint8Array(total);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(total - 8, (bytes.length * 8) >>> 0, true);
    view.setUint32(total - 4, Math.floor(bytes.length / 0x20000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const words: number[] = new Array<number>(16);
    for (let offset = 0; offset < total; offset += 64) {
      for (let j = 0; j < 16; j += 1) words[j] = view.getUint32(offset + j * 4, true);
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;
      for (let i = 0; i < 64; i += 1) {
        let f: number;
        let g: number;
        if (i < 16) {
          f = (b & c) | (~b & d);
          g = i;
        } else if (i < 32) {
          f = (d & b) | (~d & c);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          f = b ^ c ^ d;
          g = (3 * i + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          g = (7 * i) % 16;
        }
        f = (f + a + MD5_K[i] + words[g]) >>> 0;
        a = d;
        d = c;
        c = b;
        b = (b + ((f << MD5_SHIFTS[i]) | (f >>> (32 - MD5_SHIFTS[i])))) >>> 0;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    [a0, b0, c0, d0].forEach((word, i) => out.setUint32(i * 4, word, true));
    return toHex(new Uint8Array(out.buffer));
  }

  async function hashBytes(bytes: Uint8Array<ArrayBuffer>, algo: HashAlgorithm): Promise<string> {
    if (algo.subtle === null) return md5(bytes);
    return toHex(new Uint8Array(await crypto.subtle.digest(algo.subtle, bytes)));
  }

  // ---- output panel ----------------------------------------------------------

  const outputState = { title: '', text: '' };
  let outputView: { title: HTMLElement; body: HTMLElement } | null = null;

  function drawOutput(): void {
    if (!outputView) return;
    outputView.title.textContent = outputState.title;
    outputView.body.textContent = outputState.text;
  }

  function showOutput(ctx: CodePadCtx, title: string, text: string): void {
    outputState.title = title;
    outputState.text = text;
    drawOutput();
    ctx.panels.show('output');
  }

  function createOutputPanel(container: HTMLElement, ctx: CodePadCtx): CodePadPanelInstance {
    container.classList.add('cp-text-output');
    const bar = document.createElement('div');
    bar.className = 'cp-text-toolbar';
    const title = document.createElement('span');
    title.className = 'cp-text-output-title';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cp-text-iconbtn';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => ctx.clipboard.write(outputState.text));
    bar.append(title, copy);
    const body = document.createElement('pre');
    body.className = 'cp-text-output-body';
    container.append(bar, body);
    outputView = { title, body };
    drawOutput();
    return {
      dispose() {
        outputView = null;
      },
    };
  }

  // ---- commands -------------------------------------------------------------

  async function pickAlgorithms(ctx: CodePadCtx): Promise<HashAlgorithm[]> {
    const chosen = await ctx.ui.pick({
      title: 'Hash algorithms',
      items: ALGORITHMS.map((algo) => ({ label: algo.label, value: algo.id })),
      multi: true,
    });
    if (!Array.isArray(chosen) || chosen.length === 0) return [];
    return ALGORITHMS.filter((algo) => chosen.includes(algo.id));
  }

  async function hashText(ctx: CodePadCtx, text: string, title: string): Promise<void> {
    const algorithms = await pickAlgorithms(ctx);
    if (algorithms.length === 0) return;
    const bytes = new TextEncoder().encode(text);
    const lines = [`${bytes.length} bytes (UTF-8)`, ''];
    for (const algo of algorithms) {
      lines.push(`${algo.label.padEnd(8)}${await hashBytes(bytes, algo)}`);
    }
    showOutput(ctx, title, lines.join('\n'));
  }

  async function hashPath(ctx: CodePadCtx, filePath: string, title: string): Promise<void> {
    const algorithms = await pickAlgorithms(ctx);
    if (algorithms.length === 0) return;
    const lines = [filePath, ''];
    for (const algo of algorithms) {
      try {
        const { hex, size } = await ctx.files.hashFile(filePath, algo.id);
        if (lines.length === 2) lines.splice(1, 0, `${size} bytes`);
        lines.push(`${algo.label.padEnd(8)}${hex}`);
      } catch (err) {
        lines.push(`${algo.label.padEnd(8)}error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    showOutput(ctx, title, lines.join('\n'));
  }

  const register = (id: string, run: (ctx: CodePadCtx) => Promise<void>): void => CodePadCommands.register({ id, run });

  register('hash.selection', async (ctx) => {
    const current = ctx.text.selectionOrDocument();
    if (!current) return;
    if (!current.isSelection) {
      ctx.status.set('Select the text to hash first.');
      return;
    }
    const eol = current.model.getEOL();
    await hashText(ctx, current.ranges.map((range) => current.model.getValueInRange(range)).join(eol), 'Hash of selection');
  });

  register('hash.tab', async (ctx) => {
    const current = ctx.text.selectionOrDocument();
    if (!current) return;
    await hashText(ctx, current.model.getValue(), `Hash of ${current.tab.name}`);
  });

  register('hash.currentFile', async (ctx) => {
    const tab = ctx.tabs.active();
    if (!tab || !tab.path) {
      ctx.status.set('Save the file first to hash it on disk.');
      return;
    }
    await hashPath(ctx, tab.path, `Hash of ${tab.name} on disk`);
  });

  register('hash.file', async (ctx) => {
    const items: CodePadPickItem<PickedFile>[] = [];
    const seen = new Set<string>();
    for (const tab of ctx.tabs.list()) {
      if (tab.path && !seen.has(tab.path)) {
        seen.add(tab.path);
        items.push({ label: tab.name, detail: tab.path, value: { path: tab.path } });
      }
    }
    ((await ctx.files.recent.list()) || []).forEach((entry, index) => {
      if (!seen.has(entry.path)) {
        seen.add(entry.path);
        items.push({ label: entry.name, detail: entry.path, value: { recent: index } });
      }
    });
    if (items.length === 0) {
      ctx.status.set('No open or recent files to hash.');
      return;
    }
    const choice = await ctx.ui.pick({ title: 'Hash a file', items });
    if (!choice) return;
    const filePath = 'path' in choice ? choice.path : await ctx.files.recent.approveAt(choice.recent);
    await hashPath(ctx, filePath, `Hash of ${ctx.app.baseName(filePath)}`);
  });

  CodePadFeatures.register('hashes', {
    init(ctx) {
      ctx.panels.register({
        id: 'output',
        title: 'Output',
        location: 'bottom',
        order: 40,
        render: (container) => createOutputPanel(container, ctx),
      });
      // Other modules (e.g. Summary) publish text here with ctx.events.emit('output:set', {title, text}).
      ctx.events.on('output:set', ({ title, text }) => showOutput(ctx, title, text));
    },
  });
})();
