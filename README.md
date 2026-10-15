# Astro Console

Node.js + TypeScript development environment using pnpm and Jest.

## Setup

```sh
pnpm install
```

## Scripts

- `pnpm dev`: run `src/index.ts` in watch mode.
- `pnpm build`: compile TypeScript into `dist`.
- `pnpm typecheck`: run TypeScript checks without emitting files.
- `pnpm test`: run Jest unit tests.
- `pnpm test:watch`: run Jest in watch mode.

## Unit Test Flow

1. Add source files under `src/`.
2. Add tests under `tests/` using the `*.test.ts` suffix.
3. Run `pnpm test` locally before committing.
4. Run `pnpm typecheck` and `pnpm build` when changing public APIs.

## Agent hooks

The agent loads `.astro/hooks.json` from the current working directory when entering
a session. Use `astro chat --hooks <path>` or `astro ask "message" --hooks <path>` to
select another file. A missing default file disables hooks; an invalid configuration
or missing explicit file fails session startup. Configuration remains fixed until
the session is ended and entered again.

```json
{
  "hooks": {
    "SessionStart": [{ "command": "node ./scripts/session-start.js" }],
    "PreToolUse": [{ "matcher": "exec", "command": "node ./scripts/check-command.js" }],
    "PostToolUse": [{ "matcher": "*", "command": "node ./scripts/record-result.js" }],
    "SessionEnd": [{ "command": "node ./scripts/session-end.js" }]
  }
}
```

Tool matchers use case-sensitive substring matching; omitted matchers and `"*"`
match every tool. Session hooks do not accept a matcher. Commands run sequentially
in the session's working directory, through the system shell, as user-configured
local extensions. They receive JSON on stdin containing `version`, `event`,
`eventId`, `sessionId`, and `cwd`. Tool events also receive
`tool: { name, callId, args }`; PostToolUse additionally receives
`result: { status, content }` with the complete tool output before preview storage.
Session events include their lifecycle `reason`.

| Exit code | Behavior |
| --- | --- |
| 0 | Continue; stdout and stderr do not enter the conversation. |
| 1 | PreToolUse blocks the tool and returns stderr as its error; SessionStart blocks entry. PostToolUse and SessionEnd report stderr and continue. |
| 2 | Queue stderr as context for the next model request, then continue. |

Tool hooks run after permission checks and approval. Blocked or rejected calls do
not receive post hooks. Context messages are added after the complete tool-result
group and never appear as assistant reply tokens. End-hook context is persisted
for the next entry into the thread.

Each command defaults to a 10-second timeout, configurable with `timeoutMs`.
Each output stream is limited to 64 KiB. Invalid exit codes, timeouts, launch
failures, and oversized output block pre events and are reported for post events.
Cancellation terminates the hook process tree and cancels the run.

SessionStart runs on chat startup, `/new`, `/rewind`, and ask entry; it does not run
again for subsequent turns, approval resumes, or ESC cancellation. SessionEnd runs
on normal exit, switching, and ask completion. Force-killing the process does not
guarantee SessionEnd. Hook results are checkpointed at phase boundaries; a crash
between script completion and checkpointing may replay an event. Scripts with
external side effects can deduplicate using `eventId`.

API callers can pass `hooksPath` and `onHookDiagnostic` in `runAgentStream` options.
Direct calls automatically start a session; use `startAgentSession(threadId,
options)` and `endAgentSession(threadId, reason)` to manage explicit activation and
closure. `src/agent/hooks/hooks.json` is an example, not the default configuration.
Its four commands have runnable examples under `scripts/`. They read the hook input
and exit successfully without adding business rules; customize them for your project.
Run the example configuration with:

```sh
pnpm dev chat --hooks src/agent/hooks/hooks.json
```

Both `chat` and `ask` display a compact `[Tool] <name> called: <arguments>` line,
including calls that do not require approval. Arguments are limited to 120 characters;
tool results are not previewed. Failed and blocked calls show a short status line.
After each script completes, its stdout and stderr are displayed as
`[Hook <event>] <script output>`, including session hooks. Silent scripts display
nothing, and configuration commands are not printed. Script output preserves
multiple lines and is bounded by the existing 64 KiB limit for each stream.
Displaying output does not change exit-code decisions or inject stdout into the
conversation. Tool output passed to the agent is unchanged.
API callers can receive the same execution notifications using `onToolEvent` in
`runAgentStream` options and hook notifications using `onHookEvent` in session
options. These notifications are separate from reply tokens.

## SubAgent delegation

The main agent can call `agent_tool` with only `{ "prompt": "self-contained task" }`.
It normally handles work itself, and delegates independent tasks with a clear
deliverable when a separate working context is useful, or when explicitly asked.
Skill routing still comes first. This choice is guided by the system prompt and
tool description; it is not a deterministic task classifier.

Starting a child requires exec approval. Each parent session runs at most one
child at a time; multiple calls queue sequentially. The parent waits for the final
answer, reviews it, and continues. Different parent sessions can run independently.

Children use the same model, skills, long-term memory, tool permission checks and
active hook configuration. They have unique session IDs and can use every tool
except `agent_tool`, so nesting is unavailable. Only the task prompt is forwarded;
parent chat history, preprocessing and compaction context are not copied.

Child chat checkpoints and hook context stay in memory and are released on exit;
long-term memories explicitly written through tools remain stored under the child
session ID. Children do not compact context. Their intermediate reply tokens and
usage do not enter the parent reply stream, while tool and hook notifications use
the parent's callbacks. Cancellation stops the child and the current parent run.
The final result follows the normal tool-output preview storage rules.
