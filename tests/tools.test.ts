import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      paused_at TEXT, ready_at TEXT, cancelled_at TEXT, pending_escalation_id INTEGER
    );
    CREATE TABLE forge_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL, iteration INTEGER NOT NULL, persona TEXT NOT NULL,
      pass INTEGER NOT NULL, verdict_json TEXT NOT NULL, agent_run_id INTEGER,
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
