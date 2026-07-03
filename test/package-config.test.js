import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function exists(relativePath) {
  return access(path.join(projectRoot, relativePath)).then(() => true, () => false);
}

test("package scripts expose the HTTP default, stdio alternative, and complete test suite", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.scripts, {
    start: "node mcp-http.js",
    "start:stdio": "node server.js",
    test: "node --test test/*.test.js",
  });
});

test("obsolete implementations, scratch files, and empty source directories are absent", async () => {
  for (const relativePath of [
    "bridge.js",
    "config.json",
    "chatgpt_test.txt",
    "from_http_bridge.txt",
    "test_mcp.txt",
    "test-client.js",
    "src/tools",
    "src/utils",
  ]) {
    assert.equal(await exists(relativePath), false, `${relativePath} should not exist`);
  }
  assert.equal(await exists("src/bridge-core.js"), true);
});

test("gitignore protects generated output, local configuration, and private keys", async () => {
  const entries = (await readFile(path.join(projectRoot, ".gitignore"), "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const required of [
    "node_modules/",
    ".env",
    ".DS_Store",
    "*.log",
    "*.pem",
    "*.key",
    "coverage/",
    "tmp/",
  ]) {
    assert.ok(entries.includes(required), `missing .gitignore entry: ${required}`);
  }
});

test("README documents the supported setup, connection, tools, and safety boundary", async () => {
  const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");

  for (const expected of [
    /Developer Bridge/u,
    /ChatGPT Web\/App[\s\S]*HTTPS tunnel[\s\S]*Streamable HTTP MCP[\s\S]*authorized local workspace/u,
    /npm install/u,
    /export DEVELOPER_BRIDGE_WORKSPACE="\.\.\."/u,
    /export MCP_PATH="mcp-\.\.\."/u,
    /npm start/u,
    /ngrok http 3000/u,
    /MCP_PATH[^\n]*(?:path|路径)[^\n]*(?:not|不要|不得)[^\n]*(?:URL|网址)/iu,
    /(?:do not|不要|不得)[^\n]*(?:commit|提交)[^\n]*(?:secret|秘密|路径)/iu,
    /(?:do not|不要|不得)[^\n]*(?:hard.?code|硬编码)[^\n]*ngrok/iu,
    /(?:stop|关闭)[^\n]*(?:service|服务)/iu,
    /(?:single project|单个项目)/iu,
    /list_files/u,
    /read_file/u,
    /write_file/u,
    /git_status/u,
    /git_diff/u,
    /run_tests/u,
    /run_validation/u,
    /git_stage/u,
    /git_commit/u,
    /git_push_current_branch/u,
    /git_branch_list/u,
    /git_branch_create/u,
    /git_branch_switch/u,
    /git_worktree_list/u,
    /git_worktree_create/u,
    /git_worktree_switch/u,
    /DEVELOPER_BRIDGE_WORKTREE_ROOT/u,
    /managed worktree/iu,
    /clean[^\n]*(?:state|tracked|untracked)/iu,
    /main[^\n]*master/iu,
    /(?:no|无)[^\n]*(?:delete|删除)/iu,
    /(?:no|无)[^\n]*(?:arbitrary shell|任意 Shell)/iu,
    /(?:no|无)[^\n]*(?:automatic commit|自动 commit)/iu,
    /(?:no|无)[^\n]*(?:automatic push|自动 push)/iu,
    /(?:no|无)[^\n]*(?:outside|工作区外)/iu,
    /(?:no|无)[^\n]*(?:arbitrary Git arguments|任意 Git 参数)/iu,
    /(?:no|无)[^\n]*(?:detached|分离)/iu,
    /https:\/\/<ngrok-domain>\/<MCP_PATH>/u,
  ]) {
    assert.match(readme, expected);
  }

  assert.doesNotMatch(readme, /\/Users\//u);
  assert.doesNotMatch(readme, /https:\/\/[^<\s]+\/(?:mcp[-_][A-Za-z0-9._~-]+)/u);
  assert.doesNotMatch(readme, /ngrok-(?:free\.)?(?:app|io)/iu);
  assert.doesNotMatch(readme, /bridge\.js/u);
});
