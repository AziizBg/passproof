#!/usr/bin/env node
/**
 * passproof — if it says the tests passed, the runner output has to be in the same turn.
 * Does not run your tests. Blocks the claim.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const MAX_LOOP = 3;
const RECEIPT_TTL_MS = 15 * 60 * 1000;
const BLOCK_REASON = `passproof: you claimed the tests passed, but this turn has no test-runner output.

Run the tests. Paste is not enough — the runner has to actually print, in this turn, something like:
  3 passed in 0.12s
  Tests: 3 passed
  test result: ok.

Then you may say they passed.`;

const CLAIM_RE = [
  /\ball\s+tests?\s+(?:have\s+)?(?:passed|passing|pass)\b/i,
  /\btests?\s+(?:have\s+|are\s+)?(?:all\s+)?(?:passed|passing|green)\b/i,
  /\b(?:pytest|jest|vitest|npm\s+test|cargo\s+test|go\s+test)\b[^\n]{0,80}\b(?:passed|passing|green)\b/i,
  /\b\d+\s*\/\s*\d+\s+all passed\b/i,
  /\ball passed\b/i,
  /\b(?:unit|integration)\s+tests?\s+(?:passed|passing)\b/i,
];

const NOT_A_CLAIM_RE =
  /\b(will not say|won'?t say|cannot say|can'?t say|cannot claim|can'?t claim|do not (?:say|mention)|don'?t (?:say|mention)|from claiming|whether tests|you claimed the tests passed|no test-runner output|blocks an agent|did not run any tests|i will not say)\b/i;

const RUNNER_OK_RE = [
  /\d+\s+passed(?:,\s*\d+\s+(?:failed|skipped|warnings?))*\s+in\s+\d/i,
  /={3,}.*\d+\s+passed/i,
  /test suites:\s+\d+\s+passed/i,
  /tests:\s+\d+\s+passed/i,
  /\btest result: ok\./i,
  /^ok\s+\d+\s+\S+/m,
  /ran\s+\d+\s+tests?\s+in\s+/i,
  /\d+\s+passing\s+\(/i,
  /ℹ pass \d+/i,
  /# pass\s+\d+/i,
];

const SHELL_EVENTS = new Set([
  "afterShellExecution",
  "PostToolUse",
  "postToolUse",
]);

const STOP_EVENTS = new Set(["Stop", "stop", "SubagentStop", "subagentStop"]);

export function claimsTestsPassed(text) {
  if (!text) return false;
  const stripped = String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ");
  const sentences = stripped.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (NOT_A_CLAIM_RE.test(trimmed)) continue;
    if (CLAIM_RE.some((re) => re.test(trimmed))) return true;
  }
  return false;
}

export function hasRunnerOutput(text) {
  if (!text) return false;
  return RUNNER_OK_RE.some((re) => re.test(text));
}

export function extractStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractStrings(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "password" || key === "token" || key === "api_key") continue;
      extractStrings(item, out);
    }
  }
  return out;
}

export function looksLikeToolResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.type === "tool_result") return true;
  if (obj.toolUseResult) return true;
  const content = obj.message?.content;
  if (Array.isArray(content) && content.some((c) => c && c.type === "tool_result")) {
    return true;
  }
  const blob = JSON.stringify(obj).toLowerCase();
  return blob.includes("tool_result") || blob.includes('"tool_use_id"');
}

export function isHumanPrompt(obj) {
  if (!obj || looksLikeToolResult(obj)) return false;
  const role = obj.role || obj.message?.role || obj.type;
  if (role !== "user" && role !== "human") return false;
  if (obj.origin?.kind && obj.origin.kind !== "human") return false;
  const content = obj.message?.content ?? obj.content;
  if (typeof content === "string" && content.trim()) return true;
  if (Array.isArray(content) && content.some((c) => c?.type === "text" && c.text)) return true;
  return false;
}

export function lastTurnText(records) {
  if (!records.length) return "";
  let lastUser = -1;
  for (let i = 0; i < records.length; i++) {
    if (isHumanPrompt(records[i])) lastUser = i;
  }
  const slice = records.slice(lastUser + 1);
  const usable = slice.length ? slice : records.slice(-8);
  return extractStrings(usable).join("\n");
}

export function readTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const records = [];
  const jsonl = transcriptPath.endsWith(".jsonl") || /^\s*\{/.test(raw);
  if (jsonl && raw.includes("\n")) {
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // skip truncated lines
      }
    }
    if (records.length) return records;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{ role: "assistant", message: { content: [{ type: "text", text: raw }] } }];
  }
}

export function sessionKey(payload) {
  return payload.conversation_id || payload.session_id || payload.generation_id || "default";
}

export function receiptPath(payload) {
  return path.join(os.tmpdir(), "passproof", `${sessionKey(payload)}.json`);
}

export function saveReceipt(payload, output) {
  if (!hasRunnerOutput(output)) return null;
  const file = receiptPath(payload);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const receipt = {
    conversation_id: sessionKey(payload),
    generation_id: payload.generation_id || null,
    output: String(output).slice(-8000),
    ts: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(receipt));
  return file;
}

export function loadReceipt(payload) {
  const file = receiptPath(payload);
  if (!fs.existsSync(file)) return "";
  try {
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() - Number(receipt.ts || 0) > RECEIPT_TTL_MS) return "";
    if (
      payload.generation_id &&
      receipt.generation_id &&
      payload.generation_id !== receipt.generation_id
    ) {
      return "";
    }
    return String(receipt.output || "");
  } catch {
    return "";
  }
}

export function shellOutputFromPayload(payload) {
  if (payload.output) return String(payload.output);
  const response = payload.tool_response || payload.tool_result || payload.toolUseResult;
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    return [response.stdout, response.output, response.content].filter(Boolean).join("\n");
  }
  return "";
}

export function lastAssistantText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return extractStrings(value).join("\n");
}

export function turnTextFromPayload(payload) {
  if (payload.turn_text) return String(payload.turn_text);
  const parts = [];
  parts.push(lastAssistantText(payload.last_assistant_message));
  if (payload.transcript_path) {
    parts.push(lastTurnText(readTranscript(payload.transcript_path)));
  }
  parts.push(loadReceipt(payload));
  return parts.filter(Boolean).join("\n");
}

export function decide(payload, turnText) {
  const event = String(payload.hook_event_name || "");
  const status = String(payload.status || "");
  const loopCount = Number(payload.loop_count || 0);
  if (SHELL_EVENTS.has(event)) return { action: "observe", why: "shell" };
  if (payload.stop_hook_active === true) return { action: "allow", why: "stop_hook_active" };
  if (status === "aborted") return { action: "allow", why: "aborted" };
  if (loopCount >= MAX_LOOP) return { action: "allow", why: "loop_limit" };
  if (event && !STOP_EVENTS.has(event) && event !== "") {
    return { action: "allow", why: "not_stop" };
  }
  if (!claimsTestsPassed(turnText)) return { action: "allow", why: "no_claim" };
  if (hasRunnerOutput(turnText)) return { action: "allow", why: "runner_ok" };
  return { action: "block", why: "claim_without_runner" };
}

export function isCursorPayload(payload) {
  const event = payload.hook_event_name;
  if (event === "stop" || event === "afterShellExecution" || event === "subagentStop") return true;
  if (typeof payload.loop_count === "number" && payload.cursor_version) return true;
  if (Array.isArray(payload.workspace_roots) && payload.conversation_id) return true;
  return false;
}

export function hookResponse(decision, cursor) {
  if (decision.action !== "block") return { stdout: "{}\n", exit: 0 };
  if (cursor) {
    return {
      stdout: JSON.stringify({ followup_message: BLOCK_REASON }) + "\n",
      exit: 0,
    };
  }
  return {
    stdout: JSON.stringify({ decision: "block", reason: BLOCK_REASON }) + "\n",
    exit: 0,
  };
}

export function handlePayload(payload) {
  const event = String(payload.hook_event_name || "");
  if (SHELL_EVENTS.has(event)) {
    saveReceipt(payload, shellOutputFromPayload(payload));
    return { action: "observe", why: "shell" };
  }
  return decide(payload, turnTextFromPayload(payload));
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parsePayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { last_assistant_message: trimmed };
  }
}

function hookCommand(hookFile) {
  return `node ${JSON.stringify(hookFile)}`;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Could not parse ${file}`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function claudeSettingsPath(global) {
  return global
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(process.cwd(), ".claude", "settings.json");
}

function cursorHooksPath(global) {
  return global
    ? path.join(os.homedir(), ".cursor", "hooks.json")
    : path.join(process.cwd(), ".cursor", "hooks.json");
}

function vendorHook(global, kind) {
  const dir = global
    ? path.join(os.homedir(), kind === "cursor" ? ".cursor/hooks" : ".claude/hooks")
    : path.join(process.cwd(), kind === "cursor" ? ".cursor/hooks" : ".claude/hooks");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "passproof.js");
  fs.copyFileSync(SELF, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function hasPassproof(value) {
  return JSON.stringify(value || "").includes("passproof.js");
}

function installClaude(global) {
  const hookFile = vendorHook(global, "claude");
  const file = claudeSettingsPath(global);
  const settings = readJson(file, {});
  settings.hooks = settings.hooks || {};
  const command = hookCommand(hookFile);
  const entry = { hooks: [{ type: "command", command, timeout: 10 }] };
  if (!hasPassproof(settings.hooks.Stop)) {
    settings.hooks.Stop = [...(settings.hooks.Stop || []), entry];
  }
  if (!hasPassproof(settings.hooks.PostToolUse)) {
    settings.hooks.PostToolUse = [
      ...(settings.hooks.PostToolUse || []),
      { matcher: "Bash", ...entry },
    ];
  }
  writeJson(file, settings);
  return file;
}

function installCursor(global) {
  const hookFile = vendorHook(global, "cursor");
  const file = cursorHooksPath(global);
  const hooks = readJson(file, { version: 1, hooks: {} });
  hooks.version = hooks.version || 1;
  hooks.hooks = hooks.hooks || {};
  const command = hookCommand(hookFile);
  const stopEntry = { command, timeout: 10, loop_limit: MAX_LOOP };
  const shellEntry = { command, timeout: 10 };
  if (!hasPassproof(hooks.hooks.stop)) {
    hooks.hooks.stop = [...(hooks.hooks.stop || []), stopEntry];
  }
  if (!hasPassproof(hooks.hooks.afterShellExecution)) {
    hooks.hooks.afterShellExecution = [...(hooks.hooks.afterShellExecution || []), shellEntry];
  }
  writeJson(file, hooks);
  return file;
}

function uninstallFrom(file) {
  if (!fs.existsSync(file)) return file;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const strip = (arr) => (arr || []).filter((entry) => !hasPassproof(entry));
  if (data.hooks?.Stop) data.hooks.Stop = strip(data.hooks.Stop);
  if (data.hooks?.PostToolUse) data.hooks.PostToolUse = strip(data.hooks.PostToolUse);
  if (data.hooks?.stop) data.hooks.stop = strip(data.hooks.stop);
  if (data.hooks?.afterShellExecution) {
    data.hooks.afterShellExecution = strip(data.hooks.afterShellExecution);
  }
  writeJson(file, data);
  return file;
}

function printHelp() {
  process.stdout.write(`passproof — if it says the tests passed, the runner output has to be in the same turn.

Usage:
  npx passproof install     Wire Cursor + Claude Code hooks in this repo
  npx passproof install --global
  npx passproof uninstall
  npx passproof demo        Show the two cases the GIF is built from

Does not run your tests. Only blocks the claim.
`);
}

function runDemo() {
  const fake = decide({}, "All tests passed. Ready to merge.");
  const real = decide(
    {},
    "All tests passed.\n===== 3 passed in 0.12s =====",
  );
  process.stdout.write(`fake claim  → ${fake.action}  (${fake.why})
real runner → ${real.action}  (${real.why})
`);
  if (fake.action !== "block" || real.action !== "allow") process.exit(1);
}

function runHook() {
  const payload = parsePayload(readStdinSync());
  const decision = handlePayload(payload);
  if (process.env.PASSPROOF_DEBUG) {
    fs.writeFileSync(
      ".passproof-debug.json",
      JSON.stringify(
        { payload, text: turnTextFromPayload(payload).slice(-4000), decision },
        null,
        2,
      ),
    );
  }
  const { stdout, exit } = hookResponse(decision, isCursorPayload(payload));
  process.stdout.write(stdout);
  process.exit(exit);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const global = args.includes("--global");
  if (cmd === "-h" || cmd === "--help" || cmd === "help") return printHelp();
  if (cmd === "install") {
    const files = [installClaude(global), installCursor(global)];
    process.stdout.write(`installed:\n${files.map((f) => `  ${f}`).join("\n")}\n`);
    return;
  }
  if (cmd === "uninstall") {
    const files = [
      uninstallFrom(claudeSettingsPath(global)),
      uninstallFrom(cursorHooksPath(global)),
    ];
    process.stdout.write(`removed passproof from:\n${files.map((f) => `  ${f}`).join("\n")}\n`);
    return;
  }
  if (cmd === "demo") return runDemo();
  if (cmd === "test") {
    const r = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  runHook();
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && path.resolve(SELF) === entry) {
  main();
}
