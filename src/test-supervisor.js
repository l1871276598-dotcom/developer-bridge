import { spawn } from "node:child_process";

let terminating = false;
let terminationHold;

process.on("SIGTERM", () => {
  terminating = true;
  terminationHold ??= setInterval(() => {}, 1_000);
});

const child = spawn("npm", ["test"], {
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });

child.once("error", () => {
  if (terminating) return;
  console.error("The approved npm test process could not be started");
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
