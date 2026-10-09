---
description: Second-opinion code review of the current changes, run by Codex
argument-hint: '[what to focus on, e.g. "payment correctness"]'
allowed-tools: Bash(git:*), Read, mcp__codex-bridge__codex_review
---

Get an independent review of the current work from Codex, a different model.

Focus requested by the user (may be empty): `$ARGUMENTS`

Steps:

1. Find the repository root with `git rev-parse --show-toplevel`. If the working directory is not inside a git repository, say so and stop.
2. Check `git status --short`. If there are uncommitted changes, review those (`target: "uncommitted"`). If the tree is clean, review this branch against the default branch instead — pass that branch name as `target`.
3. Call `mcp__codex-bridge__codex_review` with the repo root as `working_dir`, the target from step 2, and the user's focus as `focus` if they gave one. The call takes one to three minutes; do not poll or retry while it runs.
4. Report the findings verbatim, most severe first. Do not soften them and do not pad the list.

Then, for each finding, say in one line whether you agree, and why. You have context Codex does not — you know what the change was trying to do. A finding you can show is wrong should be called wrong, not repeated for safety.

Do not fix anything. This command reviews; the user decides what to act on.
