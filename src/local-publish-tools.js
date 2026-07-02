import path from "node:path";

const PYTHON_FD_WRAPPER = [
  "def _run():",
  "    import importlib.machinery, os, stat, sys",
  "    relative_path, script_path = sys.argv[1], sys.argv[2]",
  "    components = relative_path.split(os.sep)",
  "    open_flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)",
  "    directory_fd = os.dup(3)",
  "    os.close(3)",
  "    file_fd = None",
  "    try:",
  "        for component in components[:-1]:",
  "            next_fd = os.open(component, open_flags | getattr(os, 'O_DIRECTORY', 0), dir_fd=directory_fd)",
  "            try:",
  "                is_directory = stat.S_ISDIR(os.fstat(next_fd).st_mode)",
  "            except:",
  "                os.close(next_fd)",
  "                raise",
  "            if not is_directory:",
  "                os.close(next_fd)",
  "                raise OSError('Python path component is not a directory')",
  "            os.close(directory_fd)",
  "            directory_fd = next_fd",
  "        if not components[-1].endswith('.py'):",
  "            raise OSError('Python path must end in .py')",
  "        file_fd = os.open(components[-1], open_flags, dir_fd=directory_fd)",
  "        file_stat = os.fstat(file_fd)",
  "        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_nlink != 1:",
  "            raise OSError('Python target is not a single-link regular file')",
  "        source = os.fdopen(file_fd, 'rb', closefd=False).read()",
  "    finally:",
  "        if file_fd is not None:",
  "            os.close(file_fd)",
  "        os.close(directory_fd)",
  "    sys.argv = [script_path]",
  "    main = sys.modules['__main__'].__dict__",
  "    loader = importlib.machinery.SourceFileLoader('__main__', script_path)",
  "    main.update({'__file__': script_path, '__loader__': loader, '__package__': None, '__spec__': None, '__cached__': None})",
  "    main.pop('_run', None)",
  "    exec(compile(source, script_path, 'exec'), main, main)",
  "_run()",
].join("\n");

export const LOCAL_PUBLISH_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "run_python_file",
    description: "Run one existing Python file inside the authorized workspace without interpreter arguments.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "git_add",
    description: "Stage only explicitly listed existing files in the authorized repository.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 128 },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "git_commit",
    description: "Commit the currently staged changes with one explicit message.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]);

const PROTECTED_DIRECTORY_SEGMENTS = new Set([".git", "node_modules"]);
const PROTECTED_BASENAMES = new Set([".env", "id_rsa", "id_ed25519"]);
const PROTECTED_EXTENSIONS = new Set([".pem", ".key"]);

function assertArguments(args, allowed, required) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("Arguments must be an object");
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new TypeError(`Unexpected argument: ${key}`);
  }
  for (const key of required) {
    if (!(key in args)) throw new TypeError(`Missing required argument: ${key}`);
  }
}

function assertConservativeGitPath(relativePath, ToolError) {
  if (
    relativePath === "." ||
    relativePath.startsWith("-") ||
    relativePath.startsWith(":") ||
    /[*?[\]\\]/u.test(relativePath)
  ) {
    throw new ToolError("Git paths must be explicit literal file paths");
  }
  const segments = relativePath.split(path.sep).map((segment) => segment.toLowerCase());
  const basename = segments.at(-1);
  if (
    segments.some((segment) => PROTECTED_DIRECTORY_SEGMENTS.has(segment)) ||
    (PROTECTED_BASENAMES.has(basename) || basename.startsWith(".env.")) ||
    PROTECTED_EXTENSIONS.has(path.extname(basename))
  ) {
    throw new ToolError("Staging this protected path is not allowed");
  }
}

export function createLocalPublishTools({
  root,
  normalizePath,
  existingFile,
  validateGitFile,
  runGit,
  runGitResult,
  canonicalPath,
  runProcess,
  timeoutMs,
  terminationGraceMs,
  pythonCommand = "python3",
  ToolError,
}) {
  const names = new Set(["run_python_file", "git_add", "git_commit"]);

  async function assertRepositoryRoot() {
    const topLevel = (await runGit(["rev-parse", "--show-toplevel"])).trimEnd();
    let canonicalTopLevel;
    try {
      canonicalTopLevel = await canonicalPath(topLevel);
    } catch {
      throw new ToolError("Git repository root could not be verified");
    }
    if (canonicalTopLevel !== root) {
      throw new ToolError("Authorized workspace must equal the Git repository top level");
    }
  }

  async function invokeGitAdd(args) {
    assertArguments(args, ["paths"], ["paths"]);
    if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 128) {
      throw new ToolError("paths must be a non-empty array of at most 128 strings");
    }
    const paths = [];
    const seen = new Set();
    for (const input of args.paths) {
      if (typeof input !== "string") throw new ToolError("Every Git path must be a string");
      if (input.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
        throw new ToolError("Git paths must not contain dot path segments");
      }
      const relativePath = normalizePath(input);
      assertConservativeGitPath(relativePath, ToolError);
      await validateGitFile(relativePath);
      if (!seen.has(relativePath)) {
        seen.add(relativePath);
        paths.push(relativePath);
      }
    }
    await assertRepositoryRoot();
    await runGit(["add", "--", ...paths]);
    const status = await runGit(["status", "--short", "--", ...paths]);
    return { text: status.length === 0 ? "no staged changes" : status };
  }

  async function invokeGitCommit(args) {
    assertArguments(args, ["message"], ["message"]);
    if (
      typeof args.message !== "string" ||
      args.message.trim().length === 0 ||
      args.message.startsWith("-") ||
      /[\0\r\n]/u.test(args.message) ||
      Buffer.byteLength(args.message, "utf8") > 200
    ) {
      throw new ToolError("message must be one nonempty safe line of at most 200 UTF-8 bytes");
    }
    await assertRepositoryRoot();
    const diff = await runGitResult(["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"]);
    if (diff.exitCode === 0) throw new ToolError("Nothing staged to commit");
    if (diff.exitCode !== 1) throw new ToolError("Git operation failed");
    await runGit([
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false",
      "commit", "--no-verify", "--no-gpg-sign", "-m", args.message,
    ]);
    const identity = (await runGit(["log", "-1", "--format=%H%x00%s"])).trimEnd();
    const separator = identity.indexOf("\0");
    if (separator < 1) throw new ToolError("Git operation failed");
    return {
      text: JSON.stringify({ oid: identity.slice(0, separator), summary: identity.slice(separator + 1) }),
    };
  }

  async function invoke(name, args) {
    if (!names.has(name)) throw new ToolError(`Unknown local publish tool: ${name}`);
    if (name === "git_add") return invokeGitAdd(args);
    if (name === "git_commit") return invokeGitCommit(args);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new ToolError("Arguments must be an object");
    }
    for (const key of Object.keys(args)) {
      if (key !== "path") throw new ToolError(`Unexpected argument: ${key}`);
    }
    if (!("path" in args)) throw new ToolError("Missing required argument: path");
    if (typeof args.path !== "string") throw new ToolError("Path must be a non-empty relative string");

    const relativePath = normalizePath(args.path);
    if (path.extname(relativePath) !== ".py") {
      throw new ToolError("Path must identify a Python .py file");
    }
    const { canonical, handle } = await existingFile(relativePath);
    if (path.extname(canonical) !== ".py") {
      await handle.close().catch(() => {});
      throw new ToolError("Path must identify a Python .py file");
    }

    try {
      const result = await runProcess(pythonCommand, ["-I", "-c", PYTHON_FD_WRAPPER, relativePath, canonical], {
        cwd: root,
        timeoutMs,
        detached: true,
        terminationGraceMs,
        extraStdio: [handle.fd],
      });
      return { relativePath, text: JSON.stringify(result) };
    } catch {
      throw new ToolError("Python could not be started");
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return { names, invoke };
}
