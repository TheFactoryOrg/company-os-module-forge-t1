import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createForgeT1Tools } from '../tools.js';
import type { ModuleToolContext } from '../types.js';

describe('forge-T1 no-vercel mode', () => {
  let db: Database.Database;
  let ctx: ModuleToolContext;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE forge_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tier TEXT NOT NULL, experiment_id TEXT NOT NULL, plan_id INTEGER NOT NULL,
        status TEXT NOT NULL, current_stage TEXT,
        iteration_count INTEGER NOT NULL DEFAULT 0, max_iterations INTEGER NOT NULL DEFAULT 10,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        solution_repo TEXT, solution_slug TEXT, final_commit_sha TEXT,
        paused_at TEXT, ready_at TEXT, cancelled_at TEXT, pending_escalation_id INTEGER,
        last_sandbox_status TEXT, last_sandbox_error TEXT,
        local INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      "INSERT INTO forge_runs (id, tier, experiment_id, plan_id, status) VALUES (1, 't1', 'test-exp', 1, 'running')"
    ).run();
    ctx = {
      db,
      bus: {
        publish: vi.fn(() => 1),
        getRecentEvents: () => [],
      },
      moduleId: 'forge-t1',
    };
  });

  afterEach(() => {
    process.env = origEnv;
    db.close();
  });

  it('provision_vercel_env returns skipped when FORGE_VERCEL_DISABLED=1', async () => {
    process.env.FORGE_VERCEL_DISABLED = '1';
    const { execute } = createForgeT1Tools(ctx);
    const result = JSON.parse(
      await execute('provision_vercel_env', { run_id: 1, vercel_project_id: 'p', env_vars: {} })
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('vercel_disabled');
  });

  it('attach_custom_domain returns skipped when FORGE_VERCEL_DISABLED=1', async () => {
    process.env.FORGE_VERCEL_DISABLED = '1';
    const { execute } = createForgeT1Tools(ctx);
    const result = JSON.parse(
      await execute('attach_custom_domain', { run_id: 1, vercel_project_id: 'p', domain: 'd.example' })
    );
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('vercel_disabled');
  });

  it('full mode (no env var) still returns config_error when creds missing', async () => {
    delete process.env.FORGE_VERCEL_DISABLED;
    delete process.env.VERCEL_API_TOKEN;
    delete process.env.VERCEL_ORG_ID;
    const { execute } = createForgeT1Tools(ctx);
    const result = JSON.parse(
      await execute('provision_vercel_env', { run_id: 1, vercel_project_id: 'p', env_vars: {} })
    );
    expect(result.status).toBe('config_error');
  });
});
