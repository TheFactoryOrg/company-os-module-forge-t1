import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workdir } from '../lib/workdir.js';

describe('Workdir', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-')); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  it('writes files preserving directory structure', async () => {
    const wd = new Workdir(baseDir);
    await wd.writeFiles([
      { path: 'app/page.tsx', content: 'export default function P(){return null}' },
      { path: 'lib/util.ts',  content: 'export const x = 1;' },
    ]);
    expect(fs.existsSync(path.join(baseDir, 'app/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'lib/util.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(baseDir, 'app/page.tsx'), 'utf-8')).toContain('default function P');
  });

  it('writeFiles refuses path traversal', async () => {
    const wd = new Workdir(baseDir);
    await expect(wd.writeFiles([{ path: '../escape.txt', content: 'x' }])).rejects.toThrow(/traversal/);
    await expect(wd.writeFiles([{ path: '/etc/passwd', content: 'x' }])).rejects.toThrow(/absolute/);
  });

  it('runShell captures stdout, stderr, exit code', async () => {
    const wd = new Workdir(baseDir);
    const r = await wd.runShell('echo hello && echo err 1>&2 && exit 0', { timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello');
    expect(r.stderr).toContain('err');
  });

  it('runShell enforces timeout', async () => {
    const wd = new Workdir(baseDir);
    const r = await wd.runShell('sleep 5', { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });
});
