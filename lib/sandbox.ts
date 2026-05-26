import type { MinimalDatabase } from '../types.js';
import type { Workdir } from './workdir.js';

export type SandboxStatus = 'green' | 'install_failed' | 'typecheck_failed' | 'tests_failed' | 'build_failed';

export interface SandboxRunRequest {
  runId: number;
  iteration: number;
  persona: string;
}

export interface SandboxResult {
  status: SandboxStatus;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  errorSummary: string;       // short human-readable; fed back to the agent as the tool result
}

/**
 * Runs install → typecheck → tests → build in the workdir, stopping at the first
 * failure. Persists every run to forge_sandbox_runs. The result's errorSummary
 * is surfaced to the calling persona via commit_to_solution's tool response,
 * giving the LLM concrete error text to act on next iteration.
 */
export class Sandbox {
  private static readonly STEPS: Array<{ name: SandboxStatus; cmd: string; timeoutMs: number }> = [
    // Install MUST run first: workdir is a fresh clone with no node_modules.
    // --no-audit --no-fund silences chatter; --prefer-offline reuses npm cache when possible.
    // Works with or without a lockfile (creates one on first run, respects it on subsequent runs).
    // Idempotent: if package.json is unchanged, completes in ~1-2s using the cache.
    { name: 'install_failed',   cmd: 'npm install --no-audit --no-fund --prefer-offline', timeoutMs: 600_000 },
    { name: 'typecheck_failed', cmd: 'npm run typecheck',                       timeoutMs: 180_000 },
    { name: 'tests_failed',     cmd: 'npm test --silent',                       timeoutMs: 300_000 },
    { name: 'build_failed',     cmd: 'npm run build',                           timeoutMs: 600_000 },
  ];

  constructor(private readonly wd: Workdir, private readonly db: MinimalDatabase) {}

  async run(req: SandboxRunRequest): Promise<SandboxResult> {
    let total = 0;
    let combinedStdout = '', combinedStderr = '';

    for (const step of Sandbox.STEPS) {
      const r = await this.wd.runShell(step.cmd, { timeoutMs: step.timeoutMs });
      total += r.durationMs;
      combinedStdout = (combinedStdout + '\n' + r.stdout).slice(-4000);
      combinedStderr = (combinedStderr + '\n' + r.stderr).slice(-4000);
      if (r.exitCode !== 0 || r.timedOut) {
        const summary = `${step.name.replace('_failed', '')}: ${r.timedOut ? 'TIMEOUT' : 'exit ' + r.exitCode} — ${(r.stderr || r.stdout).split('\n').filter(l => l.trim()).slice(-5).join(' | ').slice(0, 600)}`;
        this.recordRun({ ...req, status: step.name, command: step.cmd, stdoutTail: combinedStdout, stderrTail: combinedStderr, durationMs: total });
        return { status: step.name, stdoutTail: combinedStdout, stderrTail: combinedStderr, durationMs: total, errorSummary: summary };
      }
    }

    this.recordRun({ ...req, status: 'green', command: 'install && typecheck && test && build', stdoutTail: combinedStdout, stderrTail: combinedStderr, durationMs: total });
    return { status: 'green', stdoutTail: combinedStdout, stderrTail: combinedStderr, durationMs: total, errorSummary: '' };
  }

  private recordRun(args: SandboxRunRequest & { status: SandboxStatus; command: string; stdoutTail: string; stderrTail: string; durationMs: number }): void {
    this.db.prepare(
      'INSERT INTO forge_sandbox_runs (run_id, iteration, persona, status, command, stdout_tail, stderr_tail, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(args.runId, args.iteration, args.persona, args.status, args.command, args.stdoutTail, args.stderrTail, args.durationMs);
  }
}
