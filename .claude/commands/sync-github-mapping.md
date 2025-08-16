# Command: /sync-github-mapping

## Purpose

Maintain synchronization between GitHub issues/PRs and docs/GITHUB_ROADMAP_MAPPING.md

## Process

### Phase 1: GitHub Data Collection

1. Fetch all GitHub issues and PRs with `gh issue list` and `gh pr list`
2. Load current docs/ISSUES_ROADMAP.md content for reference
3. Collect issue/PR metadata: numbers, titles, states, dates

### Phase 2: Mapping Analysis

1. Compare GitHub items to roadmap items by title/description matching
2. Identify alignment status: ✅ ALIGNED, ⚠️ BROADER, ❌ MISMATCH
3. Detect new issues not yet in mapping table
4. Flag orphaned roadmap items without GitHub issues

### Phase 3: Mapping Table Updates

1. Update docs/GITHUB_ROADMAP_MAPPING.md with current GitHub status
2. Add new GitHub issues to mapping table
3. Update status column (Open, Closed, Merged, In Progress)
4. Add notes for scope discrepancies or special conditions

### Phase 4: Validation & Reporting

1. Flag any mismatches for manual review
2. Update last sync timestamp
3. Generate summary of changes made
4. Report on mapping health and alignment quality

## Command Execution

```bash
# Fetch GitHub state
gh issue list --state all --json number,title,state,createdAt,closedAt
gh pr list --state all --json number,title,state,createdAt,mergedAt

# Load roadmap reference
# Perform mapping analysis
# Update mapping table
# Generate validation report
```

## Triggers

- After creating new GitHub issues
- Weekly automated sync (recommended)
- Before major roadmap updates
- When issues are closed/merged
- Manual execution for alignment audits

## Output

- Updated docs/GITHUB_ROADMAP_MAPPING.md with current GitHub status
- List of newly detected issues requiring roadmap alignment
- Flagged mismatches requiring human attention
- Sync completion timestamp and health report

## Integration

This command works with:

- `/create-next-issue` - ensures new issues are tracked in mapping
- `/sync-issues-roadmap` - provides GitHub data for roadmap updates
- CI/CD workflows for automated synchronization
