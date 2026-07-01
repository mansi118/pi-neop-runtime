# Hermes runtime isolation (GAP-2, ADR-neop-runtime)

> **There is exactly one egress-jail spec, and it is not in this repo.** It lives in NEURAL-ops
> `neop_jcode_adapter/isolation.py` (`build_jail_spec`). This document explains how the Node Hermes
> image plugs into that spec — it deliberately does **not** restate the rules, because a second copy
> that *claims* to match and isn't *verified* to match is the exact asserted-equivalence drift GAP-2
> was opened to close (the same failure that produced the `memory.ts:23` `/mcp` gap).

## The jail is runtime-agnostic — Hermes is just a new `image`

`build_jail_spec(seat, image, *, palace_mcp_url, workdir_mount, env_passthrough, provider)` produces a
fail-closed `JailSpec` whose lockdown does not depend on what runs inside the container:

- per-seat network `neop-<palaceId>-<neopId>` (NOT the default bridge) with the egress firewall bound to it;
- `egress_allowlist` = **only** `{palace host, provider host}` — fail-closed on a blank/unparseable
  palace URL or unknown provider; everything else dropped;
- `--read-only` rootfs · `--cap-drop ALL` · `--security-opt no-new-privileges` · `--pids-limit 256`
  · `--memory 2g` · `--cpus 1.0` · `--tmpfs /tmp:rw,noexec,nosuid,size=256m` · `--workdir /work`;
- the **single** host bind is the per-seat workdir at `/work` (rootfs is RO); sensitive binds
  (docker socket, `/etc`, `/proc`, …) are refused;
- `env_passthrough` forwards var **names** only — values come from the launcher's env, never the image.

The jcode-Rust image was validated under this spec at live T7. The Node Hermes image is fed to the
**same** `build_jail_spec` as `image=ghcr.io/mansi118/pi-neop-runtime:<tag>`. No rule here widens it.

## How this image satisfies the spec's constraints

| Jail constraint | How the image complies |
|---|---|
| `--read-only` rootfs | writes nothing outside `/work` (host bind) and `/tmp` (tmpfs); `NODE_ENV=production`, no build/cache at runtime |
| non-root (closes the live-T7 uid-0 gap) | `USER node` (uid 1000) — the live T7 honest-gap was uid-0-in-container; this removes it |
| `--cap-drop ALL` / `no-new-privileges` | no setuid binaries relied on; pure Node process |
| smallest viable base | `node:22-alpine` (runs the runtime's native-TS path cleanly; distroless is a future hardening note below) |

## Proof — box-gated, RUN not BUILD

GAP-2 is **done only when the jail is *run* and adversarially proven** on the box, not when this image
builds. The proof is image-parameterized and lives with the spec it reuses:
`NEURAL-ops neop_jcode_adapter/tools/gap2_jail_proof` (image = this image). It must, from inside the
jailed container, demonstrate **enforcement** (not configuration):

- palace host reachable ✅
- cloud metadata `169.254.169.254` blocked ❌
- arbitrary internet (e.g. `https://example.com`) blocked ❌
- escape attempts fail (no docker socket, RO rootfs holds, non-root)

Until that proof exits 0 against this image, **GAP-2 is RED**. (Live T7 caught two real holes offline —
`_admin` signing, docker.sock bind — that only an executed, adversarial run surfaces.)

## Deviations from the spec (record, don't silently encode)

- **None to the egress jail.** This image adds no egress rule and changes none.
- **Base image:** `node:22-alpine` (not distroless) so the runtime's native-TS entrypoint runs without a
  separate `tsc` build stage. Distroless (`gcr.io/distroless/nodejs22`) is a future hardening once an
  emitted-JS build step exists — tracked here, not silently chosen.
- **Entrypoint:** the seat-serve entrypoint lands with M1b; today `ENTRYPOINT` runs the runtime CLI and
  the egress proof overrides it (`--entrypoint`) to run probes.
