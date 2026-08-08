import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);
const operatorIdentity = Object.freeze({ id: "laos.scope.test", type: "local-human" });

// Trusted Bridge profile. Every scope-bearing task MUST resolve to exactly this
// scope, never to caller-supplied values (C-INV-13).
const PROFILE = Object.freeze({
  LAOS_CHECKPOINT_WORKSPACE: "personal",
  LAOS_CHECKPOINT_PROJECT: "laos",
  LAOS_CHECKPOINT_CONFIDENTIALITY: "personal",
});

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "developer-bridge-laos-scope-")));
  const workspace = path.join(base, "workspace");
  const coreRoot = path.join(base, "core-runtime");
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await Promise.all([mkdir(workspace), mkdir(coreRoot), mkdir(dataRoot), mkdir(stateDir)]);
  await writeFile(path.join(dataRoot, ".research-agent-root"), "{}\n", "utf8");
  await mkdir(path.join(coreRoot, "src"));
  await writeFile(path.join(coreRoot, "src", "laos.py"), "print('fixture')\n", "utf8");
  await git(workspace, "init", "--quiet", "-b", "feat/laos-scope");
  await git(workspace, "config", "user.name", "Test User");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(workspace, "context.txt"), "fixture\n", "utf8");
  await git(workspace, "add", "context.txt");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { workspace, coreRoot, dataRoot, stateDir };
}

function env(item) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DEVELOPER_BRIDGE_CAPABILITY_PROFILE: "controlled-engineering-v1",
    LAOS_CORE_ROOT: item.coreRoot,
    LAOS_DATA_ROOT: item.dataRoot,
    LAOS_STATE_DIR: item.stateDir,
    ...PROFILE,
  };
}

// Creates a Bridge whose laosRunCommand records every Core invocation and lets
// the test assert whether Core was reached at all. A REJECT must produce zero
// calls; a PASS must produce exactly one and we can inspect what was forwarded.
async function createBridgeWithSpy(item) {
  let calls = 0;
  const forwarded = [];
  const bridge = await createBridgeWithSyncTools(item.workspace, () => {}, {
    operatorIdentity,
    env: env(item),
    laosRunCommand: async (command, args) => {
      calls += 1;
      const idx = args.indexOf("--task-json") + 1;
      forwarded.push(JSON.parse(args[idx]));
      return {
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({ ok: true })}\n`,
        stderr: "",
      };
    },
  });
  return {
    bridge,
    spy: {
      get calls() { return calls; },
      get forwarded() { return forwarded; },
    },
  };
}

// Minimal but schema-plausible inputs per allowlisted task (mirrors
// laos-task-allowlist.test.js sampler).
const BASE_INPUT = {
  "memory.create": {
    type: "principle", title: "t", scope: "global", workspace: "personal",
    confidentiality: "personal", source: "manual:user_confirmed",
    confidence: "confirmed", content: "c",
  },
  "memory.search": { query: "test" },
  "context.build": { query: "test" },
  "handoff.write": { project_slug: "p", content: "# h" },
  "loop.reflect": {},
  "loop.suggest-policies": {},
  "loop.generate-candidate": {},
  "loop.coordinate": {},
  "reflection.prepare": {},
  "reflection.apply": {},
  "reflection.record": {},
};

// F-01 escalation matrix (plan §8). Each row describes a caller attempting to
// move scope outside the trusted profile (personal / laos / personal).
//   topWorkspace overrides task.workspace (caller top-level scope)
//   inputScope merges caller-controlled scope fields into task.input
const ESCALATION_MATRIX = [
  { type: "memory.search", topWorkspace: "work", inputScope: null },
  { type: "memory.search", topWorkspace: "personal", inputScope: { project: "other" } },
  { type: "context.build", topWorkspace: "work", inputScope: null },
  { type: "context.build", topWorkspace: "personal", inputScope: { project: "other" } },
  { type: "memory.create", topWorkspace: "work", inputScope: null },
  { type: "memory.create", topWorkspace: "personal", inputScope: { project: "other" } },
  { type: "handoff.write", topWorkspace: "personal", inputScope: { project: "other" } },
  { type: "loop.reflect", topWorkspace: "work", inputScope: null },
  { type: "loop.suggest-policies", topWorkspace: "work", inputScope: null },
  { type: "loop.generate-candidate", topWorkspace: "work", inputScope: null },
  { type: "loop.coordinate", topWorkspace: "work", inputScope: null },
  { type: "reflection.prepare", topWorkspace: "work", inputScope: null },
  { type: "reflection.apply", topWorkspace: "work", inputScope: null },
  { type: "reflection.record", topWorkspace: "work", inputScope: null },
];

for (const attempt of ESCALATION_MATRIX) {
  const label = `${attempt.type} workspace=${attempt.topWorkspace}` +
    (attempt.inputScope ? ` input=${JSON.stringify(attempt.inputScope)}` : "");
  test(`F-01 REJECT: ${label} must fail with scope_mismatch and zero Core calls`, async (t) => {
    const item = await fixture(t);
    const { bridge, spy } = await createBridgeWithSpy(item);

    const task = { type: attempt.type, input: { ...BASE_INPUT[attempt.type] } };
    if (attempt.topWorkspace !== null) task.workspace = attempt.topWorkspace;
    if (attempt.inputScope) Object.assign(task.input, attempt.inputScope);

    const result = await bridge.callTool("laos_memory_task", { task });

    assert.equal(result.isError, true, `expected rejection for ${label}`);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error.code, "scope_mismatch", `expected scope_mismatch for ${label}`);
    assert.equal(spy.calls, 0, `Core must NOT be invoked for ${label}`);
  });
}

test("F-01 REJECT: caller confidentiality escalation via input.confidentiality", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);

  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "memory.search",
      input: { query: "test", workspace: "personal", confidentiality: "restricted" },
    },
  });

  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(spy.calls, 0);
});

test("F-01 REJECT: vault.snapshot.publish with caller top-level workspace=work", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);

  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "vault.snapshot.publish",
      workspace: "work",
      input: { relative_path: "P/t.md" },
    },
  });

  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "scope_mismatch");
  assert.equal(spy.calls, 0);
});

test("F-01 PASS: explicit same-scope workspace is accepted and forwarded as the trusted scope", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);

  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", workspace: "personal", input: { query: "test" } },
  });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(spy.calls, 1);
  assert.equal(spy.forwarded[0].workspace, "personal");
});

test("F-01 PASS: omitted scope is injected from the trusted profile, never caller-default", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);

  const result = await bridge.callTool("laos_memory_task", {
    task: { type: "memory.search", input: { query: "test" } },
  });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(spy.calls, 1);
  assert.equal(spy.forwarded[0].workspace, "personal");
  assert.equal(spy.forwarded[0].workspace, PROFILE.LAOS_CHECKPOINT_WORKSPACE);
});

test("F-01 PASS: caller input scope that already equals the trusted profile is normalized to trusted values", async (t) => {
  const item = await fixture(t);
  const { bridge, spy } = await createBridgeWithSpy(item);

  const result = await bridge.callTool("laos_memory_task", {
    task: {
      type: "memory.search",
      workspace: "personal",
      input: { query: "test", workspace: "personal", project: "laos", confidentiality: "personal" },
    },
  });

  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(spy.calls, 1);
  const forwarded = spy.forwarded[0];
  // memory.search consumes workspace/project/confidentiality (GP9-02: the
  // trusted confidentiality ceiling is a Core read-authorization parameter).
  assert.equal(forwarded.workspace, "personal");
  assert.equal(forwarded.input.workspace, "personal");
  assert.equal(forwarded.input.project, "laos");
  assert.equal(forwarded.input.confidentiality, "personal");
});
