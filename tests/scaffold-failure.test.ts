import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createForgeT1Tools } from '../tools.js';
import type { ModuleToolContext, FeatureCatalogSurface } from '../types.js';

// Regression coverage for the 2026-05-28 incident: when scaffold_solution_repo
// fails (e.g. org-admin scope missing on GITHUB_TOKEN), the builder must not
// be able to call pull_feature or commit_to_solution with a path that writes
// outside the per-run workdir. Previously, pull_feature took an
// agent-provided `solution_path` string and passed it directly to
// FeatureCatalog.materialize, which resolved relative paths against
// process.cwd() — the orchestrator's own repo root.

function makeCtx(): { ctx: ModuleToolContext; db: Database.Database; materializeSpy: ReturnType<typeof vi.fn> } {
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
      last_sandbox_status TEXT, last_sandbox_error TEXT,
      local INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE forge_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL, iteration INTEGER NOT NULL, persona TEXT NOT NULL,
      pass INTEGER NOT NULL, verdict_json TEXT NOT NULL, agent_run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const materializeSpy = vi.fn(async () => ({ files_added: [], package_deps_added: [], env_vars_required: [] }));
  const featureCatalog: FeatureCatalogSurface = {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    materialize: materializeSpy,
    proposePromotion: vi.fn(() => ({ promotion_id: 1 })),
  };
  const ctx: ModuleToolContext = {
    db,
    bus: {
      publish: vi.fn(() => 1),
      getRecentEvents: () => [],
    },
    moduleId: 'forge-t1',
    featureCatalog,
  };
  return { ctx, db, materializeSpy };
}

describe('forge-t1 scaffold + path guards', () => {
  let env: ReturnType<typeof makeCtx>;
  let tools: ReturnType<typeof createForgeT1Tools>;

  beforeEach(() => {
    env = makeCtx();
    tools = createForgeT1Tools(env.ctx);
    // Run row with NO solution_repo and NO solution_slug — i.e. scaffold has
    // not completed. This is the state that triggered the local-smoke incident.
    env.db.prepare(
      "INSERT INTO forge_runs (id, tier, experiment_id, plan_id, status) VALUES (1, 't1', 'exp-x', 1, 'running:builder')"
    ).run();
  });

  it('pull_feature refuses when scaffold has not completed (no solution_repo, no solution_slug)', async () => {
    const result = JSON.parse(await tools.execute('pull_feature', {
      run_id: 1, feature_id: 'feat-x', intent: 'use as-is', solution_path: 'app/page.tsx',
    }));
    expect(result.status).toBe('scaffold_required');
    expect(env.materializeSpy).not.toHaveBeenCalled();
  });

  it('pull_feature refuses absolute solution_path even when scaffolded', async () => {
    env.db.prepare("UPDATE forge_runs SET solution_repo = 'https://github.com/x/y', solution_slug = 'y' WHERE id = 1").run();
    const result = JSON.parse(await tools.execute('pull_feature', {
      run_id: 1, feature_id: 'feat-x', intent: 'use as-is', solution_path: '/etc/passwd',
    }));
    expect(result.status).toBe('invalid_path');
    expect(env.materializeSpy).not.toHaveBeenCalled();
  });

  it('pull_feature refuses solution_path that escapes the workdir via ..', async () => {
    env.db.prepare("UPDATE forge_runs SET solution_repo = 'https://github.com/x/y', solution_slug = 'y' WHERE id = 1").run();
    const result = JSON.parse(await tools.execute('pull_feature', {
      run_id: 1, feature_id: 'feat-x', intent: 'use as-is', solution_path: '../../etc/passwd',
    }));
    expect(result.status).toBe('invalid_path');
    expect(env.materializeSpy).not.toHaveBeenCalled();
  });

  it('pull_feature refuses empty solution_path (would resolve to CWD)', async () => {
    env.db.prepare("UPDATE forge_runs SET solution_repo = 'https://github.com/x/y', solution_slug = 'y' WHERE id = 1").run();
    const result = JSON.parse(await tools.execute('pull_feature', {
      run_id: 1, feature_id: 'feat-x', intent: 'use as-is', solution_path: '',
    }));
    // Empty is caught by the existing invalid('solution_path') check OR by
    // the new path guard. Either status is acceptable, just not "materialized".
    expect(result.status).not.toBe('materialized');
    expect(env.materializeSpy).not.toHaveBeenCalled();
  });

  it('pull_feature passes the resolved absolute workdir path to materialize on a valid relative input', async () => {
    env.db.prepare("UPDATE forge_runs SET solution_repo = 'https://github.com/x/y', solution_slug = 'y' WHERE id = 1").run();
    const result = JSON.parse(await tools.execute('pull_feature', {
      run_id: 1, feature_id: 'feat-x', intent: 'use as-is', solution_path: 'app',
    }));
    expect(result.status).toBe('materialized');
    expect(env.materializeSpy).toHaveBeenCalledTimes(1);
    const [, , passedPath] = env.materializeSpy.mock.calls[0];
    expect(path.isAbsolute(passedPath)).toBe(true);
    // The path must end with /<expected workdir>/app
    expect(passedPath.endsWith(`${path.sep}forge-t1-workdir${path.sep}app`)).toBe(true);
  });

  it('commit_to_solution still refuses when scaffold has not completed (existing guard, unchanged)', async () => {
    const result = JSON.parse(await tools.execute('commit_to_solution', {
      run_id: 1, persona: 'builder', iteration: 1, subject: 'wip', files: [{ path: 'app/page.tsx', content: 'x' }],
    }));
    expect(['run_not_scaffolded', 'scaffold_required']).toContain(result.status);
  });
});
