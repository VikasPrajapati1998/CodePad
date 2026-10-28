/*
 * Build driver. It runs before any compiled output exists, so Node executes this file directly by stripping the
 * types (Node 22.18+; no loader). Compiles the main-process and renderer projects with tsc into dist/, then copies
 * every non-TypeScript file under src/ (HTML, CSS) and assets/icon.png next to the emitted JavaScript.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root: string = path.join(import.meta.dirname, '..');
const dist: string = path.join(root, 'dist');
const src: string = path.join(root, 'src');
const tsc: string = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function compile(project: string): void {
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(root, project)], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function copyStatic(dir: string): void {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      copyStatic(from);
    } else if (!entry.name.endsWith('.ts')) {
      const to = path.join(dist, path.relative(src, from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  });
}

fs.rmSync(dist, { recursive: true, force: true });
compile('tsconfig.main.json');
compile('tsconfig.renderer.json');
copyStatic(src);
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(dist, 'assets', 'icon.png'));
