---
name: pr-cycle
description: Run a Terrastories pull request through the full autonomous review, fix, CI, merge-readiness, and authorized merge/cleanup lifecycle. Use when the user says "PR cycle", asks to make a PR fully mergeable or merge-ready, asks to address review comments and CI until green, requests repeated independent reviewer/fix loops, or authorizes merging and cleanup of a reviewed PR. A PR-cycle request authorizes fixes, pushes, and resolution of actionable review feedback, but never authorizes merge unless the user explicitly says to merge.
---

# Terrastories PR Cycle

Drive one PR to a defensible merge-ready state without disturbing unrelated work. Repository `AGENTS.md` and more specific local instructions take precedence.

Before evaluating or changing a PR, read `docs/SOURCE-OF-TRUTH.md` and the governing sections of `docs/SPEC-V2.md`. Record the spec references in the review notes. If the PR or its issue conflicts with canonical product/architecture intent, do not normalize the conflict by changing tests or code; surface and resolve the spec conflict first.

## Core contract

- Work autonomously through review comments, CI failures, fixes, commits, pushes, and repeated verification once a PR cycle is requested.
- Never merge merely because the PR is ready. Merge only when the user explicitly authorizes it, including language such as "merge when ready".
- Protect unrelated worktrees and dirty working trees. Never reset, clean, stash, stage, commit, overwrite, or delete unrelated user or agent work.
- Evaluate readiness against the exact pushed PR head SHA and the current live target-branch tip. Any new push or base-tip movement invalidates the previous readiness verdict and independent review.
- Treat timeouts as execution-surface limits, not automatically as failures. Do not rerun the same broad command unchanged; switch to bounded shards, narrower validation, quieter reporters, or CI polling.
- Prefer squash merge unless repository policy or the user requests another strategy.

## 1. Resolve scope and isolate work

1. Resolve repository, PR number or URL, base branch, head branch, current head SHA, and live base-tip SHA.
2. Read `AGENTS.md` before editing.
3. Inspect all worktrees and the target worktree state.
4. If the default worktree is dirty, do not switch branches, reset, stash, clean, or co-opt it. Use or create an isolated PR worktree.
5. Record pre-existing changes and unrelated worktree paths so final cleanup can be scoped precisely.

## 2. Establish current truth

Before changing code, collect:

- PR state and draft status;
- exact head SHA and current live target-branch tip;
- mergeability and merge-state status;
- complete CI/check rollup, including pending, skipped, neutral, and soft-failed jobs;
- review decision and all reviews;
- thread-aware unresolved review comments;
- latest reviewer activity outside threads, including general PR comments or summary reviews posted after the most recent review request;
- current worktree cleanliness.

Fail closed when required state cannot be read. Never call a PR merge-ready from partial GitHub state.

## 3. Fix loop

Repeat until no actionable findings remain on the current head:

1. Verify each threaded or unthreaded review finding against the exact current head. Resolve stale, duplicate, already-fixed, or false-positive feedback with evidence instead of creating churn. General PR comments and summary reviews with actionable findings must be adjudicated exactly like threaded findings even when the platform provides no resolve control.
2. Inspect failed CI logs and fix failures caused by the PR. Never change unrelated code simply to mask unrelated infrastructure failures.
3. Follow Terrastories TDD and validation requirements from `AGENTS.md`.
4. Run narrow affected tests first, then broader gates. Use terminating Vitest invocations (`vitest run` or `npm test -- --run`) for autonomous/CI work.
5. Commit and push only intentional PR changes.
6. Reply to and resolve addressed review threads only after the requested change is fully satisfied; for actionable unthreaded feedback, reply or otherwise record the disposition/evidence so the final gate can prove it was cleared.
7. Record the new pushed head SHA. All earlier readiness and reviewer verdicts are stale after a push.

Do not stop after green CI if unresolved actionable feedback remains.

## 4. Terrastories-specific validation gates

Choose gates by risk, but never weaken them to make a PR pass.

### Every code PR

- `npm run type-check`
- `npm run lint` with no new warnings; before production release, all warnings must be removed or explicitly justified
- `npm run format:check`
- `npm run build`
- affected Vitest files in terminating mode
- full stable test suite before merge when CI is not already proving it on the exact head

### API/Hono/Fastify behavior

- Run the shared API contract suite against every transport touched by the change.
- During the Fastify -> Hono migration, a Hono change is not merge-ready merely because `tests/hono` smoke tests pass. The same behavioral contract assertions must execute against both Fastify V1 and Hono V2, with intentionally documented namespace differences only.
- A comparison test that merely detects or logs mismatches does not count as parity. Unexpected response/status/header mismatches must fail the gate.
- Preserve error envelopes, auth semantics, pagination, multipart behavior, community isolation, and data-sovereignty rules unless an explicit API change is approved and documented. Preserve cultural behavior only when it is still required by canonical V2; never reintroduce removed V1 elder/cultural-metadata restrictions merely because legacy tests or reviews expect them.

### Database/schema/migration changes

Terrastories V2 has two first-class database targets: SQLite/D1 and PostgreSQL. For shared DB behavior, validation on only one backend is insufficient. Require both-backend evidence for production-relevant schema/repository/migration changes, including:

- migration from a fresh database;
- migration from the previous production schema or a production-like snapshot where supported;
- data preservation and constraints/indexes;
- application startup after migration;
- rollback/restore procedure rehearsal for destructive or irreversible changes;
- portable spatial behavior when geographic tables or queries are touched.

Do not introduce PostGIS or another database-specific spatial extension into shared V2 behavior unless `docs/SPEC-V2.md` is explicitly amended first. Never generate or apply a destructive migration to production data without a reviewed backup/restore or expand-contract plan.

### Auth, files, cultural data, and sovereignty

Treat these as high-risk. Require negative tests as well as success paths:

- unauthenticated and unauthorized access;
- cross-community access attempts;
- super-admin boundaries around protected community content and metadata;
- session creation, expiry, revocation, concurrent sessions, and restart behavior;
- upload MIME/size/path traversal checks and cross-community file access;
- logs/errors must not expose secrets, session tokens, sensitive cultural content, or unnecessary personal data.

### Deployment/runtime changes

Require a real production image/container startup check that fails if the process exits or health never becomes ready. Validate graceful shutdown, database connectivity, migrations, persistence, health/readiness endpoints, and backup/restore behavior. Soft-failed startup probes do not count as green.

## 5. Independent merge-readiness review loops

When the user names a reviewer/model, use it. Otherwise use a strong independent reviewer when available and justified by risk.

For each review:

- bind the review to the exact current head SHA and live base-tip SHA;
- do not prime the reviewer with the desired verdict;
- categorize findings as blockers, should-fix issues, and non-blocking nits;
- fix blockers and should-fix findings, push, refresh the base tip, and rerun review on the new revision pair;
- address nits when they materially improve correctness, security, data-loss prevention, maintainability, test quality, clarity, or operability;
- skip purely cosmetic or preference-only nits whose value does not justify another revision cycle;
- after two consecutive nit-only revision cycles, continue only for newly surfaced nits with clear correctness/security/data-loss/operability risk or unusually high maintenance/test value;
- never treat a malformed, missing, failed, stale-revision, or needs-input reviewer result as approval.

Static reviewer approval never substitutes for live GitHub/CI verification.

## 6. Merge-ready gate

Declare `MERGE-READY` only when all are true simultaneously for one exact head/base-tip pair:

- PR is open and not draft;
- head SHA and live target-branch tip still match the final reviewed pair;
- GitHub reports the PR mergeable/clean or a clearly understood equivalent;
- every required and relevant check is terminal and green;
- every skipped/neutral check is explicitly adjudicated as legitimately conditional;
- no relevant failure is hidden by `continue-on-error`, `|| true`, `|| echo`, or equivalent soft-fail logic;
- review decision is not blocking;
- no unresolved actionable review threads remain;
- no actionable unthreaded reviewer feedback remains without an explicit disposition/evidence;
- no independent-review blocker or should-fix finding remains;
- the PR worktree is clean after the final push;
- all Terrastories-specific gates above are satisfied.

Before stopping at `MERGE-READY` for any reason, execute the required self-improvement checkpoint in §8. If merge is not authorized, leave the verified PR unchanged solely for meta-learning, then report the checkpoint outcome and exact reviewed revision pair.

## 7. Authorized merge and cleanup

Only after explicit authorization:

1. Re-read live PR state immediately before merging.
2. If the user mentions merge order, a queue, prerequisites, or multiple pending PRs, inspect the open PR set and explicit dependency/base relationships. A PR being merge-ready does not prove it is logically next.
3. Confirm head and base-tip still equal the reviewed merge-ready pair; otherwise return to review/CI.
4. Reconfirm green CI, threaded and unthreaded reviewer state, and mergeability.
5. Merge with an exact-head guard when tooling supports it. Never use an admin bypass unless the user explicitly authorizes that separate override. Prefer explicit repository context when merging from a detached review worktree; branch-deletion helpers may assume a checked-out branch.
6. Treat a nonzero or otherwise ambiguous merge command as **unknown state**, not proof that the merge failed. Refresh the target ref and re-read the remote PR before any retry: a client can complete the remote merge and then fail during local branch cleanup. Never issue a second merge after remote state already reports the PR merged.
7. Verify the PR is merged and record the platform-reported merge/result commit when available. Refresh the target branch and prove that recorded commit is reachable from the current target-branch tip; if the platform does not expose a result commit, identify and record the exact resulting target-branch commit from refreshed remote state before continuing.
8. Observe required workflows triggered on the recorded resulting target-branch commit. Do not advance the merge queue while the target branch is red, still has unresolved required checks, or the merged-result ancestry check is unproven.
9. If a post-merge target-branch failure appears, distinguish a regression from a newly changed external condition. For a new dependency advisory, trace the source and prefer removing unused dependencies or applying a compatible fix over widening an audit baseline. Put any necessary minimal repair ahead of unrelated queued work.
10. Clean only the PR's own remote branch, isolated worktree, and local branch after proving there are no unpushed commits or untracked work worth preserving. Prefer explicit remote/local cleanup after verifying the merge rather than relying on a merge command's branch-cleanup side effect.
11. Verify unrelated worktrees and their pre-existing changes remain untouched.

## 8. Required self-improvement checkpoint

Before concluding every substantial PR cycle, explicitly review the session for durable lessons: recurring CI blind spots, flaky/isolation hazards, migration risks, tool timeouts, reviewer limitations, cleanup hazards, or repository-wide conventions. The checkpoint may conclude `no durable lesson`; do not manufacture process churn.

When a reusable lesson exists, improve the smallest canonical owner:

- `.agents/skills/pr-cycle/` for PR-cycle mechanics and safeguards;
- `AGENTS.md` for Terrastories-specific coding, architecture, testing, or repository conventions;
- deterministic script/test/config when the lesson can be enforced mechanically;
- `README.md` only for contributor/user-facing setup or workflows.

Self-improvement must not invalidate the original PR's verified state:

1. Do not append meta-process edits to a PR merely because it reached `MERGE-READY`.
2. If the original PR is not authorized to merge, report the durable lesson and leave the verified PR unchanged unless the lesson is directly in scope.
3. After an authorized merge and cleanup, make durable process improvements in a separate isolated branch/change based on the resulting target branch.
4. Validate that follow-up proportionally, review it independently when meaningful, and use the normal authorization rules for any separate merge unless the user explicitly included the self-improvement change in their merge instruction.
5. Keep the learning itself concise and general. Do not add session diaries, provider outage notes, or feature-specific history that belongs in an issue/spec/ADR.

For reviewer/tool lessons, preserve evidence without coupling the skill to one provider: bind reviews to exact SHAs, use bounded/quiet execution when verbose traces threaten timeouts, and never count timeout/error/needs-input output as approval.

## Status reporting

During long cycles, report meaningful milestones: first substantive finding, fixes pushed/new SHA, CI state, independent reviewer verdict, merge completion, and cleanup completion.

A final report should include the PR, exact final head/base-tip pair, CI state, unresolved actionable threaded and unthreaded feedback counts/dispositions, reviewer verdicts, mergeability, production-specific gate status when relevant, merge/cleanup state when authorized, and the self-improvement checkpoint outcome (`no durable lesson`, documented follow-up, or merged follow-up).
