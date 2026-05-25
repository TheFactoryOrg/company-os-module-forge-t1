/**
 * Forge T1 — tool factory.
 *
 * Tools are split into:
 *  - boundary actions (J&J): scaffold_solution_repo (and downstream
 *    build_continue/build_cancel handled by the coordinator escalation flow).
 *  - internal loop tools (inform): scaffold/quality/security/ci_cd/critic/tester/etc.
 *
 * The coordinator in lib/coordinator.ts orchestrates the iterate-to-fixed-point
 * loop using these tools. Phase 6 implements the coordinator + persona prompts
 * and replaces these stub handlers.
 */

import type { ModuleToolContext, ModuleTools, ToolDefinition } from './types.js';

export function createForgeT1Tools(_ctx: ModuleToolContext): ModuleTools {
  const definitions: ToolDefinition[] = [
    {
      name: 'scaffold_solution_repo',
      description: 'Create TheFactoryOrg/solution-<slug> GitHub repo and push initial commit. J&J-gated.',
      input_schema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Solution slug ^[a-z][a-z0-9-]{1,31}$' },
          description: { type: 'string', description: 'Repo description' },
          private: { type: 'boolean', default: false },
        },
        required: ['slug', 'description'],
      },
    },
    {
      name: 'query_feature_catalog',
      description: 'Search the Catalog for features matching filter.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          tier: { type: 'string' },
          tracks: { type: 'array', items: { type: 'string' } },
          category: { type: 'string' },
          tag: { type: 'string' },
          search: { type: 'string' },
        },
      },
    },
    {
      name: 'pull_feature',
      description: 'Materialize a feature into the working solution (kind-aware).',
      input_schema: {
        type: 'object',
        properties: {
          feature_id: { type: 'string' },
          intent: { type: 'string' },
          substitutions: { type: 'object' },
        },
        required: ['feature_id', 'intent'],
      },
    },
    {
      name: 'commit_to_solution',
      description: 'git commit + push the current working state with a structured message.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          persona: { type: 'string' },
          iteration: { type: 'integer' },
        },
        required: ['message', 'persona', 'iteration'],
      },
    },
    {
      name: 'propose_feature_promotion',
      description: 'Propose a chunk of solution code for promotion to the Catalog. Pending operator approval.',
      input_schema: {
        type: 'object',
        properties: {
          proposed_id: { type: 'string' },
          proposed_spec: { type: 'object' },
          payload_path: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['proposed_id', 'proposed_spec', 'payload_path'],
      },
    },
    {
      name: 'run_quality_checks',
      description: 'Run npm run lint && tsc && npm test in the solution repo. Return pass/fail + failures.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'run_security_scan',
      description: 'npm audit + secret sweep + no-DB-enforcement.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'configure_ci_cd',
      description: 'Write .github/workflows/, vercel.json, observability config.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'provision_vercel_env',
      description: 'Set Vercel project env vars from solution .env.example.',
      input_schema: {
        type: 'object',
        properties: { env_vars: { type: 'object' } },
      },
    },
    {
      name: 'attach_custom_domain',
      description: 'Call Vercel API to attach a custom domain if desired_domain in brief.',
      input_schema: {
        type: 'object',
        properties: { desired_domain: { type: 'string' } },
        required: ['desired_domain'],
      },
    },
    {
      name: 'run_critic_evaluation',
      description: 'Critic persona: read PRD + solution, return alignment_score 0-100 + misalignments[].',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'run_e2e_test',
      description: 'Tester persona: build solution, run smoke script against preview deploy.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'record_verdict',
      description: 'Persist a persona verdict to forge_verdicts. Advances or restarts the loop.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'integer' },
          iteration: { type: 'integer' },
          persona: { type: 'string' },
          pass: { type: 'boolean' },
          verdict: { type: 'object' },
          agent_run_id: { type: 'integer' },
        },
        required: ['run_id', 'iteration', 'persona', 'pass', 'verdict'],
      },
    },
    {
      name: 'request_continue_or_cancel',
      description: 'At iteration cap, escalate to J&J with full verdict bundle.',
      input_schema: {
        type: 'object',
        properties: { run_id: { type: 'integer' } },
        required: ['run_id'],
      },
    },
    {
      name: 'publish_build_ready',
      description: 'Emit forge_t1.build.ready with the verdict bundle + promotions.',
      input_schema: {
        type: 'object',
        properties: { run_id: { type: 'integer' } },
        required: ['run_id'],
      },
    },
  ];

  async function execute(toolName: string, _input: unknown): Promise<{ status: 'not_implemented'; tool: string }> {
    // Phase 6 replaces this with real handlers.
    return { status: 'not_implemented', tool: toolName };
  }

  return { definitions, execute };
}
