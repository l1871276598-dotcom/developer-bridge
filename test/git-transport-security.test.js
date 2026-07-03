import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createBridgeCore } from "../src/bridge-core.js";
import { createBridgeWithSyncTools } from "../src/bridge-with-sync-tools.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function repository(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-transport-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await git(workspace, "init", "--quiet", "-b", "feat/test");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Developer Bridge Transport Test");
  await writeFile(path.join(workspace, "tracked.txt"), "fixture\n", "utf8");
  await git(workspace, "add", "tracked.txt");
  await git(workspace, "commit", "--quiet", "-m", "fixture");
  return workspace;
}

test("git push rejects repository-configured SSH commands before execution", async (t) => {
  const workspace = await repository(t);
  const canary = path.join(workspace, "ssh-command-canary");
  const command = path.join(workspace, "configured-ssh.mjs");
  await writeFile(command, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(canary)}, "executed");`,
    "process.exitCode = 1;",
    "",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  await git(workspace, "remote", "add", "origin", "git@github.com:example/repository.git");
  await git(workspace, "config", "core.sshCommand", command);

  const core = await createBridgeCore(workspace, () => {});
  const result = await core.callTool("git_push_current_branch", {});

  assert.equal(result.isError, true);
  await assert.rejects(access(canary));
});

test("git fetch rejects repository-configured HTTP proxies before network access", async (t) => {
  const workspace = await repository(t);
  let contacted = false;
  const proxy = net.createServer((socket) => {
    contacted = true;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");

  await git(workspace, "remote", "add", "origin", "https://github.com/example/repository.git");
  await git(workspace, "config", "http.proxy", `http://127.0.0.1:${address.port}`);

  const bridge = await createBridgeWithSyncTools(workspace, () => {});
  const result = await bridge.callTool("git_fetch_origin_main", {});

  assert.equal(result.isError, true);
  assert.equal(contacted, false);
});
