import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertNoRepositoryTransportOverrides } from "./fixed-git-runner.js";

const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 200_000;
const SAFE_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: os.devNull,
  GIT_CONFIG_KEY_2: "commit.gpgSign",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "protocol.ext.allow",
  GIT_CONFIG_VALUE_3: "never",
});

const WRITE_TOOL_NAMES = new Set([
  "git_stage",
  "git_commit",
  "git_push_current_branch",
  "github_pr_create_draft",
  "run_validation",
]);

export const GIT_WRITE_TOOL_DEFINITIONS = [
  {
    name: "git_stage",
    description:
      "Stage explicitly listed paths in the authorized workspace. Sensitive paths and paths outside the repository are rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["paths"],
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
  {
    name: "git_commit",
    description:
      "Create a normal commit from staged changes on the authorized branch. Amend and history rewriting are not supported.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", minLength: 1, maxLength: 300 },
      },
    },
  },
  {
    name: "git_push_current_branch",
    description:
      "Push the authorized current branch to the same branch on origin. Force push, deletion, tags, main and master are forbidden.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "github_pr_create_draft",
    description:
      "Create one GitHub Draft pull request from the clean, fully pushed authorized branch using fixed gh arguments and repository defaults.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "run_validation",
    description:
      "Run fixed validation commands: pytest, compileall and Git diff checks. Arbitrary commands are not accepted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

export function isGitWriteTool(name) {
  return WRITE_TOOL_NAMES.has(name);
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Missing authorized workspace snapshot.");
  }
  for (const key of ["root", "branch", "commonDir"]) {
    if (typeof snapshot[key] !== "string" || !snapshot[key]) {
      throw new Error("Invalid authorized workspace snapshot.");
    }
  }
  return snapshot;
}

function assertPlainArguments(args, allowed = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Arguments must be an object.");
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected argument: ${key}`);
  }
}

function clip(value) {
  const text = String(value ?? "");
  return text.length <= MAX_OUTPUT
    ? text
    : `${text.slice(0, MAX_OUTPUT)}\n...[output truncated]`;
}

function run(command, args, options = {}) {
  const {
    cwd,
    timeoutMs = TIMEOUT_MS,
    allowedExitCodes = [0],
    envOverrides = {},
  } = options;
  if (typeof cwd !== "string" || !cwd) throw new Error("A fixed command cwd is required.");

  return new Promise((resolve, reject) => {
    const baseEnv = command === "git" ? { ...process.env, ...SAFE_GIT_ENV } : process.env;
    const child = spawn(command, args, {
      cwd,
      env: { ...baseEnv, ...envOverrides },
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT * 2) stdout = stdout.slice(-MAX_OUTPUT);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT * 2) stderr = stderr.slice(-MAX_OUTPUT);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const result = {
        exitCode,
        signal,
        stdout: clip(stdout),
        stderr: clip(stderr),
      };

      if (!allowedExitCodes.includes(exitCode)) {
        reject(new Error("Fixed command failed."));
        return;
      }

      resolve(result);
    });
  });
}

function git(args, snapshot, options = {}) {
  return run("git", args, { cwd: snapshot.root, ...options });
}

async function currentBranch(snapshot) {
  const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], snapshot);
  const branch = result.stdout.trim();
  if (!branch) throw new Error("Detached HEAD is not allowed.");
  return branch;
}

async function assertNoExternalFilters(snapshot) {
  const configured = await git(
    ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
    snapshot,
    { allowedExitCodes: [0, 1] },
  );
  if (configured.exitCode === 0 && configured.stdout.trim().length > 0) {
    throw new Error("External Git filters are not allowed for staging operations.");
  }
}

async function assertAuthorized(snapshotValue) {
  const snapshot = assertSnapshot(snapshotValue);
  const configured = fs.realpathSync(snapshot.root);
  const actual = fs.realpathSync(
    (await git(["rev-parse", "--show-toplevel"], snapshot)).stdout.trim(),
  );
  const commonPath = (await git(["rev-parse", "--git-common-dir"], snapshot)).stdout.trim();
  const commonDir = fs.realpathSync(path.resolve(snapshot.root, commonPath));

  if (actual !== configured || actual !== snapshot.root || commonDir !== snapshot.commonDir) {
    throw new Error("Repository identity no longer matches the authorized snapshot.");
  }

  const branch = await currentBranch(snapshot);
  if (branch === "main" || branch === "master") {
    throw new Error(`Protected branch cannot be modified: ${branch}`);
  }
  if (branch !== snapshot.branch) {
    throw new Error("Current branch no longer matches the authorized snapshot.");
  }

  return snapshot;
}

const FORBIDDEN = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env($|\.)/i,
  /(^|\/).*credentials?.*(\/|$)/i,
  /(^|\/).*oauth.*(\/|$)/i,
  /(^|\/).*secrets?.*(\/|$)/i,
  /(^|\/).*private[_-]?key.*(\/|$)/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)(acceptance|acceptance-data|acceptance_data)(\/|$)/i,
  /(^|\/)(validation-data|validation_data)(\/|$)/i,
  /(^|\/)(验收数据|真实验收数据)(\/|$)/i,
];

function safePath(root, supplied) {
  if (typeof supplied !== "string" || !supplied.trim()) {
    throw new Error("Each path must be a non-empty string.");
  }
  if (supplied.includes("\0")) throw new Error("Path contains a null byte.");

  const input = supplied.replaceAll("\\", "/").trim();
  if (path.isAbsolute(input)) throw new Error(`Absolute path rejected: ${input}`);
  if (FORBIDDEN.some((pattern) => pattern.test(input))) {
    throw new Error(`Sensitive path rejected: ${input}`);
  }

  const absolute = path.resolve(root, input);
  const relative = path.relative(root, absolute);

  if (
    !relative ||
    relative === "." ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes workspace or is the workspace root: ${input}`);
  }

  if (fs.existsSync(absolute)) {
    const real = fs.realpathSync(absolute);
    const realRelative = path.relative(root, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`Symlink escapes workspace: ${input}`);
    }
  }

  const gitPath = relative.split(path.sep).join("/");
  if (FORBIDDEN.some((pattern) => pattern.test(gitPath))) {
    throw new Error(`Sensitive path rejected: ${gitPath}`);
  }
  return gitPath;
}

async function stage(args, snapshotValue) {
  const snapshot = await assertAuthorized(snapshotValue);
  const branch = snapshot.branch;
  const root = snapshot.root;

  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    throw new Error("git_stage requires a non-empty paths array.");
  }

  const paths = [...new Set(args.paths.map((item) => safePath(root, item)))];
  await assertNoExternalFilters(snapshot);
  await git(["add", "--", ...paths], snapshot);
  const status = await git(["status", "--short"], snapshot);

  return {
    text: [
      `Staged ${paths.length} path(s) on ${branch}:`,
      ...paths.map((item) => `- ${item}`),
      "",
      "Git status:",
      status.stdout || "(clean)",
    ].join("\n"),
  };
}

async function commit(args, snapshotValue) {
  const snapshot = await assertAuthorized(snapshotValue);
  const branch = snapshot.branch;
  const message = String(args.message ?? "").trim();

  if (!message) throw new Error("Commit message cannot be empty.");
  if (message.length > 300) throw new Error("Commit message is too long.");
  if (/[\r\n\0]/.test(message)) {
    throw new Error("Commit message must be one line.");
  }

  const staged = await git(
    ["diff", "--cached", "--quiet", "--exit-code"],
    snapshot,
    { allowedExitCodes: [0, 1] },
  );

  if (staged.exitCode === 0) {
    throw new Error("No staged changes are available to commit.");
  }

  await git(["diff", "--cached", "--check"], snapshot);
  const result = await git(["commit", "--no-verify", "--no-gpg-sign", "-m", message], snapshot);
  const head = (await git(["rev-parse", "HEAD"], snapshot)).stdout.trim();

  return {
    text: [
      `Commit created on ${branch}.`,
      `HEAD: ${head}`,
      "",
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function push(snapshotValue) {
  const snapshot = await assertAuthorized(snapshotValue);
  const branch = snapshot.branch;
  await assertNoRepositoryTransportOverrides(snapshot.root);
  const remote = (await git(["remote", "get-url", "origin"], snapshot)).stdout.trim();

  if (!remote) throw new Error("Remote origin is not configured.");

  const result = await git([
    "push",
    "--set-upstream",
    "--no-verify",
    "--porcelain",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ], snapshot);

  return {
    text: [
      `Pushed to origin/${branch}.`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function isGitHubOrigin(remote) {
  return (
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote) ||
    /^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote) ||
    /^ssh:\/\/git@github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(remote)
  );
}

async function createDraftPr(args, snapshotValue, runCommand) {
  assertPlainArguments(args);
  const snapshot = await assertAuthorized(snapshotValue);
  const branch = snapshot.branch;
  await assertNoRepositoryTransportOverrides(snapshot.root);
  const status = await git(["status", "--porcelain=v1", "-z"], snapshot);
  if (status.stdout.length !== 0) throw new Error("Git workspace must be clean before creating a Draft PR.");

  const remote = (await git(["remote", "get-url", "origin"], snapshot)).stdout.trim();
  if (!isGitHubOrigin(remote)) throw new Error("A GitHub origin remote is required.");

  const upstream = (await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    snapshot,
  )).stdout.trim();
  if (upstream !== `origin/${branch}`) {
    throw new Error("Current branch must track the same branch on origin.");
  }

  const localHead = (await git(["rev-parse", "HEAD"], snapshot)).stdout.trim();
  const remoteHead = (await git(["rev-parse", `refs/remotes/origin/${branch}`], snapshot)).stdout.trim();
  if (localHead !== remoteHead) throw new Error("Current branch must be fully pushed before creating a Draft PR.");

  const envOverrides = {
    ...SAFE_GIT_ENV,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  await runCommand("gh", ["auth", "status", "--hostname", "github.com"], {
    cwd: snapshot.root,
    timeoutMs: 60_000,
    envOverrides,
  });
  const created = await runCommand("gh", ["pr", "create", "--draft", "--fill"], {
    cwd: snapshot.root,
    timeoutMs: 120_000,
    envOverrides,
  });
  const url = created.stdout
    .trim()
    .split(/\r?\n/u)
    .reverse()
    .find((line) => /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/u.test(line));
  if (!url) throw new Error("GitHub did not return a valid pull request URL.");

  return {
    text: JSON.stringify({ draft: true, branch, url }),
    auditBranch: branch,
  };
}

async function validate(snapshotValue) {
  const snapshot = await assertAuthorized(snapshotValue);
  const branch = snapshot.branch;
  const root = snapshot.root;
  const directories = ["src", "tests", "tools"].filter((item) =>
    fs.existsSync(path.join(root, item)),
  );

  const commands = [
    ["pytest", "python3", ["-m", "pytest", "-q"]],
    ["compileall", "python3", ["-m", "compileall", "-q", ...directories]],
    ["git diff --check", "git", ["diff", "--check"]],
    ["git diff --cached --check", "git", ["diff", "--cached", "--check"]],
  ];

  const output = [`Validation passed on ${branch}.`];

  for (const [label, command, args] of commands) {
    const result = await run(command, args, { cwd: root });
    output.push(
      "",
      `=== ${label}: PASS ===`,
      result.stdout,
      result.stderr,
    );
  }

  return { text: output.filter((item) => item !== "").join("\n") };
}

export async function handleGitWriteTool(name, args = {}, snapshot, options = {}) {
  if (name === "git_stage") return stage(args, snapshot);
  if (name === "git_commit") return commit(args, snapshot);
  if (name === "git_push_current_branch") return push(snapshot);
  if (name === "github_pr_create_draft") {
    return createDraftPr(args, snapshot, options.runCommand || run);
  }
  if (name === "run_validation") return validate(snapshot);
  throw new Error(`Unsupported Git write tool: ${name}`);
}
