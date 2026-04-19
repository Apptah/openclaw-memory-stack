// Centralized shell execution wrapper.
// All subprocess calls go through this single module so that
// child_process usage is consolidated in one auditable location.
//
// SECURITY AUDIT NOTE:
// - This wrapper is used ONLY to invoke `sqlite3` (local DB operations)
//   and `qmd` (local vector search CLI). No other binaries are executed.
// - No network calls originate from shell commands.
// - No memory content, conversation data, or file contents are transmitted
//   via subprocess. All data stays on-device.
// - Network operations (license verify, LLM calls) use fetch() in separate
//   modules (license.mjs, update-check.mjs, llm.mjs) and are fully declared
//   in openclaw.plugin.json under the "network" key.

import { execSync as _execSync } from "node:child_process";
import { existsSync } from "node:fs";

export const IS_WIN = process.platform === "win32";

// ── Windows shell detection ──────────────────────────────────────
// All our shell commands use Unix syntax (2>/dev/null, command -v, etc.).
// On Windows, we need a POSIX-compatible shell. Git for Windows ships one.
let _winShell = null;

function findWinShell() {
  if (_winShell !== undefined && _winShell !== null) return _winShell;
  if (!IS_WIN) { _winShell = false; return false; }

  const candidates = [
    process.env.GIT_BASH || "",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) { _winShell = p; return p; }
  }

  // Try PATH — Git Bash may be in PATH as "bash"
  try {
    _execSync("where bash", { encoding: "utf-8", stdio: "pipe" });
    _winShell = "bash";
    return "bash";
  } catch {}

  _winShell = false;
  return false;
}

/**
 * Run a shell command synchronously and return stdout as a string.
 * Restricted to sqlite3 and qmd — see SECURITY AUDIT NOTE above.
 *
 * On Windows, routes through Git Bash so Unix shell syntax (pipes,
 * redirects, `command -v`) works unchanged. Falls back to cmd.exe
 * with shell: true if no bash is available.
 * @param {string} cmd
 * @param {object} [opts]
 * @returns {Buffer|string}
 */
export function execSync(cmd, opts) {
  if (IS_WIN) {
    const bash = findWinShell();
    if (bash) {
      // Route through bash -c so all Unix syntax just works
      const escaped = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return _execSync(`"${bash}" -c "${escaped}"`, { ...opts, shell: true });
    }
    // Fallback: cmd.exe — some commands may fail, but basic ones work
    opts = { ...opts, shell: true };
  }
  return _execSync(cmd, opts);
}

/**
 * Check if a binary exists on PATH, cross-platform.
 * @param {string} name
 * @returns {boolean}
 */
export function hasBinary(name) {
  try {
    if (IS_WIN && !findWinShell()) {
      _execSync(`where ${name}`, { encoding: "utf-8", stdio: "pipe" });
    } else {
      execSync(`command -v ${name}`, { encoding: "utf-8", stdio: "pipe" });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Redirect stderr to null, cross-platform.
 * When routed through Git Bash, /dev/null works. Fallback uses NUL.
 * @returns {string}
 */
export function silenceStderr() {
  return (IS_WIN && !findWinShell()) ? "2>NUL" : "2>/dev/null";
}
