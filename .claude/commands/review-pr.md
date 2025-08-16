# Command: /review-pr

## Purpose

Intelligently review a pull request by aggregating feedback from multiple AI reviewers, applying fixes, and ensuring the PR meets all quality standards before merge.

## Usage

```
/review-pr [pr-number]
/review-pr [pr-number] --auto-fix
/review-pr [pr-number] --focus [security|performance|types|tests]
/review-pr [pr-number] --final-check
```

## Review Architecture

### Multi-Source Review Aggregation

```typescript
interface ReviewSource {
  name: string;
  type: 'ai' | 'human' | 'automated';
  severity: 'error' | 'warning' | 'suggestion' | 'note';
  confidence: number;
}

class ReviewAggregator {
  async collectAllReviews(prNumber: number): Promise<AggregatedReviews> {
    const reviews = {
      github: await this.getGitHubReviews(prNumber),
      aiReviewers: await this.getAIReviewerComments(prNumber),
      automated: await this.getAutomatedChecks(prNumber),
      human: await this.getHumanReviews(prNumber),
    };

    // Deduplicate similar feedback
    const deduplicated = this.deduplicateReviews(reviews);

    // Prioritize by severity and confidence
    const prioritized = this.prioritizeReviews(deduplicated);

    // Identify conflicts
    const conflicts = this.identifyConflicts(reviews);

    return {
      reviews: prioritized,
      conflicts,
      summary: this.generateSummary(prioritized),
      actionItems: this.extractActionItems(prioritized),
    };
  }

  private deduplicateReviews(reviews: AllReviews): Review[] {
    const seen = new Map<string, Review>();

    Object.values(reviews)
      .flat()
      .forEach((review) => {
        const key = this.generateReviewKey(review);
        const existing = seen.get(key);

        if (!existing || review.confidence > existing.confidence) {
          seen.set(key, review);
        }
      });

    return Array.from(seen.values());
  }

  private identifyConflicts(reviews: AllReviews): Conflict[] {
    const conflicts = [];

    // Check for contradictory suggestions
    reviews.forEach((review1, i) => {
      reviews.slice(i + 1).forEach((review2) => {
        if (this.areConflicting(review1, review2)) {
          conflicts.push({
            review1,
            review2,
            resolution: this.suggestResolution(review1, review2),
          });
        }
      });
    });

    return conflicts;
  }
}
```

## Phase 1: Collect Reviews

```typescript
class ReviewCollector {
  async execute(prNumber: number): Promise<CollectedReviews> {
    console.log(`\n🔍 Collecting reviews for PR #${prNumber}`);

    // 1. GitHub native reviews
    const githubReviews = await this.collectGitHubReviews(prNumber);
    console.log(`  ✓ GitHub reviews: ${githubReviews.length}`);

    // 2. AI reviewer comments (CodeRabbit, Qodo, etc.)
    const aiReviews = await this.collectAIReviews(prNumber);
    console.log(`  ✓ AI reviews: ${aiReviews.length}`);

    // 3. CI/CD check results
    const ciChecks = await this.collectCIChecks(prNumber);
    console.log(`  ✓ CI checks: ${ciChecks.length}`);

    // 4. Security scanning results
    const securityScans = await this.collectSecurityScans(prNumber);
    console.log(`  ✓ Security scans: ${securityScans.length}`);

    // 5. Performance analysis
    const perfAnalysis = await this.collectPerformanceAnalysis(prNumber);
    console.log(`  ✓ Performance checks: ${perfAnalysis.length}`);

    return {
      github: githubReviews,
      ai: aiReviews,
      ci: ciChecks,
      security: securityScans,
      performance: perfAnalysis,
      total:
        githubReviews.length +
        aiReviews.length +
        ciChecks.length +
        securityScans.length +
        perfAnalysis.length,
    };
  }

  private async collectAIReviews(prNumber: number): Promise<AIReview[]> {
    const reviews = [];

    // Parse CodeRabbit comments
    const codeRabbitComments = await this.getCommentsFromBot(
      'coderabbitai',
      prNumber
    );
    reviews.push(...this.parseCodeRabbitReviews(codeRabbitComments));

    // Parse Qodo reviews
    const qodoComments = await this.getCommentsFromBot(
      'qodo-merge-pro',
      prNumber
    );
    reviews.push(...this.parseQodoReviews(qodoComments));

    // Parse other AI reviewers
    const otherAI = await this.getOtherAIReviews(prNumber);
    reviews.push(...otherAI);

    return reviews;
  }
}
```

## Phase 2: Analyze & Categorize

```typescript
class ReviewAnalyzer {
  async analyze(reviews: CollectedReviews): Promise<AnalyzedReviews> {
    console.log('\n📊 Analyzing collected reviews...');

    const categorized = {
      mustFix: [], // Blocking issues
      shouldFix: [], // Important but not blocking
      consider: [], // Suggestions to consider
      nitpicks: [], // Style/preference issues
      praise: [], // Positive feedback
    };

    // Categorize each review
    for (const review of this.flattenReviews(reviews)) {
      const category = this.categorizeReview(review);
      categorized[category].push(review);
    }

    // Group by file/component
    const byFile = this.groupByFile(categorized);

    // Identify patterns
    const patterns = this.identifyPatterns(categorized);

    // Calculate fix complexity
    const complexity = this.calculateFixComplexity(categorized);

    return {
      categorized,
      byFile,
      patterns,
      complexity,
      stats: {
        total: this.countTotal(categorized),
        blocking: categorized.mustFix.length,
        important: categorized.shouldFix.length,
        suggestions: categorized.consider.length,
      },
    };
  }

  private categorizeReview(review: Review): Category {
    // Blocking issues
    if (
      review.severity === 'error' ||
      review.type === 'security' ||
      review.message.match(/must|required|breaking|critical/i)
    ) {
      return 'mustFix';
    }

    // Important issues
    if (
      review.severity === 'warning' ||
      review.type === 'performance' ||
      review.message.match(/should|recommend|important/i)
    ) {
      return 'shouldFix';
    }

    // Style/preference
    if (
      review.type === 'style' ||
      review.message.match(/consider|perhaps|maybe|nit:/i)
    ) {
      return 'nitpicks';
    }

    // Positive feedback
    if (review.message.match(/good|great|excellent|nice|lgtm/i)) {
      return 'praise';
    }

    return 'consider';
  }
}
```

## Phase 3: Auto-Fix Implementation

```typescript
class AutoFixer {
  async applyFixes(
    analysis: AnalyzedReviews,
    options: AutoFixOptions
  ): Promise<FixResult> {
    console.log('\n🔧 Applying automatic fixes...');

    const fixes = [];
    const skipped = [];

    // Priority order: mustFix > shouldFix > consider
    const reviewsToFix = [
      ...analysis.categorized.mustFix,
      ...(options.includeSuggestions ? analysis.categorized.shouldFix : []),
      ...(options.includeNitpicks ? analysis.categorized.consider : []),
    ];

    for (const review of reviewsToFix) {
      console.log(`\n  Fixing: ${review.message.substring(0, 60)}...`);

      try {
        const fix = await this.attemptFix(review);

        if (fix.success) {
          fixes.push(fix);
          console.log(`    ✅ Fixed successfully`);
        } else {
          skipped.push({ review, reason: fix.reason });
          console.log(`    ⏭️ Skipped: ${fix.reason}`);
        }
      } catch (error) {
        skipped.push({ review, reason: error.message });
        console.log(`    ❌ Failed: ${error.message}`);
      }
    }

    // Verify fixes don't break tests
    if (fixes.length > 0) {
      await this.verifyFixes(fixes);
    }

    return { fixes, skipped };
  }

  private async attemptFix(review: Review): Promise<Fix> {
    // Determine fix strategy based on review type
    const strategy = this.selectFixStrategy(review);

    switch (strategy) {
      case 'type-fix':
        return this.fixTypeError(review);

      case 'lint-fix':
        return this.fixLintIssue(review);

      case 'import-fix':
        return this.fixImportIssue(review);

      case 'test-fix':
        return this.fixTestIssue(review);

      case 'security-fix':
        return this.fixSecurityIssue(review);

      case 'performance-fix':
        return this.fixPerformanceIssue(review);

      case 'documentation-fix':
        return this.fixDocumentationIssue(review);

      default:
        return { success: false, reason: 'No automatic fix available' };
    }
  }

  private async fixTypeError(review: Review): Promise<Fix> {
    const file = review.file;
    const line = review.line;

    // Read file
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');

    // Apply type fix
    if (review.suggestion) {
      lines[line - 1] = review.suggestion;
      await fs.writeFile(file, lines.join('\n'));

      // Verify TypeScript compiles
      const result = await exec('npx tsc --noEmit');

      return {
        success: result.success,
        file,
        line,
        original: content.split('\n')[line - 1],
        fixed: review.suggestion,
      };
    }

    return { success: false, reason: 'No suggestion provided' };
  }
}
```

## Phase 4: Conflict Resolution

```typescript
class ConflictResolver {
  async resolveConflicts(conflicts: Conflict[]): Promise<Resolution[]> {
    console.log('\n⚖️ Resolving review conflicts...');

    const resolutions = [];

    for (const conflict of conflicts) {
      console.log(`\n  Conflict: ${conflict.description}`);
      console.log(`    Option 1: ${conflict.review1.message}`);
      console.log(`    Option 2: ${conflict.review2.message}`);

      const resolution = await this.resolveConflict(conflict);
      resolutions.push(resolution);

      console.log(`    ✓ Resolution: ${resolution.decision}`);
    }

    return resolutions;
  }

  private async resolveConflict(conflict: Conflict): Promise<Resolution> {
    // Resolution priority rules
    const priorities = {
      security: 10,
      'breaking-change': 9,
      performance: 8,
      'type-safety': 7,
      'test-coverage': 6,
      'code-quality': 5,
      style: 3,
      preference: 1,
    };

    const priority1 = this.calculatePriority(conflict.review1, priorities);
    const priority2 = this.calculatePriority(conflict.review2, priorities);

    if (priority1 > priority2) {
      return {
        chosen: conflict.review1,
        rejected: conflict.review2,
        decision: `Chose ${conflict.review1.source} (higher priority: ${priority1} vs ${priority2})`,
        reason: 'Higher priority issue type',
      };
    } else if (priority2 > priority1) {
      return {
        chosen: conflict.review2,
        rejected: conflict.review1,
        decision: `Chose ${conflict.review2.source} (higher priority: ${priority2} vs ${priority1})`,
        reason: 'Higher priority issue type',
      };
    } else {
      // Same priority - use confidence score
      return this.resolveByConfidence(conflict);
    }
  }
}
```

## Phase 5: Generate Fix Commits

```typescript
class FixCommitter {
  async createFixCommits(fixes: Fix[]): Promise<CommitResult> {
    console.log('\n📝 Creating fix commits...');

    // Group fixes by type for logical commits
    const grouped = this.groupFixesByType(fixes);

    const commits = [];

    for (const [type, groupFixes] of Object.entries(grouped)) {
      if (groupFixes.length === 0) continue;

      // Stage files
      const files = groupFixes.map((f) => f.file);
      await exec(`git add ${files.join(' ')}`);

      // Create commit message
      const message = this.generateCommitMessage(type, groupFixes);

      // Commit
      await exec(`git commit -m "${message}"`);
      commits.push({ type, message, files: files.length });

      console.log(`  ✓ Committed ${type} fixes (${files.length} files)`);
    }

    // Push all commits
    await exec('git push');

    return { commits, total: fixes.length };
  }

  private generateCommitMessage(type: string, fixes: Fix[]): string {
    const templates = {
      type: 'fix(types): resolve TypeScript errors from review',
      lint: 'style: fix linting issues',
      test: 'test: improve test coverage and fix failing tests',
      security: 'fix(security): address security vulnerabilities',
      performance: 'perf: optimize performance based on review',
      documentation: 'docs: update documentation per review feedback',
    };

    const message = templates[type] || `fix: address ${type} review feedback`;

    // Add details
    const details = fixes
      .slice(0, 5)
      .map((f) => `- ${f.file}: ${f.description || 'Fixed issue'}`)
      .join('\n');

    return `${message}\n\n${details}`;
  }
}
```

## Phase 6: Final Validation

```typescript
class FinalValidator {
  async validate(prNumber: number): Promise<ValidationResult> {
    console.log('\n✅ Running final validation...');

    const checks = {
      allReviewsAddressed: await this.checkAllReviewsAddressed(prNumber),
      testsPass: await this.checkTestsPass(),
      ciGreen: await this.checkCIStatus(prNumber),
      noNewIssues: await this.checkNoNewIssues(prNumber),
      codeQuality: await this.checkCodeQuality(),
      documentation: await this.checkDocumentation(),
      readyToMerge: false,
    };

    checks.readyToMerge = Object.values(checks).every((v) => v === true);

    return checks;
  }

  private async checkAllReviewsAddressed(prNumber: number): Promise<boolean> {
    const unresolvedThreads = await exec(
      `gh pr view ${prNumber} --json reviews --jq '.reviews[] | select(.state == "CHANGES_REQUESTED")'`
    );

    return unresolvedThreads.length === 0;
  }

  private async checkCIStatus(prNumber: number): Promise<boolean> {
    const checks = await exec(
      `gh pr checks ${prNumber} --json status --jq '.[] | select(.status != "COMPLETED" or .conclusion != "SUCCESS")'`
    );

    return checks.length === 0;
  }
}
```

## Phase 7: Generate Report

```typescript
class ReviewReporter {
  async generateReport(
    prNumber: number,
    analysis: AnalyzedReviews,
    fixes: FixResult,
    validation: ValidationResult
  ): Promise<string> {
    const report = `
# PR Review Report - #${prNumber}

## 📊 Review Summary
- Total feedback items: ${analysis.stats.total}
- Blocking issues: ${analysis.stats.blocking}
- Important issues: ${analysis.stats.important}
- Suggestions: ${analysis.stats.suggestions}

## 🔧 Automatic Fixes Applied
- Successfully fixed: ${fixes.fixes.length}
- Skipped: ${fixes.skipped.length}
${this.formatFixes(fixes.fixes)}

## ⏭️ Items Requiring Manual Attention
${this.formatSkipped(fixes.skipped)}

## ✅ Validation Status
${this.formatValidation(validation)}

## 📈 Code Quality Metrics
${await this.generateQualityMetrics()}

## 🎯 Next Steps
${this.generateNextSteps(validation)}

## 📝 Review Comments Addressed
${await this.generateAddressedComments(prNumber)}

---
Generated at: ${new Date().toISOString()}
`;

    // Save report
    await fs.writeFile(`.claude/reviews/pr-${prNumber}-review.md`, report);

    // Add comment to PR
    await exec(
      `gh pr comment ${prNumber} --body "${this.generatePRComment(analysis, fixes, validation)}"`
    );

    return report;
  }

  private generatePRComment(
    analysis: AnalyzedReviews,
    fixes: FixResult,
    validation: ValidationResult
  ): string {
    const emoji = validation.readyToMerge ? '✅' : '🔄';
    const status = validation.readyToMerge
      ? 'Ready to merge'
      : 'Needs attention';

    return `${emoji} **Claude Code Review Update**

**Status**: ${status}

**Summary**:
- Addressed ${fixes.fixes.length} review items automatically
- ${fixes.skipped.length} items need manual review
- All tests passing: ${validation.testsPass ? '✅' : '❌'}
- CI checks green: ${validation.ciGreen ? '✅' : '❌'}

${
  fixes.skipped.length > 0
    ? `
**Manual attention needed**:
${fixes.skipped
  .slice(0, 3)
  .map((s) => `- ${s.review.message.substring(0, 60)}...`)
  .join('\n')}
`
    : ''
}

${validation.readyToMerge ? '**This PR is ready to merge!** 🎉' : '**Please address remaining items.**'}

View full report: [Review Report](.claude/reviews/pr-${prNumber}-review.md)
`;
  }
}
```

## Success Output

```markdown
✅ PR Review Complete!

📊 Review Analysis:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total feedback items: 47

- Must fix: 3 (all addressed ✅)
- Should fix: 12 (10 addressed ✅)
- Suggestions: 20 (5 applied)
- Style issues: 12 (auto-fixed ✅)

🔧 Automatic Fixes:

- Type errors fixed: 3
- Lint issues resolved: 12
- Tests updated: 2
- Documentation added: 4
- Performance optimizations: 1

⏭️ Manual Review Required:

1. Complex refactoring suggestion (line 145-200)
2. Architecture discussion needed

✅ Validation Results:

- All tests passing: ✅
- Type check clean: ✅
- Lint check clean: ✅
- Security scan clean: ✅
- CI/CD green: ✅
- Code coverage: 94% (✅ above threshold)

📝 Commits Created:

1. fix(types): resolve TypeScript errors from review
2. style: fix linting issues
3. test: improve test coverage
4. docs: update documentation per review feedback

🎯 PR Status: READY TO MERGE

Next command:
/merge-pr [pr-number]
```

## Error Handling

```typescript
class ReviewErrorHandler {
  async handle(error: Error, context: ReviewContext): Promise<void> {
    if (error.message.includes('rate limit')) {
      console.log('⏳ API rate limit reached. Waiting...');
      await this.wait(60000);
      return this.retry(context);
    }

    if (error.message.includes('merge conflict')) {
      console.log('⚠️ Merge conflict detected. Attempting to resolve...');
      await this.resolveMergeConflict(context.prNumber);
      return this.retry(context);
    }

    if (error.message.includes('test failure')) {
      console.log('❌ Tests failing after fixes. Rolling back...');
      await this.rollbackFixes(context);
      throw new Error(
        'Unable to fix without breaking tests. Manual intervention required.'
      );
    }

    console.error('❌ Unexpected error:', error.message);
    await this.saveErrorContext(context, error);
  }
}
```

## Configuration

```yaml
# .claude/config/review-pr.yaml
review_pr:
  sources:
    github_reviews: true
    ai_reviewers:
      - coderabbit
      - qodo
      - deepcode
    ci_checks: true
    security_scans: true

  auto_fix:
    enabled: true
    include_suggestions: true
    include_style: true
    create_commits: true

  conflict_resolution:
    priority_order:
      - security
      - breaking_changes
      - performance
      - type_safety
      - tests
      - code_quality
      - style

  validation:
    require_all_addressed: false
    require_ci_green: true
    require_tests_pass: true
    min_coverage: 80

  reporting:
    add_pr_comment: true
    save_report: true
    notify_on_ready: true
```

## Integration Points

This command integrates with:

- `/work` - Follows this command to review generated PRs
- `/merge-pr` - Next step after successful review and fixes
- `/sync-github-mapping` - Can update mapping if PR scope differs from issue
- GitHub Actions - Aggregates CI/CD results
- External reviewers - Consolidates AI and human feedback
