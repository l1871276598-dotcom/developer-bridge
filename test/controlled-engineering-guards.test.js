import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  guardControlledEngineeringTool,
  validateControlledWorkflow,
} from "../src/controlled-engineering-guards.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

function safeWorkflow() {
  return [
    "name: CI",
    "on: pull_request",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          persist-credentials: false",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 20",
    "      - run: npm ci",
    "      - run: npm test",
    "",
  ].join("\n");
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root });
}

test("accepts only a read-only workflow with approved actions and commands", () => {
  assert.deepEqual(
    validateControlledWorkflow(".github/workflows/ci.yml", safeWorkflow()),
    { valid: true, path: ".github/workflows/ci.yml" },
  );
  assert.throws(
    () => validateControlledWorkflow(
      ".github/workflows/ci.yml",
      safeWorkflow().replace("permissions:\n  contents: read", "permissions: { contents: write }"),
    ),
    /permissions/i,
  );
  assert.throws(
    () => validateControlledWorkflow(
      ".github/workflows/ci.yml",
      safeWorkflow().replace("actions/setup-node@v4", "third-party/action@v1"),
    ),
    /approved GitHub Actions/i,
  );
  assert.throws(
    () => validateControlledWorkflow(
      ".github/workflows/ci.yml",
      safeWorkflow().replace("persist-credentials: false\n", ""),
    ),
    /persist-credentials/i,
  );
  assert.throws(
    () => validateControlledWorkflow(
      ".github/workflows/ci.yml",
      safeWorkflow().replace("npm test", "npm install unapproved-package"),
    ),
    /allowlisted/i,
  );
  assert.throws(
    () => validateControlledWorkflow(
      ".github/workflows/ci.yml",
      safeWorkflow().replace("      - run: npm test", "      - run: npm test\n        shell: bash -c 'touch /tmp/pwn'; {0}"),
    ),
    /shell/i,
  );
  assert.throws(
    () => validateControlledWorkflow(
      ".github/workflows/ci.yml",
      safeWorkflow().replace("          persist-credentials: false", "          persist-credentials: false\n          repository: attacker/repository"),
    ),
    /checkout inputs/i,
  );
});

test("disables in-process regular expressions and rejects package manifest symlinks", async (t) => {
  const root = await workspace(t);
  await assert.rejects(
    guardControlledEngineeringTool("search_text", { query: "nested repetition", regex: true }, root),
    /disabled/i,
  );

  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
  await writeFile(outside, "{}", "utf8");
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, "package.json"));
  await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
  await assert.rejects(
    guardControlledEngineeringTool("install_dependencies", {}, root),
    /symbolic links/i,
  );
});

test("rejects modified package scripts before command execution", async (t) => {
  const root = await workspace(t);
  await git(root, "init", "--quiet", "-b", "feat/test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "Developer Bridge Test");
  await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n", "utf8");
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await git(root, "add", "package.json", "package-lock.json");
  await git(root, "commit", "--quiet", "-m", "fixture");
  await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test\":\"touch /tmp/pwn\"}}\n", "utf8");
  await assert.rejects(
    guardControlledEngineeringTool("run_package_script", { script: "test" }, root),
    /committed state/i,
  );
});

test("validates local workflow files before the primary handler runs", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  await writeFile(path.join(root, ".github/workflows/ci.yml"), safeWorkflow(), "utf8");
  await guardControlledEngineeringTool(
    "validate_github_workflow",
    { path: ".github/workflows/ci.yml" },
    root,
  );
});

test("wires the preflight gate before the controlled tool handler", async () => {
  const source = await readFile(path.join(projectRoot, "src/bridge-with-sync-tools.js"), "utf8");
  assert.match(source, /guardControlledEngineeringTool as preflightControlledTool/u);
  const preflight = source.indexOf("await preflightControlledTool(name, args, activeRoot)");
  const handler = source.indexOf("await handleControlledEngineeringTool(name, args, activeRoot");
  assert.ok(preflight >= 0);
  assert.ok(handler > preflight);
});