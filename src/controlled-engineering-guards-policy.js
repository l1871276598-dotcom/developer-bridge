import fs from "node:fs/promises";
import path from "node:path";

import { runFixedGit } from "./fixed-git-runner.js";

const MAX_WORKFLOW_BYTES = 256 * 1024;
const SAFE_ACTIONS = new Set([
  "actions/checkout@v4",
  "actions/setup-node@v4",
]);
const SAFE_ACTION_INPUTS = new Map([
  ["actions/checkout@v4", new Set(["persist-credentials: false"])],
  ["actions/setup-node@v4", new Set(["node-version: 20"])],
]);
const SAFE_COMMANDS = new Set([
  "npm ci",
  "npm ci --ignore-scripts",
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run typecheck",
  "npm run build",
  "npm run format:check",
]);
const SAFE_EVENTS = new Set([
  "pull_request:",
  "push:",
  "workflow_dispatch:",
]);

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error("Path must stay inside the authorized workspace.");
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Path must stay inside the authorized workspace.");
  }
  return normalized;
}

async function canonicalRoot(root) {
  const canonical = await fs.realpath(root);
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error("Authorized workspace is invalid.");
  return canonical;
}

async function singleLinkFile(root, relative) {
  const normalized = normalizeRelative(relative);
  const lexical = path.resolve(root, normalized);
  if (!isContained(root, lexical)) throw new Error("Path escapes the authorized workspace.");
  const lexicalStat = await fs.lstat(lexical);
  if (lexicalStat.isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
  const canonical = await fs.realpath(lexical);
  if (!isContained(root, canonical)) throw new Error("Path escapes the authorized workspace.");
  const stat = await fs.stat(canonical);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Path must be a single-link regular file.");
  return canonical;
}

function workflowPath(value) {
  const normalized = normalizeRelative(value).split(path.sep).join("/");
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(normalized)) {
    throw new Error("Workflow path must be under .github/workflows with a YAML extension.");
  }
  return normalized;
}

function lineInfo(line) {
  const withoutComment = line.replace(/\s+#.*$/u, "").trimEnd();
  return {
    text: withoutComment.trim(),
    indent: withoutComment.length - withoutComment.trimStart().length,
  };
}

function validatePermissions(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const info = lineInfo(lines[index]);
    if (!info.text.startsWith("permissions:")) continue;
    if (info.indent !== 0 || info.text !== "permissions:") {
      throw new Error("Only one top-level permissions block is allowed.");
    }
    blocks.push(index);
  }
  if (blocks.length !== 1) throw new Error("Workflow must declare exactly one top-level permissions block.");

  let entries = 0;
  for (let index = blocks[0] + 1; index < lines.length; index += 1) {
    const info = lineInfo(lines[index]);
    if (info.text === "") continue;
    if (info.indent === 0) break;
    if (info.text !== "contents: read") throw new Error("Only contents: read permission is allowed.");
    entries += 1;
  }
  if (entries !== 1) throw new Error("Workflow must grant exactly contents: read.");
}

function validateTriggers(lines) {
  let triggerFound = false;
  for (let index = 0; index < lines.length; index += 1) {
    const info = lineInfo(lines[index]);
    if (info.indent !== 0) continue;
    if (/^(?:on|['"]on['"]):\s*pull_request$/u.test(info.text)) {
      triggerFound = true;
      continue;
    }
    if (!/^(?:on|['"]on['"]):$/u.test(info.text)) continue;
    triggerFound = true;
    let events = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const child = lineInfo(lines[cursor]);
      if (child.text === "") continue;
      if (child.indent === 0) break;
      if (child.indent === 2 && child.text.endsWith(":")) {
        if (!SAFE_EVENTS.has(child.text)) throw new Error("Workflow trigger is not allowlisted.");
        events += 1;
      }
    }
    if (events === 0) throw new Error("Workflow must declare an allowlisted trigger.");
  }
  if (!triggerFound) throw new Error("Workflow must declare triggers.");
}

function validateActionInputs(lines, actionIndex, actionName) {
  const actionIndent = lineInfo(lines[actionIndex]).indent;
  const allowedInputs = SAFE_ACTION_INPUTS.get(actionName);
  let withIndent = null;
  let checkoutCredentialsDisabled = false;

  for (let index = actionIndex + 1; index < lines.length; index += 1) {
    const child = lineInfo(lines[index]);
    if (child.text === "") continue;
    if (child.indent <= actionIndent) break;
    if (child.text === "with:") {
      if (withIndent !== null) throw new Error("Action inputs must use one with block.");
      withIndent = child.indent;
      continue;
    }
    if (withIndent !== null && child.indent > withIndent) {
      if (!allowedInputs.has(child.text)) {
        throw new Error(actionName === "actions/checkout@v4"
          ? "Checkout inputs are not allowlisted."
          : "Action inputs are not allowlisted.");
      }
      if (child.text === "persist-credentials: false") checkoutCredentialsDisabled = true;
    } else if (withIndent !== null) {
      withIndent = null;
    }
  }

  if (actionName === "actions/checkout@v4" && !checkoutCredentialsDisabled) {
    throw new Error("Checkout must set persist-credentials: false.");
  }
}

export function validateControlledWorkflow(pathValue, content) {
  const normalizedPath = workflowPath(pathValue);
  if (typeof content !== "string" || content.length === 0) throw new Error("Workflow content is required.");
  if (Buffer.byteLength(content, "utf8") > MAX_WORKFLOW_BYTES) throw new Error("Workflow exceeds the fixed size limit.");
  if (content.includes("\0") || content.includes("\t") || content.includes("${{")) {
    throw new Error("Workflow contains unsupported dynamic content.");
  }

  const lines = content.split(/\r?\n/u);
  validatePermissions(lines);
  validateTriggers(lines);

  let jobsDeclared = false;
  let runners = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const info = lineInfo(lines[index]);
    if (info.text === "") continue;
    if (info.indent === 0 && info.text === "jobs:") jobsDeclared = true;
    const unsupported = /^(env|defaults|container|services|shell|working-directory):/u.exec(info.text);
    if (unsupported) throw new Error(`${unsupported[1]} is not allowlisted.`);

    const runner = /^runs-on:\s*(\S+)$/u.exec(info.text);
    if (runner) {
      if (runner[1] !== "ubuntu-latest") throw new Error("Only ubuntu-latest runners are allowed.");
      runners += 1;
    }

    const action = /^(?:-\s*)?uses:\s*(\S+)$/u.exec(info.text);
    if (action) {
      if (!SAFE_ACTIONS.has(action[1])) throw new Error("Only approved GitHub Actions are allowed.");
      validateActionInputs(lines, index, action[1]);
    }

    const command = /^(?:-\s*)?run:\s*(.*)$/u.exec(info.text);
    if (command && !SAFE_COMMANDS.has(command[1].trim())) {
      throw new Error("Workflow run command is not allowlisted.");
    }

    if (/^[^#]*[&*][A-Za-z0-9_-]+/u.test(info.text)) {
      throw new Error("Workflow aliases are not allowed.");
    }
  }

  if (!jobsDeclared) throw new Error("Workflow must declare jobs.");
  if (runners === 0) throw new Error("Workflow must use an approved runner.");
  return { valid: true, path: normalizedPath };
}

async function validateWorkflowFile(root, pathValue) {
  const normalized = workflowPath(pathValue);
  const file = await singleLinkFile(root, normalized);
  validateControlledWorkflow(normalized, await fs.readFile(file, "utf8"));
}

async function validateMoveSource(root, source) {
  const normalized = normalizeRelative(source);
  const lexical = path.resolve(root, normalized);
  if (!isContained(root, lexical)) throw new Error("Path escapes the authorized workspace.");
  const lexicalStat = await fs.lstat(lexical);
  if (lexicalStat.isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
  const canonical = await fs.realpath(lexical);
  if (!isContained(root, canonical)) throw new Error("Path escapes the authorized workspace.");
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {
    throw new Error("Move source must be a directory or single-link regular file.");
  }
}

async function assertCommittedPackageFiles(root) {
  const status = await runFixedGit(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "package.json", "package-lock.json"],
    { cwd: root },
  );
  if (status.stdout.trim()) throw new Error("Package manifests must match committed state.");
}

export async function guardControlledEngineeringTool(name, args = {}, workspace) {
  const root = await canonicalRoot(workspace);
  if (name === "search_text" && args.regex === true) {
    throw new Error("Regular-expression search is disabled; use bounded literal search.");
  }
  if (["install_dependencies", "run_package_script", "run_project_validation"].includes(name)) {
    await singleLinkFile(root, "package.json");
    await singleLinkFile(root, "package-lock.json");
    await assertCommittedPackageFiles(root);
  }
  if (name === "validate_github_workflow") await validateWorkflowFile(root, args.path);
  if (name === "github_contents_write_workflow") validateControlledWorkflow(args.path, args.content);
  if (name === "move_path") await validateMoveSource(root, args.source);
}