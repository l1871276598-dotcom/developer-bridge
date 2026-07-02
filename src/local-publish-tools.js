import path from "node:path";

const PYTHON_FD_WRAPPER = [
  "import os, sys",
  "script_path = sys.argv[1]",
  "sys.argv = [script_path]",
  "source = os.fdopen(3, 'rb', closefd=False).read()",
  "scope = {'__name__': '__main__', '__file__': script_path, '__package__': None, '__cached__': None, '__spec__': None}",
  "exec(compile(source, script_path, 'exec'), scope, scope)",
].join("; ");

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
]);

export function createLocalPublishTools({
  root,
  normalizePath,
  existingFile,
  runProcess,
  timeoutMs,
  terminationGraceMs,
  pythonCommand = "python3",
  ToolError,
}) {
  const names = new Set(["run_python_file"]);

  async function invoke(name, args) {
    if (!names.has(name)) throw new ToolError(`Unknown local publish tool: ${name}`);
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
      const result = await runProcess(pythonCommand, ["-I", "-c", PYTHON_FD_WRAPPER, canonical], {
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
