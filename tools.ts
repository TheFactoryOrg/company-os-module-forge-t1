/**
 * Forge T1 — tool factory.
 *
 * Personas own subsets of these tools (see agent.md for persona-tool mapping):
 *   Builder:  scaffold_solution_repo, query_feature_catalog, pull_feature,
 *             commit_to_solution, propose_feature_promotion, record_verdict
 *   Quality:  run_quality_checks, commit_to_solution, record_verdict
 *   Security: run_security_scan, record_verdict
 *   CI/CD:    configure_ci_cd, provision_vercel_env, attach_custom_domain,
 *             commit_to_solution, record_verdict
 *   Critic:   run_critic_evaluation, record_verdict
 *   Tester:   run_e2e_test, commit_to_solution, record_verdict
 *
 * Boundary actions (create_github_repo, build_continue, build_cancel) are
 * handled by the coordinator, not by the agent — see lib/coordinator.ts.
 *
 * `publish_build_ready` exists on the tool surface for symmetry with the
 * spec table but is a no-op when invoked from the agent: the coordinator
 * publishes forge_t1.build.ready when promotion_review's verdict lands.
 */

import path from 'node:path';
import fs from 'node:fs';
import { GitHubClient, type GitHubFile } from './lib/github.js';
import { VercelClient } from './lib/vercel.js';
import { Workdir } from './lib/workdir.js';
import { Sandbox } from './lib/sandbox.js';
import type {
  FeatureCatalogSurface,
  ModuleToolContext,
  ModuleTools,
  PersonaId,
  ToolDefinition,
} from './types.js';

function workdirPath(experimentId: string): string {
  return path.resolve(process.cwd(), 'experiments', experimentId, 'forge-t1-workdir');
}

// Used by the Quality carve-out in handleCommitToSolution: match the
// project's test-file conventions (Vitest defaults). Conservative — if
// uncertain, treat as production code.
function isTestPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('tests/') || norm.includes('/tests/')) return true;
  if (norm.startsWith('test/') || norm.includes('/test/')) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(norm)) return true;
  return false;
}

const PERSONA_NAMES: PersonaId[] = [
  'builder', 'quality', 'security', 'ci_cd', 'critic', 'tester', 'promotion_review',
];

const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function createForgeT1Tools(ctx: ModuleToolContext): ModuleTools {
  const definitions: ToolDefinition[] = [
    {
      name: 'scaffold_solution_repo',
      description: 'Create TheFactoryOrg/solution-<slug> on GitHub and push the initial commit. Coordinator already gated this with create_github_repo (J&J); this tool performs the API call.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          slug: { type: 'string', description: 'Solution slug ^[a-z][a-z0-9-]{1,31}$' },
          description: { type: 'string' },
          initial_files: {
            type: 'array',
            description: 'Files to commit on initial push. Empty → just creates the auto-init repo.',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
          private: { type: 'boolean', default: false },
        },
        required: ['run_id', 'slug', 'description'],
      },
    },
    {
      name: 'query_feature_catalog',
      description: 'Search the Catalog for features matching filter (kind, tier, tracks, category, tag, search). Returns array of matches.',
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
      description: 'Materialize a Catalog feature into the working solution directory. Kind-aware: snippet=copy+sub, integration=add SDK+glue, platform=copy client. Returns files_added/deps/env_vars.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          feature_id: { type: 'string' },
          intent: { type: 'string', description: 'use as-is | use as base scaffold | customize | extend' },
          solution_path: { type: 'string' },
          substitutions: { type: 'object' },
        },
        required: ['run_id', 'feature_id', 'intent', 'solution_path'],
      },
    },
    {
      name: 'commit_to_solution',
      description: 'Commit + push files to the solution repo. Subject is prefixed as <persona>(<iter>): <subject> per spec §8.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          persona: { type: 'string', enum: PERSONA_NAMES },
          iteration: { type: 'number' },
          subject: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
            minItems: 1,
          },
        },
        required: ['run_id', 'persona', 'iteration', 'subject', 'files'],
      },
    },
    {
      name: 'propose_feature_promotion',
      description: 'Mark a piece of solution code as catalog-worthy. Queues a feature_promotions row for operator approval.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          spec: { type: 'object', description: 'Proposed feature.yaml spec' },
          payload_path: { type: 'string', description: 'Local path containing candidate code to copy on approval' },
        },
        required: ['run_id', 'spec', 'payload_path'],
      },
    },
    {
      name: 'run_quality_checks',
      description: 'Persona-Quality tool. Agent reports tests added and any failures.',
      input_schema: {
        type: 'object',
        properties: { run_id: { type: 'number' }, tests_added: { type: 'array', items: { type: 'string' } } },
        required: ['run_id'],
      },
    },
    {
      name: 'run_security_scan',
      description: 'Persona-Security tool. Agent records advisories and the no-DB-rule check.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          advisories: { type: 'array', items: { type: 'object' } },
          db_violation_found: { type: 'boolean' },
        },
        required: ['run_id'],
      },
    },
    {
      name: 'configure_ci_cd',
      description: 'CI/CD persona records the workflow YAMLs and vercel.json added. Files committed via commit_to_solution.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          workflows_added: { type: 'array', items: { type: 'string' } },
          vercel_configured: { type: 'boolean' },
          observability_configured: { type: 'boolean' },
        },
        required: ['run_id'],
      },
    },
    {
      name: 'provision_vercel_env',
      description: 'Set Vercel env vars on the solution project.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          vercel_project_id: { type: 'string' },
          env_vars: { type: 'object', description: 'Map of key → value' },
        },
        required: ['run_id', 'vercel_project_id', 'env_vars'],
      },
    },
    {
      name: 'attach_custom_domain',
      description: 'Attach a custom domain to the solution\'s Vercel project, if the brief specifies one.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          vercel_project_id: { type: 'string' },
          domain: { type: 'string' },
        },
        required: ['run_id', 'vercel_project_id', 'domain'],
      },
    },
    {
      name: 'run_critic_evaluation',
      description: 'Critic persona records alignment score (0–100) and misalignments against PRD.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          alignment_score: { type: 'number' },
          misalignments: { type: 'array', items: { type: 'string' } },
        },
        required: ['run_id', 'alignment_score'],
      },
    },
    {
      name: 'run_e2e_test',
      description: 'Tester persona records E2E results + evidence URLs.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          e2e_results: { type: 'array', items: { type: 'object' } },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['run_id'],
      },
    },
    {
      name: 'record_verdict',
      description: 'Persist a persona verdict to forge_verdicts and publish forge_t1.verdict.recorded. THIS MUST BE THE FINAL TOOL CALL of every persona run.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'number' },
          iteration: { type: 'number' },
          persona: { type: 'string', enum: PERSONA_NAMES },
          pass: { type: 'boolean' },
          verdict: { type: 'object', description: 'Full persona-shaped verdict payload (see spec §3 table)' },
        },
        required: ['run_id', 'iteration', 'persona', 'pass', 'verdict'],
      },
    },
    {
      name: 'publish_build_ready',
      description: 'No-op from the agent — the coordinator publishes forge_t1.build.ready when promotion_review records a passing verdict. Present here only for spec symmetry.',
      input_schema: { type: 'object', properties: { run_id: { type: 'number' } }, required: ['run_id'] },
    },
  ];

  // --- Handlers ----------------------------------------------------------

  const githubToken = process.env.GITHUB_TOKEN ?? '';
  const githubOrg = process.env.GITHUB_ORG ?? 'TheFactoryOrg';
  const vercelToken = process.env.VERCEL_API_TOKEN ?? '';
  const vercelOrgId = process.env.VERCEL_ORG_ID ?? '';

  async function execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'scaffold_solution_repo':       return await handleScaffoldSolutionRepo(input);
      case 'query_feature_catalog':        return handleQueryFeatureCatalog(input);
      case 'pull_feature':                 return await handlePullFeature(input);
      case 'commit_to_solution':           return await handleCommitToSolution(input);
      case 'propose_feature_promotion':    return handleProposeFeaturePromotion(input);
      case 'run_quality_checks':           return handleSnapshot(input, 'quality');
      case 'run_security_scan':            return handleSnapshot(input, 'security');
      case 'configure_ci_cd':              return handleSnapshot(input, 'ci_cd');
      case 'provision_vercel_env':         return await handleProvisionVercelEnv(input);
      case 'attach_custom_domain':         return await handleAttachCustomDomain(input);
      case 'run_critic_evaluation':        return handleSnapshot(input, 'critic');
      case 'run_e2e_test':                 return handleSnapshot(input, 'tester');
      case 'record_verdict':               return handleRecordVerdict(input);
      case 'publish_build_ready':          return JSON.stringify({ status: 'deferred_to_coordinator' });
      default:                             return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  }

  async function handleScaffoldSolutionRepo(input: Record<string, unknown>): Promise<string> {
    const runId = numOr0(input.run_id);
    const slug = strOr(input.slug, '');
    const description = strOr(input.description, '');
    if (!runId) return invalid('run_id');
    if (!SLUG_RE.test(slug)) return invalid('slug');
    if (!description) return invalid('description');
    if (!githubToken) return JSON.stringify({ status: 'config_error', message: 'GITHUB_TOKEN not set' });

    const client = new GitHubClient({ token: githubToken, org: githubOrg });
    let info;
    try {
      info = await client.createSolutionRepo(slug, description, input.private === true);
    } catch (err) {
      return JSON.stringify({ status: 'github_error', message: errMsg(err) });
    }

    // Clone the new repo into a per-experiment workdir, then push the initial files.
    const run = ctx.db.prepare('SELECT experiment_id FROM forge_runs WHERE id = ?').get(runId) as { experiment_id: string } | undefined;
    if (!run) return JSON.stringify({ status: 'run_not_found', run_id: runId });
    const workdirRoot = workdirPath(run.experiment_id);
    let wd;
    try {
      wd = await Workdir.cloneRepo(info.html_url + '.git', workdirRoot, githubToken);
    } catch (err) {
      return JSON.stringify({ status: 'clone_error', message: errMsg(err) });
    }

    const initialFiles = Array.isArray(input.initial_files) ? (input.initial_files as GitHubFile[]) : [];
    let commitSha: string | null = null;
    if (initialFiles.length > 0) {
      try {
        await wd.writeFiles(initialFiles);
        commitSha = await wd.stageCommitPush('chore: initial commit');
      } catch (err) {
        return JSON.stringify({ status: 'github_error', message: errMsg(err) });
      }
    }

    ctx.db.prepare('UPDATE forge_runs SET solution_repo = ?, solution_slug = ?, final_commit_sha = ? WHERE id = ?')
      .run(info.full_name, slug, commitSha, runId);

    return JSON.stringify({
      status: 'created',
      full_name: info.full_name,
      html_url: info.html_url,
      default_branch: info.default_branch,
      initial_commit_sha: commitSha,
      workdir: workdirRoot,
    });
  }

  function handleQueryFeatureCatalog(input: Record<string, unknown>): string {
    if (!ctx.featureCatalog) return JSON.stringify({ status: 'config_error', message: 'FeatureCatalog not wired into ctx' });
    const filter: Parameters<FeatureCatalogSurface['list']>[0] = {
      kind: strOptional(input.kind),
      tier: strOptional(input.tier),
      tracks: Array.isArray(input.tracks) ? (input.tracks as string[]) : undefined,
      category: strOptional(input.category),
      tag: strOptional(input.tag),
      search: strOptional(input.search),
      status: 'active',
    };
    const features = ctx.featureCatalog.list(filter);
    return JSON.stringify({ status: 'ok', features });
  }

  async function handlePullFeature(input: Record<string, unknown>): Promise<string> {
    if (!ctx.featureCatalog) return JSON.stringify({ status: 'config_error', message: 'FeatureCatalog not wired' });
    const runId = numOr0(input.run_id);
    const featureId = strOr(input.feature_id, '');
    const intent = strOr(input.intent, '');
    const solutionPath = strOr(input.solution_path, '');
    if (!runId) return invalid('run_id');
    if (!featureId) return invalid('feature_id');
    if (!intent) return invalid('intent');
    if (!solutionPath) return invalid('solution_path');

    const run = ctx.db.prepare('SELECT experiment_id, solution_repo, tier FROM forge_runs WHERE id = ?').get(runId) as { experiment_id: string; solution_repo: string | null; tier: string } | undefined;
    if (!run) return JSON.stringify({ status: 'run_not_found', run_id: runId });

    const subs = (input.substitutions && typeof input.substitutions === 'object')
      ? (input.substitutions as Record<string, string>)
      : {};

    try {
      const result = await ctx.featureCatalog.materialize(
        featureId, intent, solutionPath, subs,
        { experiment_id: run.experiment_id, solution_repo: run.solution_repo ?? '', tier: run.tier },
      );
      return JSON.stringify({ status: 'materialized', ...result });
    } catch (err) {
      return JSON.stringify({ status: 'materialize_error', message: errMsg(err) });
    }
  }

  async function handleCommitToSolution(input: Record<string, unknown>): Promise<string> {
    const runId = numOr0(input.run_id);
    const persona = strOr(input.persona, '');
    const iteration = numOr0(input.iteration);
    const subject = strOr(input.subject, '');
    const files = Array.isArray(input.files) ? (input.files as GitHubFile[]) : [];
    if (!runId) return invalid('run_id');
    if (!PERSONA_NAMES.includes(persona as PersonaId)) return invalid('persona');
    if (!iteration) return invalid('iteration');
    if (!subject) return invalid('subject');
    if (files.length === 0) return invalid('files');

    const run = ctx.db.prepare('SELECT experiment_id, solution_slug FROM forge_runs WHERE id = ?').get(runId) as { experiment_id: string; solution_slug: string | null } | undefined;
    if (!run || !run.solution_slug) return JSON.stringify({ status: 'run_not_scaffolded', run_id: runId });

    const workdirRoot = workdirPath(run.experiment_id);
    if (!fs.existsSync(workdirRoot)) return JSON.stringify({ status: 'workdir_missing', message: `Expected workdir at ${workdirRoot}. Did scaffold_solution_repo run?` });

    const wd = new Workdir(workdirRoot);
    try {
      await wd.writeFiles(files);
    } catch (err) {
      return JSON.stringify({ status: 'write_error', message: errMsg(err) });
    }

    // Run sandbox BEFORE committing. If sandbox fails, leave files staged in the
    // workdir (the agent can iterate on them next turn) but do NOT push — EXCEPT
    // for the Quality carve-out below.
    const sandbox = new Sandbox(wd, ctx.db);
    const sb = await sandbox.run({ runId, iteration, persona });
    if (sb.status !== 'green') {
      // Quality carve-out: a failing test that Quality just authored is a
      // legitimate deliverable (it proves a Builder bug). Push it as
      // [red-tests] so Builder iter+1 can SEE the test file, not just read
      // about it in Quality's verdict notes. Conditions:
      //   - persona is 'quality'
      //   - sandbox failed at the test step (typecheck/build/install failures don't qualify)
      //   - every file in the batch is a test file (no production code sneaking through)
      const allFilesAreTests = files.every(f => isTestPath(f.path));
      const qualityRedTests =
        persona === 'quality' &&
        sb.status === 'tests_failed' &&
        allFilesAreTests;

      if (qualityRedTests) {
        let sha: string;
        try {
          sha = await wd.stageCommitPush(`[red-tests] quality(${iteration}): ${subject}`);
        } catch (err) {
          return JSON.stringify({ status: 'git_error', message: errMsg(err) });
        }
        // Keep last_sandbox_status as 'failed' — the gate in record_verdict
        // still blocks pass=true. Quality MUST record pass=false next.
        ctx.db.prepare('UPDATE forge_runs SET last_sandbox_status = ?, last_sandbox_error = ? WHERE id = ?')
          .run('failed', sb.errorSummary, runId);
        return JSON.stringify({
          status: 'committed_red_tests',
          sha,
          sandbox_status: sb.status,
          error_summary: sb.errorSummary,
          message: 'Failing tests pushed as [red-tests]. Now call record_verdict with pass:false and detail the failure in verdict.notes — Builder will pick it up next iteration.',
        });
      }

      ctx.db.prepare('UPDATE forge_runs SET last_sandbox_status = ?, last_sandbox_error = ? WHERE id = ?')
        .run('failed', sb.errorSummary, runId);
      return JSON.stringify({
        status: 'sandbox_failed',
        sandbox_status: sb.status,
        error_summary: sb.errorSummary,
        stdout_tail: sb.stdoutTail.slice(-1500),
        stderr_tail: sb.stderrTail.slice(-1500),
        message: 'Files written to workdir but NOT pushed. Fix the errors and call commit_to_solution again. Do not call record_verdict with pass:true until sandbox returns green.',
      });
    }

    // Sandbox green → commit + push.
    let sha: string;
    try {
      sha = await wd.stageCommitPush(`${persona}(${iteration}): ${subject}`);
    } catch (err) {
      return JSON.stringify({ status: 'git_error', message: errMsg(err) });
    }
    ctx.db.prepare('UPDATE forge_runs SET final_commit_sha = ?, last_sandbox_status = ?, last_sandbox_error = NULL WHERE id = ?')
      .run(sha, 'green', runId);
    return JSON.stringify({ status: 'committed', sha, sandbox_status: 'green' });
  }

  function handleProposeFeaturePromotion(input: Record<string, unknown>): string {
    if (!ctx.featureCatalog) return JSON.stringify({ status: 'config_error', message: 'FeatureCatalog not wired' });
    const runId = numOr0(input.run_id);
    const spec = (input.spec && typeof input.spec === 'object') ? (input.spec as Record<string, unknown>) : null;
    const payloadPath = strOr(input.payload_path, '');
    if (!runId) return invalid('run_id');
    if (!spec) return invalid('spec');
    if (!payloadPath) return invalid('payload_path');

    const { promotion_id } = ctx.featureCatalog.proposePromotion(spec, payloadPath, runId);
    return JSON.stringify({ status: 'proposed', promotion_id });
  }

  async function handleProvisionVercelEnv(input: Record<string, unknown>): Promise<string> {
    if (!vercelToken || !vercelOrgId) return JSON.stringify({ status: 'config_error', message: 'VERCEL_API_TOKEN / VERCEL_ORG_ID not set' });
    const projectId = strOr(input.vercel_project_id, '');
    if (!projectId) return invalid('vercel_project_id');
    const vars = (input.env_vars && typeof input.env_vars === 'object') ? (input.env_vars as Record<string, string>) : null;
    if (!vars) return invalid('env_vars');
    const client = new VercelClient({ token: vercelToken, orgId: vercelOrgId });
    try {
      await client.setEnvVars(projectId, vars);
      return JSON.stringify({ status: 'env_set', keys: Object.keys(vars) });
    } catch (err) {
      return JSON.stringify({ status: 'vercel_error', message: errMsg(err) });
    }
  }

  async function handleAttachCustomDomain(input: Record<string, unknown>): Promise<string> {
    if (!vercelToken || !vercelOrgId) return JSON.stringify({ status: 'config_error', message: 'VERCEL_API_TOKEN / VERCEL_ORG_ID not set' });
    const projectId = strOr(input.vercel_project_id, '');
    const domain = strOr(input.domain, '');
    if (!projectId) return invalid('vercel_project_id');
    if (!domain) return invalid('domain');
    const client = new VercelClient({ token: vercelToken, orgId: vercelOrgId });
    try {
      const result = await client.attachDomain(projectId, domain);
      return JSON.stringify({ status: 'attached', name: result.name, verified: result.verified });
    } catch (err) {
      return JSON.stringify({ status: 'vercel_error', message: errMsg(err) });
    }
  }

  function handleSnapshot(input: Record<string, unknown>, persona: PersonaId): string {
    const runId = numOr0(input.run_id);
    if (!runId) return invalid('run_id');
    return JSON.stringify({ status: 'snapshot_recorded', persona, run_id: runId });
  }

  function handleRecordVerdict(input: Record<string, unknown>): string {
    const runId = numOr0(input.run_id);
    const iteration = numOr0(input.iteration);
    const persona = strOr(input.persona, '');
    const verdict = (input.verdict && typeof input.verdict === 'object') ? input.verdict : null;
    if (!runId) return invalid('run_id');
    if (!iteration) return invalid('iteration');
    if (!PERSONA_NAMES.includes(persona as PersonaId)) return invalid('persona');
    if (typeof input.pass !== 'boolean') return invalid('pass');
    if (!verdict) return invalid('verdict');

    const result = ctx.db.prepare(
      'INSERT INTO forge_verdicts (run_id, iteration, persona, pass, verdict_json) VALUES (?, ?, ?, ?, ?)'
    ).run(runId, iteration, persona, input.pass ? 1 : 0, JSON.stringify(verdict));
    const verdictId = Number(result.lastInsertRowid);

    ctx.bus.publish('forge_t1.verdict.recorded', ctx.moduleId, {
      run_id: runId, iteration, persona, pass: input.pass, verdict_id: verdictId, verdict,
    });

    return JSON.stringify({ status: 'recorded', verdict_id: verdictId });
  }

  return { definitions, execute };
}

// --- helpers ---------------------------------------------------------------

function numOr0(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function strOr(v: unknown, fallback: string): string { return typeof v === 'string' ? v : fallback; }
function strOptional(v: unknown): string | undefined { return typeof v === 'string' && v.length > 0 ? v : undefined; }
function invalid(field: string): string { return JSON.stringify({ status: 'invalid_input', field }); }
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
