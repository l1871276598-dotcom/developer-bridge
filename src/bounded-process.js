import { spawn } from "node:child_process";

export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 2 * 1000;

function appendBounded(chunks, chunk, state, limit) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - state.bytes);
  if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
  state.bytes += buffer.length;
  return state.bytes > limit;
}

function decodeBoundedUtf8(chunks, limit) {
  const text = Buffer.concat(chunks).toString("utf8");
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const encoded = Buffer.from(text, "utf8");
  return encoded.subarray(0, Math.max(0, limit - 3)).toString("utf8");
}

export function runBoundedProcess(command, args, {
  cwd,
  timeoutMs,
  stdoutLimit = MAX_COMMAND_OUTPUT_BYTES,
  stderrLimit = MAX_COMMAND_OUTPUT_BYTES,
  detached = false,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  env = process.env,
  extraStdio = [],
}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      shell: false,
      detached,
      stdio: ["ignore", "pipe", "pipe", ...extraStdio],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminationStarted = false;
    let forcedTermination;
    let closedResult;
    let settled = false;

    const finish = () => {
      if (settled || !closedResult) return;
      settled = true;
      resolve({
        ...closedResult,
        stdout: decodeBoundedUtf8(stdoutChunks, stdoutLimit),
        stderr: decodeBoundedUtf8(stderrChunks, stderrLimit),
        timedOut,
        outputLimitExceeded,
      });
    };

    const signalProcess = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    const startTermination = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalProcess("SIGTERM");
      forcedTermination = setTimeout(() => {
        signalProcess("SIGKILL");
        forcedTermination = undefined;
        finish();
      }, terminationGraceMs);
      forcedTermination.unref();
    };

    const stopForLimit = () => {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      startTermination();
    };
    child.stdout.on("data", (chunk) => {
      if (appendBounded(stdoutChunks, chunk, stdoutState, stdoutLimit)) stopForLimit();
    });
    child.stderr.on("data", (chunk) => {
      if (appendBounded(stderrChunks, chunk, stderrState, stderrLimit)) stopForLimit();
    });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      startTermination();
    }, timeoutMs);
    timeout.unref();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      closedResult = { exitCode, signal };
      if (!detached || !terminationStarted) {
        clearTimeout(forcedTermination);
        forcedTermination = undefined;
        finish();
        return;
      }
      try {
        process.kill(-child.pid, 0);
        if (forcedTermination === undefined) finish();
      } catch (error) {
        if (error?.code !== "ESRCH") {
          clearTimeout(forcedTermination);
          forcedTermination = undefined;
          settled = true;
          reject(error);
          return;
        }
        clearTimeout(forcedTermination);
        forcedTermination = undefined;
        finish();
      }
    });
  });
}
