# pi-neop-runtime

> **NEOS runtime + `nrt` Pi-agent test harness, built on the [earendil-works/pi](https://github.com/earendil-works/pi) agent harness.**
> NE-TSD-RT-V1 · NEURALEDGE · SYNLEX TECHNOLOGIES PVT. LTD. — *verify before trust, gate by gate.*

This is the **NEOS runtime spec (NE-TSD-RT-V1) implemented on top of the real `pi`
runtime** instead of a hand-rolled engine. The terminology lines up exactly:

| NEOS doc term | What it is here |
|---|---|
| **Pi-agent** | one running NEop session (the plan→execute→verify loop) |
| **Pi-subagents** (`planner` / `executor` / `verifier`) | **real [`pi`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) `Agent` runs** |
| **Tool broker** | real **`pi` `AgentTool[]`** with a `beforeToolCall` allowlist guard |
| **Model broker** | **`pi-ai` providers** — the `faux` provider for deterministic unit mode, real providers for integration/live |
| **nrt** | the NEOS Runtime Tester CLI in this repo |

The doc's **supervisor** owns the deterministic plan→execute→verify DAG and the
lifecycle state machine; each phase **delegates to a genuine `pi` agent loop**, so
the agents you test here are running on the same harness that ships them.

---

## Why on top of pi

A NEOP runtime needs an agent engine: model routing, a tool-calling loop, state
management, and — critically for a *test* harness — a way to make runs
deterministic. `pi` provides all four:

- **`@earendil-works/pi-agent-core`** — the `Agent` loop, tool execution, `beforeToolCall`/`afterToolCall` hooks.
- **`@earendil-works/pi-ai`** — multi-provider model API **and the `faux` provider**, which lets the model broker replay recorded responses so unit mode is byte-for-byte deterministic with zero spend.

So the planner/executor/verifier are not simulated — they are real `pi` `Agent`
runs whose model happens to be `faux` in unit mode. The allowlist is enforced by
`pi`'s own `beforeToolCall` hook; tools execute through `pi`'s tool machinery.

---

## Quickstart (no API keys)

```bash
npm install

npm run nrt -- validate agents/recon       # frontmatter + schema, no run
npm run nrt -- test     agents/recon        # all fixtures, unit mode
npm run suite                               # every NEop (CI entrypoint)
npm test                                    # vitest acceptance suite (§6)
```

```
$ node src/cli.ts suite agents/ --mode unit
...
==================================================
SUITE GREEN
```

Node ≥ 22.18 runs the TypeScript sources natively (type-stripping) — no build step.

---

## How a run flows

```
nrt test ─► dispatch() ─► Loader (validate or REJECTED)
                          └─► SessionSupervisor (state machine + DAG)
                                ├─ PLANNING   → runPlanner()   = pi Agent (no tools) → plan.v1
                                ├─ EXECUTING  → runExecutor()  = pi Agent + AgentTools → tool result
                                │                (side-effecting tool ⇒ AWAITING_APPROVAL)
                                └─ VERIFYING  → runVerifier()  = pi Agent (no tools) → pass/fail
                                      ├─ all pass ─► DONE
                                      └─ fail ─► REPLANNING ─► PLANNING | ESCALATED
                          └─► Assertion engine ─► PASS/FAIL + diff + latency + token cost
```

In **unit** mode the model broker programs `pi`'s faux provider before each phase
from `fixtures/cassettes/<case>.json`; in **integration/live** mode the real model
drives the same loop.

### Lifecycle state machine (§2.2)

`LOADING → ASSEMBLING → PLANNING → EXECUTING ⇄ VERIFYING → DONE`, with
`EXECUTING → AWAITING_APPROVAL → {EXECUTING | FAILED}`,
`VERIFYING → REPLANNING → {PLANNING | ESCALATED}`, and `LOADING → REJECTED`.
Illegal transitions throw (`src/state.ts`).

---

## Test modes (§4.1)

| Mode | Model | Tools | Determinism |
|---|---|---|---|
| **unit** | `pi-ai` **faux** (cassette replay) | mock (`fixtures/mocks`) | byte-identical ×3, no spend |
| **integration** | live `pi-ai` provider | mock | catches prompt/plan drift |
| **live** | live provider | real MCP (sandboxed) | promotion smoke |

Integration/live need `ANTHROPIC_API_KEY`. Unit needs nothing.

---

## The Pi-agent contract (§3)

```
agents/<neop>/
  neop.md  planner.md  executor.md  verifier.md   # role + 3 Pi-subagent prompts
  tools.json          # allowlist (+ side_effecting); anything else is denied
  capabilities.json   metrics.json
  fixtures/
    eval.jsonl        # test cases (one JSON object per line)
    golden_plans/     # reference plan.v1 per case
    cassettes/        # recorded faux responses (unit determinism)
    mocks/mocks.json  # canned tool results, keyed by (tool, args-hash)
    twins/            # seed twins
```

A bad definition **fails loud with a named error**:

```
$ node src/cli.ts validate examples/broken-neop
FAIL  examples/broken-neop  -> role_family: must be one of [...], got 'wizardry'
```

---

## CLI surface (§4.5)

```bash
node src/cli.ts validate agents/recon [--suite]
node src/cli.ts test     agents/recon [--mode unit|integration|live] [--case <id>]
node src/cli.ts golden   agents/recon --record
node src/cli.ts trace    <run_id>
node src/cli.ts suite    agents/ [--mode unit]
```

`nrt golden --record` captures current plans as `golden_plans/` — a plan change
becomes a deliberate, diffable commit, not silent drift.

---

## Acceptance — "the Pi-agents are tested" (§6)

All eight criteria run through the **real pi harness** and are covered by
`tests/acceptance.test.ts` (`npm test` → 10 passed):

| # | Criterion | Demonstrated by |
|---|---|---|
| 1 | Loads or **fails loud** (named error) | `examples/broken-neop` |
| 2 | plan→execute→verify to a correct terminal state | `recon_delhi_agencies` → DONE |
| 3 | **Determinism** in unit mode (identical plan ×3) | every unit case (pi faux) |
| 4 | **Golden-plan regression** catches a plan change | `structuralDiff` |
| 5 | **Allowlist** enforced; `must_not_call` never fires | `recon_forbidden_tool` (send_email denied) |
| 6 | **Re-plan + escalate** | `recon_escalate_always_fail` → ESCALATED |
| 7 | **Live smoke** (sandboxed) | `--mode live` (scaffolded) |
| 8 | Whole suite in **CI** under fixed budget | `.github/workflows/nrt.yml` |

The `outreach` NEop additionally exercises the **AWAITING_APPROVAL** grant/deny path.

---

## Repo layout

```
src/
  schema.ts       frontmatter + plan.v1 validation (named errors)
  loader.ts       load + validate a NEop folder (fails loud)
  state.ts        lifecycle state machine + transition guard
  plan.ts         plan.v1 model + structural diff + deterministic ids
  trace.ts        per-phase spans + token/cost ledger (fed by pi usage)
  brokers/
    model.ts      pi-ai: faux (unit) / real provider (integration/live)
    tool.ts       builds pi AgentTools from the allowlist + mocks
    memory.ts     fixture STM + no-op write sink
    acp.ts        HMAC-signed envelopes (Ed25519 stand-in)
  subagents.ts    planner/executor/verifier as REAL pi Agent runs
  supervisor.ts   state machine + plan→execute→verify DAG
  api.ts          dispatch (loader → supervisor → trace)
  harness/        fixtures loader · assertion engine
  cli.ts          the `nrt` command
agents/           recon, outreach (with fixtures + cassettes)
examples/         broken-neop (fail-loud test)
tests/            vitest acceptance suite (maps to §6)
```

## License

MIT (matches upstream `pi`).
