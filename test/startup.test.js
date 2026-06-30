import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

function runServer(script, env, { waitMs = 1000, readyPattern } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let timedOut = false;
    let spawnError;

    function inspectReadiness() {
      if (!ready && readyPattern?.test(`${stdout}\n${stderr}`)) {
        ready = true;
        child.kill("SIGTERM");
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      inspectReadiness();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      inspectReadiness();
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ready, spawnError });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, waitMs);
  });
}

function runHttpServer(env, options) {
  return runServer("mcp-http.js", env, options);
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.DEVELOPER_BRIDGE_WORKSPACE;
  delete env.MCP_PATH;
  return { ...env, ...overrides };
}

test("HTTP server rejects a missing workspace without leaking the route", async () => {
  const secretRoute = "mcp-secret-route";
  const result = await runHttpServer(cleanEnv({ MCP_PATH: secretRoute }));

  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /DEVELOPER_BRIDGE_WORKSPACE/);
  assert.doesNotMatch(result.stderr, new RegExp(secretRoute));
});

test("HTTP server rejects a missing MCP_PATH", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-"));
  try {
    const result = await runHttpServer(
      cleanEnv({ DEVELOPER_BRIDGE_WORKSPACE: workspace }),
    );

    assert.equal(result.timedOut, false);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MCP_PATH/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const invalidRoute of [
  "http://example.invalid/mcp",
  "https://example.invalid/mcp",
  "/mcp-route",
  "nested/mcp",
  "mcp route",
  "mcp?token=secret",
  ".",
  "..",
]) {
  test(`HTTP server rejects invalid MCP_PATH form: ${invalidRoute.split(":")[0]}`, async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-"));
    try {
      const result = await runHttpServer(
        cleanEnv({
          DEVELOPER_BRIDGE_WORKSPACE: workspace,
          MCP_PATH: invalidRoute,
        }),
      );

      assert.equal(result.timedOut, false);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /MCP_PATH/);
      if (invalidRoute.length > 2) {
        assert.doesNotMatch(result.stderr, new RegExp(invalidRoute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

test("stdio server rejects a missing workspace instead of using cwd", async () => {
  const result = await runServer("server.js", cleanEnv());
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /DEVELOPER_BRIDGE_WORKSPACE/);
});

test("HTTP server rejects a workspace that is not an existing directory", async () => {
  const result = await runHttpServer(cleanEnv({
    DEVELOPER_BRIDGE_WORKSPACE: path.join(os.tmpdir(), "developer-bridge-does-not-exist"),
    MCP_PATH: "mcp-valid",
  }));
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /existing directory/);
});

test("valid HTTP configuration starts without logging workspace or MCP route", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "developer-bridge-"));
  const route = "mcp-super-secret";
  try {
    const result = await runHttpServer(
      cleanEnv({
        DEVELOPER_BRIDGE_WORKSPACE: workspace,
        MCP_PATH: route,
        DEVELOPER_BRIDGE_PORT: "0",
      }),
      { readyPattern: /running/i },
    );
    assert.equal(result.ready, true);
    assert.equal(result.timedOut, false);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /running/i);
    assert.doesNotMatch(output, new RegExp(workspace));
    assert.doesNotMatch(output, new RegExp(route));
    assert.doesNotMatch(output, /https?:\/\//);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
