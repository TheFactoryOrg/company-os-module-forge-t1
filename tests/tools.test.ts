import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createForgeT1Tools } from '../tools.js';
import type { ModuleToolContext, FeatureCatalogSurface } from '../types.js';

function makeCtx(): { ctx: ModuleToolContext; db: Database.Database; published: Array<{ type: string; payload: unknown }> } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE forge_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier TEXT NOT NULL, experiment_id TEXT NOT NULL, plan_id INTEGER NOT NULL,
      status TEXT NOT NULL, current_stage TEXT,
      iteration_count INTEGER NOT NULL DEFAULT 0, max_iterations INTEGER NOT NULL DEFAULT 10,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      solution_repo TEXT, solution_slug TEXT, final_commit_sha TEXT,
      paused_at TEXT, ready_at TEXT, cancelled_at TEXT, pending_escalation_id INTEGER,
      last_sandbox_status TEXT, last_sandbox_error TEXT
    );
    CREATE TABLE forge_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL, iteration INTEGER NOT NULL, persona TEXT NOT NULL,
      pass INTEGER NOT NULL, verdict_json TEXT NOT NULL, agent_run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE forge_sandbox_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL, iteration INTEGER NOT NULL,
      persona TEXT NOT NULL, status TEXT NOT NULL, command TEXT NOT NULL,
      stdout_tail TEXT, stderr_tail TEXT, duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const published: Array<{ type: string; payload: unknown }> = [];
  const featureCatalog: FeatureCatalogSurface = {
    list: vi.fn(() => [{
      id: 'feat-landing', name: 'Landing', description: 'd', kind: 'snippet', version: 1,
      categories: ['scaffold'], tags: ['nextjs'], applicable_tiers: ['t1'], applicable_tracks: ['simple_saas'],
      credentials_required: [], source_path: 'features/feat-landing',
    }]),
    get: vi.fn(() => null),
    materialize: vi.fn(async () => ({ files_added: ['app/page.tsx'], package_deps_added: ['next'], env_vars_required: [] })),
    proposePromotion: vi.fn(() => ({ promotion_id: 42 })),
  };
  const ctx: ModuleToolContext = {
    db,
    bus: {
      publish(type, _src, payload) { published.push({ type, payload }); return published.length; },
      getRecentEvents: () => [],
    },
    moduleId: 'forge-t1',
    featureCatalog,
  };
  return { ctx, db, published };
}

describe('forge-t1 tool handlers', () => {
  let env: ReturnType<typeof makeCtx>;
  let tools: ReturnType<typeof createForgeT1Tools>;
  beforeEach(() => {
    env = makeCtx();
    tools = createForgeT1Tools(env.ctx);
    env.db.prepare(
      "INSERT INTO forge_runs (tier, experiment_id, plan_id, status, iteration_count) VALUES ('t1', 'exp-foo', 7, 'running:builder', 1)"
    ).run();
  });

  it('query_feature_catalog returns Catalog matches', async () => {
    const out = await tools.execute('query_feature_catalog', { kind: 'snippet', tier: 't1' });
    const parsed = JSON.parse(out as string) as { features: Array<{ id: string }> };
    expect(parsed.features[0].id).toBe('feat-landing');
  });

  it('record_verdict writes a forge_verdicts row and publishes forge_t1.verdict.recorded', async () => {
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    const out = await tools.execute('record_verdict', {
      run_id: runId, iteration: 1, persona: 'builder', pass: true,
      verdict: { notes: 'looks good', files_changed: ['app/page.tsx'] },
    });
    const parsed = JSON.parse(out as string) as { status: string; verdict_id: number };
    expect(parsed.status).toBe('recorded');
    const row = env.db.prepare('SELECT persona, pass FROM forge_verdicts WHERE id = ?').get(parsed.verdict_id) as { persona: string; pass: number };
    expect(row.persona).toBe('builder');
    expect(row.pass).toBe(1);
    expect(env.published.find(e => e.type === 'forge_t1.verdict.recorded')).toBeTruthy();
  });

  it('record_verdict rejects unknown persona', async () => {
    const out = await tools.execute('record_verdict', { run_id: 1, iteration: 1, persona: 'wizard', pass: true, verdict: {} });
    const parsed = JSON.parse(out as string) as { status: string; field: string };
    expect(parsed.status).toBe('invalid_input');
    expect(parsed.field).toBe('persona');
  });

  it('propose_feature_promotion delegates to ctx.featureCatalog.proposePromotion', async () => {
    const out = await tools.execute('propose_feature_promotion', {
      run_id: 1, spec: { id: 'feat-magic', kind: 'snippet' }, payload_path: '/tmp/x',
    });
    const parsed = JSON.parse(out as string) as { promotion_id: number; status: string };
    expect(parsed.status).toBe('proposed');
    expect(parsed.promotion_id).toBe(42);
  });

  it('publish_build_ready is a no-op for the agent (coordinator owns publication)', async () => {
    const out = await tools.execute('publish_build_ready', { run_id: 1 });
    const parsed = JSON.parse(out as string) as { status: string };
    expect(parsed.status).toBe('deferred_to_coordinator');
  });
});

// ---------------------------------------------------------------------------
// commit_to_solution sandbox + Quality carve-out integration tests.
//
// These tests bootstrap a workdir at experiments/<expId>/forge-t1-workdir/
// with a local bare repo as origin so stageCommitPush actually succeeds.
// The package.json has a failing `npm test` script so the sandbox returns
// tests_failed deterministically.
// ---------------------------------------------------------------------------

interface CarveOutEnv extends ReturnType<typeof makeCtx> {
  runId: number;
  expId: string;
  workdirRoot: string;
  bareRemote: string;
  cleanupDirs: string[];
}

function setupCarveOut(): CarveOutEnv {
  const env = makeCtx() as CarveOutEnv;
  env.cleanupDirs = [];

  // Unique experiment id per test → independent workdir path inside experiments/.
  env.expId = `carveout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Bare repo to act as "origin" — push works locally without network.
  env.bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-remote-'));
  env.cleanupDirs.push(env.bareRemote);
  execSync(`git init --bare`, { cwd: env.bareRemote, stdio: 'pipe' });

  // Bootstrap the workdir: init + initial commit + remote pointing at the bare repo.
  env.workdirRoot = path.resolve(process.cwd(), 'experiments', env.expId, 'forge-t1-workdir');
  env.cleanupDirs.push(path.dirname(env.workdirRoot));
  fs.mkdirSync(env.workdirRoot, { recursive: true });
  execSync(
    `git init -b main -q && git config user.email t@t && git config user.name t && ` +
    `echo "# init" > README.md && git add README.md && git commit -q -m init && ` +
    `git remote add origin ${env.bareRemote} && git push -q -u origin main`,
    { cwd: env.workdirRoot, stdio: 'pipe', shell: '/bin/bash' },
  );

  // Sandboxable package.json — tests fail, everything else passes.
  // No deps so `npm install --no-audit --no-fund --prefer-offline` returns instantly.
  fs.writeFileSync(path.join(env.workdirRoot, 'package.json'), JSON.stringify({
    name: 'sb', version: '0.0.0', type: 'module',
    scripts: {
      typecheck: 'exit 0',
      test:      'exit 1',
      build:     'exit 0',
    },
  }));
  // Commit the package.json so subsequent commits have a baseline.
  execSync(`git add package.json && git commit -q -m "add package.json" && git push -q origin main`,
    { cwd: env.workdirRoot, stdio: 'pipe', shell: '/bin/bash' });

  // Seed the forge_runs row pointing at this experiment.
  const result = env.db.prepare(
    "INSERT INTO forge_runs (tier, experiment_id, plan_id, status, iteration_count, solution_slug) VALUES ('t1', ?, 7, 'running:builder', 1, 'sb')"
  ).run(env.expId);
  env.runId = Number(result.lastInsertRowid);

  return env;
}

describe('forge-t1 commit_to_solution carve-out', () => {
  let env: CarveOutEnv;
  let tools: ReturnType<typeof createForgeT1Tools>;
  beforeEach(() => {
    env = setupCarveOut();
    tools = createForgeT1Tools(env.ctx);
  });
  afterEach(() => {
    for (const d of env.cleanupDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('quality + all-test files + tests_failed → committed_red_tests (carve-out fires)', async () => {
    const out = await tools.execute('commit_to_solution', {
      run_id: env.runId, persona: 'quality', iteration: 1,
      subject: 'add calculator boundary tests',
      files: [{ path: 'tests/calculator.test.ts', content: '// failing test body\n' }],
    });
    const parsed = JSON.parse(out as string) as { status: string; sha?: string };
    expect(parsed.status).toBe('committed_red_tests');
    expect(parsed.sha).toBeTruthy();
    // last_sandbox_status stays 'failed' so record_verdict's gate still blocks pass:true.
    const row = env.db.prepare('SELECT last_sandbox_status FROM forge_runs WHERE id = ?').get(env.runId) as { last_sandbox_status: string };
    expect(row.last_sandbox_status).toBe('failed');
  }, 30_000);

  it('quality + mixed (test + production) files + tests_failed → sandbox_failed (carve-out blocked)', async () => {
    const out = await tools.execute('commit_to_solution', {
      run_id: env.runId, persona: 'quality', iteration: 1,
      subject: 'add tests + sneak code change',
      files: [
        { path: 'tests/calculator.test.ts', content: '// failing test\n' },
        { path: 'lib/calculator.ts',        content: '// production code change\n' },
      ],
    });
    expect(JSON.parse(out as string).status).toBe('sandbox_failed');
  }, 30_000);

  it('builder + all-test files + tests_failed → sandbox_failed (carve-out is quality-only)', async () => {
    const out = await tools.execute('commit_to_solution', {
      run_id: env.runId, persona: 'builder', iteration: 1,
      subject: 'add my own tests',
      files: [{ path: 'tests/foo.test.ts', content: '// failing test\n' }],
    });
    expect(JSON.parse(out as string).status).toBe('sandbox_failed');
  }, 30_000);
});
