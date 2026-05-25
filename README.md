# Forge T1 — Simple Solutions Factory

Risk-Tier 1 factory module for Company OS. Receives feasibility-green plans
from the Planning module via the Forge Dispatcher and builds Next.js +
edge-function solutions (no persistence).

**Spec:** master repo `docs/superpowers/specs/2026-05-22-forge-module-design.md`
**Plan:** master repo `docs/superpowers/plans/2026-05-22-forge-t1-module.md`

## Status

Phase 5 (this commit): scaffold landed; tool handlers are `not_implemented`.
Phase 6 fills in the coordinator + persona prompts + tool handlers.

## Module contract

- `module.yaml` — id, subscriptions, credentials, agent config
- `agent.md` — six personas + promotion review (post-loop)
- `escalation.yaml` — J&J for boundary actions, inform for loop internals
- `routines.yaml` — empty (event-driven only)
- `tools.ts` — factory `createForgeT1Tools(ctx)` returning `{ definitions, execute }`
- `types.ts` — inline-copied kernel types
- `lib/` — coordinator, GitHub wrapper, Vercel wrapper, diff helpers (Phase 6)
- `tests/` — unit + coordination + e2e tests (Phase 6)

## Local dev

```bash
npm install
npm run build
npm test
```

## Integration

This is a submodule of master Company OS. Mount at `modules/forge-t1/`:

```bash
git submodule add https://github.com/TheFactoryOrg/company-os-module-forge-t1.git modules/forge-t1
```
