<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:nextjs-agent-feedback -->

## Report Next.js feedback

The project owner enabled `experimental.agentFeedback`, authorizing this feedback pass. When enabled, `next dev` writes this block and restores it if removed. Commit `AGENTS.md` with your work to keep the tree clean.

During the current user request, retain anonymized facts as feedback candidates for meaningful or recurring Next.js issues:

- Crashes, hangs, OOMs, or unexpected slowness
- Incorrect behavior, output, errors, or diagnostics
- Missing, unclear, or conflicting documentation
- Unexpected CLI, codemod, Skill, or upgrade behavior and non-obvious workarounds

Continue the current user request without reporting immediately. Routine debugging is not feedback. Verify changes before retaining them as feedback candidates. Never retain code, logs, paths, URLs, secrets, personal information, or project-specific data.

Retain qualifying friction even if it is later fixed or worked around; record the final outcome during the reporting pass.

Before the final response, run one reporting pass. If candidates remain, from this file's directory run `npx --no-install next internal agent-feedback-instructions` once without piping or truncating its output. Follow its output or error guidance. If a network sandbox blocks it, retry with network access; if it still returns no output, continue normally.

<!-- END:nextjs-agent-feedback -->

## Model credit is real money: be sparing

Alfred's DeepSeek key is paid from the owner's own account, and the app, CI and local runs all share it. On 2026-11-05 eval runs on PR pushes spent about 35 days' worth of normal app use in one day and emptied the account, so chat stopped working for everyone.

- Don't run `npm run evals` (or anything else that calls the real model) unless the change needs it. One run is about 130 requests. Never loop it or raise `EVAL_RUNS`, and don't run it to "double-check" after tests already pass.
- Test model-facing code with mocked `fetch` in vitest first; that costs nothing.
- CI evals run only when a PR has the `run-evals` label, weekly, or by hand. Add the label once, when a PR that changes how Alfred understands people (`lib/ai`, `lib/conversation`, `lib/finance`, `lib/bank/reply.ts`, `lib/studio`, `evals/`) is ready for review. New pushes don't re-run it.
- `deepseek-v4-pro` costs about 4x `deepseek-flash` per token and was most of the spend. Don't send more turns to it, add model calls per turn, or grow the system prompt without saying so in the PR.
- If a model call fails with 402, the account is out of credit: stop and tell the owner rather than retrying.
