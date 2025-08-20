# Command: /merge-pr

# Command: /merge-pr

## 🚀 Command Summary

- **Purpose**: To safely merge a pull request after final validation, perform all post-merge updates, and suggest the next development steps.
- **Key Phases**: Pre-Merge Validation -> Merge Execution -> Post-Merge Actions -> Next Step Analysis.
- **Primary Outcome**: A merged pull request, updated documentation (roadmaps, issues), and a summary report with recommended next actions.

## 🤖 Prompt to Agent

## As the merge agent, your task is to execute the safe merging of the specified pull request. Follow the phases outlined in this document. First, perform all pre-merge validation checks. If they pass, execute the merge using the best strategy. After merging, perform all post-merge actions like closing issues and updating roadmaps. Finally, analyze the project state and generate a summary report that includes recommended next steps.

## Purpose

Safely merge a pull request after final validation, update project tracking, intelligently suggest next development steps based on project context, and trigger workflow improvements when needed.

## Usage

```
/merge-pr [pr-number]
/merge-pr [pr-number] --strategy [merge|squash|rebase]
/merge-pr [pr-number] --deploy [staging|production]
/merge-pr [pr-number] --no-delete-branch
/merge-pr [pr-number] --skip-workflow-improvement
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

    // 8. Check if workflow improvement should be triggered
    await this.checkWorkflowImprovement(mergeResult);
  }

  private async checkWorkflowImprovement(
    mergeResult: MergeResult
  ): Promise<void> {
    const mergeCount = await this.getMergeCount();
    const improvementConfig = await this.getWorkflowImprovementConfig();

    // Skip if disabled or flag set
    if (!improvementConfig.enabled || process.env.SKIP_WORKFLOW_IMPROVEMENT) {
      return;
    }

    // Check trigger conditions
    const shouldTrigger =
      mergeCount % improvementConfig.trigger_after_merges === 0 ||
      (await this.hasRepeatedIssues()) ||
      (await this.hasPerformanceDegradation());

    if (shouldTrigger) {
      console.log('\n🔧 Triggering workflow improvement analysis...');
      await this.triggerWorkflowImprovement(mergeResult);
    }
  }

  private async triggerWorkflowImprovement(
    mergeResult: MergeResult
  ): Promise<void> {
    try {
      // Record the merge that triggered improvement
      await this.recordImprovementTrigger(mergeResult);

      // Execute improvement analysis
      await exec('/improve-workflow --auto --trigger-source merge-pr');

      console.log('  ✅ Workflow improvement analysis completed');
    } catch (error) {
      console.log(`  ⚠️ Workflow improvement failed: ${error.message}`);
      // Don't fail the merge for workflow improvement issues
    }
  }

  private async hasRepeatedIssues(): Promise<boolean> {
    // Check last 5 merge sessions for repeated issues
    const recentSessions = await this.getRecentWorkSessions(5);
    const issuePatterns = [];

    for (const session of recentSessions) {
      if (session.issues && session.issues.length > 0) {
        issuePatterns.push(...session.issues);
      }
    }

    // Look for patterns that appear in 3+ sessions
    const issueCounts = {};
    issuePatterns.forEach((issue) => {
      const key = this.normalizeIssueKey(issue);
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    });

    return Object.values(issueCounts).some((count) => count >= 3);
  }

  private async hasPerformanceDegradation(): Promise<boolean> {
    const recentMetrics = await this.getRecentPerformanceMetrics(10);
    if (recentMetrics.length < 5) return false;

    // Check if average session time increased by >20%
    const recent = recentMetrics.slice(0, 5);
    const older = recentMetrics.slice(5, 10);

    const recentAvg =
      recent.reduce((sum, m) => sum + m.totalTime, 0) / recent.length;
    const olderAvg =
      older.reduce((sum, m) => sum + m.totalTime, 0) / older.length;

    return (recentAvg - olderAvg) / olderAvg > 0.2;
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
      workflowHealth: await this.assessWorkflowHealth(),
    };

    // Analyze dependencies
    const unblocked = await this.findUnblockedWork(context, mergeResult);

    // Prioritize next work
    const priorities = await this.prioritizeWork(unblocked, context);

    // Generate recommendations
    const recommendations = this.generateRecommendations(priorities, context);

    // Check if workflow improvement is needed
    const workflowRecommendation = this.checkWorkflowRecommendation(context);
    if (workflowRecommendation) {
      recommendations.unshift(workflowRecommendation);
    }

    return {
      immediate: recommendations.slice(0, 3),
      upcoming: recommendations.slice(3, 10),
      blocked: context.blockers,
      workflowHealth: context.workflowHealth,
      metrics: {
        velocity: context.teamVelocity,
        issuesOpen: context.openIssues.length,
        prsOpen: context.openPRs.length,
      },
    };
  }

  private checkWorkflowRecommendation(context: Context): Recommendation | null {
    const health = context.workflowHealth;

    // Recommend workflow improvement if health is degrading
    if (health.score < 0.7 || health.hasRepeatedIssues) {
      return {
        action: 'Improve Workflow',
        target: {
          type: 'workflow',
          title: 'Optimize development workflow',
          priority: 'high',
        },
        reasoning: `Workflow health score is ${Math.round(health.score * 100)}%. ${health.issues.join(', ')}`,
        effort: 0.5, // 30 minutes
        impact: 8, // High impact on future productivity
        command: '/improve-workflow',
      };
    }

    return null;
  }

  private async assessWorkflowHealth(): Promise<WorkflowHealth> {
    const recentSessions = await this.getRecentWorkSessions(10);
    const issues = [];
    let score = 1.0;

    // Check for repeated checkpoint recoveries
    const recoveryCount = recentSessions.filter((s) => s.hadRecovery).length;
    if (recoveryCount > 3) {
      issues.push('Frequent checkpoint recoveries');
      score -= 0.2;
    }

    // Check for slow session times
    const avgTime =
      recentSessions.reduce((sum, s) => sum + s.duration, 0) /
      recentSessions.length;
    const expectedTime = await this.getExpectedSessionTime();
    if (avgTime > expectedTime * 1.5) {
      issues.push('Sessions taking longer than expected');
      score -= 0.15;
    }

    // Check for repeated manual interventions
    const manualInterventions = recentSessions.filter(
      (s) => s.requiredManualIntervention
    ).length;
    if (manualInterventions > 5) {
      issues.push('Frequent manual interventions required');
      score -= 0.2;
    }

    // Check for test failures
    const testFailures = recentSessions.filter((s) => s.hadTestFailures).length;
    if (testFailures > 4) {
      issues.push('Recurring test failures');
      score -= 0.15;
    }

    return {
      score: Math.max(0, score),
      issues,
      hasRepeatedIssues: issues.length > 2,
      lastImprovement: await this.getLastImprovementDate(),
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
      case 'workflow':
        return '/improve-workflow';
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

    const workflowHealthSection = nextSteps.workflowHealth
      ? `
## 🔧 Workflow Health
- **Health Score**: ${Math.round(nextSteps.workflowHealth.score * 100)}%
- **Issues**: ${nextSteps.workflowHealth.issues.length > 0 ? nextSteps.workflowHealth.issues.join(', ') : 'None detected'}
- **Last Improvement**: ${nextSteps.workflowHealth.lastImprovement || 'Never'}
${nextSteps.workflowHealth.score < 0.7 ? '- **⚠️ Recommendation**: Run `/improve-workflow` to optimize performance' : ''}
`
      : '';

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
${stats.triggeredWorkflowImprovement ? '- Triggered workflow improvement analysis' : ''}

${workflowHealthSection}

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
- **Workflow Health**: ${Math.round((nextSteps.workflowHealth?.score || 1) * 100)}%

## 🚀 Quick Actions
\`\`\`bash
# Start next high-priority issue
${nextSteps.immediate[0]?.command || '/create-next-issue'}

# Review open PRs
${nextSteps.metrics.prsOpen > 0 ? `/review-pr ${await this.getOldestPR()}` : '# No open PRs'}

# Create next issue from roadmap
/create-next-issue

# Improve workflow (if health < 70%)
${(nextSteps.workflowHealth?.score || 1) < 0.7 ? '/improve-workflow' : '# Workflow health good'}
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
    const workflowWarning =
      nextSteps.workflowHealth && nextSteps.workflowHealth.score < 0.7
        ? '\n⚠️ **Workflow optimization recommended** - Run `/improve-workflow`\n'
        : '';

    return `✅ **Successfully merged!**
${workflowWarning}
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
┌──────────────────────────────────────┐
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
- ✓ Workflow improvement triggered

🔧 Workflow Health: 85
```
