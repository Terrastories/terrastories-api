# Archive: stale local work (2025-08 to 2026-09)

**Status: LIKELY STALE — do not build on this.**

This branch is a one-time snapshot of uncommitted local work found on the
worktree of `spec/v2-intentional-evolution` on 2026-09-27. The work dates from
the abandoned TypeScript-API era (mostly August–September 2025, before the
project pivoted to the V2 spec rewrite). It is preserved here for reference
only.

## Contents

- `USER_WORKFLOW_REPORT.md` — test report for `scripts/user_workflow.sh`.
  Findings: story creation missing `communityId`, viewer registration
  failures. Written against the pre-V2 TS API.
- `scripts/README.md` — usage docs for the same script.
- `*.json` (6 files) — registration test payloads. Fake credentials for a
  local dev server, not real secrets.
- `graft/` — tool cache directory, no project value.
- `.claude/` — local Claude Code configuration (settings, hooks, agents,
  status lines). Machine-local, not project work.
- `.devcontainer/` — devcontainer config (Dockerfile, devcontainer.json,
  init-firewall.sh). Possibly still useful, unrevised since 2025.

## Related stale branches (kept locally, renamed with `archive/` prefix)

| Branch                                                      | Last commit | Note                                                      |
| ----------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| `archive/stale-2025-09/fix-story-creation-typescript-types` | 2025-09-10  | commit `ff5d041`: user_workflow.sh rewrite, 21 steps → 10 |
| `archive/stale-2025-09/issue-75`                            | 2025-09-08  | user_workflow.sh + story creation fixes                   |
| `archive/stale-2025-09/issue-59-production-readiness`       | 2025-09-04  | prod readiness work                                       |
| `archive/stale-2025-09/issue-57`                            | 2025-08-31  | CI test fixes                                             |
| `archive/stale-2025-09/issue-53-docker-configuration`       | 2025-08-28  | Docker CI config                                          |
| `archive/stale-2025-09/issue-51-super-admin-endpoints`      | 2025-08-28  | super admin endpoints                                     |
| `archive/stale-2025-09/issue-44`                            | 2025-08-23  | roadmap docs                                              |

None of these are merged into `main`. Their remote counterparts were deleted.

## Stash entries (SHAs preserved for recovery)

| Stash      | Commit                                     | Date       | Base                            |
| ---------- | ------------------------------------------ | ---------- | ------------------------------- |
| stash@{0}  | `c78d5ad0dcc52a0e7a5765e90014a52fd247e8cf` | 2026-09-05 | feature/issue-92                |
| stash@{1}  | `3fdb63d5eaa019abfeecd2b9cecd9732a9f0ae3f` | 2025-09-10 | story-creation-typescript-types |
| stash@{2}  | `4504b3d3fe6cd7cf856c4f25ec9a116e93b179c9` | 2025-09-04 | issue-59-production-readiness   |
| stash@{3}  | `328636b48cb1b5bd76a9bca69b0689278cc68f73` | 2025-08-24 | issue-48-member-dashboard       |
| stash@{4}  | `df2c689ff7bc4f4240f4e56c49e1b46240d33ab8` | 2025-08-24 | issue-48-member-dashboard       |
| stash@{5}  | `75ec98e5206ac1df5033ddfc45f69d4832da5fa8` | 2025-08-24 | issue-46                        |
| stash@{6}  | `e64015c001e13f57093851fde0c9f2476f2b072b` | 2025-08-21 | main                            |
| stash@{7}  | `abd50f02d1112f7d6bf6978fb66c084a43c93780` | 2025-08-21 | main                            |
| stash@{8}  | `dc69cc081695b735cc1e299ec3c538175f80ba51` | 2025-08-21 | issue-38                        |
| stash@{9}  | `0166ce6727d7e00062ce38630134f1a2b86140bd` | 2025-08-18 | main                            |
| stash@{10} | `2b975d444aa263855158684902d8329fd3246c08` | 2025-08-18 | phase3-completion-fixes         |
| stash@{11} | `948cf82b6b654491c6c6748aeb4ec820475bfe64` | 2025-08-18 | issue-23                        |
| stash@{12} | `4c881390cfb561a6de7272698d85dd444df9c947` | 2025-08-18 | issue-23                        |
| stash@{13} | `03709869b7efd70ecfe5fa894b8d933be31f2f69` | 2025-08-17 | issue-22                        |
| stash@{14} | `bc9d64626e2e8be4aa2ff96f89bdd9b2fd9273f9` | 2025-08-17 | issue-19                        |
| stash@{15} | `a524bf56d0949d8f61325560e419f100f90376cc` | 2025-08-16 | main                            |
| stash@{16} | `f199bb1a7e50c1120ccc45356cbf0ff2208a873f` | 2025-08-15 | config-system                   |

Recover with `git stash apply <commit>` or `git branch <name> <commit>`.
If the stashes are later cleared, these commits remain recoverable from the
SHAs above until git garbage collection prunes them.
