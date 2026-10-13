---
name: phase-worker-dispatch
description: Decide when to hand work to a phase-worker subagent and how to run the phase_control workflow (approve, prepare, dispatch, review, checkpoint, answer, resume). Use only when the phase_control tool exists in this session and the user asks to implement or build something that can be split into bounded, independently testable phases, or explicitly asks for a subagent or phase-worker. Skip for small single-file edits, open-ended design discussion, or when phase_control is not available.
---

# Phase-worker dispatch

`phase_control` + `subagent(agent: "phase-worker")` hand ONE bounded implementation phase at a time to a child. You are the parent: you plan, approve, verify. The child only implements.

## Decide: delegate or do it yourself

Delegate a phase only if ALL are true:
- the user wants the work built, not discussed, and has approved a goal (a real message from them);
- the phase has a concrete finish line: files it may touch, acceptance checks, and a command that proves them (for example `node --test test/x.test.ts`);
- it is small enough for ~20 minutes of child work, and its edits are limited to a few named files;
- no deletion, payment, publishing, credential or permission change is involved.

Do it yourself when: the edit is trivial (one file, a few lines), the scope is unclear and needs back-and-forth with the user, or the phases cannot be tested separately. Never delegate by default; never run two writable phase-workers at once.

## Flow (follow `allowedNextActions` in every phase_control result)

1. `status` - read `humanReferenceCandidate`. It is the latest real human entry. Use it as `approvalReference` only if that message is the user's approval of this goal; otherwise ask the user.
2. `approve` - pass the goal (object, or absolute path to a `.json` file inside the session directory) plus `approvalReference`. Each phase needs `id, objective, cwd (absolute), allowedPaths (relative files/dirs, no .. or wildcards), acceptance[], verifyCommands[], nonGoals[]` (use `[]` for none).
3. `prepare` - returns the contract for the next phase. You do NOT need to copy it: the dispatch gate substitutes the approved contract for whatever `task` you send. Still pass the returned `task` unchanged; do not reword it.
4. `subagent` with `agent: "phase-worker"`, a short `name`, and `cwd` equal to the phase cwd. Do not set `model`, `tools`, `skills` or `fork`; they are forbidden and the child uses your model and thinking level. It returns immediately; do not poll. The result arrives by itself.
5. When the child reports, verify it yourself: inspect the changed files against `allowedPaths`, run the verify command(s) and read the output. A child saying "tests pass" is not acceptance.
6. `review` with `passed`, `verification: [{command, exitCode}]` using the commands you actually ran, and `acceptanceEvidence[]` with at least one concrete line per acceptance item. If it failed, `passed: false` returns the phase for a repair attempt (max 2).
7. Next phase: if your lazy mode is off (the recommended setting) ask the user for a checkpoint, then `checkpoint` with their message as `approvalReference`, then `prepare` again. After the last phase the goal is complete: nothing to `release`; report to the user and stop.

## When the child asks for help

A child message of "needs help" is not a result. Read the question.
- A technical choice inside the approved contract: `answer` with `category: "technical-within-contract"` and your decision, then `subagent_resume` using exactly the returned `sessionPath` and `message` (no extra options).
- Anything else (new scope, deletion, cost, credentials, preference only the user can decide): ask the user; `answer` then needs their approvalReference.

## Rules

- Never invent an `approvalReference`. Do not use `?`, a file path or an ID you made up.
- Never widen `allowedPaths` or add work to make a check pass; report instead.
- If an action is rejected, read the error: it ends with the allowed next actions. Do the next allowed action; do not retry the same call.
- Do not start other agents while a phase is unresolved. Stop and tell the user if the child fails twice, a check keeps failing, or the model/thinking changed.
- Report to the user at the end: what changed (paths), the commands you ran with exit codes, and anything not verified.
