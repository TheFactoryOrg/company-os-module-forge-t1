/**
 * Inline-copied kernel types. Per the module contract, this submodule
 * MUST NOT import from master src/. When the kernel evolves these types,
 * mirror the change here.
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
  status?: 'ok' | 'error' | 'pending' | 'not_implemented';
  [key: string]: unknown;
}

export interface ModuleToolContext {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
  };
  bus: {
    publish(eventType: string, source: string, payload: unknown): void;
    subscribe(eventType: string, handler: (eventType: string, source: string, payload: unknown) => void): void;
  };
  moduleId: string;
  moduleDir?: string;
  experimentId?: string;
  // Forge T1 needs access to the FeatureCatalog at runtime — wired in via kernel
  featureCatalog?: {
    list(filter: Record<string, unknown>): Array<{
      id: string; name: string; description: string;
      kind: 'snippet' | 'integration' | 'agent' | 'platform';
      version: number;
      categories: string[]; tags: string[];
      applicable_tiers: string[]; applicable_tracks: string[];
      credentials_required: string[];
      source_path: string;
    }>;
    get(id: string): unknown;
    materialize(id: string, intent: string, solutionPath: string, substitutions: Record<string, string>, usage: { experiment_id: string; solution_repo: string; tier: string }): Promise<{ files_added: string[]; package_deps_added: string[]; env_vars_required: string[] }>;
    proposePromotion(spec: unknown, payloadPath: string, runId: number | null): { promotion_id: number };
  };
  // Escalation framework: take_action returns pending/proceed/blocked
  takeAction?(actionType: string, detail: Record<string, unknown>): Promise<{ proceed: boolean; status: string; escalation_id?: number }>;
}

export interface ModuleTools {
  definitions: ToolDefinition[];
  execute(toolName: string, input: unknown): Promise<ToolExecuteResult>;
}

export type Tier = 't1' | 't2' | 't3';

export interface PersonaName {
  name: 'builder' | 'quality' | 'security' | 'ci_cd' | 'critic' | 'tester' | 'promotion_review';
}

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
    locales?: string[];
    primary_locale?: string;
    desired_domain?: string;
  };
  budget?: {
    build_cost_cap_usd?: number;
    monthly_ops_cap_usd?: number;
    monthly_soft_cap_usd?: number;
  };
  solution_slug?: string;
}
