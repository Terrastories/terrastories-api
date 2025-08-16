# Command: /create-next-issue

## Purpose

Analyzes project context (past issues, PRs, and ROADMAP.md) to automatically create the next logical issue, maintaining development continuity and momentum.

## Usage

```
/create-next-issue [--type feature|bug|chore] [--priority high|medium|low]
```

## Execution Flow

### 1. Context Gathering Phase

```bash
# Analyze recent development activity
git log --oneline -20 --pretty=format:"%s" > .claude/temp/recent-commits.txt
gh pr list --state merged --limit 5 --json number,title,body,files > .claude/temp/recent-prs.json
gh issue list --state closed --limit 10 --json number,title,body,labels > .claude/temp/recent-issues.json

# Check current state
gh issue list --state open --json number,title,labels,assignees > .claude/temp/open-issues.json
npm test -- --reporter=json > .claude/temp/test-coverage.json 2>/dev/null || true
```

### 2. Roadmap Analysis

```typescript
interface RoadmapAnalysis {
  async analyzeRoadmap(): Promise<NextItem> {
    const roadmap = await readFile('ROADMAP.md');

    // Parse roadmap structure
    const sections = this.parseRoadmapSections(roadmap);

    // Identify next logical item
    const analysis = {
      completedItems: this.findCompletedItems(sections),
      inProgressItems: this.findInProgressItems(sections),
      blockedItems: this.findBlockedItems(sections),
      readyItems: this.findReadyItems(sections)
    };

    // Determine next priority
    return this.selectNextItem(analysis);
  }

  private selectNextItem(analysis: Analysis): NextItem {
    // Priority order:
    // 1. Unblock other work
    // 2. Complete in-progress items
    // 3. High-value, low-effort items
    // 4. Technical debt if > 20% of backlog
    // 5. Next roadmap item

    if (analysis.blockedItems.length > 0) {
      return this.findBlockerSolution(analysis.blockedItems[0]);
    }

    if (analysis.inProgressItems.length > 0) {
      return this.createSubtask(analysis.inProgressItems[0]);
    }

    return analysis.readyItems[0];
  }
}
```

### 3. Issue Generation

```markdown
## Issue Template Structure

### Title Generation

- Format: `[type]: [concise description]`
- Examples:
  - `feat: Add user authentication endpoints`
  - `fix: Resolve database connection pooling issue`
  - `chore: Update dependencies to latest versions`

### Body Generation
```

Generate issue with this structure:

```markdown
## 📋 Overview

[Clear description of what needs to be done and why]

## 🎯 Acceptance Criteria

- [ ] [Specific, measurable outcome 1]
- [ ] [Specific, measurable outcome 2]
- [ ] [Specific, measurable outcome 3]

## 🔗 Context

- Related to: #[previous-issue-numbers]
- Blocks: #[future-issue-numbers] (if applicable)
- Depends on: #[dependency-issues] (if applicable)
- Roadmap item: [link to ROADMAP.md section]

## 📊 Technical Details

### Affected Components

- [ ] Routes: `[specific routes]`
- [ ] Services: `[specific services]`
- [ ] Database: `[migrations needed?]`
- [ ] Tests: `[test files to create/modify]`

### Implementation Approach

1. [High-level step 1]
2. [High-level step 2]
3. [High-level step 3]

## ✅ Definition of Done

- [ ] All acceptance criteria met
- [ ] Tests written and passing (coverage ≥ 80%)
- [ ] Documentation updated
- [ ] TypeScript strict mode passing
- [ ] Lint and format checks passing
- [ ] PR reviewed and approved

## 📏 Estimation

- **Complexity**: [XS|S|M|L|XL]
- **Effort**: [1-5 days]
- **Risk**: [Low|Medium|High]

## 🏷️ Labels

- `type:[feature|bug|chore]`
- `priority:[high|medium|low]`
- `component:[specific-component]`
- `needs-discussion` (if applicable)
```

### 4. Pattern Learning

```typescript
class PatternLearner {
  async learnFromHistory(): Promise<Patterns> {
    const recentPRs = await this.getRecentPRs();

    return {
      averageFilesPerPR: this.calculateAverage(recentPRs, 'filesChanged'),
      commonTestPatterns: this.extractTestPatterns(recentPRs),
      typicalPRSize: this.calculatePRSizeDistribution(recentPRs),
      commonIssueTypes: this.categorizeIssues(recentPRs),
      estimationAccuracy: this.compareEstimatesVsActual(recentPRs),
    };
  }

  async suggestImprovements(patterns: Patterns): string[] {
    const suggestions = [];

    if (patterns.averageFilesPerPR > 20) {
      suggestions.push('Consider breaking into smaller PRs');
    }

    if (patterns.estimationAccuracy < 0.7) {
      suggestions.push(
        'Adjust estimation strategy - currently off by ' +
          Math.round((1 - patterns.estimationAccuracy) * 100) +
          '%'
      );
    }

    return suggestions;
  }
}
```

### 5. Dependency Analysis

```bash
# Check for blocking dependencies
analyze_dependencies() {
  echo "Analyzing dependencies..."

  # Check open PRs that might block
  gh pr list --json number,title,isDraft --jq '.[] | select(.isDraft == false)'

  # Check failing tests that might need fixing first
  npm test 2>&1 | grep -E "FAIL|Error" || true

  # Check for TODO comments that might be relevant
  grep -r "TODO\|FIXME\|HACK" --include="*.ts" --include="*.tsx" src/ | head -10
}
```

### 6. Issue Creation

```bash
# Create the issue via GitHub CLI
create_github_issue() {
  local title="$1"
  local body="$2"
  local labels="$3"

  gh issue create \
    --title "$title" \
    --body "$body" \
    --label "$labels" \
    --assignee "@me"
}
```

## Context Persistence

Save analysis results to maintain context:

```bash
# Save context for future reference
mkdir -p .claude/context/issues/
echo "{
  \"timestamp\": \"$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")\",
  \"roadmapState\": \"$roadmap_analysis\",
  \"selectedItem\": \"$selected_item\",
  \"reasoning\": \"$reasoning\",
  \"dependencies\": $dependencies,
  \"estimatedEffort\": \"$effort\"
}" > .claude/context/issues/issue-$(date +%s).json
```

## Validation Checks

Before creating issue:

```typescript
interface IssueValidation {
  validateIssue(issue: Issue): ValidationResult {
    const checks = [
      this.hasAcceptanceCriteria(issue),
      this.hasEstimation(issue),
      this.hasNoCircularDependencies(issue),
      this.isNotDuplicate(issue),
      this.hasTestStrategy(issue),
      this.alignsWithRoadmap(issue)
    ];

    return {
      valid: checks.every(c => c.passed),
      failures: checks.filter(c => !c.passed).map(c => c.message)
    };
  }
}
```

## Success Output

```markdown
✅ Issue created successfully!

📋 Issue #[number]: [title]
🔗 URL: https://github.com/[owner]/[repo]/issues/[number]

📊 Analysis Summary:

- Based on: [X merged PRs, Y closed issues]
- Roadmap alignment: [specific section]
- Estimated effort: [days]
- Dependencies: [none|list]
- Risk level: [low|medium|high]

🎯 Suggested next actions:

1. Review and refine acceptance criteria
2. Assign to appropriate team member
3. Add to current sprint/milestone

💡 Patterns detected:

- [Any relevant patterns from history]
- [Suggestions for improvement]

Ready to start work? Run:
/work [issue-number]
```

## Error Handling

```typescript
class IssueCreationError {
  handle(error: Error): void {
    if (error.message.includes('rate limit')) {
      console.log('⏳ GitHub rate limit reached. Waiting 60 seconds...');
      setTimeout(() => this.retry(), 60000);
    } else if (error.message.includes('ROADMAP.md not found')) {
      console.log('📝 No ROADMAP.md found. Creating from open issues...');
      this.generateRoadmapFromIssues();
    } else if (error.message.includes('no recent activity')) {
      console.log('🆕 No recent activity. Suggesting initial setup tasks...');
      this.suggestInitialTasks();
    } else {
      console.error('❌ Failed to create issue:', error.message);
      this.saveFailureContext(error);
    }
  }
}
```

## Configuration Options

```yaml
# .claude/config/create-issue.yaml
create_issue:
  analysis:
    lookback_days: 30
    pr_limit: 10
    issue_limit: 20

  estimation:
    velocity_calculation: rolling_average
    include_review_time: true
    buffer_percentage: 20

  patterns:
    min_confidence: 0.7
    learning_enabled: true

  templates:
    use_custom: false
    template_path: .github/ISSUE_TEMPLATE/

  auto_assign:
    enabled: true
    strategy: round_robin # or workload_based

  labels:
    auto_apply: true
    required: [type, priority]
    component_detection: true
```

## Integration with Workflow

This command integrates with:

- `/revise-issue` - Refine the created issue
- `/work` - Start implementation
- `/review-pr` - Links back to this issue
- `/merge-pr` - Closes this issue

## Post-Creation Synchronization

After successfully creating a new GitHub issue:

```bash
# Update mapping to track new issue alignment
/sync-github-mapping

# This ensures the new issue is:
# - Added to docs/GITHUB_ROADMAP_MAPPING.md
# - Checked for roadmap alignment
# - Flagged if misaligned with roadmap items
```

## Performance Metrics

Track command effectiveness:

- Issue acceptance rate (no revisions needed)
- Estimation accuracy
- Dependency prediction accuracy
- Time saved vs manual creation
- Roadmap alignment score
