import { spawn } from "node:child_process";

let terminating = false;
let terminationHold;

process.on("SIGTERM", () => {
  terminating = true;
  terminationHold ??= setInterval(() => {}, 1_000);
});

const testProfile =
  process.env.DEVELOPER_BRIDGE_TEST_PROFILE || "npm";

const approvedTests = {
  npm: {
    command: "npm",
    args: ["test"],
  },
  "python-unittest": {
    command: "python3",
    args: ["-m", "unittest", "discover", "-s", "tests", "-v"],
  },
};

const selectedTest = approvedTests[testProfile];

if (!selectedTest) {
  console.error("Unsupported approved test profile");
  process.exit(2);
}

const testCommand = selectedTest.command;
const testArgs = selectedTest.args;

const child = spawn(testCommand, testArgs, {
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });

child.once("error", () => {
  if (terminating) return;
  console.error(
    `The approved test process could not be started: ${testCommand}`
  );
  process.exitCode = 1;
});

child.once("close", (exitCode, signal) => {
  setTimeout(() => {
    if (terminating) return;
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = exitCode ?? 1;
  }, 25);
});
