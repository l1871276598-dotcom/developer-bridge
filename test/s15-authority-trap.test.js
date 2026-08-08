import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const git = (cwd, ...args) => execFileAsync("git", args, { cwd });
const operatorIdentity = Object.freeze({ id: "laos.s15.test", type: "local-human" });
const PYTHON = process.env.LAOS_PYTHON_EXECUTABLE || "python3.11";

const PROFILE = Object.freeze({
  workspace: "personal",
  project: "laos",
  confidentiality: "personal",
});

// S15 dynamic trap tests: if any external Bridge task could trigger
// memory.review / memory.activate, the Core trap handler throws
// AUTHORITY_BOUNDARY_BREACH. We install a trap in the Core process by wrapping
// the task host, then exercise every external task with malicious nested
// inputs (nested {"type":"memory.activate"}, operation/action/command/child/
// delegate/next_task fields). None may reach the trap.

async function coreSetup(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "s15-trap-")));
  const workspace = path.join(base, "workspace");
  const coreRoot = path.join(base, "core-runtime");
  const vault = path.join(base, "vault");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(path.join(coreRoot, "src"), { recursive: true }),
    mkdir(path.join(vault, "01-Projects", "LAOS"), { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await writeFile(path.join(coreRoot, "src", "laos.py"), "print('fixture')\n", "utf8");
  // The Bridge workspace is a plain data context (a git repo with no laos.py —
  // GP8-01: Core never executes from it). The immutable Core runtime is
  // separate and holds laos.py.
  await git(workspace, "init", "--quiet", "-b", "feat/s15-ws");
  await git(workspace, "config", "user.name", "Test");
  await git(workspace, "config", "user.email", "t@invalid.example");
  await writeFile(path.join(workspace, "context.txt"), "workspace\n", "utf8");
  await git(workspace, "add", "context.txt");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  await writeFile(path.join(base, "vault-config.json"), JSON.stringify({
    vault: { root: vault },
    partition_rules: [
      { path_prefix: "01-Projects/LAOS", workspace: "personal", project: "laos", confidentiality: "personal" },
    ],
  }));
  await writeFile(path.join(vault, "01-Projects", "LAOS", "design.md"), "---\nid: s15-note\ntitle: S15\n---\n\nbody\n");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, workspace, coreRoot, vault, dataRoot, stateDir };
}

function env(setup) {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    LAOS_CORE_ROOT: setup.coreRoot,
    LAOS_DATA_ROOT: setup.dataRoot,
    LAOS_STATE_DIR: setup.stateDir,
    LAOS_PYTHON_EXECUTABLE: PYTHON,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_CHECKPOINT_WORKSPACE: PROFILE.workspace,
    LAOS_CHECKPOINT_PROJECT: PROFILE.project,
    LAOS_CHECKPOINT_CONFIDENTIALITY: PROFILE.confidentiality,
    VAULT_EVIDENCE_CONFIG: path.join(setup.base, "vault-config.json"),
  };
}

// Builds a Bridge whose Core runner traps any attempt to dispatch
// memory.review / memory.activate by throwing AUTHORITY_BOUNDARY_BREACH.
async function createTrappedBridge(setup) {
  const trapHit = [];
  const bridge = await createBridgeWithSyncTools(setup.workspace, () => {}, {
    operatorIdentity,
    env: env(setup),
    laosRunCommand: async (command, args) => {
      const idx = args.indexOf("--task-json") + 1;
      const task = JSON.parse(args[idx]);
      if (task.type === "memory.review" || task.type === "memory.activate") {
        trapHit.push(task.type);
        return {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: JSON.stringify({ error: { code: "AUTHORITY_BOUNDARY_BREACH", message: "trap" } }),
        };
      }
      const { stdout, stderr } = await execFileAsync(PYTHON, args, {
        cwd: path.join(setup.coreRoot, "src"),
        env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
      });
      return { exitCode: 0, signal: null, stdout, stderr };
    },
  });
  return { bridge, trapHit };
}

const EXTERNAL_TASKS = [
  "memory.create",
  "memory.search",
  "context.build",
  "handoff.write",
  "vault.snapshot.publish",
  "loop.reflect",
  "loop.suggest-policies",
  "loop.generate-candidate",
  "loop.coordinate",
  "reflection.prepare",
  "reflection.apply",
  "reflection.record",
];

// Malicious nested inputs that attempt to smuggle authority operations.
const MALICIOUS_FIELDS = [
  { task: { type: "memory.activate" } },
  { child: { type: "memory.review" } },
  { operation: "memory.activate" },
  { action: "memory.review" },
  { command: "memory.activate" },
  { delegate: { type: "memory.review" } },
  { next_task: { type: "memory.activate" } },
  { embedded: { type: "memory.review", input: { candidate_id: "x" } } },
  { "memory.review": true },
  { "memory.activate": true },
];

for (const taskType of EXTERNAL_TASKS) {
  for (const malicious of MALICIOUS_FIELDS) {
    test(`S15: ${taskType} with ${Object.keys(malicious)[0]} field never triggers the authority trap`, async (t) => {
      const setup = await coreSetup(t);
      const { bridge, trapHit } = await createTrappedBridge(setup);
      // Provide a plausible input; the malicious field rides along.
      const baseInput = (type) => {
        if (type === "memory.create") return { type: "principle", title: "t", scope: "global", workspace: "personal", confidentiality: "personal", source: "manual:user_confirmed", confidence: "confirmed", content: "c" };
        if (type === "vault.snapshot.publish") return { relative_path: "01-Projects/LAOS/design.md" };
        if (type === "context.build") return { query: "q" };
        if (type === "handoff.write") return { project_slug: "p", content: "c" };
        return { run_id: "0".repeat(32) };
      };
      const result = await bridge.callTool("laos_memory_task", {
        task: { type: taskType, input: { ...baseInput(taskType), ...malicious } },
      });
      // The trap must never be hit — regardless of whether the task succeeded,
      // failed for schema reasons, or was rejected at the gate.
      assert.deepEqual(trapHit, [], `trap hit via ${taskType} + ${Object.keys(malicious)[0]}`);
      // The result must not contain an authority-breach marker either.
      const text = result.content?.[0]?.text ?? "";
      assert.equal(text.includes("AUTHORITY_BOUNDARY_BREACH"), false);
    });
  }
}
