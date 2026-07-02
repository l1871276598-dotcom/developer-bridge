import path from "node:path";

const PYTHON_FD_WRAPPER = [
  "def _run():",
  "    import os, stat, sys",
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
  "    main.update({'__file__': script_path, '__loader__': None, '__package__': None, '__spec__': None, '__cached__': None})",
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
