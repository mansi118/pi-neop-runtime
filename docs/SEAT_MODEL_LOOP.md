# The seat reply loop & how models are wired (Haiku + Sonnet)

> **A NEop's conversational turn is a defined two-model loop, not one opaque call.** The fast tier
> (Haiku) grounds memory and guards the draft; the quality tier (Sonnet) writes the answer. This doc
> explains the loop and — the part worth keeping — **exactly how a model is added and routed through
> the codebase**, so adding another tier or swapping a provider is a recipe, not an archaeology dig.
> Shipped in #12 (ML directive 2026-07-10). Live on both seat services (aria, recon).

## Why a loop

A single generation is opaque: you can't see why it answered, and it happily bleeds irrelevant
retrieved memory into unrelated answers (the seeded-junk-ICP bleed). Splitting the turn into named
steps makes each one cheap where it can be, testable in isolation, and honest about what it did:

```
GROUND  (Haiku)  — filter retrieved memory to ONLY what's relevant to THIS message. Kills the bleed.
ANSWER  (Sonnet) — think, then reply — grounded ONLY in the kept memory + persona, no fabrication.
GUARD   (Haiku)  — vet the draft (on-persona, no prompt leak, no invented facts); on failure, fall
                   back to a safe reply (`LOOP_FALLBACK`) rather than ship a bad one.
```

The loop is **pure over injected `fast`/`quality` `Generate`s + memory** (`src/seat/loop.ts`) —
unit-tested with stubs, no live model (`tests/loop.test.ts`, 10 cases). Both tiers are `Generate`
(a judgement/answer, never a tool action), so the loop is tool-less by construction.

| Step | Tier | Function (`src/seat/loop.ts`) | Behaviour |
|---|---|---|---|
| GROUND | Haiku (fast) | `ground()` :30 | Returns kept snippets, or `""` when retrieval is empty / the model says `(none)`. |
| ANSWER | Sonnet (quality) | `answer()` :53 | System = persona + how-to-answer rules (`answerSystem()` :40); user = message + kept memory (or `(no relevant memory)`). |
| GUARD | Haiku (fast) | `guard()` :73 | Parses `{"ok":true|false}`; a parse/throw failure returns `true` (best-effort — never blocks a genuine answer). |
| — | — | `replyLoop()` :91 | Composes the three; returns a `ReplyEnvelope` with honest `meta` (retrievalCount, groundedKept, guarded, loop). Empty draft or a failed guard → `LOOP_FALLBACK` :20. |

## How models flow through the codebase

A model id enters as an env string and comes out as a `pi-ai` `Model` the loop can call. Four hops:

```
env (SEAT_MODEL_FAST / SEAT_MODEL_QUALITY)
  └─ server.ts runSeatServer         makeFast / makeQuality factories        (src/seat/server.ts:57)
       └─ new ModelBroker("live", <id override>)                            (src/brokers/model.ts:86)
            └─ resolveLiveModel → resolveBedrockModel  → pi-ai Model         (src/brokers/model.ts:189)
                 └─ modelGenerate(broker) → Generate                        (src/seat/generate.ts)
                      └─ replyLoop({ fast, quality, memory })               (src/seat/wrapper.ts:219)
```

1. **`ModelBroker(mode, modelIdOverride?)`** (`src/brokers/model.ts:86`) — the integration point with
   `pi-ai`. The optional **`modelIdOverride`** (:82) is what lets **two brokers on the same provider run
   different models** without fighting over the single process-wide `NRT_MODEL`. It wins over
   `NRT_MODEL`, which wins over the provider `DEFAULT_MODEL` (`resolveLiveModel`, :189).

2. **Provider is chosen by `NEOP_PROVIDER`** (`resolveProvider`, default `openrouter`; the sealed spine
   sets `amazon-bedrock`). Each provider knows its key env via `PROVIDER_KEY_ENV`. `amazon-bedrock` is
   special: `pi-ai` reads `AWS_BEARER_TOKEN_BEDROCK` + region from env **itself** at stream time, so the
   key does not flow through `getApiKey`.

3. **Bedrock id mapping** (`BEDROCK_PROFILE_TO_CATALOG`, :58) — `pi-ai`'s registry knows only **bare**
   ids (`amazon.nova-lite-v1:0`), but on-demand Converse needs the **regional/global inference profile**
   (`apac.*` / `global.*`); bare ids reject. `pi-ai` sends `model.id` **verbatim** as the Converse
   `modelId`, so `resolveBedrockModel` (:189+) fetches a bare catalog shell, **clones it**, and stamps
   the profile id onto the clone:
   ```ts
   const model = Object.assign(Object.create(Object.getPrototypeOf(shell)), shell);
   (model as any).id = wanted;   // e.g. "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
   ```
   Two things matter here and are load-bearing:
   - **CLONE before stamping.** The registry returns a *shared* object; the fast and quality brokers
     would otherwise stamp the same instance and clobber each other's id.
   - **Fallback shell.** Newer Claude ids may not be in `pi-ai`'s registry yet — the shell then falls
     back to the always-present `amazon.nova-lite-v1:0` and the wanted id rides on it (Bedrock itself
     rejects a truly bogus id at invoke time).

4. **`modelGenerate(broker)`** (`src/seat/generate.ts`) wraps a broker into a `Generate =
   (system, user) => Promise<string>` (tool-less). `makeLiveHandlers` builds one per tier — `genFast`,
   `genQuality` (`src/seat/wrapper.ts:214`) — routes `classify` on the fast tier and `reply` through
   `replyLoop` with both (:219). The **task path is unchanged**: it still rides `NRT_MODEL`.

### Config surface

| Env | Used by | Default | Notes |
|---|---|---|---|
| `NEOP_PROVIDER` | `resolveProvider` | `openrouter` | Spine sets `amazon-bedrock`. |
| `SEAT_MODEL_FAST` | `makeFast` (server.ts:58) | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Haiku: ground + guard + classify. |
| `SEAT_MODEL_QUALITY` | `makeQuality` (server.ts:60) | `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | Sonnet: the user-facing answer. |
| `NRT_MODEL` | task path only | provider `DEFAULT_MODEL` | The reply loop overrides it via `modelIdOverride`. |
| `AWS_BEARER_TOKEN_BEDROCK` | `pi-ai` (bedrock) | — | Read from env by `pi-ai`; its IAM principal must allow `bedrock:InvokeModel` on the profile ARNs. |

Terraform wires the two seat env vars per provider in `infra/terraform/wrapper.tf` (NEURAL-ops);
live seat task-defs also carry them (`neos-dogfood-wrapper` / `-recon`).

## Worked example — adding a model tier (or swapping a provider)

Say you want a third **`critic`** tier on Bedrock (`global.anthropic.claude-opus-4-5-...`) for an extra
refine pass. The change is mechanical because each hop above is a named seam:

1. **Register the id** so on-demand Converse resolves the profile. Add to `BEDROCK_PROFILE_TO_CATALOG`
   (`src/brokers/model.ts:58`) — or rely on the nova-shell fallback if it isn't in `pi-ai`'s registry:
   ```ts
   "global.anthropic.claude-opus-4-5-20251101-v1:0": "anthropic.claude-opus-4-5-20251101-v1:0",
   ```
2. **Thread a broker** for it: add `makeCritic: () => new ModelBroker("live", env.SEAT_MODEL_CRITIC || "<id>")`
   to `SeatServerDeps` (`src/seat/server.ts:19`) and `assembleSeatServer` (:44), pass it into
   `makeLiveHandlers`, wrap it with `modelGenerate` next to `genFast`/`genQuality` (`src/seat/wrapper.ts:214`).
3. **Use it in the loop**: add a step to `src/seat/loop.ts` (a new `Generate` param on `LoopDeps` :85 and
   a call in `replyLoop` :91). Keep it pure — a system prompt + the draft in, a string out.
4. **Test first** — extend `tests/loop.test.ts` with a stub for the new tier (no live model), and
   `tests/server.test.ts` / `tests/serve.test.ts` for the new factory + the id stamp. `npx vitest run`.
5. **Config**: add `SEAT_MODEL_CRITIC` to `infra/terraform/wrapper.tf` and the live task-defs.
6. **Deploy**: CodeBuild rebuild → roll both seat services → verify. Confirm the bearer token's IAM
   allows `bedrock:InvokeModel` on the new profile ARN.

**Swapping a provider** (e.g. run the loop on OpenRouter) needs only steps 2/5-style changes: set
`NEOP_PROVIDER=openrouter` and point `SEAT_MODEL_FAST/QUALITY` at provider-prefixed ids
(`anthropic/claude-3.5-haiku`). No loop code changes — the broker abstracts the provider.

## Invariants (don't regress)

- **Scope is never model-chosen.** The loop only sees the persona + filtered memory; palace scope stays
  env-baked in the wrapper (`M_SCOPE_SPOOF` rejection). Adding a tier must not pass scope to a model.
- **Clone Bedrock shells before stamping `.id`** — shared registry objects, one per-broker id.
- **Guard is best-effort** — a guard parse/throw failure must return `true`, never block a real answer.
- **Task path stays on `NRT_MODEL`** — the loop overrides only the reply path via `modelIdOverride`.
