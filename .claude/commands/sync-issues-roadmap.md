# Command: /sync-issues-roadmap

## Purpose

Keep docs/ISSUES_ROADMAP.md current with actual GitHub progress and maintain synchronization with docs/GITHUB_ROADMAP_MAPPING.md

## Process

### Phase 1: GitHub Status Analysis

1. Check completion status of all referenced GitHub issues using `gh issue list` and `gh pr list`
2. Identify closed issues and merged PRs that complete roadmap items
3. Collect status information for in-progress items

### Phase 2: Roadmap Updates

1. Update phase completion percentages in docs/ISSUES_ROADMAP.md
2. Mark completed items with ✅ COMPLETED status
3. Update in-progress indicators with current status
4. Maintain roadmap timeline accuracy

### Phase 3: Mapping Synchronization

1. Update docs/GITHUB_ROADMAP_MAPPING.md with current GitHub issue statuses
2. Compare GitHub items to roadmap items by title/description matching
3. Flag any new misalignments for manual review
4. Record sync timestamp and completion status

### Phase 4: Validation

1. Verify all roadmap items have corresponding GitHub tracking
2. Check for orphaned GitHub issues not in roadmap
3. Validate completion percentages are accurate
4. Ensure mapping table is current

## Command Execution

```bash
# Fetch current GitHub state
gh issue list --state all --json number,title,state,closedAt
gh pr list --state all --json number,title,state,mergedAt

# Update roadmap progress
# Update mapping alignment
# Generate status report
```

## Triggers

- After merging PRs that close roadmap issues
- Weekly status reviews (automated)
- Before stakeholder updates
- Phase completion milestones
- Manual execution for roadmap audits

## Output

- Updated docs/ISSUES_ROADMAP.md with current progress
- Updated docs/GITHUB_ROADMAP_MAPPING.md with issue alignments
- Status report of completed/in-progress items
- Flagged misalignments requiring attention

## Integration

This command integrates with:

- `/create-next-issue` - ensures new issues align with roadmap
- `/merge-pr` - triggers automatic roadmap updates
- Weekly automation for continuous tracking
