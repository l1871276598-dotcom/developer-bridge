import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  MAX_FILE_BYTES,
  createBridgeCore,
} from "../src/bridge-core.js";

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-core-"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await execFileAsync("git", ["init", "--quiet", "-b", "feat/test"], { cwd: workspace });
  t.after(() => rm(base, { recursive: true, force: true }));
  const logs = [];
  const core = await createBridgeCore(workspace, (line) => logs.push(line));
  return { base, workspace, outside, logs, core };
}

function resultText(result) {
  return result.content[0].text;
}

test("exposes exactly the seventeen approved tools with strict object schemas", async (t) => {
  const { core } = await fixture(t);
  assert.deepEqual(core.tools.map(({ name }) => name), [
    "list_files",
    "read_file",
    "write_file",
    "git_stage",
    "git_commit",
    "git_push_current_branch",
    "github_pr_create_draft",
    "run_validation",
    "git_branch_list",
    "git_branch_create",
    "git_branch_switch",
    "git_worktree_list",
    "git_worktree_create",
    "git_worktree_switch",
    "git_status",
    "git_diff",
    "run_tests",
  ]);
  for (const tool of core.tools) assert.equal(tool.inputSchema.additionalProperties, false);
});

test("lists the workspace root and reads a normal UTF-8 file", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, "hello.txt"), "hello", "utf8");
  const listing = await core.callTool("list_files", { path: "." });
  const reading = await core.callTool("read_file", { path: "hello.txt" });
  assert.equal(listing.isError, undefined);
  assert.match(resultText(listing), /FILE hello\.txt/);
  assert.equal(resultText(reading), "hello");
});

test("rejects empty, non-string, absolute, and escaping paths", async (t) => {
  const { workspace, core } = await fixture(t);
  for (const invalid of ["", 12, null, path.join(workspace, "file.txt"), "../outside.txt"]) {
    const result = await core.callTool("read_file", { path: invalid });
    assert.equal(result.isError, true, `expected rejection for ${String(invalid)}`);
  }
  for (const invalid of ["", 12, null]) {
    const result = await core.callTool("list_files", { path: invalid });
    assert.equal(result.isError, true, `expected list rejection for ${String(invalid)}`);
  }
});

test("rejects reads and writes through a symlink to outside the workspace", async (t) => {
  const { workspace, outside, core } = await fixture(t);
  await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, path.join(workspace, "escape"), "dir");
  for (const [name, args] of [
    ["read_file", { path: "escape/secret.txt" }],
    ["write_file", { path: "escape/new.txt", content: "nope" }],
  ]) {
    const result = await core.callTool(name, args);
    assert.equal(result.isError, true);
  }
  await assert.rejects(readFile(path.join(outside, "new.txt"), "utf8"));
});

test("never writes outside when a directory symlink is atomically switched during validation", async (t) => {
  const { workspace, outside, core } = await fixture(t);
  const inside = path.join(workspace, "inside");
  const alias = path.join(workspace, "alias");
  await mkdir(inside);
  await writeFile(path.join(inside, "victim.txt"), "inside", "utf8");
  await writeFile(path.join(outside, "victim.txt"), "outside-original", "utf8");
  await symlink(inside, alias, "dir");

  const toggler = (async () => {
    for (let index = 0; index < 200; index += 1) {
      const next = path.join(workspace, `alias-next-${index}`);
      await symlink(index % 2 === 0 ? outside : inside, next, "dir");
      await rename(next, alias);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const writer = (async () => {
    for (let index = 0; index < 200; index += 1) {
      await core.callTool("write_file", { path: "alias/victim.txt", content: `inside-${index}` });
    }
  })();
  await Promise.all([toggler, writer]);
  assert.equal(await readFile(path.join(outside, "victim.txt"), "utf8"), "outside-original");
});

test("never returns oversized content when a file is atomically replaced during reading", async (t) => {
  const { workspace, core } = await fixture(t);
  const target = path.join(workspace, "changing.txt");
  const oversized = "x".repeat(MAX_FILE_BYTES + 1);
  await writeFile(target, "x", "utf8");

  const toggler = (async () => {
    for (let index = 0; index < 40; index += 1) {
      const next = path.join(workspace, `changing-${index}.txt`);
      await writeFile(next, index % 2 === 0 ? oversized : "x", "utf8");
      await rename(next, target);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const reader = (async () => {
    for (let index = 0; index < 100; index += 1) {
      const result = await core.callTool("read_file", { path: "changing.txt" });
      if (!result.isError) {
        assert.ok(Buffer.byteLength(resultText(result), "utf8") <= MAX_FILE_BYTES);
      }
    }
  })();
  await Promise.all([toggler, reader]);
});

test("rejects reads and writes through hard links, including protected-file aliases", async (t) => {
  const { workspace, outside, core } = await fixture(t);
  const outsideFile = path.join(outside, "outside.txt");
  const envFile = path.join(workspace, ".env");
  await writeFile(outsideFile, "outside-original", "utf8");
  await writeFile(envFile, "env-original", "utf8");
  await link(outsideFile, path.join(workspace, "outside-alias.txt"));
  await link(envFile, path.join(workspace, "innocent.txt"));

  for (const [name, args] of [
    ["read_file", { path: "outside-alias.txt" }],
    ["write_file", { path: "outside-alias.txt", content: "blocked" }],
    ["write_file", { path: "innocent.txt", content: "blocked" }],
  ]) {
    const result = await core.callTool(name, args);
    assert.equal(result.isError, true);
  }
  assert.equal(await readFile(outsideFile, "utf8"), "outside-original");
  assert.equal(await readFile(envFile, "utf8"), "env-original");
});

test("enforces the centralized 1 MiB read limit without returning partial content", async (t) => {
  const { workspace, core } = await fixture(t);
  assert.equal(MAX_FILE_BYTES, 1024 * 1024);
  await writeFile(path.join(workspace, "exact.txt"), "x".repeat(MAX_FILE_BYTES));
  await writeFile(path.join(workspace, "large.txt"), "x".repeat(MAX_FILE_BYTES + 1));
  assert.equal(resultText(await core.callTool("read_file", { path: "exact.txt" })).length, MAX_FILE_BYTES);
  const result = await core.callTool("read_file", { path: "large.txt" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /size limit/i);
  assert.doesNotMatch(resultText(result), /xxx/);
});

test("enforces the UTF-8 byte write limit before changing the target", async (t) => {
  const { workspace, core } = await fixture(t);
  const exact = "é".repeat(MAX_FILE_BYTES / 2);
  const ok = await core.callTool("write_file", { path: "exact.txt", content: exact });
  assert.equal(ok.isError, undefined);
  assert.match(resultText(ok), new RegExp(`exact\\.txt.*${MAX_FILE_BYTES}`));
  await writeFile(path.join(workspace, "kept.txt"), "original", "utf8");
  const rejected = await core.callTool("write_file", {
    path: "kept.txt",
    content: `${exact}x`,
  });
  assert.equal(rejected.isError, true);
  assert.match(resultText(rejected), /size limit/i);
  assert.equal(await readFile(path.join(workspace, "kept.txt"), "utf8"), "original");
});

test("rejects protected paths, directories, and missing parent directories", async (t) => {
  const { workspace, core } = await fixture(t);
  await mkdir(path.join(workspace, "node_modules"));
  await mkdir(path.join(workspace, "directory"));
  for (const target of [
    ".env", ".git/config", "node_modules/test.txt", "test.pem", "test.key",
    "id_rsa", "id_ed25519", "directory", "a/b/c.txt", ".ENV", ".GIT/config", "NODE_MODULES/test.txt", "TEST.PEM",
  ]) {
    const result = await core.callTool("write_file", { path: target, content: "blocked" });
    assert.equal(result.isError, true, `expected rejection for ${target}`);
  }
});

test("rejects protected paths reached through in-workspace symlink aliases", async (t) => {
  const { workspace, core } = await fixture(t);
  await writeFile(path.join(workspace, ".env"), "original", "utf8");
  await symlink(path.join(workspace, ".git"), path.join(workspace, "git-alias"), "dir");
  await symlink(path.join(workspace, ".env"), path.join(workspace, "env-alias"), "file");
  for (const target of ["git-alias/config", "env-alias"]) {
    const result = await core.callTool("write_file", { path: target, content: "blocked" });
    assert.equal(result.isError, true, `expected rejection for alias ${target}`);
  }
  assert.equal(await readFile(path.join(workspace, ".env"), "utf8"), "original");
});

test("strictly rejects extra arguments and non-string write content at runtime", async (t) => {
  const { core } = await fixture(t);
  for (const [name, args] of [
    ["list_files", { path: ".", surprise: true }],
    ["read_file", {}],
    ["write_file", { path: "x.txt", content: 123 }],
  ]) {
    const result = await core.callTool(name, args);
    assert.equal(result.isError, true);
  }
});

test("writes a normal file and returns only its relative path and UTF-8 byte count", async (t) => {
  const { workspace, core } = await fixture(t);
  const result = await core.callTool("write_file", { path: "normal.txt", content: "你好" });
  assert.equal(result.isError, undefined);
  assert.equal(resultText(result), "Wrote normal.txt (6 bytes)");
  assert.equal(await readFile(path.join(workspace, "normal.txt"), "utf8"), "你好");
  assert.doesNotMatch(resultText(result), new RegExp(workspace));
});

test("logs only metadata and never file contents, workspace, route, or full arguments", async (t) => {
  const { workspace, logs, core } = await fixture(t);
  const secret = "TOP_SECRET_FILE_BODY";
  await writeFile(path.join(workspace, "safe.txt"), secret, "utf8");
  await core.callTool("read_file", { path: "safe.txt" });
  await core.callTool("write_file", { path: "new.txt", content: secret });
  const output = logs.join("\n");
  assert.match(output, /tool=read_file/);
  assert.match(output, /path=safe\.txt/);
  assert.match(output, /result=success/);
  assert.match(output, /duration_ms=\d+/);
  assert.match(output, /content_bytes=20/);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, new RegExp(workspace));
  assert.doesNotMatch(output, /MCP_PATH|https?:\/\//);
  assert.doesNotMatch(output, /\{.*content/);
});

test("returns sanitized errors without absolute paths", async (t) => {
  const { workspace, core } = await fixture(t);
  const result = await core.callTool("read_file", { path: "missing.txt" });
  assert.equal(result.isError, true);
  assert.doesNotMatch(resultText(result), new RegExp(workspace));
});

test("escapes untrusted metadata so tool names and paths cannot forge log fields", async (t) => {
  const { logs, core } = await fixture(t);
  await core.callTool("unknown\nresult=success", { path: "bad\npath.txt" });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].split("\n").length, 1);
  assert.doesNotMatch(logs[0], /unknown\n|bad\n/);
  assert.match(logs[0], /result=failure/);
});

test("omits unvalidated absolute paths and URLs from failure logs", async (t) => {
  const { logs, core } = await fixture(t);
  const absoluteSecret = "/TOP_SECRET_ABSOLUTE/secret.txt";
  const urlSecret = "https://secret.example/token";
  await core.callTool("read_file", { path: absoluteSecret });
  await core.callTool("read_file", { path: urlSecret });
  const output = logs.join("\n");
  assert.doesNotMatch(output, new RegExp(absoluteSecret));
  assert.doesNotMatch(output, new RegExp(urlSecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});