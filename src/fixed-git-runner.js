import { spawn } from "node:child_process";
import os from "node:os";

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SAFE_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: os.devNull,
  GIT_CONFIG_KEY_2: "commit.gpgSign",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "protocol.ext.allow",
  GIT_CONFIG_VALUE_3: "never",
  GIT_TERMINAL_PROMPT: "0",
});

export function runFixedGit(command, args, { cwd, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...SAFE_GIT_ENV },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const stop = (signal) => {
      if (settled || child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 2_000).unref();
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
      else stop("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
      else stop("SIGKILL");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        reject(new Error("Fixed command output exceeded the limit."));
        return;
      }
      const result = {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      allowedExitCodes.includes(exitCode)
        ? resolve(result)
        : reject(new Error("Fixed Git command failed."));
    });
  });
}
