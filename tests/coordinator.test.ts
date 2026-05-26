import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createForgeT1Coordinator } from '../lib/coordinator.js';
import type {
  CoordinatorContext,
  CoordinatorEventBus,
  CoordinatorEscalationManager,
  EventRow,
} from '../types.js';

interface PublishCall { type: string; payload: Record<string, unknown> }

function makeContext(): {
  ctx: CoordinatorContext;
  db: Database.Database;
  published: PublishCall[];
  handlers: Map<string, (e: EventRow) => void>;
  escalation: CoordinatorEscalationManager & { __setProceed(b: boolean): void };
} {
  const db = new Database(':memory:');
  // Schema matches kernel migration 010 (forge_runs) minimally — adds
  // ready_pending_secrets_at + preview_url because the coordinator's
  // R6/R5 transitions UPDATE those columns. The plan's test snippet
  // omitted them; including them keeps the SQL valid.
  db.exec(`
    CREATE TABLE forge_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      plan_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT,
      iteration_count INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL DEFAULT 10,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      paused_at TEXT,
      ready_at TEXT,
      ready_pending_secrets_at TEXT,
      cancelled_at TEXT,
      solution_repo TEXT,
      solution_slug TEXT,
      final_commit_sha TEXT,
      preview_url TEXT,
      pending_escalation_id INTEGER,
      cost_usd_cap REAL,
      persona_started_at TEXT
    );
    CREATE TABLE forge_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      iteration INTEGER NOT NULL,
      persona TEXT NOT NULL,
      pass INTEGER NOT NULL,
      verdict_json TEXT NOT NULL,
      agent_run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE feature_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT NOT NULL,
      feature_version INTEGER NOT NULL,
      solution_repo TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE feature_promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposed_id TEXT NOT NULL,
      proposed_kind TEXT NOT NULL,
      proposed_by_run_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      proposed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const published: PublishCall[] = [];
  const handlers = new Map<string, (e: EventRow) => void>();
  const bus: CoordinatorEventBus = {
    publish(type, _src, payload) {
      published.push({ type, payload });
      return published.length;
    },
    subscribe(pattern, _moduleId, handler) {
      handlers.set(pattern, handler);
    },
    getRecentEvents: () => [],
  };
  let proceedFlag = true;
  const escalation = {
    checkAndProceed: vi.fn(() => ({ proceed: proceedFlag, escalationId: 99 })),
    __setProceed(b: boolean) { proceedFlag = b; },
  };
  const ctx: CoordinatorContext = {
    db,
    bus,
    escalation,
    escalationRules: {
      create_github_repo: { requires: ['J&J'], timeout_minutes: 1440, timeout_behavior: 'escalate' },
      build_continue: { requires: ['J&J'], timeout_minutes: 4320, timeout_behavior: 'escalate' },
    },
    featureCatalog: {} as unknown as CoordinatorContext['featureCatalog'],
    moduleId: 'forge-t1',
  };
  return { ctx, db, published, handlers, escalation };
}

function buildRequestedEvent(): EventRow {
  return {
    id: 1,
    type: 'forge_t1.build.requested',
    source_module: 'forge-dispatcher',
    payload: {
      plan_id: 7,
      experiment_id: 'exp-foo',
      tier: 't1',
      features_selected: [],
      new_features_needed: [],
      verdict: 'green',
    },
    experiment_id: 'exp-foo',
    pipeline_session_id: null,
    created_at: new Date().toISOString(),
  };
}

function verdictEvent(runId: number, iter: number, persona: string, pass: boolean): EventRow {
  return {
    id: 1,
    type: 'forge_t1.verdict.recorded',
    source_module: 'forge-t1',
    payload: { run_id: runId, iteration: iter, persona, pass, verdict: {} },
    experiment_id: 'exp-foo',
    pipeline_session_id: null,
    created_at: new Date().toISOString(),
  };
}

describe('ForgeT1Coordinator', () => {
  let env: ReturnType<typeof makeContext>;

  beforeEach(() => {
    env = makeContext();
    const coord = createForgeT1Coordinator(env.ctx);
    coord.start();
  });

  it('creates a forge_runs row when forge_t1.build.requested arrives', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const row = env.db.prepare('SELECT * FROM forge_runs WHERE experiment_id = ?').get('exp-foo') as { status: string; iteration_count: number };
    expect(row).toBeTruthy();
    expect(row.iteration_count).toBe(1);
  });

  it('transitions pending → running:builder + publishes builder trigger when create_github_repo is inform-tier (proceed=true)', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const row = env.db.prepare('SELECT status FROM forge_runs LIMIT 1').get() as { status: string };
    expect(row.status).toBe('running:builder');
    expect(env.published.map(p => p.type)).toContain('forge_t1.build.started');
    expect(env.published.map(p => p.type)).toContain('forge_t1.iteration.started');
    expect(env.published.map(p => p.type)).toContain('forge_t1.persona.builder.requested');
  });

  it('stays in pending when escalation returns proceed=false', () => {
    env.escalation.__setProceed(false);
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const row = env.db.prepare('SELECT status, pending_escalation_id FROM forge_runs LIMIT 1').get() as { status: string; pending_escalation_id: number };
    expect(row.status).toBe('pending');
    expect(row.pending_escalation_id).toBe(99);
    expect(env.published.map(p => p.type)).not.toContain('forge_t1.persona.builder.requested');
  });

  it('on escalation.resolved (approved) transitions pending → running:builder', () => {
    env.escalation.__setProceed(false);
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    env.handlers.get('escalation.resolved')!({
      id: 2, type: 'escalation.resolved', source_module: 'kernel',
      payload: { escalation_id: 99, status: 'approved', module_id: 'forge-t1', action_type: 'create_github_repo' },
      experiment_id: 'exp-foo', pipeline_session_id: null, created_at: new Date().toISOString(),
    });
    const row = env.db.prepare('SELECT status FROM forge_runs LIMIT 1').get() as { status: string };
    expect(row.status).toBe('running:builder');
  });

  it('on escalation.resolved (rejected) transitions to cancelled', () => {
    env.escalation.__setProceed(false);
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    env.handlers.get('escalation.resolved')!({
      id: 2, type: 'escalation.resolved', source_module: 'kernel',
      payload: { escalation_id: 99, status: 'rejected', module_id: 'forge-t1', action_type: 'create_github_repo' },
      experiment_id: 'exp-foo', pipeline_session_id: null, created_at: new Date().toISOString(),
    });
    const row = env.db.prepare('SELECT status FROM forge_runs LIMIT 1').get() as { status: string };
    expect(row.status).toBe('cancelled');
    expect(env.published.map(p => p.type)).toContain('forge_t1.build.cancelled');
  });

  it('advances Builder→Quality on pass=true', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    env.published.length = 0;
    env.handlers.get('forge_t1.verdict.recorded')!(verdictEvent(runId, 1, 'builder', true));
    const row = env.db.prepare('SELECT status FROM forge_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('running:quality');
    expect(env.published.map(p => p.type)).toContain('forge_t1.persona.quality.requested');
  });

  it('Tester pass=true transitions to running:promotion_review', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    env.published.length = 0;
    env.handlers.get('forge_t1.verdict.recorded')!(verdictEvent(runId, 1, 'tester', true));
    const row = env.db.prepare('SELECT status FROM forge_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('running:promotion_review');
    expect(env.published.map(p => p.type)).toContain('forge_t1.iteration.completed');
    expect(env.published.map(p => p.type)).toContain('forge_t1.persona.promotion_review.requested');
  });

  it('promotion_review pass=true transitions to ready and publishes forge_t1.build.ready', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    env.published.length = 0;
    env.handlers.get('forge_t1.verdict.recorded')!(verdictEvent(runId, 1, 'promotion_review', true));
    const row = env.db.prepare('SELECT status FROM forge_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('ready');
    const ready = env.published.find(p => p.type === 'forge_t1.build.ready');
    expect(ready).toBeDefined();
    // R5 / I1: enriched payload must match spec §2 — verify the shape, not exhaustive contents.
    const p = ready!.payload as Record<string, unknown>;
    expect(p).toHaveProperty('verdicts');
    expect(p).toHaveProperty('features_used');
    expect(p).toHaveProperty('promotion_review');
    expect(p).toHaveProperty('preview_url');
    expect(p).toHaveProperty('next_step');
    expect(p).toHaveProperty('solution_slug');
  });

  it('R6: promotion_review pass=true with unset env vars publishes ready_pending_secrets instead of ready', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    // Simulate CI/CD verdict declaring required env vars unset.
    env.db.prepare(
      'INSERT INTO forge_verdicts (run_id, iteration, persona, pass, verdict_json) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, 1, 'ci_cd', 1, JSON.stringify({
      env_vars_required: ['POSTGRES_URL', 'RESEND_API_KEY'],
      env_vars_provisioned: [],
    }));
    env.published.length = 0;
    env.handlers.get('forge_t1.verdict.recorded')!(verdictEvent(runId, 1, 'promotion_review', true));
    const row = env.db.prepare('SELECT status FROM forge_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('ready_pending_secrets');
    expect(env.published.map(p => p.type)).toContain('forge_t1.build.ready_pending_secrets');
    expect(env.published.map(p => p.type)).not.toContain('forge_t1.build.ready');
  });

  it('R6: forge_t1.secrets_provisioned transitions ready_pending_secrets → ready', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    // Land a ci_cd verdict with vars now provisioned.
    env.db.prepare(
      'INSERT INTO forge_verdicts (run_id, iteration, persona, pass, verdict_json) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, 1, 'ci_cd', 1, JSON.stringify({
      env_vars_required: ['POSTGRES_URL'],
      env_vars_provisioned: ['POSTGRES_URL'],
    }));
    // Force the run into ready_pending_secrets to simulate the prior step.
    env.db.prepare("UPDATE forge_runs SET status = 'ready_pending_secrets' WHERE id = ?").run(runId);
    env.published.length = 0;
    env.handlers.get('forge_t1.secrets_provisioned')!({
      id: 99, type: 'forge_t1.secrets_provisioned', source_module: 'operator-cli',
      payload: { run_id: runId }, created_at: new Date().toISOString(),
    } as unknown as Parameters<NonNullable<ReturnType<typeof env.handlers.get>>>[0]);
    const row = env.db.prepare('SELECT status FROM forge_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('ready');
    expect(env.published.map(p => p.type)).toContain('forge_t1.build.ready');
  });

  it('any pass=false (below iteration cap) restarts at builder with iter+1', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    env.published.length = 0;
    env.handlers.get('forge_t1.verdict.recorded')!(verdictEvent(runId, 1, 'security', false));
    const row = env.db.prepare('SELECT status, iteration_count FROM forge_runs WHERE id = ?').get(runId) as { status: string; iteration_count: number };
    expect(row.status).toBe('running:builder');
    expect(row.iteration_count).toBe(2);
    expect(env.published.map(p => p.type)).toContain('forge_t1.iteration.completed');
    expect(env.published.map(p => p.type)).toContain('forge_t1.iteration.started');
    expect(env.published.map(p => p.type)).toContain('forge_t1.persona.builder.requested');
  });

  it('pauses with cost_exceeded when summed agent_runs cost > cap', () => {
    env.db.exec(`CREATE TABLE agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id TEXT NOT NULL,
      pipeline_session_id TEXT,
      cost_usd REAL NOT NULL DEFAULT 0
    )`);
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    // Seed cap = $1 (override default) and burn $1.50.
    env.db.prepare('UPDATE forge_runs SET cost_usd_cap = 1.0 WHERE id = ?').run(runId);
    env.db.prepare(
      "INSERT INTO agent_runs (module_id, pipeline_session_id, cost_usd) VALUES ('forge-t1', 'exp-foo', 1.5)"
    ).run();
    env.published.length = 0;
    env.handlers.get('forge_t1.verdict.recorded')!(verdictEvent(runId, 1, 'builder', true));
    const row = env.db.prepare('SELECT status FROM forge_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('paused:cost');
    expect(env.published.map(p => p.type)).toContain('forge_t1.build.cost_exceeded');
  });

  it('pass=false at iteration cap pauses with forge_t1.build.maxiter_reached', () => {
    env.handlers.get('forge_t1.build.requested')!(buildRequestedEvent());
    const runId = (env.db.prepare('SELECT id FROM forge_runs LIMIT 1').get() as { id: number }).id;
    env.db.prepare('UPDATE forge_runs SET iteration_count = 10 WHERE id = ?').run(runId);
    env.published.length = 0;
    env.handlers.get('forge_t1.verdict.recorded')!(verdictEvent(runId, 10, 'critic', false));
    const row = env.db.prepare('SELECT status FROM forge_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('paused:maxiter');
    expect(env.published.map(p => p.type)).toContain('forge_t1.build.maxiter_reached');
  });
});
