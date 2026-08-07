import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { FROZEN_LAOS_TASKS } from "../src/laos-memory-tool.js";

// S15 mechanical invariant (R3-5): from every external Bridge task, there must
// be NO reachable path to memory.review / memory.activate. This is a static
// graph test over the Core agent registry + the documented internal dispatch
// edges, not a human grep.

const CORE_ROOT = "/Users/user/projects/laos-ws/gpt";
const REGISTRY_PATH = path.join(CORE_ROOT, "src", "agents", "registry-v0.9.yaml");
const CORE_SRC = path.join(CORE_ROOT, "src");

// Documented internal dispatch edges: Core agent run() may synchronously call
// another agent's run(). These are the ONLY cross-agent edges in the codebase
// (verified against src/agents/coordinator.py). Each edge is
// [from_task, to_task].
const INTERNAL_DISPATCH_EDGES = [
  // LoopCoordinatorAgent.run synchronously drives these loop.* sub-runs.
  ["loop.coordinate", "loop.reflect"],
  ["loop.coordinate", "loop.suggest-policies"],
  ["loop.coordinate", "loop.generate-candidate"],
  // Bridge-owned vault.snapshot.publish is implemented in the Bridge and
  // forwards to Core's internal evidence.publish target (EvidenceAgent),
  // which is NOT an authority agent.
  ["vault.snapshot.publish", "evidence.publish"],
];

// Core agents whose run() would execute the authority operation.
const AUTHORITY_AGENTS = new Set(["ReviewAgent", "ActivationAgent"]);

async function parseRegistry() {
  const raw = await readFile(REGISTRY_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const byTask = new Map();
  for (const agent of parsed.agents) {
    for (const handle of agent.handles) {
      byTask.set(handle, agent.class);
    }
  }
  return byTask;
}

// Build the set of Core agent classes reachable from a task via the internal
// dispatch graph, then check none is an authority agent.
function authorityReachable(task, byTask) {
  const seen = new Set();
  const queue = [task];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const agentClass = byTask.get(current);
    if (AUTHORITY_AGENTS.has(agentClass)) return { reachable: true, via: current };
    for (const [from, to] of INTERNAL_DISPATCH_EDGES) {
      if (from === current) queue.push(to);
    }
  }
  return { reachable: false, via: null };
}

test("S15 mechanical invariant: external Bridge tasks never reach review/activate", async () => {
  const byTask = await parseRegistry();
  for (const task of FROZEN_LAOS_TASKS) {
    // vault.snapshot.publish is Bridge-implemented; its Core target is the
    // internal evidence.publish (EvidenceAgent), covered by the dispatch edge
    // above. Every other external task must exist in the Core registry.
    if (task === "vault.snapshot.publish") continue;
    assert.ok(byTask.has(task), `external task ${task} not in Core registry`);
  }
  for (const task of FROZEN_LAOS_TASKS) {
    const { reachable, via } = authorityReachable(task, byTask);
    assert.equal(reachable, false, `${task} reaches authority via ${via}`);
  }
});

test("S15: the authority tasks map to authority agents and are NOT in the external allowlist", async () => {
  const byTask = await parseRegistry();
  assert.equal(byTask.get("memory.review"), "ReviewAgent");
  assert.equal(byTask.get("memory.activate"), "ActivationAgent");
  for (const op of ["memory.review", "memory.activate"]) {
    assert.equal(FROZEN_LAOS_TASKS.includes(op), false);
  }
});

test("S15: no external task's Core agent invokes review/activate via source inspection", async () => {
  // Belt-and-suspenders: scan the Core agent sources for any direct reference
  // to the review/activate task types or ReviewAgent/ActivationAgent imports.
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(path.join(CORE_SRC, "agents"))).filter((f) => f.endsWith(".py"));
  for (const file of files) {
    const src = await readFile(path.join(CORE_SRC, "agents", file), "utf8");
    // Only the authority agents and the orchestrator (registry wiring) may
    // mention review/activate; loop/reflection/context/handoff/evidence must
    // not. Match actual code references, not prose ("never reviews" is prose).
    const isAuthorityOrOrchestrator = /review|activation|orchestrator/.test(file);
    if (isAuthorityOrOrchestrator) continue;
    const dangerous =
      /"memory\.review"|'memory\.review'|"memory\.activate"|'memory\.activate'|from \.review import|from \.activation import/.test(src);
    assert.equal(dangerous, false, `${file} references authority operations`);
  }
});
