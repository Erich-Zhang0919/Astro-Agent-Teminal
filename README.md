# Astro Console

Node.js + TypeScript development environment using pnpm and Jest.

## Setup

```sh
pnpm install
```

Create `~/.astro/astro.json` in your user home directory before starting Astro:

```json
{
  "model": {
    "model": "kimi-k2.6",
    "apiKey": "your_moonshot_api_key_here",
    "baseURL": "https://api.moonshot.cn/v1"
  },
  "env": {
    "TAVILY_API_KEY": "your_tavily_api_key_here"
  }
}
```

The path uses the operating system's home directory on Windows, macOS and Linux
(for example, `C:\Users\<user>\.astro\astro.json` on Windows).
The file, all three model fields and `env.TAVILY_API_KEY` are required. Missing or invalid configuration
stops startup with an error showing the configuration path and fields to fix.
Model credentials are read from this file; `MOONSHOT_API_KEY` is no longer used.
Web search reads `env.TAVILY_API_KEY` from this file and passes it directly to
Tavily; it no longer uses `TAVILY_API_KEY` from `.env` or the process environment.

The database is stored at `~/.astro/.data/checkpointer.db`, using the operating
system's home directory. Startup creates the directory and database if missing
and reuses the database on subsequent runs. Existing project-local `.data`
databases are not migrated automatically.

Context usage queries `<baseURL>/models` for the actual response model ID and
reads `context_length` or `context_window` (input + output capacity). If metadata
is missing or unavailable, documented DeepSeek, MiniMax, GLM, Qwen and MiMo
limits are used for recognized official API hosts and exact model IDs. The
fallback catalog and official source links are in `src/agent/model-context-limits.ts`
(checked 2026-10-20); K/M-only specifications use conservative decimal counts.
Live metadata always wins. Unknown models and third-party endpoints remain
`unknown` without metadata, so percentage warnings and automatic compaction
cannot be triggered from a guessed limit. Fallback entries do not imply that a
retired model is still available.

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

Each user request can use up to 12 tool-call rounds (parallel calls count as one
round). The graph has a 100-step limit to accommodate permission and hook nodes.
At the tool budget, Astro asks the model to answer using existing results with
tools disabled. A graph step-limit error also triggers a final answer instead of
continuing pending searches. A new question closes any previous tool call that
has not yet reached permission review; pending approvals and hook recovery retain
their normal behavior.

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

## MCP Servers

Astro can discover and call tools from local stdio and remote Streamable HTTP MCP
Servers. Put configuration in `.astro/mcp.json` in your working directory, or use
`astro chat --mcp-config <path>` / `astro ask "message" --mcp-config <path>`.
An absent default file leaves MCP disabled. An explicit missing file, invalid JSON
or invalid configuration stops session startup. The source file
`src/agent/mcp/mcp.json` is an example and is never loaded automatically.

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.83"],
      "autoApprove": ["browser_snapshot"]
    },
    "internal": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${INTERNAL_MCP_TOKEN}" }
    }
  }
}
```

The example pins Playwright MCP to a fixed version; no external programs run until configured.
Configured stdio commands run as local extensions when entering a session, before
tool approval, without shell interpolation. They receive the SDK's base environment
plus explicit `env` values, not all of Astro's environment. `env` and HTTP `headers`
support `${ENV_VAR}` substitutions. A missing variable disables that Server and
reports its name. Relative `cwd` values resolve against the configuration file;
otherwise stdio runs in the session's working directory.

Each Server supports `enabled` (default `true`), `autoApprove` (default `[]`),
`connectTimeoutMs` (default 15000), and `callTimeoutMs` (default 60000). Connections
and initial discovery share the connection deadline. Static Headers can carry a
Bearer token or API key; OAuth login and legacy SSE transports are not supported.

Tool names are prefixed, for example `mcp__playwright__browser_navigate`. Each MCP
call requires approval unless its **original** tool name is in that Server's
`autoApprove` array; `['*']` approves all tools on that Server. Non-interactive
calls requiring approval are denied. Server-provided read-only annotations do not
grant permission. Approved and whitelisted calls still run both tool hooks.

Use `/mcp` to inspect Server status and `/mcp tools [server]` to inspect tools.
Configuration and tool catalogs stay fixed during an activation. Use `/new`,
switch away and back, or restart chat to reload. One failed connection leaves the
built-in tools and other successful Servers available. Disconnected Servers retry
only on the next activation. Tool calls are never automatically replayed after a
timeout or disconnect; their effects may already have occurred.

MCP connections belong to parent sessions. Children share the parent's tools,
approval policy and connection, so they can continue in the same browser. Separate
parent sessions use independent connections. Calls to the same Server are serialized.
ESC cancels current and queued requests without closing a usable connection.
Normal exit, switching, and failed activation clean up owned connections. Previously
approved checkpoint calls are blocked if their MCP target or tool binding changed.

Text and structured results enter the existing tool-output pipeline. Images, audio
and embedded blobs are saved under `tool_output` and returned as paths with MIME
types. Resource links are returned without fetching them. The text model does not
receive binary Base64 or image content. Resources and Prompts are not exposed.

API callers use `mcpConfigPath` and `onMcpDiagnostic` in `runAgentStream` /
`startAgentSession` options, `getMcpSessionStatus(threadId)` for inspection, and
`endAgentSession` to release connections. Direct use of the exported low-level
`agent` graph retains its built-in tools unless a runtime `context.toolset` is supplied.

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
