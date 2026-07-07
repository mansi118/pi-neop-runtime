#!/usr/bin/env node
/**
 * nrt — NEOS Runtime Tester CLI, on top of the pi agent harness (§4.5).
 *
 *   nrt validate <neop> [--suite]
 *   nrt test     <neop> [--mode unit|integration|live] [--case <id>]
 *   nrt golden   <neop> --record [--case <id>]
 *   nrt trace    <run_id>
 *   nrt suite    <agents-dir> [--mode ...]
 */

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "./loader.ts";

// Minimal .env loader (no dependency): used by integration/live mode for keys.
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadDotEnv();
import { FrontmatterError } from "./schema.ts";
import { dispatch } from "./api.ts";
import { loadCases, writeGolden } from "./harness/fixtures.ts";
import { assertCase } from "./harness/assertions.ts";
import { canonicalBytes } from "./plan.ts";
import { loadTrace } from "./trace.ts";
import type { Mode } from "./brokers/model.ts";
import { serveSeat } from "./serve.ts";
import { runSeatServer } from "./seat/server.ts";

const useColor = process.stdout.isTTY;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const PASS = green("PASS");
const FAIL = red("FAIL");

function discoverNeops(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "neop.md")))
    .sort();
}

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function cmdValidate(positional: string[], flags: any): Promise<number> {
  const paths = flags.suite ? discoverNeops(positional[0]) : [positional[0]];
  if (flags.suite && paths.length === 0) {
    console.log(red(`no NEop folders found under ${positional[0]}`));
    return 1;
  }
  let rc = 0;
  for (const p of paths) {
    try {
      const nd = load(p);
      console.log(`${PASS}  ${p}  (${nd.neopId} v${nd.frontmatter.version}, ${nd.allow.length} tools allowed)`);
    } catch (e) {
      console.log(`${FAIL}  ${p}  -> ${red(String((e as Error).message))}`);
      rc = 1;
    }
  }
  return rc;
}

async function determinismOk(neopPath: string, testCase: any): Promise<[boolean, string]> {
  const sigs = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const r = await dispatch(neopPath, testCase, "unit");
    if (!r.plan) return [false, "no plan emitted"];
    sigs.add(canonicalBytes(r.plan));
  }
  return [sigs.size === 1, sigs.size === 1 ? "byte-identical x3" : "plan varied across runs"];
}

async function cmdTest(positional: string[], flags: any): Promise<number> {
  const neopPath = positional[0];
  const mode: Mode = (flags.mode as Mode) ?? "unit";
  let nd;
  try {
    nd = load(neopPath);
  } catch (e) {
    console.log(`${FAIL}  load ${neopPath} -> ${red(String((e as Error).message))}`);
    return 1;
  }
  let cases = loadCases(nd);
  if (flags.case) cases = cases.filter((c) => c.case_id === flags.case);
  if (cases.length === 0) {
    console.log(red(`no matching cases in ${join(nd.fixturesDir, "eval.jsonl")}`));
    return 1;
  }

  console.log(bold(`\n${nd.neopId}  ·  mode=${mode}  ·  ${cases.length} case(s)\n`));
  let totalFail = 0;

  for (const testCase of cases) {
    let result;
    try {
      result = await dispatch(neopPath, testCase, mode);
    } catch (e) {
      totalFail++;
      console.log(`${FAIL}  ${testCase.case_id}  ${dim(`[run error]`)}`);
      console.log(red(`      ✗ ${(e as Error).message}`));
      continue;
    }
    const report = assertCase(nd, testCase, result);
    if (mode === "unit" && result.terminalState !== "REJECTED") {
      const [ok, detail] = await determinismOk(neopPath, testCase);
      report.add("determinism", ok, detail);
    }
    const status = report.passed ? PASS : FAIL;
    if (!report.passed) totalFail++;
    const lat = result.trace.totalLatencyS();
    console.log(`${status}  ${testCase.case_id}  ${dim(`[${result.terminalState}] ${lat}s $${result.trace.costUsd}`)}`);
    for (const chk of report.checks) {
      const mark = chk.passed ? green("✓") : red("✗");
      const line = `      ${mark} ${chk.name}: ${chk.detail}`;
      console.log(chk.passed ? line : red(line));
    }
    console.log(dim(`      run_id=${result.runId}  (nrt trace ${result.runId})`));
  }

  const summary = `${cases.length - totalFail}/${cases.length} cases passed`;
  console.log("\n" + (totalFail === 0 ? green(summary) : red(summary)));
  return totalFail === 0 ? 0 : 1;
}

async function cmdGolden(positional: string[], flags: any): Promise<number> {
  const neopPath = positional[0];
  const nd = load(neopPath);
  let cases = loadCases(nd);
  if (flags.case) cases = cases.filter((c) => c.case_id === flags.case);
  let n = 0;
  for (const testCase of cases) {
    const ref = testCase.expect?.golden_plan;
    if (!ref) continue;
    const result = await dispatch(neopPath, testCase, (flags.mode as Mode) ?? "unit");
    if (!result.plan) {
      console.log(`${FAIL}  ${testCase.case_id}: no plan to record`);
      continue;
    }
    if (flags.record) {
      const out = writeGolden(nd, ref, result.plan);
      console.log(`${green("recorded")}  ${testCase.case_id} -> ${out}`);
      n++;
    } else {
      console.log(dim(`would record ${testCase.case_id} -> ${ref} (pass --record to write)`));
    }
  }
  if (flags.record) console.log(green(`\n${n} golden plan(s) written — commit as a deliberate, diffable change.`));
  return 0;
}

async function cmdTrace(positional: string[]): Promise<number> {
  let tr;
  try {
    tr = loadTrace(positional[0]);
  } catch (e) {
    console.log(red(String((e as Error).message)));
    return 1;
  }
  console.log(bold(`\ntrace ${tr.run_id}  ·  neop=${tr.neop}  case=${tr.case_id}\n`));
  console.log(dim("transitions:"));
  for (const t of tr.transitions) console.log(`  ${t}`);
  console.log(dim("\nphases (latency):"));
  for (const [name, secs] of Object.entries(tr.phase_latency_s)) console.log(`  ${name.padEnd(10)} ${secs}s`);
  console.log(`  ${"TOTAL".padEnd(10)} ${tr.total_latency_s}s`);
  console.log(dim("\ntool calls:"));
  for (const cc of tr.tool_calls) console.log(`  ${cc.tool} (args ${cc.argsHash})`);
  if (tr.denied_tools.length) console.log(red("\ndenied tools: ") + tr.denied_tools.join(", "));
  console.log(dim(`\ntokens in/out: ${tr.tokens.in}/${tr.tokens.out}   cost: $${tr.cost_usd}\n`));
  return 0;
}

async function cmdSuite(positional: string[], flags: any): Promise<number> {
  const neops = discoverNeops(positional[0]);
  if (neops.length === 0) {
    console.log(red(`no NEop folders under ${positional[0]}`));
    return 1;
  }
  let rc = 0;
  for (const p of neops) {
    if ((await cmdTest([p], { mode: flags.mode ?? "unit" })) !== 0) rc = 1;
  }
  console.log(bold("\n" + "=".repeat(50)));
  console.log(rc === 0 ? green("SUITE GREEN") : red("SUITE RED"));
  return rc;
}

// serve — run a NEop on a REAL task (M1b mechanism). See src/serve.ts.
async function cmdServe(positional: string[], flags: any): Promise<number> {
  const neopPath = positional[0];
  if (!neopPath || !flags.task) {
    console.log(red('usage: nrt serve <neop-path> --task "<objective>" [--mode live] [--approvals grant|deny] --i-understand-this-is-T9 yes'));
    return 1;
  }
  const mode: Mode = (flags.mode as Mode) ?? "live";
  // STOP-AND-ASK (CLAUDE.md): a LIVE seat run IS T9 — the first real NEop executing. Refuse to fire it
  // without an explicit acknowledgement flag, so it can never run by accident from a stray invocation.
  if (mode === "live" && flags["i-understand-this-is-T9"] !== "yes") {
    console.log(
      red("REFUSING: `serve --mode live` is the first-real-NEop gate (T9). It needs the box (GAP-2 jail),"),
    );
    console.log(
      red("a live palace (GAP-1: PALACE_MCP_URL/PALACE_ID/NEOP_ID) + a model key (OPENROUTER_API_KEY), and"),
    );
    console.log(red("explicit T9 authorization. Re-run with `--i-understand-this-is-T9 yes` once all hold."));
    return 2;
  }
  const res = await serveSeat(
    neopPath,
    { task: String(flags.task), approvals: flags.approvals === "deny" ? "deny" : "grant" },
    mode,
    Date.now(),
  );
  console.log(
    JSON.stringify(
      {
        neop: res.neop,
        terminalState: res.terminalState,
        acceptanceAllPass: res.acceptanceAllPass,
        replansPerformed: res.replansPerformed,
        taskOutcomes: res.taskOutcomes,
        error: res.error,
      },
      null,
      2,
    ),
  );
  return res.terminalState === "DONE" ? 0 : 1;
}

// serve-seat — the B-fwd HTTP seat wrapper (POST /seat/turn). Config + T9 gate live in seat/server.ts;
// this just boots it and blocks. Refuses loudly (fail-fast) on a blank FORWARD_TOKEN or missing NEOP_T9_ACK.
async function cmdServeSeat(): Promise<number> {
  try {
    runSeatServer(process.env); // throws on blank token / missing T9 ack / blank NEOP_PATH — before wiring live
  } catch (e) {
    console.log(red(`serve-seat refused: ${(e as Error).message}`));
    return 2;
  }
  await new Promise<never>(() => {}); // the node:http server keeps the loop alive; serve until killed
  return 0; // unreachable
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  try {
    switch (cmd) {
      case "validate":
        return await cmdValidate(positional, flags);
      case "test":
        return await cmdTest(positional, flags);
      case "golden":
        return await cmdGolden(positional, flags);
      case "trace":
        return await cmdTrace(positional);
      case "suite":
        return await cmdSuite(positional, flags);
      case "serve":
        return await cmdServe(positional, flags);
      case "serve-seat":
        return await cmdServeSeat();
      default:
        console.log("usage: nrt <validate|test|golden|trace|suite|serve|serve-seat> ...");
        return 1;
    }
  } catch (e) {
    if (e instanceof FrontmatterError) {
      console.log(red(`definition error: ${e.message}`));
      return 1;
    }
    throw e;
  }
}

main().then((code) => process.exit(code));
