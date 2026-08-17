import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  claimsTestsPassed,
  decide,
  handlePayload,
  hasRunnerOutput,
  hookResponse,
  isHumanPrompt,
  lastTurnText,
  loadReceipt,
  looksLikeToolResult,
  saveReceipt,
} from "./passproof.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(root, "passproof.js");

describe("claims", () => {
  it("catches the lie people actually write", () => {
    assert.equal(claimsTestsPassed("All tests passed. Ready to merge."), true);
    assert.equal(claimsTestsPassed("4966/4966 ALL PASSED (golden)"), true);
    assert.equal(claimsTestsPassed("the unit tests are passing now"), true);
  });

  it("lets ordinary closeouts through", () => {
    assert.equal(claimsTestsPassed("Done. I added the helper."), false);
    assert.equal(claimsTestsPassed("Fixed the off-by-one."), false);
    assert.equal(claimsTestsPassed(""), false);
  });

  it("does not treat negation or a definition as a closeout", () => {
    assert.equal(
      claimsTestsPassed("I will not say that all tests passed and we can merge."),
      false,
    );
    assert.equal(
      claimsTestsPassed(
        "passproof blocks an agent from claiming tests passed unless runner output appears in that same turn.",
      ),
      false,
    );
    assert.equal(
      claimsTestsPassed(
        "passproof: you claimed the tests passed, but this turn has no test-runner output.",
      ),
      false,
    );
    assert.equal(
      claimsTestsPassed("I cannot say that all tests passed and we can merge."),
      false,
    );
    assert.equal(
      claimsTestsPassed('then "All tests passed." The turn ended.'),
      false,
    );
  });
});

describe("runner output", () => {
  it("accepts real runners, not the word passed", () => {
    assert.equal(hasRunnerOutput("3 passed in 0.12s"), true);
    assert.equal(hasRunnerOutput("Tests:       3 passed, 0 failed"), true);
    assert.equal(hasRunnerOutput("test result: ok. 2 passed; 0 failed"), true);
    assert.equal(hasRunnerOutput("ℹ pass 17"), true);
    assert.equal(hasRunnerOutput("All tests passed."), false);
    assert.equal(hasRunnerOutput("Commands run: npm test"), false);
  });
});

describe("decide", () => {
  it("blocks claim without runner", () => {
    assert.equal(decide({}, "All tests passed.").action, "block");
  });

  it("allows claim with pytest in the same turn", () => {
    const d = decide({}, "All tests passed.\n===== 3 passed in 0.12s =====");
    assert.equal(d.action, "allow");
    assert.equal(d.why, "runner_ok");
  });

  it("does not become a done-police", () => {
    assert.equal(decide({}, "I am done with the refactor.").action, "allow");
  });

  it("fails open on loops and abort", () => {
    assert.equal(decide({ loop_count: 3 }, "All tests passed.").action, "allow");
    assert.equal(decide({ status: "aborted" }, "All tests passed.").action, "allow");
    assert.equal(decide({ stop_hook_active: true }, "All tests passed.").action, "allow");
  });
});

describe("live transcripts", () => {
  it("reads Cursor role/message JSONL and ignores an older pytest", () => {
    const text = lastTurnText([
      {
        role: "user",
        message: { content: [{ type: "text", text: "run tests" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "===== 3 passed in 0.12s =====" }] },
      },
      {
        role: "user",
        message: { content: [{ type: "text", text: "ship it" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "All tests passed." }] },
      },
    ]);
    assert.equal(hasRunnerOutput(text), false);
    assert.equal(claimsTestsPassed(text), true);
  });

  it("does not treat a Claude tool_result as a new user turn", () => {
    const toolUser = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "===== 3 passed in 0.12s =====",
          },
        ],
      },
    };
    assert.equal(looksLikeToolResult(toolUser), true);
    assert.equal(isHumanPrompt(toolUser), false);
    const text = lastTurnText([
      { type: "user", message: { role: "user", content: "please test" } },
      toolUser,
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "All tests passed." }] },
      },
    ]);
    assert.equal(hasRunnerOutput(text), true);
    assert.equal(claimsTestsPassed(text), true);
  });
});

describe("shell receipt", () => {
  it("lets Stop see pytest from afterShellExecution in the same generation", () => {
    const payload = {
      conversation_id: `test-${Date.now()}`,
      generation_id: "gen-1",
    };
    saveReceipt(payload, "===== 3 passed in 0.12s =====");
    assert.match(loadReceipt(payload), /3 passed in 0.12s/);
    const stop = handlePayload({
      ...payload,
      hook_event_name: "stop",
      cursor_version: "1.0",
      loop_count: 0,
      last_assistant_message: "All tests passed.",
    });
    assert.equal(stop.action, "allow");
    assert.equal(stop.why, "runner_ok");
  });

  it("does not reuse a receipt from a later generation", () => {
    const conversation_id = `test-gen-${Date.now()}`;
    saveReceipt(
      { conversation_id, generation_id: "gen-1" },
      "===== 3 passed in 0.12s =====",
    );
    const stop = handlePayload({
      conversation_id,
      generation_id: "gen-2",
      hook_event_name: "Stop",
      last_assistant_message: "All tests passed.",
    });
    assert.equal(stop.action, "block");
  });
});

describe("hook I/O", () => {
  it("blocks Claude with a decision JSON", () => {
    const { stdout, exit } = hookResponse({ action: "block" }, false);
    assert.equal(exit, 0);
    assert.equal(JSON.parse(stdout).decision, "block");
  });

  it("blocks Cursor with a follow-up, not a crash", () => {
    const { stdout } = hookResponse({ action: "block" }, true);
    assert.ok(JSON.parse(stdout).followup_message.includes("passproof"));
  });

  it("stdin fixture: fake claim is blocked", () => {
    const r = spawnSync(process.execPath, [bin], {
      input: JSON.stringify({
        hook_event_name: "Stop",
        last_assistant_message: "All tests passed.",
      }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).decision, "block");
  });

  it("stdin fixture: Cursor transcript_path claim is blocked", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "passproof-"));
    const transcript = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "are the tests green?" }] },
      })}\n${JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "All tests passed." }] },
      })}\n`,
    );
    const r = spawnSync(process.execPath, [bin], {
      input: JSON.stringify({
        hook_event_name: "stop",
        cursor_version: "1.0",
        loop_count: 0,
        conversation_id: "c1",
        transcript_path: transcript,
      }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).followup_message.includes("passproof"));
  });

  it("afterShellExecution is silent and stores the runner", () => {
    const r = spawnSync(process.execPath, [bin], {
      input: JSON.stringify({
        hook_event_name: "afterShellExecution",
        conversation_id: "shell-1",
        generation_id: "g",
        command: "pytest -q",
        output: "3 passed in 0.12s",
      }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "{}");
  });
});

describe("install", () => {
  it("vendors the hook and wires Cursor stop + afterShellExecution", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "passproof-"));
    const r = spawnSync(process.execPath, [bin, "install"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(path.join(dir, ".cursor/hooks/passproof.js")));
    const cursor = JSON.parse(fs.readFileSync(path.join(dir, ".cursor/hooks.json"), "utf8"));
    const claude = JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"));
    assert.ok(JSON.stringify(cursor.hooks.stop).includes("passproof.js"));
    assert.ok(JSON.stringify(cursor.hooks.afterShellExecution).includes("passproof.js"));
    assert.ok(JSON.stringify(claude.hooks.Stop).includes("passproof.js"));
    assert.ok(JSON.stringify(claude.hooks.PostToolUse).includes("passproof.js"));
  });
});
