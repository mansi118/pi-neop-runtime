# Hermes/Pi NEop runtime image (GAP-2, ADR-neop-runtime).
#
# THIS FILE DEFINES NO EGRESS SPEC. The egress jail is the single source of truth in
# NEURAL-ops `neop_jcode_adapter/isolation.py` (`build_jail_spec`), which is runtime-agnostic — it
# wraps ANY image in the same fail-closed lockdown (per-seat network + egress firewall confined to
# {palace host, provider host}, --read-only, --cap-drop ALL, --no-new-privileges, single /work bind,
# tmpfs /tmp). This image is simply fed to that jail as `image=`. See docs/JAIL.md. Re-expressing the
# egress rules here would re-create the asserted-equivalence drift GAP-2 exists to close — so we don't.
#
# This Dockerfile's only job: produce the smallest Node image that runs the runtime cleanly AND
# satisfies the jail's constraints — runs NON-ROOT (closes the live-T7 uid-0-in-container gap), writes
# nothing outside /work (host bind) and /tmp (tmpfs) so --read-only rootfs holds, needs no caps/setuid.

# ── build: install prod deps only ──────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY agents ./agents

# ── runtime: minimal, non-root ─────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
# Node 22-alpine runs TS via native type-stripping (package.json engines: node>=22.18); no build step.
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/agents ./agents
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
# Non-root: the 'node' user (uid 1000) ships in the base image — this closes the live-T7 uid-0 gap.
# The jail mounts the seat workdir at /work and a tmpfs at /tmp; the app must write ONLY there.
USER node
# The seat-serve entrypoint lands with M1b; today this runs the runtime CLI. The GAP-2 egress proof
# overrides the entrypoint (`--entrypoint node ... -e <probe>`) to attempt egress from inside the jail.
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["suite", "agents"]
