---
description: Hand a coding task to Codex, then check its work
argument-hint: '<the task to delegate>'
allowed-tools: Bash(git:*), Read, Grep, Glob, mcp__codex-bridge__codex_code
disable-model-invocation: true
---

<!-- Manual invocation only. This command writes files, and delegating an edit
     is a decision the user makes, not one Claude should reach on its own. -->


Delegate an implementation task to Codex so it does not consume this session's context, then verify what came back.

Task: `$ARGUMENTS`

Steps:

1. Confirm the tree is clean enough to tell Codex's changes apart from existing work: run `git status --short`. If there are unrelated uncommitted changes, tell the user, because the diff afterwards will be mixed and harder to review.
2. Gather only what you need to write a good brief — the relevant file paths and conventions. Do not read the whole codebase; the point of delegating is to avoid spending context here.
3. Call `mcp__codex-bridge__codex_code` with `working_dir` set to the repository root. Write the `task` as if briefing a competent engineer who cannot see this conversation: exact file paths, the constraints that matter, what "done" looks like, and what not to touch. A vague brief comes back as a vague diff.
4. When it returns, run `git diff` and read the actual changes. Codex's summary is a claim, not evidence — this step is the whole reason to run the command rather than trusting the summary.
5. Report to the user: what changed, whether it does what was asked, and anything that looks wrong. If Codex left part of the task undone or did something out of scope, say that explicitly.

If the diff is wrong in a small way, fix it yourself. If it is wrong in a way that suggests the brief was misunderstood, say so and ask whether to re-delegate with a sharper brief rather than patching around it.
