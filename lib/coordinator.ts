import type {
  CoordinatorContext,
  EventRow,
  ForgeRunRow,
  PersonaId,
} from '../types.js';
import { PERSONA_SEQUENCE } from '../types.js';

export interface Coordinator {
  start(): void;
}

/**
 * Forge T1 coordinator — implements the state machine from spec §4.
 *
 * Subscriptions:
 *   - forge_t1.build.requested   → seed forge_runs row, gate on create_github_repo
 *   - forge_t1.verdict.recorded  → advance / restart / finalize based on persona + pass
 *   - escalation.resolved        → resume from `pending` once J&J resolves create_github_repo
 *                                  (and from `paused:maxiter` once build_continue resolves)
 *
 * Publishes:
 *   - forge_t1.build.started, forge_t1.iteration.started, forge_t1.iteration.completed,
 *     forge_t1.persona.<id>.requested, forge_t1.build.ready, forge_t1.build.cancelled,
 *     forge_t1.build.maxiter_reached
 */
export function createForgeT1Coordinator(ctx: CoordinatorContext): Coordinator {
  const { db, bus, escalation, escalationRules, moduleId } = ctx;

  function start(): void {
    bus.subscribe('forge_t1.build.requested', moduleId, handleBuildRequested);
    bus.subscribe('forge_t1.verdict.recorded', moduleId, handleVerdictRecorded);
    bus.subscribe('escalation.resolved', moduleId, handleEscalationResolved);
    // R6 / I2: operator (or future credentials-vault module) emits this once env vars are wired.
    bus.subscribe('forge_t1.secrets_provisioned', moduleId, (e: EventRow) => handleSecretsProvisioned(e.payload));
  }

  function handleBuildRequested(event: EventRow): void {
    const p = event.payload as Record<string, unknown>;
    const planId = numOr0(p.plan_id);
    const experimentId = typeof p.experiment_id === 'string' ? p.experiment_id : '';
    const tier = typeof p.tier === 'string' ? p.tier : 't1';
    if (!planId || !experimentId) return;

    const existing = db.prepare(
      "SELECT id FROM forge_runs WHERE experiment_id = ? AND status NOT IN ('ready', 'cancelled', 'crashed')"
    ).get(experimentId);
    if (existing) return;

    const result = db.prepare(
      `INSERT INTO forge_runs (tier, experiment_id, plan_id, status, current_stage, iteration_count, max_iterations)
       VALUES (?, ?, ?, 'pending', NULL, 1, 10)`
    ).run(tier, experimentId, planId);
    const runId = Number(result.lastInsertRowid);

    // R9 (2026-05-25 dry-run): the brief now carries two separate budget fields.
    // - build_cost_cap_usd caps Claude API spend for THIS build (defaults $20).
    // - monthly_ops_cap_usd caps server/Vercel runtime cost and is informational only —
    //   we do NOT use it as a build-run cap (doing so falsely paused PRDs with low ops budgets).
    // Backward-compat: if the older monthly_soft_cap_usd field is present and the new
    // build_cost_cap_usd is absent, fall back to it.
    const budget = p.budget as { build_cost_cap_usd?: number; monthly_ops_cap_usd?: number; monthly_soft_cap_usd?: number } | undefined;
    const explicit = typeof budget?.build_cost_cap_usd === 'number' && budget.build_cost_cap_usd > 0
      ? budget.build_cost_cap_usd : undefined;
    const legacy   = typeof budget?.monthly_soft_cap_usd === 'number' && budget.monthly_soft_cap_usd > 0
      ? budget.monthly_soft_cap_usd : undefined;
    const costCap  = explicit ?? legacy ?? 20; // default $20/build
    db.prepare('UPDATE forge_runs SET cost_usd_cap = ? WHERE id = ?').run(costCap, runId);

    bus.publish('forge_t1.build.started', moduleId, { run_id: runId, experiment_id: experimentId, plan_id: planId });

    const slug = deriveSlug(experimentId, p);
    const check = escalation.checkAndProceed(
      moduleId,
      'create_github_repo',
      `Create solution-${slug} GitHub repo`,
      { slug, experiment_id: experimentId, plan_id: planId },
      escalationRules,
      experimentId,
      null,
    );

    if (check.proceed) {
      enterBuilderIteration(runId, 1);
    } else {
      db.prepare('UPDATE forge_runs SET pending_escalation_id = ? WHERE id = ?').run(
        check.escalationId ?? null,
        runId,
      );
    }
  }

  function handleVerdictRecorded(event: EventRow): void {
    const p = event.payload as Record<string, unknown>;
    const runId = numOr0(p.run_id);
    const iteration = numOr0(p.iteration);
    const persona = typeof p.persona === 'string' ? (p.persona as PersonaId) : null;
    const pass = p.pass === true || p.pass === 1;
    if (!runId || !persona) return;

    // Cost guard runs before state transitions. If cap exceeded, the run was
    // paused and we stop processing this verdict — operator J&J will resume.
    if (checkCostCap(runId)) return;

    const run = db.prepare('SELECT * FROM forge_runs WHERE id = ?').get(runId) as ForgeRunRow | undefined;
    if (!run) return;

    if (pass) {
      handlePass(run, persona, iteration);
    } else {
      handleFail(run, persona, iteration);
    }
  }

  /**
   * Returns true if the cost cap was exceeded (and the run was transitioned
   * to paused:cost). The caller should return immediately.
   *
   * Sums agent_runs.cost_usd for this build via the experiment_id link
   * (kernel's TraceRecorder writes cost_usd on completeRun).
   */
  function checkCostCap(runId: number): boolean {
    // Skip silently if agent_runs table is not present (test fixtures without
    // the full kernel schema). Real kernel always has it (migration 001).
    try {
      const r = db.prepare(
        `SELECT cost_usd_cap,
                COALESCE((
                  SELECT SUM(cost_usd) FROM agent_runs
                   WHERE module_id = 'forge-t1'
                     AND pipeline_session_id IN (
                       SELECT experiment_id FROM forge_runs WHERE id = ?
                     )
                ), 0) AS spent
         FROM forge_runs WHERE id = ?`
      ).get(runId, runId) as { cost_usd_cap: number | null; spent: number } | undefined;
      if (!r || !r.cost_usd_cap) return false;
      if (r.spent < r.cost_usd_cap) return false;

      db.prepare("UPDATE forge_runs SET status = 'paused:cost', paused_at = datetime('now'), current_stage = NULL WHERE id = ?").run(runId);
      bus.publish('forge_t1.build.cost_exceeded', moduleId, {
        run_id: runId,
        spent_usd: r.spent,
        cap_usd: r.cost_usd_cap,
      });
      // Gate on J&J — operator can raise cap and resume, or cancel.
      const check = escalation.checkAndProceed(
        moduleId,
        'build_continue', // reuse the maxiter J&J rule
        `Build ${runId} exceeded cost cap ($${r.spent.toFixed(2)} / $${r.cost_usd_cap.toFixed(2)})`,
        { run_id: runId, spent_usd: r.spent, cap_usd: r.cost_usd_cap },
        escalationRules,
        null, null,
      );
      db.prepare('UPDATE forge_runs SET pending_escalation_id = ? WHERE id = ?').run(check.escalationId ?? null, runId);
      return true;
    } catch {
      return false; // agent_runs table missing → no cost data → skip cap.
    }
  }

  function handleEscalationResolved(event: EventRow): void {
    const p = event.payload as Record<string, unknown>;
    const escalationId = numOr0(p.escalation_id);
    const status = typeof p.status === 'string' ? p.status : '';
    const actionType = typeof p.action_type === 'string' ? p.action_type : '';
    if (!escalationId || !status || !actionType) return;

    const run = db.prepare('SELECT * FROM forge_runs WHERE pending_escalation_id = ?').get(escalationId) as ForgeRunRow | undefined;
    if (!run) return;

    db.prepare('UPDATE forge_runs SET pending_escalation_id = NULL WHERE id = ?').run(run.id);

    if (actionType === 'create_github_repo') {
      if (status === 'approved') {
        enterBuilderIteration(run.id, 1);
      } else {
        cancel(run.id, 'create_github_repo rejected');
      }
      return;
    }
    if (actionType === 'build_continue' && run.status === 'paused:maxiter') {
      if (status === 'approved') {
        enterBuilderIteration(run.id, run.iteration_count + 1);
      } else {
        cancel(run.id, 'maxiter reached, operator declined to continue');
      }
    }
  }

  // --- transition helpers ----------------------------------------------

  function handlePass(run: ForgeRunRow, persona: PersonaId, iteration: number): void {
    if (persona === 'promotion_review') {
      // R6 / I2: if any required env var is still unset, fire ready_pending_secrets
      // instead of ready. The coordinator waits for forge_t1.secrets_provisioned
      // before emitting the real ready (handled in handleSecretsProvisioned below).
      const payload = buildReadyPayload(run, iteration);
      if ((payload.required_env_vars_unset as string[]).length > 0) {
        db.prepare("UPDATE forge_runs SET status = 'ready_pending_secrets', ready_pending_secrets_at = datetime('now'), current_stage = NULL WHERE id = ?").run(run.id);
        bus.publish('forge_t1.build.ready_pending_secrets', moduleId, payload);
        return;
      }
      db.prepare("UPDATE forge_runs SET status = 'ready', ready_at = datetime('now'), current_stage = NULL WHERE id = ?").run(run.id);
      bus.publish('forge_t1.build.ready', moduleId, payload);
      return;
    }

    if (persona === 'tester') {
      db.prepare("UPDATE forge_runs SET status = 'running:promotion_review', current_stage = 'promotion_review' WHERE id = ?").run(run.id);
      bus.publish('forge_t1.iteration.completed', moduleId, { run_id: run.id, iteration, pass: true });
      bus.publish('forge_t1.persona.promotion_review.requested', moduleId, { run_id: run.id, experiment_id: run.experiment_id });
      return;
    }

    const idx = PERSONA_SEQUENCE.indexOf(persona);
    const next = PERSONA_SEQUENCE[idx + 1];
    if (!next) return;
    db.prepare("UPDATE forge_runs SET status = ?, current_stage = ? WHERE id = ?").run(`running:${next}`, next, run.id);
    bus.publish(`forge_t1.persona.${next}.requested`, moduleId, { run_id: run.id, experiment_id: run.experiment_id, iteration });
  }

  function handleFail(run: ForgeRunRow, persona: PersonaId, iteration: number): void {
    bus.publish('forge_t1.iteration.completed', moduleId, {
      run_id: run.id, iteration, pass: false, failed_at: persona,
    });

    if (run.iteration_count >= run.max_iterations) {
      // Iteration cap hit — the failing iteration was already the last one budgeted.
      db.prepare("UPDATE forge_runs SET status = 'paused:maxiter', paused_at = datetime('now'), current_stage = NULL WHERE id = ?").run(run.id);
      const check = escalation.checkAndProceed(
        moduleId,
        'build_continue',
        `Build for ${run.experiment_id} hit iteration cap`,
        { run_id: run.id, iteration, failed_at: persona },
        escalationRules,
        run.experiment_id,
        null,
      );
      bus.publish('forge_t1.build.maxiter_reached', moduleId, {
        run_id: run.id, experiment_id: run.experiment_id, iteration, failed_at: persona,
      });
      db.prepare('UPDATE forge_runs SET pending_escalation_id = ? WHERE id = ?').run(check.escalationId ?? null, run.id);
      return;
    }

    enterBuilderIteration(run.id, run.iteration_count + 1);
  }

  function enterBuilderIteration(runId: number, iter: number): void {
    db.prepare(
      "UPDATE forge_runs SET status = 'running:builder', current_stage = 'builder', iteration_count = ? WHERE id = ?"
    ).run(iter, runId);
    bus.publish('forge_t1.iteration.started', moduleId, { run_id: runId, iteration: iter });
    bus.publish('forge_t1.persona.builder.requested', moduleId, { run_id: runId, iteration: iter });
  }

  function cancel(runId: number, reason: string): void {
    db.prepare("UPDATE forge_runs SET status = 'cancelled', cancelled_at = datetime('now'), current_stage = NULL WHERE id = ?").run(runId);
    bus.publish('forge_t1.build.cancelled', moduleId, { run_id: runId, reason });
  }

  function deriveSlug(experimentId: string, payload: Record<string, unknown>): string {
    if (typeof payload.solution_slug === 'string' && payload.solution_slug) return payload.solution_slug;
    return experimentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'unnamed';
  }

  /**
   * R5 (I1 / X1 from the 2026-05-25 dry-run): the `forge_t1.build.ready` event
   * is the documented hand-off contract to downstream operator-review tooling
   * (spec §2). Aggregate the spec-required fields once at publish time rather
   * than forcing every consumer to re-query forge_verdicts + feature_usages
   * + feature_promotions themselves.
   *
   * Latest verdict per persona wins (if a persona ran multiple iterations,
   * the most recent verdict is the one that mattered for ready).
   */
  function buildReadyPayload(run: ForgeRunRow, iteration: number): Record<string, unknown> {
    const verdictRows = db.prepare(
      `SELECT iteration, persona, pass, verdict_json
         FROM forge_verdicts
        WHERE run_id = ?
          AND id IN (
            SELECT MAX(id) FROM forge_verdicts WHERE run_id = ? GROUP BY persona
          )
        ORDER BY iteration, persona`
    ).all(run.id, run.id) as Array<{ iteration: number; persona: string; pass: number; verdict_json: string }>;
    const verdicts: Record<string, unknown> = {};
    for (const v of verdictRows) {
      verdicts[v.persona] = {
        iteration: v.iteration,
        pass: v.pass === 1,
        ...(JSON.parse(v.verdict_json) as Record<string, unknown>),
      };
    }

    const featuresUsed = db.prepare(
      `SELECT feature_id, feature_version FROM feature_usages
        WHERE solution_repo = ? ORDER BY used_at`
    ).all(run.solution_repo ?? '') as Array<{ feature_id: string; feature_version: number }>;

    const promotionsProposed = db.prepare(
      `SELECT id AS promotion_id, proposed_id AS feature_id, proposed_kind AS kind, status
         FROM feature_promotions WHERE proposed_by_run_id = ? ORDER BY proposed_at`
    ).all(run.id) as Array<{ promotion_id: number; feature_id: string; kind: string; status: string }>;

    // Required env vars unset (drives R6 / ready_pending_secrets gating).
    // CI/CD writes the required-vars list into the ci_cd verdict at iter close;
    // the coordinator reads it here to decide whether the env is provisioned.
    const ciCd = verdicts.ci_cd as { env_vars_required?: string[]; env_vars_provisioned?: string[] } | undefined;
    const required = ciCd?.env_vars_required ?? [];
    const provisioned = new Set(ciCd?.env_vars_provisioned ?? []);
    const requiredEnvVarsUnset = required.filter(v => !provisioned.has(v));

    return {
      run_id: run.id,
      experiment_id: run.experiment_id,
      plan_id: run.plan_id,
      solution_repo: run.solution_repo,
      solution_slug: run.solution_slug,
      final_commit_sha: run.final_commit_sha,
      preview_url: run.preview_url ?? null,
      iterations: iteration,
      tier: run.tier,
      verdicts,                         // { builder, quality, security, ci_cd, critic, tester }
      features_used: featuresUsed,
      promotion_review: {
        promotions_proposed_count: promotionsProposed.length,
        promotions_proposed: promotionsProposed,
      },
      features_promoted: promotionsProposed.filter(p => p.status === 'approved'),
      required_env_vars_unset: requiredEnvVarsUnset,
      next_step: requiredEnvVarsUnset.length > 0
        ? `Provision env vars (${requiredEnvVarsUnset.join(', ')}) then emit forge_t1.secrets_provisioned to receive forge_t1.build.ready.`
        : 'Build is ready. Inspect verdicts + promotion proposals; trigger Phase 8 (Lighthouse + integration) when satisfied.',
    };
  }

  /**
   * R6 / I2: subscribed to forge_t1.secrets_provisioned. When the operator (or
   * a future credentials-vault module) finishes wiring env vars, it publishes
   * this event with the same run_id. We then transition ready_pending_secrets → ready
   * and emit the canonical forge_t1.build.ready event with the (now complete) payload.
   */
  function handleSecretsProvisioned(payload: Record<string, unknown>): void {
    const runId = numOr0(payload.run_id);
    if (!runId) return;
    const run = db.prepare('SELECT * FROM forge_runs WHERE id = ? AND status = ?').get(runId, 'ready_pending_secrets') as ForgeRunRow | undefined;
    if (!run) return; // idempotent — only acts if we're actually waiting for secrets
    const iteration = run.iteration_count;
    const newPayload = buildReadyPayload(run, iteration);
    if (newPayload.required_env_vars_unset && (newPayload.required_env_vars_unset as string[]).length > 0) {
      // Still incomplete; do nothing (operator must call provision_vercel_env again first).
      return;
    }
    db.prepare("UPDATE forge_runs SET status = 'ready', ready_at = datetime('now') WHERE id = ?").run(run.id);
    bus.publish('forge_t1.build.ready', moduleId, newPayload);
  }

  function numOr0(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  return { start };
}
