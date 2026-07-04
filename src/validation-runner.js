import { runFixedGit } from "./fixed-git-runner.js";
import { usesUnittest } from "./python-test-kind.js";

const ALLOWED_EXIT_CODES = Object.freeze(Array.from({ length: 256 }, (_, index) => index));
const PYTEST = ["-m", "pytest", "-q"];
const UNITTEST = ["-m", "unittest", "discover", "-s", "tests", "-p", "test*.py", "-v"];

function sameArgs(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function selectValidationArgs(command, args, cwd) {
  return command === "python3" && sameArgs(args, PYTEST) && usesUnittest(cwd)
    ? UNITTEST
    : args;
}

export function runValidationCommand(command, args, options) {
  return runFixedGit(command, selectValidationArgs(command, args, options.cwd), {
    cwd: options.cwd,
    allowedExitCodes: ALLOWED_EXIT_CODES,
  });
}
