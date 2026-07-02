import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 200_000;

const WRITE_TOOL_NAMES = new Set([
  "git_stage",
  "git_commit",
  "git_push_current_branch",
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

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function workspaceRoot() {
  const root = fs.realpathSync(requiredEnv("DEVELOPER_BRIDGE_WORKSPACE"));
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw new Error(`Workspace is not a Git repository: ${root}`);
  }
  return root;
}

function allowedBranch() {
  return (
    process.env.DEVELOPER_BRIDGE_ALLOWED_BRANCH?.trim() ||
    "codex/stage-07-learning-loop"
  );
}

function clip(value) {
  const text = String(value ?? "");
  return text.length <= MAX_OUTPUT
    ? text
    : `${text.slice(0, MAX_OUTPUT)}\n...[output truncated]`;
}

function run(command, args, options = {}) {
  const {
    cwd = workspaceRoot(),
    timeoutMs = TIMEOUT_MS,
    allowedExitCodes = [0],
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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
        const rendered = [command, ...args]
          .map((part) => JSON.stringify(part))
          .join(" ");
        reject(
          new Error(
            [
              `Command failed: ${rendered}`,
              `Exit code: ${exitCode}`,
              signal ? `Signal: ${signal}` : "",
              result.stdout ? `stdout:\n${result.stdout}` : "",
              result.stderr ? `stderr:\n${result.stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        return;
      }

      resolve(result);
    });
  });
}

function git(args, options = {}) {
  return run("git", args, { cwd: workspaceRoot(), ...options });
}

async function currentBranch() {
  const result = await git(["branch", "--show-current"]);
  const branch = result.stdout.trim();
  if (!branch) throw new Error("Detached HEAD is not allowed.");
  return branch;
}

async function assertAuthorized() {
  const configured = workspaceRoot();
  const actual = fs.realpathSync(
    (await git(["rev-parse", "--show-toplevel"])).stdout.trim(),
  );

  if (actual !== configured) {
    throw new Error(
      `Repository mismatch. Authorized=${configured}; actual=${actual}`,
    );
  }

  const branch = await currentBranch();
  const allowed = allowedBranch();

  if (branch === "main" || branch === "master") {
    throw new Error(`Protected branch cannot be modified: ${branch}`);
  }
  if (branch !== allowed) {
    throw new Error(`Unauthorized branch. Allowed=${allowed}; current=${branch}`);
  }

  return branch;
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

  /*
   * Deleted paths do not exist, but still need to be stageable. For existing
   * paths, resolve symlinks and ensure they remain inside the workspace.
   */
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

async function stage(args) {
  const branch = await assertAuthorized();
  const root = workspaceRoot();

  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    throw new Error("git_stage requires a non-empty paths array.");
  }

  const paths = [...new Set(args.paths.map((item) => safePath(root, item)))];
  await git(["add", "--", ...paths]);
  const status = await git(["status", "--short"]);

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

async function commit(args) {
  const branch = await assertAuthorized();
  const message = String(args.message ?? "").trim();

  if (!message) throw new Error("Commit message cannot be empty.");
  if (message.length > 300) throw new Error("Commit message is too long.");
  if (/[\r\n\0]/.test(message)) {
    throw new Error("Commit message must be one line.");
  }

  const staged = await git(
    ["diff", "--cached", "--quiet", "--exit-code"],
    { allowedExitCodes: [0, 1] },
  );

  if (staged.exitCode === 0) {
    throw new Error("No staged changes are available to commit.");
  }

  await git(["diff", "--cached", "--check"]);
  const result = await git(["commit", "-m", message]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();

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

async function push() {
  const branch = await assertAuthorized();
  const remote = (await git(["remote", "get-url", "origin"])).stdout.trim();

  if (!remote) throw new Error("Remote origin is not configured.");

  const result = await git([
    "push",
    "--porcelain",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);

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

async function validate() {
  const branch = await assertAuthorized();
  const root = workspaceRoot();
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

export async function handleGitWriteTool(name, args = {}) {
  if (name === "git_stage") return stage(args);
  if (name === "git_commit") return commit(args);
  if (name === "git_push_current_branch") return push();
  if (name === "run_validation") return validate();
  throw new Error(`Unsupported Git write tool: ${name}`);
}
