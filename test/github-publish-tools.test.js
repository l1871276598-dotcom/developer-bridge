import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeCore } from "../src/bridge-core.js";

test("git_push exposes a strict normal-push schema", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-push-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const core = await createBridgeCore(workspace, () => {}, {
    allowedBranch: "codex/stage-07-learning-loop",
  });
  const definition = core.tools.find(({ name }) => name === "git_push");

  assert.deepEqual(definition.inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.deepEqual(definition.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
});

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

test("git_push pushes only the configured current branch to origin", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-push-"));
  const workspace = path.join(base, "workspace");
  const remote = path.join(base, "origin.git");
  const branch = "codex/stage-07-learning-loop";

  await mkdir(workspace);
  t.after(() => rm(base, { recursive: true, force: true }));

  await git(base, "init", "--bare", "--quiet", remote);
  await git(workspace, "init", "--quiet");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Developer Bridge Test");
  await git(workspace, "checkout", "-b", branch);
  await writeFile(path.join(workspace, "tracked.txt"), "initial\n", "utf8");
  await git(workspace, "add", "tracked.txt");
  await git(workspace, "commit", "--quiet", "-m", "initial");
  await git(workspace, "remote", "add", "origin", remote);

  const core = await createBridgeCore(workspace, () => {}, {
    allowedBranch: branch,
  });

  const result = await core.callTool("git_push", {});
  assert.equal(result.isError, undefined);

  const remoteOid = (
    await git(base, "--git-dir", remote, "rev-parse", `refs/heads/${branch}`)
  ).stdout.trim();
  const localOid = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();

  assert.equal(remoteOid, localOid);
  assert.equal(
    (await git(workspace, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"))
      .stdout.trim(),
    `origin/${branch}`,
  );
});
