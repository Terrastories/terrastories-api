# Command: /merge-pr

## Purpose

Safely merge a pull request after final validation, update project tracking, and intelligently suggest next development steps based on project context.

## Usage

```
/merge-pr [pr-number]
/merge-pr [pr-number] --strategy [merge|squash|rebase]
/merge-pr [pr-number] --deploy [staging|production]
/merge-pr [pr-number] --no-delete-branch
```

## Pre-Merge Validation

```typescript
interface PreMergeValidator {
  async validate(prNumber: number): Promise<MergeReadiness> {
    console.log(`\n🔍 Validating PR #${prNumber} for merge...`);

    const checks = {
      // Required checks
      required: {
        allChecksPass: await this.verifyAllChecksPass(prNumber),
        approved: await this.verifyApproved(prNumber),
        upToDate: await this.verifyUpToDate(prNumber),
        noConflicts: await this.verifyNoConflicts(prNumber),
        testsPass: await this.verifyTestsPass(prNumber)
      },

      // Quality checks
      quality: {
        coverageMaintained: await this.verifyCoverage(prNumber),
        performanceOk: await this.verifyPerformance(prNumber),
        noSecurityIssues: await this.verifySecurityClean(prNumber),
        documentationUpdated: await this.verifyDocsUpdated(prNumber)
      },

      // Process checks
      process: {
        linkedIssue: await this.verifyLinkedIssue(prNumber),
        changelogUpdated: await this.verifyChangelog(prNumber),
        reviewsAddressed: await this.verifyReviewsAddressed(prNumber)
      }
    };

    const readyToMerge = Object.values(checks.required).every(v => v === true);
    const warnings = this.generateWarnings(checks.quality, checks.process);

    return {
      ready: readyToMerge,
      checks,
      warnings,
      blockingIssues: this.getBlockingIssues(checks.required)
    };
  }

  private async verifyAllChecksPass(prNumber: number): Promise<boolean> {
    const checks = await exec(`gh pr checks ${prNumber} --json`);
    const parsed = JSON.parse(checks);

    const failing = parsed.filter(check =>
      check.status === 'COMPLETED' && check.conclusion !== 'SUCCESS'
    );

    if (failing.length > 0) {
      console.log(`  ❌ CI checks failing: ${failing.map(c => c.name).join(', ')}`);
      return false;
    }

    console.log('  ✅ All CI checks passing');
    return true;
  }

  private async verifyApproved(prNumber: number): Promise<boolean> {
    const reviews = await exec(`gh pr view ${prNumber} --json reviews`);
    const parsed = JSON.parse(reviews);

    const approvals = parsed.reviews.filter(r => r.state === 'APPROVED');
    const changesRequested = parsed.reviews.filter(r => r.state === 'CHANGES_REQUESTED');

    if (changesRequested.length > 0) {
      console.log(`  ❌ Changes requested by: ${changesRequested.map(r => r.author.login).join(', ')}`);
      return false;
    }

    if (approvals.length === 0) {
      console.log('  ❌ No approvals yet');
      return false;
    }

    console.log(`  ✅ Approved by: ${approvals.map(r => r.author.login).join(', ')}`);
    return true;
  }
}
```

## Phase 1: Merge Strategy Selection

```typescript
class MergeStrategySelector {
  async selectStrategy(
    prNumber: number,
    preferredStrategy?: string
  ): Promise<MergeStrategy> {
    if (preferredStrategy) {
      return preferredStrategy as MergeStrategy;
    }

    const prInfo = await this.getPRInfo(prNumber);
    const commits = await this.getCommits(prNumber);

    // Auto-select strategy based on PR characteristics
    if (commits.length === 1) {
      return 'squash'; // Single commit - squash is clean
    }

    if (this.hasLogicalCommitHistory(commits)) {
      return 'merge'; // Preserve meaningful history
    }

    if (prInfo.labels.includes('hotfix')) {
      return 'rebase'; // Clean linear history for hotfixes
    }

    // Default to squash for clean history
    return 'squash';
  }

  private hasLogicalCommitHistory(commits: Commit[]): boolean {
    // Check if commits follow conventional commits
    const conventionalCommits = commits.filter((c) =>
      /^(feat|fix|docs|style|refactor|test|chore)(\(.+\))?:/.test(c.message)
    );

    // If most commits are well-structured, preserve history
    return conventionalCommits.length / commits.length > 0.8;
  }
}
```

## Phase 2: Execute Merge

```typescript
class MergeExecutor {
  async execute(
    prNumber: number,
    strategy: MergeStrategy,
    validation: MergeReadiness
  ): Promise<MergeResult> {
    if (!validation.ready) {
      throw new Error(`Cannot merge: ${validation.blockingIssues.join(', ')}`);
    }

    console.log(`\n🔀 Merging PR #${prNumber} using ${strategy} strategy...`);

    // Generate merge commit message
    const commitMessage = await this.generateMergeMessage(prNumber);

    // Execute merge
    const mergeResult = await this.performMerge(
      prNumber,
      strategy,
      commitMessage
    );

    // Get merge commit SHA
    const mergeSha = await this.getMergeCommitSha(mergeResult);

    // Tag if needed
    if (await this.shouldTag(prNumber)) {
      await this.createTag(mergeSha, prNumber);
    }

    // Delete branch if configured
    if (this.shouldDeleteBranch()) {
      await this.deleteBranch(prNumber);
    }

    return {
      sha: mergeSha,
      strategy,
      timestamp: new Date().toISOString(),
      prNumber,
    };
  }

  private async performMerge(
    prNumber: number,
    strategy: MergeStrategy,
    message: string
  ): Promise<string> {
    const commands = {
      merge: `gh pr merge ${prNumber} --merge --body "${message}"`,
      squash: `gh pr merge ${prNumber} --squash --body "${message}"`,
      rebase: `gh pr merge ${prNumber} --rebase`,
    };

    return await exec(commands[strategy]);
  }

  private async generateMergeMessage(prNumber: number): Promise<string> {
    const pr = await this.getPRDetails(prNumber);
    const issue = await this.getLinkedIssue(prNumber);

    return `Merge PR #${prNumber}: ${pr.title}

${pr.body}

Closes #${issue.number}
Co-authored-by: ${pr.reviewers.join(', ')}`;
  }
}
```

## Phase 3: Post-Merge Actions

```typescript
class PostMergeActions {
  async execute(mergeResult: MergeResult): Promise<void> {
    console.log('\n📋 Executing post-merge actions...');

    // 1. Update issue status
    await this.closeLinkedIssues(mergeResult.prNumber);

    // 2. Update project boards
    await this.updateProjectBoards(mergeResult.prNumber);

    // 3. Update ROADMAP.md and ISSUES_ROADMAP.md
    await this.updateRoadmap(mergeResult.prNumber);
    await this.updateIssuesRoadmap(mergeResult.prNumber);

    // 4. Generate release notes
    await this.updateReleaseNotes(mergeResult);

    // 5. Trigger deployments if configured
    await this.triggerDeployments(mergeResult);

    // 6. Update metrics
    await this.updateMetrics(mergeResult);

    // 7. Clean up work session
    await this.archiveWorkSession(mergeResult.prNumber);
  }

  private async closeLinkedIssues(prNumber: number): Promise<void> {
    const linkedIssues = await this.getLinkedIssues(prNumber);

    for (const issue of linkedIssues) {
      await exec(
        `gh issue close ${issue.number} --comment "Resolved in PR #${prNumber}"`
      );
      console.log(`  ✓ Closed issue #${issue.number}`);
    }
  }

  private async updateRoadmap(prNumber: number): Promise<void> {
    const roadmap = await fs.readFile('ROADMAP.md', 'utf-8');
    const pr = await this.getPRDetails(prNumber);

    // Find and mark item as complete
    const updated = roadmap.replace(
      new RegExp(`- \\[ \\] (.*${pr.relatedRoadmapItem}.*)`, 'g'),
      `- [x] $1 ✅ (PR #${prNumber})`
    );

    await fs.writeFile('ROADMAP.md', updated);
    console.log('  ✓ Updated ROADMAP.md');
  }

  private async updateIssuesRoadmap(prNumber: number): Promise<void> {
    const issuesRoadmap = await fs.readFile('docs/ISSUES_ROADMAP.md', 'utf-8');
    const pr = await this.getPRDetails(prNumber);
    const linkedIssues = await this.getLinkedIssues(prNumber);

    let updated = issuesRoadmap;

    // For each linked issue, mark it as completed in the roadmap
    for (const issue of linkedIssues) {
      const issuePattern = new RegExp(
        `### Issue #${issue.number}:([^#]+?)(?=###|##|$)`,
        'gs'
      );

      updated = updated.replace(issuePattern, (match, content) => {
        // Skip if already marked as completed
        if (match.includes('✅ **COMPLETED**')) {
          return match;
        }

        // Add ✅ to the title line
        const titleMatch = match.match(/### Issue #\d+: (.+)/);
        if (!titleMatch) return match;

        const title = titleMatch[1];
        const completedStatus = `
**Status**: ✅ **COMPLETED** in PR #${prNumber} (Issue #${issue.number})
- ${pr.title}
- Merged: ${new Date(pr.mergedAt).toLocaleDateString()}
- ${this.extractKeyFeatures(pr.body).join('\n- ')}
`;

        // Insert completion status after the description, before next issue/section
        const updatedMatch = match
          .replace(/### Issue #(\d+): (.+)/, `### Issue #$1: $2 ✅`)
          .replace(/(\n\n)(### Issue #|\## Phase)/, `${completedStatus}$1$2`);

        return updatedMatch;
      });
    }

    await fs.writeFile('docs/ISSUES_ROADMAP.md', updated);
    console.log(
      `  ✓ Updated ISSUES_ROADMAP.md for issues: ${linkedIssues.map((i) => `#${i.number}`).join(', ')}`
    );
  }

  private extractKeyFeatures(prBody: string): string[] {
    // Extract bullet points from PR description
    const features = [];
    const bulletMatches = prBody.match(/^- .+$/gm) || [];

    // Take first 3 most meaningful bullet points
    const meaningfulBullets = bulletMatches
      .filter(
        (bullet) =>
          !bullet.includes('Closes #') && !bullet.includes('Generated with')
      )
      .slice(0, 3);

    return meaningfulBullets.length > 0
      ? meaningfulBullets
      : ['Implementation completed successfully'];
  }
}
```

## Phase 4: Next Steps Analysis

```typescript
class NextStepsAnalyzer {
  async analyzeNextSteps(mergeResult: MergeResult): Promise<NextSteps> {
    console.log('\n🎯 Analyzing next steps...');

    // Gather context
    const context = {
      openIssues: await this.getOpenIssues(),
      openPRs: await this.getOpenPRs(),
      roadmap: await this.analyzeRoadmap(),
      recentMerges: await this.getRecentMerges(),
      teamVelocity: await this.calculateVelocity(),
      blockers: await this.identifyBlockers(),
    };

    // Analyze dependencies
    const unblocked = await this.findUnblockedWork(context, mergeResult);

    // Prioritize next work
    const priorities = await this.prioritizeWork(unblocked, context);

    // Generate recommendations
    const recommendations = this.generateRecommendations(priorities, context);

    return {
      immediate: recommendations.slice(0, 3),
      upcoming: recommendations.slice(3, 10),
      blocked: context.blockers,
      metrics: {
        velocity: context.teamVelocity,
        issuesOpen: context.openIssues.length,
        prsOpen: context.openPRs.length,
      },
    };
  }

  private async findUnblockedWork(
    context: Context,
    mergeResult: MergeResult
  ): Promise<WorkItem[]> {
    const unblocked = [];

    // Check if this merge unblocked any issues
    for (const issue of context.openIssues) {
      const dependencies = await this.getIssueDependencies(issue.number);

      if (dependencies.includes(mergeResult.prNumber)) {
        // This issue was blocked by the merged PR
        const remainingDeps = dependencies.filter(
          (d) => d !== mergeResult.prNumber
        );

        if (remainingDeps.length === 0) {
          unblocked.push({
            type: 'issue',
            number: issue.number,
            title: issue.title,
            priority: 'high', // Unblocked work is high priority
            reason: `Unblocked by PR #${mergeResult.prNumber}`,
          });
        }
      }
    }

    return unblocked;
  }

  private generateRecommendations(
    priorities: WorkItem[],
    context: Context
  ): Recommendation[] {
    return priorities
      .map((item) => {
        const recommendation: Recommendation = {
          action: this.determineAction(item),
          target: item,
          reasoning: this.explainReasoning(item, context),
          effort: this.estimateEffort(item, context),
          impact: this.assessImpact(item, context),
          command: this.getCommand(item),
        };

        return recommendation;
      })
      .sort((a, b) => {
        // Sort by impact/effort ratio
        const ratioA = a.impact / a.effort;
        const ratioB = b.impact / b.effort;
        return ratioB - ratioA;
      });
  }

  private getCommand(item: WorkItem): string {
    switch (item.type) {
      case 'issue':
        return `/work ${item.number}`;
      case 'pr':
        return `/review-pr ${item.number}`;
      case 'roadmap':
        return `/create-next-issue`;
      default:
        return '/create-next-issue';
    }
  }
}
```

## Phase 5: Generate Summary Report

```typescript
class MergeSummaryGenerator {
  async generate(
    mergeResult: MergeResult,
    nextSteps: NextSteps
  ): Promise<MergeSummary> {
    const pr = await this.getPRDetails(mergeResult.prNumber);
    const stats = await this.gatherStatistics(mergeResult);

    const summary = `
# 🎉 PR #${mergeResult.prNumber} Successfully Merged!

## 📊 Merge Summary
- **Title**: ${pr.title}
- **Strategy**: ${mergeResult.strategy}
- **Merge Commit**: ${mergeResult.sha}
- **Timestamp**: ${mergeResult.timestamp}

## 📈 Impact Metrics
- **Files Changed**: ${stats.filesChanged}
- **Lines Added**: +${stats.linesAdded}
- **Lines Removed**: -${stats.linesRemoved}
- **Test Coverage**: ${stats.coverageBefore}% → ${stats.coverageAfter}% (${stats.coverageDelta > 0 ? '+' : ''}${stats.coverageDelta}%)
- **Build Time**: ${stats.buildTime}s
- **Bundle Size**: ${stats.bundleSize} (${stats.bundleDelta > 0 ? '+' : ''}${stats.bundleDelta} bytes)

## ✅ Completed Actions
- Closed issue #${pr.closedIssues.join(', #')}
- Updated ROADMAP.md with progress markers
- Updated ISSUES_ROADMAP.md with completion status
- Generated release notes
- Archived work session
${pr.deployed ? `- Deployed to ${pr.deploymentEnv}` : ''}

## 🎯 Recommended Next Steps

### Immediate Priority
${nextSteps.immediate
  .map(
    (rec, i) => `
${i + 1}. **${rec.action}**: ${rec.target.title}
   - Reason: ${rec.reasoning}
   - Effort: ${rec.effort} hours
   - Impact: ${rec.impact}/10
   - Command: \`${rec.command}\`
`
  )
  .join('')}

### Upcoming Work
${nextSteps.upcoming
  .slice(0, 5)
  .map((rec, i) => `${i + 1}. ${rec.target.title} - \`${rec.command}\``)
  .join('\n')}

## 📊 Project Health
- **Open Issues**: ${nextSteps.metrics.issuesOpen}
- **Open PRs**: ${nextSteps.metrics.prsOpen}
- **Team Velocity**: ${nextSteps.metrics.velocity} points/sprint
- **Roadmap Progress**: ${await this.calculateRoadmapProgress()}%

## 🚀 Quick Actions
\`\`\`bash
# Start next high-priority issue
${nextSteps.immediate[0]?.command || '/create-next-issue'}

# Review open PRs
${nextSteps.metrics.prsOpen > 0 ? `/review-pr ${await this.getOldestPR()}` : '# No open PRs'}

# Create next issue from roadmap
/create-next-issue
\`\`\`

---
*Merge completed at ${new Date().toISOString()}*
`;

    // Save summary
    await fs.writeFile(
      `.claude/merges/pr-${mergeResult.prNumber}-summary.md`,
      summary
    );

    // Add comment to closed PR
    await exec(
      `gh pr comment ${mergeResult.prNumber} --body "${this.generatePRComment(mergeResult, nextSteps)}"`
    );

    return summary;
  }

  private generatePRComment(
    mergeResult: MergeResult,
    nextSteps: NextSteps
  ): string {
    return `✅ **Successfully merged!**

**Next recommended actions:**
${nextSteps.immediate
  .slice(0, 3)
  .map(
    (rec, i) =>
      `${i + 1}. ${rec.action}: ${rec.target.title} - \`${rec.command}\``
  )
  .join('\n')}

View full summary: [Merge Report](.claude/merges/pr-${mergeResult.prNumber}-summary.md)`;
  }
}
```

## Phase 6: Deployment Trigger

```typescript
class DeploymentManager {
  async handleDeployment(
    mergeResult: MergeResult,
    env?: string
  ): Promise<DeploymentResult> {
    if (!env) {
      env = await this.determineEnvironment(mergeResult);
    }

    console.log(`\n🚀 Triggering deployment to ${env}...`);

    // Create deployment
    const deployment = await this.createDeployment(mergeResult, env);

    // Monitor deployment
    const result = await this.monitorDeployment(deployment);

    if (result.success) {
      console.log(`  ✅ Successfully deployed to ${env}`);
      await this.notifyDeploymentSuccess(deployment);
    } else {
      console.log(`  ❌ Deployment failed`);
      await this.handleDeploymentFailure(deployment, result);
    }

    return result;
  }

  private async determineEnvironment(
    mergeResult: MergeResult
  ): Promise<string> {
    const pr = await this.getPRDetails(mergeResult.prNumber);

    if (pr.labels.includes('hotfix')) {
      return 'production';
    }

    if (pr.targetBranch === 'main') {
      return 'staging';
    }

    return 'development';
  }

  private async createDeployment(
    mergeResult: MergeResult,
    env: string
  ): Promise<Deployment> {
    return await exec(`gh api repos/{owner}/{repo}/deployments \
      --method POST \
      --field ref=${mergeResult.sha} \
      --field environment=${env} \
      --field description="Deploy PR #${mergeResult.prNumber}" \
      --field auto_merge=false`);
  }
}
```

## Success Output

```markdown
🎉 PR #123 Successfully Merged!

📊 Merge Summary:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Strategy: squash
Commit: abc123def
Closed Issues: #45, #46

📈 Code Metrics:

- Files: 12 changed
- Lines: +450 -120
- Coverage: 92% (+3%)
- Bundle: 245KB (-2KB)

✅ Post-Merge Actions:

- ✓ Issues closed
- ✓ ROADMAP updated
- ✓ Release notes generated
- ✓ Deployed to staging
- ✓ Metrics updated

🎯 RECOMMENDED NEXT STEPS:

1. 🔥 HIGH PRIORITY: Fix critical bug #48
   Unblocked by this merge
   Estimated: 2 hours
   Command: /work 48

2. 📝 Continue feature #49
   Next roadmap item
   Estimated: 1 day
   Command: /work 49

3. 👀 Review PR #122
   Waiting for review (2 days)
   Command: /review-pr 122

📊 Project Status:

- Roadmap Progress: 65% ████████░░░░
- Sprint Velocity: 34 points
- Open Issues: 12
- Open PRs: 3

🚀 Quick Start Next Task:
/work 48
```

## Error Handling

```typescript
class MergeErrorHandler {
  async handle(error: Error, context: MergeContext): Promise<void> {
    if (error.message.includes('not mergeable')) {
      console.log('❌ PR is not mergeable. Checking issues...');
      const issues = await this.diagnnoseMergeIssues(context.prNumber);

      console.log('\n🔧 Attempting automatic resolution...');
      for (const issue of issues) {
        await this.attemptResolution(issue, context);
      }

      // Retry merge
      return this.retryMerge(context);
    }

    if (error.message.includes('checks failing')) {
      console.log('❌ Required checks are failing');
      await this.displayFailingChecks(context.prNumber);
      throw new Error(
        'Cannot merge with failing checks. Fix issues and try again.'
      );
    }

    if (error.message.includes('deployment failed')) {
      console.log('⚠️ Merge succeeded but deployment failed');
      await this.handleDeploymentRollback(context);
    }

    console.error('❌ Unexpected error during merge:', error.message);
    await this.saveErrorContext(context, error);
  }
}
```

## Configuration

```yaml
# .claude/config/merge-pr.yaml
merge_pr:
  validation:
    require_approval: true
    min_approvals: 1
    require_ci_pass: true
    require_up_to_date: true

  merge_strategy:
    default: squash
    preserve_commits_for:
      - feature
      - release
    squash_for:
      - fix
      - chore
      - docs

  post_merge:
    close_issues: true
    delete_branch: true
    update_roadmap: true
    generate_release_notes: true

  deployment:
    auto_deploy: true
    environments:
      staging:
        branch: main
        auto: true
      production:
        branch: main
        auto: false
        require_approval: true

  next_steps:
    analyze_dependencies: true
    suggest_count: 5
    prioritize_by:
      - unblocked_work
      - roadmap_order
      - issue_age
      - impact_effort_ratio

  notifications:
    slack: true
    email: false
    github_comment: true
```

## Post-Merge Synchronization

After successful merge completion:

```bash
# Update roadmap progress and mapping alignment
/sync-issues-roadmap

# This ensures:
# - ISSUES_ROADMAP.md completion status is updated
# - GITHUB_ROADMAP_MAPPING.md reflects current states
# - Phase completion percentages are accurate
# - Roadmap timeline maintains accuracy
```

## Integration Points

This command integrates with:

- `/create-next-issue` - Suggests as next action
- `/work` - Recommends for high-priority issues
- `/review-pr` - Suggests for open PRs
- `/sync-issues-roadmap` - Updates roadmap progress after merge
- GitHub Actions - Triggers deployments
- Release Please - Updates changelogs
