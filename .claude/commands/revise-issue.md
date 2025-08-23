# Command: /revise-issue

## Purpose

Refine and improve an existing issue based on human feedback, ensuring clarity and completeness before development begins.

## Usage

```
/revise-issue "revision instructions" [issue-number]
/revise-issue --interactive [issue-number]
/revise-issue --template [template-name] [issue-number]
```

## Execution Flow

### 1. Fetch Current Issue

```typescript
interface IssueFetcher {
  async fetchIssue(issueNumber: number): Promise<Issue> {
    // Fetch via GitHub CLI
    const issue = await exec(`gh issue view ${issueNumber} --json title,body,labels,assignees,milestone`);

    // Parse current structure
    return {
      number: issueNumber,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      currentSections: this.parseIssueSections(issue.body),
      metadata: {
        created: issue.createdAt,
        updated: issue.updatedAt,
        author: issue.author,
        comments: issue.comments.totalCount
      }
    };
  }

  parseIssueSections(body: string): IssueSections {
    return {
      overview: this.extractSection(body, 'Overview'),
      acceptanceCriteria: this.extractSection(body, 'Acceptance Criteria'),
      technicalDetails: this.extractSection(body, 'Technical Details'),
      testingStrategy: this.extractSection(body, 'Testing Strategy'),
      estimation: this.extractSection(body, 'Estimation')
    };
  }
}
```

### 2. Analyze Revision Request

```typescript
class RevisionAnalyzer {
  analyzeRequest(instruction: string, currentIssue: Issue): RevisionPlan {
    const intentions = this.detectIntentions(instruction);

    return {
      scopeChange: this.detectScopeChange(instruction, currentIssue),
      clarifications: this.extractClarifications(instruction),
      additions: this.identifyAdditions(instruction),
      removals: this.identifyRemovals(instruction),
      priority: this.detectPriorityChange(instruction),
      technical: this.extractTechnicalChanges(instruction),
      risks: this.identifyNewRisks(instruction),
    };
  }

  detectIntentions(instruction: string): Intentions {
    const patterns = {
      expand: /add|include|expand|also/i,
      reduce: /remove|exclude|simplify|just/i,
      clarify: /clarify|explain|detail|specify/i,
      split: /split|separate|break.*down/i,
      combine: /combine|merge|consolidate/i,
      reprioritize: /urgent|priority|asap|defer/i,
    };

    return Object.entries(patterns)
      .filter(([_, pattern]) => pattern.test(instruction))
      .map(([intention]) => intention);
  }
}
```

### 3. Apply Intelligent Revisions

```typescript
class IssueReviser {
  async reviseIssue(
    issue: Issue,
    plan: RevisionPlan,
    instruction: string
  ): Promise<RevisedIssue> {
    let revised = { ...issue };

    // Apply scope changes
    if (plan.scopeChange) {
      revised = this.adjustScope(revised, plan.scopeChange);
    }

    // Add clarifications
    if (plan.clarifications.length > 0) {
      revised = this.addClarifications(revised, plan.clarifications);
    }

    // Update acceptance criteria
    revised.acceptanceCriteria = this.reviseAcceptanceCriteria(
      revised.acceptanceCriteria,
      instruction
    );

    // Recalculate estimation based on changes
    if (this.scopeSignificantlyChanged(issue, revised)) {
      revised.estimation = this.recalculateEstimation(revised);
    }

    // Update technical approach if needed
    if (plan.technical.length > 0) {
      revised.technicalDetails = this.reviseTechnicalApproach(
        revised.technicalDetails,
        plan.technical
      );
    }

    // Add revision history
    revised.revisionHistory = this.addRevisionRecord(
      issue.revisionHistory || [],
      instruction,
      this.summarizeChanges(issue, revised)
    );

    return revised;
  }

  private adjustScope(issue: Issue, scopeChange: ScopeChange): Issue {
    if (scopeChange.type === 'expand') {
      return {
        ...issue,
        acceptanceCriteria: [
          ...issue.acceptanceCriteria,
          ...scopeChange.additions,
        ],
        estimation: this.increaseEstimation(
          issue.estimation,
          scopeChange.magnitude
        ),
      };
    } else if (scopeChange.type === 'reduce') {
      return {
        ...issue,
        acceptanceCriteria: issue.acceptanceCriteria.filter(
          (ac) => !scopeChange.removals.includes(ac.id)
        ),
        estimation: this.decreaseEstimation(
          issue.estimation,
          scopeChange.magnitude
        ),
      };
    }
    return issue;
  }
}
```

### 4. Validation and Consistency Checks

```typescript
interface RevisionValidator {
  validate(original: Issue, revised: Issue): ValidationResult {
    const checks = [
      this.checkAcceptanceCriteriaConsistency(revised),
      this.checkEstimationReasonable(original, revised),
      this.checkDependenciesStillValid(revised),
      this.checkNoConflictingRequirements(revised),
      this.checkTestabilityMaintained(revised),
      this.checkBackwardCompatibility(original, revised)
    ];

    const warnings = [
      this.warnIfScopeCreep(original, revised),
      this.warnIfComplexityIncreased(original, revised),
      this.warnIfTimelineImpacted(original, revised)
    ];

    return {
      valid: checks.every(c => c.passed),
      errors: checks.filter(c => !c.passed).map(c => c.message),
      warnings: warnings.filter(w => w.triggered).map(w => w.message)
    };
  }

  private warnIfScopeCreep(original: Issue, revised: Issue): Warning {
    const originalPoints = this.calculateStoryPoints(original);
    const revisedPoints = this.calculateStoryPoints(revised);

    if (revisedPoints > originalPoints * 1.5) {
      return {
        triggered: true,
        message: `⚠️ Scope increased by ${Math.round((revisedPoints/originalPoints - 1) * 100)}%. Consider splitting into multiple issues.`
      };
    }
    return { triggered: false };
  }
}
```

### 5. Generate Diff View

```markdown
## Issue Revision Summary

### Changed Sections

#### Title

- **Before**: [original title]
- **After**: [revised title]

#### Acceptance Criteria

**Added**:

- [ ] New criterion 1
- [ ] New criterion 2

**Removed**:

- [ ] Removed criterion

**Modified**:
~ [ ] Original criterion -> Modified criterion

#### Estimation

- **Before**: M (3 days)
- **After**: L (5 days)
- **Reason**: Scope expanded to include additional API endpoints

#### Technical Approach

[Summary of technical changes]

### Impact Analysis

- **Timeline**: +2 days
- **Dependencies**: New dependency on Issue #45
- **Risk**: Increased from Low to Medium
- **Test Coverage**: Additional integration tests required
```

### 6. Update Issue

```bash
# Update the GitHub issue
update_github_issue() {
  local issue_number="$1"
  local new_body="$2"
  local new_title="$3"

  # Update title if changed
  if [ -n "$new_title" ]; then
    gh issue edit "$issue_number" --title "$new_title"
  fi

  # Update body
  gh issue edit "$issue_number" --body "$new_body"

  # Add revision comment
  gh issue comment "$issue_number" --body "📝 Issue revised based on feedback:

  $revision_summary

  Changes applied by: @$USER
  Revision instruction: \"$instruction\""
}
```

### 7. Interactive Mode

```typescript
class InteractiveRevision {
  async startInteractive(issue: Issue): Promise<RevisedIssue> {
    console.log('🔄 Starting interactive revision mode...\n');

    const questions = [
      {
        type: 'confirm',
        name: 'scopeOk',
        message: 'Is the current scope appropriate?',
        default: true,
      },
      {
        type: 'checkbox',
        name: 'sectionsToRevise',
        message: 'Which sections need revision?',
        choices: [
          'Overview',
          'Acceptance Criteria',
          'Technical Details',
          'Testing Strategy',
          'Estimation',
          'Dependencies',
        ],
      },
      {
        type: 'editor',
        name: 'specificChanges',
        message: 'Describe specific changes needed:',
      },
    ];

    const answers = await inquirer.prompt(questions);
    return this.applyInteractiveChanges(issue, answers);
  }
}
```

### 8. Template Application

```typescript
interface TemplateRevision {
  applyTemplate(issue: Issue, templateName: string): Issue {
    const templates = {
      'bug-report': this.bugReportTemplate,
      'feature-request': this.featureRequestTemplate,
      'technical-debt': this.technicalDebtTemplate,
      'performance': this.performanceTemplate,
      'security': this.securityTemplate
    };

    const template = templates[templateName];
    if (!template) {
      throw new Error(`Template '${templateName}' not found`);
    }

    return this.mergeWithTemplate(issue, template);
  }

  private bugReportTemplate(): IssueTemplate {
    return {
      sections: {
        'Steps to Reproduce': { required: true },
        'Expected Behavior': { required: true },
        'Actual Behavior': { required: true },
        'Environment': { required: true },
        'Possible Solution': { required: false },
        'Regression Test': { required: true }
      },
      labels: ['bug', 'needs-investigation'],
      priority: 'high'
    };
  }
}
```

## Success Output

```markdown
✅ Issue #[number] successfully revised!

📊 Revision Summary:

- Sections changed: [count]
- Acceptance criteria: [added: X, removed: Y, modified: Z]
- Estimation: [before] → [after]
- New dependencies: [list]
- Risk level: [before] → [after]

📝 Key Changes:

1. [Major change 1]
2. [Major change 2]
3. [Major change 3]

⚠️ Warnings:

- [Any warnings from validation]

🔗 View revised issue:
https://github.com/[owner]/[repo]/issues/[number]

💡 Recommendations:

- [Suggestions based on revision]
- [Next steps]

Ready to implement? Run:
/work [issue-number]
```

## Error Recovery

```typescript
class RevisionErrorHandler {
  async handle(error: Error, issue: Issue, instruction: string): Promise<void> {
    // Save the attempted revision
    await this.saveFailedRevision(issue, instruction, error);

    if (error.message.includes('merge conflict')) {
      console.log('⚠️ Issue was modified by another user. Fetching latest...');
      const latest = await this.fetchLatestIssue(issue.number);
      return this.retryRevision(latest, instruction);
    }

    if (error.message.includes('validation failed')) {
      console.log('❌ Revision validation failed:');
      console.log(error.details);
      console.log(
        '\n💡 Suggestion: Adjust the revision to address these issues'
      );
      return this.suggestAlternatives(issue, instruction, error.details);
    }

    console.error('❌ Unexpected error during revision:', error.message);
    this.saveRecoveryInstructions(issue, instruction);
  }
}
```

## Configuration

```yaml
# .claude/config/revise-issue.yaml
revise_issue:
  validation:
    strict_mode: true
    allow_scope_increase: true
    max_scope_increase_percent: 50
    require_estimation_update: true

  templates:
    location: .github/ISSUE_TEMPLATE/
    allow_custom: true

  history:
    track_revisions: true
    max_revisions: 10

  interactive:
    enabled: true
    timeout: 300 # seconds

  formatting:
    preserve_original_structure: false
    standardize_sections: true

  automation:
    auto_add_labels: true
    auto_update_milestone: true
    notify_assignees: true
```

## Post-Revision Synchronization

After modifying issue scope or requirements:

```bash
# Update mapping to reflect revised scope
/sync-github-mapping

# This ensures:
# - GITHUB_ROADMAP_MAPPING.md reflects revised issue scope
# - Alignment status is re-evaluated after changes
# - Any scope changes are documented in mapping table
```

## Integration

Links with other commands:

- Follows `/create-next-issue`
- Precedes `/work`
- Can be called multiple times
- Updates tracked in PR description
- `/sync-github-mapping` - Updates mapping after scope changes

### Get Second Opinion from Gemini and Codex

After revising the issue and synchronizing the roadmap, get a second opinion on the revision from Gemini and Codex.

```bash
# Call Gemini CLI for a second revision analysis
gemini -y -p "Revise issue #[issue-number]"

# Get a second opinion from openai codex
codex -m gpt-5 --dangerously-bypass-approvals-and-sandbox exec "Revise issue #[issue-number]"
```

This ensures the revised issue is reviewed from multiple perspectives, improving its clarity and actionability before development begins.
