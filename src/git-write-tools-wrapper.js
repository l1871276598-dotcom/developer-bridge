import {
  GIT_WRITE_TOOL_DEFINITIONS as BASE_DEFINITIONS,
  handleGitWriteTool as handleBaseTool,
  isGitWriteTool,
} from "./git-write-tools-base.js";
import { usesUnittest } from "./python-test-kind.js";
import { runValidationCommand, selectValidationArgs } from "./validation-runner.js";

export const GIT_WRITE_TOOL_DEFINITIONS = BASE_DEFINITIONS.map((definition) =>
  definition.name === "run_validation"
    ? {
        ...definition,
        description:
          "Run fixed Python validation using pytest or unittest discovery, followed by compileall and Git diff checks.",
      }
    : definition,
);
export { isGitWriteTool };

export async function handleGitWriteTool(name, args = {}, snapshot, options = {}) {
  if (name !== "run_validation") return handleBaseTool(name, args, snapshot, options);

  const runner = options.runCommand || runValidationCommand;
  const runCommand = (command, commandArgs, runOptions) =>
    runner(command, selectValidationArgs(command, commandArgs, runOptions.cwd), runOptions);
  const result = await handleBaseTool(name, args, snapshot, { ...options, runCommand });
  if (!usesUnittest(snapshot.root)) return result;

  const payload = JSON.parse(result.text);
  payload.results[0].step = "unittest";
  if (payload.failed_step === "pytest") payload.failed_step = "unittest";
  return { ...result, text: JSON.stringify(payload) };
}
