import path from "node:path";

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
    const { canonical } = await existingFile(relativePath);

    let result;
    try {
      result = await runProcess(pythonCommand, ["-I", canonical], {
        cwd: root,
        timeoutMs,
        detached: true,
        terminationGraceMs,
      });
    } catch {
      throw new ToolError("Python could not be started");
    }
    return { relativePath, text: JSON.stringify(result) };
  }

  return { names, invoke };
}
