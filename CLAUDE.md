# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
pnpm install

# Run src/index.ts in watch mode (hot-reload via tsx)
pnpm dev

# Compile TypeScript to dist/ (uses tsconfig.build.json)
pnpm build

# Type-check without emitting (uses tsconfig.json, includes tests/)
pnpm typecheck

# Run all Jest tests
pnpm test

# Run a single test file
pnpm test -- tests/index.test.ts

# Run tests in watch mode
pnpm test:watch
```

## Architecture

This is a TypeScript LangChain/LangGraph scratchpad library. The intended workflow is:

- Experiment with LangChain/LangGraph patterns in `src/index.ts` (the sole entry point)
- Run experiments live with `pnpm dev` (tsx watch mode)
- Write tests in `tests/*.test.ts` using Jest + ts-jest

**Two tsconfig files serve different purposes:**
- `tsconfig.json` — type-checking only; includes `src/` and `tests/`
- `tsconfig.build.json` — extends the above; excludes tests, outputs declarations to `dist/`

**Module system:** source uses ES module syntax (`import`/`export`), but `tsconfig.json` targets CommonJS for Node compatibility. Jest runs via `ts-jest` directly against TypeScript source — no pre-compilation needed for tests.

**Dependencies:** `@langchain/core`, `@langchain/langgraph`, `langchain` — all available for import in any source file added under `src/`.

## behavior rules

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.