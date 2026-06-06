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
