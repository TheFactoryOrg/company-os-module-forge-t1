import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { Workdir } from '../lib/workdir.js';
import { Sandbox } from '../lib/sandbox.js';

function setupSandboxableProject(dir: string): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'sb-test', version: '0.0.0', type: 'module',
    scripts: {
      typecheck: "echo 'tsc-mock' && exit 0",
      test:      "echo 'tests-mock' && exit 0",
      build:     "echo 'build-mock' && exit 0",
    },
  }, null, 2));
}

describe('Sandbox.run', () => {
  let baseDir: string;
  let db: Database.Database;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
    setupSandboxableProject(baseDir);
    db = new Database(':memory:');
    db.exec(`CREATE TABLE forge_sandbox_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL, iteration INTEGER NOT NULL,
      persona TEXT NOT NULL, status TEXT NOT NULL, command TEXT NOT NULL,
      stdout_tail TEXT, stderr_tail TEXT, duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  });

  it('records green status when all four steps pass', async () => {
    const wd = new Workdir(baseDir);
    const sb = new Sandbox(wd, db);
    const result = await sb.run({ runId: 1, iteration: 1, persona: 'builder' });
    expect(result.status).toBe('green');
    const row = db.prepare('SELECT status FROM forge_sandbox_runs LIMIT 1').get() as { status: string };
    expect(row.status).toBe('green');
  });

  it('returns install_failed and stops if npm install fails (e.g., unresolvable dep)', async () => {
    fs.writeFileSync(path.join(baseDir, 'package.json'), JSON.stringify({
      name: 'sb-test', version: '0.0.0', type: 'module',
      dependencies: { 'this-package-does-not-exist-xyzzy-nope': '99.99.99' },
      scripts: { typecheck: 'exit 0', test: 'exit 0', build: 'exit 0' },
    }));
    const wd = new Workdir(baseDir);
    const sb = new Sandbox(wd, db);
    const result = await sb.run({ runId: 1, iteration: 1, persona: 'builder' });
    expect(result.status).toBe('install_failed');
  });

  it('returns typecheck_failed and stops if typecheck fails', async () => {
    fs.writeFileSync(path.join(baseDir, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'exit 1', test: 'echo nope', build: 'echo nope' },
    }));
    const wd = new Workdir(baseDir);
    const sb = new Sandbox(wd, db);
    const result = await sb.run({ runId: 1, iteration: 1, persona: 'builder' });
    expect(result.status).toBe('typecheck_failed');
  });

  it('returns tests_failed if tests fail (after typecheck green)', async () => {
    fs.writeFileSync(path.join(baseDir, 'package.json'), JSON.stringify({
      scripts: { typecheck: 'exit 0', test: 'exit 1', build: 'echo nope' },
    }));
    const wd = new Workdir(baseDir);
    const sb = new Sandbox(wd, db);
    const result = await sb.run({ runId: 1, iteration: 1, persona: 'quality' });
    expect(result.status).toBe('tests_failed');
  });
});
