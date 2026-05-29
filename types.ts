/**
 * Inline-copied kernel types. This submodule MUST NOT import from master src/.
 * Mirror kernel changes here when they happen.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolExecuteResult {
  status?: 'ok' | 'error' | 'pending' | 'not_implemented' | 'invalid_input' | string;
  [key: string]: unknown;
}

export interface MinimalDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction?<T extends (...args: unknown[]) => unknown>(fn: T): T;
}

/**
 * Event row as emitted by the kernel's EventBus.subscribe handler.
 * Matches src/core/event-bus.ts::EventRow.
 */
export interface EventRow {
  id: number;
  type: string;
  source_module: string;
  payload: Record<string, unknown>;
  status?: string;
  experiment_id: string | null;
  pipeline_session_id: string | null;
  created_at: string;
}

/**
 * Bus surface visible to module tools. Tools may publish but not subscribe;
 * subscriptions are declared in module.yaml and wired by the kernel.
 */
export interface MinimalEventBus {
  publish(
    type: string,
    sourceModule: string,
    payload: Record<string, unknown>,
    opts?: { experimentId?: string | null },
  ): number;
  getRecentEvents(limit: number): Array<{
    type: string;
    source_module: string;
    payload: unknown;
    created_at: string;
  }>;
}

/**
 * Extended bus surface that includes subscribe(). Used by the coordinator only,
 * which is wired by the kernel and is not a regular module tool.
 */
export interface CoordinatorEventBus extends MinimalEventBus {
  subscribe(pattern: string, moduleId: string, handler: (event: EventRow) => void): void;
}

/**
 * Escalation surface the coordinator calls directly (for boundary actions
 * like create_github_repo). Mirrors src/core/escalation.ts::EscalationManager.
 */
export interface CoordinatorEscalationManager {
  checkAndProceed(
    moduleId: string,
    actionType: string,
    summary: string,
    detail: Record<string, unknown>,
    rules: Record<string, EscalationRuleLike>,
    experimentId: string | null,
    pipelineSessionId?: string | null,
  ): { proceed: boolean; escalationId: number | undefined };
}

/**
 * Subset of EscalationRule used by checkAndProceed. The kernel passes the full
 * shape through; the coordinator only needs the structural compatibility.
 */
export interface EscalationRuleLike {
  requires: string[];
  timeout_minutes: number | null;
  timeout_behavior: 'auto_approve' | 'auto_reject' | 'escalate' | null;
}

/**
 * Catalog surface as constructed in Phase 2. Tools and the coordinator
 * both reach into this. Optional on ModuleToolContext for older kernel builds.
 */
export interface FeatureCatalogSurface {
  list(filter: {
    kind?: string;
    tier?: string;
    tracks?: string[];
    category?: string;
    tag?: string;
    search?: string;
    status?: string;
  }): Array<{
    id: string;
    name: string;
    description: string;
    kind: 'snippet' | 'integration' | 'agent' | 'platform';
    version: number;
    categories: string[];
    tags: string[];
    applicable_tiers: string[];
    applicable_tracks: string[];
    credentials_required: string[];
    source_path: string;
  }>;
  get(id: string): unknown;
  materialize(
    id: string,
    intent: string,
    solutionPath: string,
    substitutions: Record<string, string>,
    usage: { experiment_id: string; solution_repo: string; tier: string },
  ): Promise<{ files_added: string[]; package_deps_added: string[]; env_vars_required: string[] }>;
  proposePromotion(
    spec: Record<string, unknown>,
    payloadPath: string,
    runId: number | null,
  ): { promotion_id: number };
}

/**
 * Context passed to createForgeT1Tools(ctx). Same shape the kernel's
 * src/app.ts::loadModuleTools constructs.
 */
export interface ModuleToolContext {
  db: MinimalDatabase;
  bus: MinimalEventBus;
  moduleId: string;
  moduleDir?: string;
  experimentId?: string;
  featureCatalog?: FeatureCatalogSurface;
}

export interface ModuleTools {
  definitions: ToolDefinition[];
  execute(toolName: string, input: Record<string, unknown>): Promise<string> | string;
}

/**
 * Context passed to createForgeT1Coordinator(ctx). Constructed in src/app.ts
 * after modules.loadAll(). The coordinator is module-resident but kernel-wired.
 */
export interface CoordinatorContext {
  db: MinimalDatabase;
  bus: CoordinatorEventBus;
  escalation: CoordinatorEscalationManager;
  escalationRules: Record<string, EscalationRuleLike>;
  featureCatalog: FeatureCatalogSurface;
  moduleId: string; // 'forge-t1'
}

// --- Module-internal domain types ----------------------------------------

export type Tier = 't1' | 't2' | 't3';

export type PersonaId =
  | 'builder'
  | 'quality'
  | 'security'
  | 'ci_cd'
  | 'critic'
  | 'tester'
  | 'promotion_review';

export const PERSONA_SEQUENCE: PersonaId[] = [
  'builder',
  'quality',
  'security',
  'ci_cd',
  'critic',
  'tester',
];

export interface PersonaVerdict {
  pass: boolean;
  notes?: string;
  [key: string]: unknown;
}

export interface BuildBrief {
  plan_id: number;
  experiment_id: string;
  verdict: 'green' | 'yellow' | 'red';
  tier: Tier;
  plan_file_path?: string;
  features_selected: Array<{
    id: string;
    intent: string;
    version_at_selection: number;
  }>;
  new_features_needed: Array<{
    description: string;
    proposed_kind: 'snippet' | 'integration' | 'agent' | 'platform';
    likely_promotable: boolean;
    rationale: string;
  }>;
  constraints?: {
    stack?: string;
    no_persistence?: boolean;
    desired_domain?: string;
  };
  budget?: {
    monthly_soft_cap_usd?: number;
    monthly_hard_cap_usd?: number;
  };
}

/**
 * Row in the master kernel's forge_runs table (migration 009).
 * Read-only struct on the module side.
 */
export interface ForgeRunRow {
  id: number;
  tier: Tier;
  experiment_id: string;
  plan_id: number;
  status: string;
  current_stage: string | null;
  iteration_count: number;
  max_iterations: number;
  started_at: string;
  paused_at: string | null;
  ready_at: string | null;
  ready_pending_secrets_at: string | null;  // R6 / I2
  cancelled_at: string | null;
  solution_repo: string | null;
  solution_slug: string | null;
  final_commit_sha: string | null;
  preview_url: string | null;               // R5 / I1 (set by Phase 8 deploy step)
}
