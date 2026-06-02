---
neop_id: broken
version: 1
role_family: wizardry
model:
  planner: claude-sonnet
  executor: gpt-5.4-mini
  classifier: haiku
limits:
  max_replans: 2
  phase_timeout_s: { plan: 20, execute: 45, verify: 15 }
tools: [browser_agent, send_email]
---

# broken — used by tests

`role_family: wizardry` is not one of the five families, and `tools:` lists
`send_email` which is not in tools.json allow[]. `nrt validate` must fail loud
with a *named* error pointing at the offending field.
