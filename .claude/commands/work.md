# Command: /work

## Purpose

Execute the complete development workflow for an issue autonomously, with checkpoint saves and human confirmation at key decision points.

## Usage

```
/work [issue-number]
/work [issue-number] --resume-from [checkpoint]
/work [issue-number] --no-interactive
/work [issue-number] --fast-mode
```

## Workflow Architecture

### Checkpoint System

```typescript
interface WorkSession {
  issueNumber: number;
  startTime: Date;
  checkpoints: {
    analyze: CheckpointData;
    plan: CheckpointData;
    testFirst: CheckpointData;
    implement: CheckpointData;
    verify: CheckpointData;
    refactor: CheckpointData;
    commit: CheckpointData;
    pr: CheckpointData;
  };
  currentPhase: Phase;
  canResume: boolean;
}

class CheckpointManager {
  private sessionPath: string;

  constructor(issueNumber: number) {
    this.sessionPath = `.claude/work-sessions/issue-${issueNumber}`;
  }

  async saveCheckpoint(phase: Phase, data: any): Promise<void> {
    const checkpoint = {
      phase,
      timestamp: new Date().toISOString(),
      data,
      success: true,
      files: await this.captureFileState(),
      gitStatus: await this.captureGitStatus(),
    };

    await fs.writeFile(
      `${this.sessionPath}/checkpoint-${phase}.json`,
      JSON.stringify(checkpoint, null, 2)
    );
  }

  async canResume(phase: Phase): Promise<boolean> {
    const checkpointFile = `${this.sessionPath}/checkpoint-${phase}.json`;
    if (!(await fs.exists(checkpointFile))) return false;

    const checkpoint = JSON.parse(await fs.readFile(checkpointFile));
    const ageHours =
      (Date.now() - new Date(checkpoint.timestamp).getTime()) / 3600000;

    return ageHours < 24 && checkpoint.success;
  }
}
```

## Phase 1: ANALYZE

```typescript
class AnalyzePhase {
  async execute(issue: Issue): Promise<AnalysisResult> {
    console.log('🔍 Phase 1: Analyzing issue #' + issue.number);

    // 1. Parse requirements from issue
    const requirements = await this.parseRequirements(issue);

    // 2. Identify affected files
    const affectedFiles = await this.identifyAffectedFiles(requirements);

    // 3. Check existing patterns
    const patterns = await this.findExistingPatterns(affectedFiles);

    // 4. Identify dependencies
    const dependencies = await this.analyzeDependencies(affectedFiles);

    // 5. Risk assessment
    const risks = await this.assessRisks(requirements, affectedFiles);

    // Save checkpoint
    await this.checkpoint.save('analyze', {
      requirements,
      affectedFiles,
      patterns,
      dependencies,
      risks,
    });

    // Generate analysis report
    const report = this.generateAnalysisReport({
      requirements,
      affectedFiles,
      patterns,
      dependencies,
      risks,
    });

    console.log('\n📋 Analysis Complete:');
    console.log(report);

    return { requirements, affectedFiles, patterns, dependencies, risks };
  }

  private async identifyAffectedFiles(
    requirements: Requirements
  ): Promise<string[]> {
    const files = new Set<string>();

    // Search for files containing related keywords
    for (const keyword of requirements.keywords) {
      const searchResult = await exec(
        `grep -r "${keyword}" --include="*.ts" --include="*.tsx" src/ || true`
      );
      searchResult.split('\n').forEach((line) => {
        const file = line.split(':')[0];
        if (file) files.add(file);
      });
    }

    // Add test files
    Array.from(files).forEach((file) => {
      const testFile = file.replace(/\.(ts|tsx)$/, '.test.$1');
      if (fs.existsSync(testFile)) {
        files.add(testFile);
      }
    });

    return Array.from(files);
  }
}
```

## Phase 2: PLAN

```typescript
class PlanPhase {
  async execute(analysis: AnalysisResult): Promise<Plan> {
    console.log('\n📝 Phase 2: Creating implementation plan');

    // 1. Break down into subtasks
    const subtasks = await this.createSubtasks(analysis.requirements);

    // 2. Order by dependencies
    const orderedTasks = this.orderByDependencies(
      subtasks,
      analysis.dependencies
    );

    // 3. Estimate effort
    const estimates = await this.estimateEffort(orderedTasks);

    // 4. Create test strategy
    const testStrategy = await this.createTestStrategy(orderedTasks);

    // 5. Identify potential blockers
    const blockers = await this.identifyBlockers(orderedTasks, analysis);

    const plan = {
      subtasks: orderedTasks,
      estimates,
      testStrategy,
      blockers,
      totalEffortHours: estimates.reduce((sum, e) => sum + e.hours, 0),
    };

    // Save checkpoint
    await this.checkpoint.save('plan', plan);

    // Request human confirmation
    if (!this.options.noInteractive) {
      await this.requestPlanApproval(plan);
    }

    return plan;
  }

  private async requestPlanApproval(plan: Plan): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('📋 IMPLEMENTATION PLAN - APPROVAL REQUIRED');
    console.log('='.repeat(60));

    console.log('\n📌 Subtasks:');
    plan.subtasks.forEach((task, i) => {
      console.log(`  ${i + 1}. ${task.title} (${task.estimate}h)`);
    });

    console.log('\n🧪 Test Strategy:');
    console.log(`  - Unit Tests: ${plan.testStrategy.unitTests.length} files`);
    console.log(
      `  - Integration Tests: ${plan.testStrategy.integrationTests.length} scenarios`
    );
    console.log(`  - E2E Tests: ${plan.testStrategy.e2eTests.length} flows`);

    console.log(`\n⏱️ Total Estimated Effort: ${plan.totalEffortHours} hours`);

    if (plan.blockers.length > 0) {
      console.log('\n⚠️ Potential Blockers:');
      plan.blockers.forEach((b) => console.log(`  - ${b}`));
    }

    console.log('\n' + '='.repeat(60));
    console.log('Press ENTER to approve and continue, or Ctrl+C to abort...');

    // Wait for user input
    await this.waitForUserConfirmation();
  }
}
```

## Phase 3: TEST FIRST

```typescript
class TestFirstPhase {
  async execute(plan: Plan): Promise<TestResults> {
    console.log('\n🧪 Phase 3: Writing tests first (TDD)');

    const testResults = [];

    for (const subtask of plan.subtasks) {
      console.log(`\n  Writing tests for: ${subtask.title}`);

      // 1. Generate test file
      const testFile = await this.generateTestFile(subtask);

      // 2. Write comprehensive tests
      const tests = await this.writeTests(subtask, plan.testStrategy);

      // 3. Save test file
      await fs.writeFile(testFile.path, testFile.content);

      // 4. Run tests to verify they fail
      const result = await this.runTests(testFile.path);

      if (!result.failed) {
        throw new Error(
          `Tests should fail before implementation! Check: ${testFile.path}`
        );
      }

      testResults.push({
        subtask: subtask.id,
        testFile: testFile.path,
        tests: tests.length,
        status: 'failing_as_expected',
      });

      console.log(`    ✅ ${tests.length} tests written (failing as expected)`);
    }

    // Save checkpoint
    await this.checkpoint.save('test-first', testResults);

    return testResults;
  }

  private async writeTests(
    subtask: Subtask,
    strategy: TestStrategy
  ): Promise<Test[]> {
    const tests = [];

    // Unit tests
    tests.push(...this.generateUnitTests(subtask));

    // Integration tests if needed
    if (subtask.requiresIntegration) {
      tests.push(...this.generateIntegrationTests(subtask));
    }

    // Edge cases
    tests.push(...this.generateEdgeCaseTests(subtask));

    // Error handling
    tests.push(...this.generateErrorTests(subtask));

    // Type safety tests
    tests.push(...this.generateTypeTests(subtask));

    return tests;
  }
}
```

## Phase 4: IMPLEMENT

```typescript
class ImplementPhase {
  async execute(plan: Plan, tests: TestResults): Promise<Implementation> {
    console.log('\n💻 Phase 4: Implementing code to pass tests');

    const implementations = [];

    for (const subtask of plan.subtasks) {
      console.log(`\n  Implementing: ${subtask.title}`);

      // 1. Find corresponding test
      const test = tests.find((t) => t.subtask === subtask.id);

      // 2. Implement minimal code to pass
      const implementation = await this.implementMinimal(subtask, test);

      // 3. Save implementation
      await fs.writeFile(implementation.path, implementation.content);

      // 4. Run tests to verify they pass
      const result = await this.runTests(test.testFile);

      if (!result.passed) {
        // Retry with adjustments
        const adjusted = await this.adjustImplementation(
          implementation,
          result.errors
        );
        await fs.writeFile(implementation.path, adjusted.content);

        const retryResult = await this.runTests(test.testFile);
        if (!retryResult.passed) {
          throw new Error(
            `Failed to pass tests after implementation: ${test.testFile}`
          );
        }
      }

      implementations.push({
        subtask: subtask.id,
        file: implementation.path,
        testsPass: true,
        coverage: result.coverage,
      });

      console.log(`    ✅ Tests passing (coverage: ${result.coverage}%)`);
    }

    // Save checkpoint
    await this.checkpoint.save('implement', implementations);

    return implementations;
  }

  private async implementMinimal(
    subtask: Subtask,
    test: TestResult
  ): Promise<Implementation> {
    // Analyze test to understand requirements
    const testRequirements = await this.analyzeTest(test.testFile);

    // Generate minimal implementation
    const code = await this.generateCode(testRequirements, subtask);

    // Add proper types (no 'any')
    const typedCode = await this.addTypes(code);

    // Add error handling
    const safeCode = await this.addErrorHandling(typedCode);

    // Add Swagger documentation if this is a schema implementation
    if (this.isSchemaImplementation(subtask)) {
      await this.addSwaggerDocumentation(subtask);
    }

    return {
      path: this.getImplementationPath(subtask),
      content: safeCode,
    };
  }
}
```

## Phase 5: VERIFY

```typescript
class VerifyPhase {
  async execute(
    implementations: Implementation[]
  ): Promise<VerificationResult> {
    console.log('\n✅ Phase 5: Running verification suite');

    const results = {
      tests: await this.runAllTests(),
      typeCheck: await this.runTypeCheck(),
      lint: await this.runLint(),
      format: await this.runFormat(),
      build: await this.runBuild(),
      security: await this.runSecurityCheck(),
      coverage: await this.checkCoverage(),
    };

    // Save checkpoint
    await this.checkpoint.save('verify', results);

    // Display results
    this.displayResults(results);

    // Check if all passed
    const allPassed = Object.values(results).every((r) => r.success);

    if (!allPassed) {
      console.log('\n❌ Verification failed. Attempting fixes...');
      await this.attemptAutoFix(results);

      // Re-run verification
      return this.execute(implementations);
    }

    return results;
  }

  private async attemptAutoFix(results: VerificationResults): Promise<void> {
    if (!results.lint.success) {
      console.log('  Fixing lint issues...');
      await exec('npm run lint -- --fix');
    }

    if (!results.format.success) {
      console.log('  Fixing formatting...');
      await exec('npm run format');
    }

    if (!results.typeCheck.success) {
      console.log('  Attempting to fix type errors...');
      // Analyze type errors and attempt fixes
      await this.fixTypeErrors(results.typeCheck.errors);
    }
  }
}
```

## Phase 6: REFACTOR

```typescript
class RefactorPhase {
  async execute(
    verificationResult: VerificationResult
  ): Promise<RefactorResult> {
    console.log('\n🔧 Phase 6: Refactoring for quality');

    // 1. Identify refactoring opportunities
    const opportunities = await this.identifyOpportunities();

    // 2. Apply refactorings
    const refactorings = [];
    for (const opportunity of opportunities) {
      console.log(`  Refactoring: ${opportunity.description}`);

      const result = await this.applyRefactoring(opportunity);

      // Verify tests still pass
      const testResult = await this.runTests(opportunity.affectedFiles);

      if (!testResult.passed) {
        // Rollback refactoring
        await this.rollback(opportunity);
        console.log(`    ⚠️ Skipped (tests failed)`);
      } else {
        refactorings.push(result);
        console.log(`    ✅ Applied successfully`);
      }
    }

    // 3. Add documentation
    await this.addDocumentation();

    // 4. Create Swagger/OpenAPI documentation for schema implementations
    await this.addSwaggerDocumentation();

    // Save checkpoint
    await this.checkpoint.save('refactor', refactorings);

    return refactorings;
  }

  private async identifyOpportunities(): Promise<RefactorOpportunity[]> {
    return [
      ...(await this.findDuplicateCode()),
      ...(await this.findComplexFunctions()),
      ...(await this.findPoorNaming()),
      ...(await this.findMissingTypes()),
      ...(await this.findPerformanceIssues()),
    ];
  }

  private async addSwaggerDocumentation(): Promise<void> {
    console.log('  Adding Swagger/OpenAPI documentation...');

    // Check if current implementation involves database schemas
    const schemaFiles = await this.findSchemaFiles();

    for (const schemaFile of schemaFiles) {
      if (await this.isNewSchema(schemaFile)) {
        console.log(`    Creating Swagger docs for: ${schemaFile}`);

        // Create comprehensive Swagger schemas
        await this.createSwaggerSchemas(schemaFile);

        // Create comprehensive tests for Swagger schemas
        await this.createSwaggerTests(schemaFile);

        // Register with Fastify Swagger
        await this.registerWithFastify(schemaFile);

        console.log(`    ✅ Swagger documentation complete for ${schemaFile}`);
      }
    }
  }

  private async findSchemaFiles(): Promise<string[]> {
    // Look for new schema files in src/db/schema/
    const schemaFiles = await glob('src/db/schema/*.ts');
    return schemaFiles.filter((file) => !file.includes('index.ts'));
  }

  private async isNewSchema(schemaFile: string): Promise<boolean> {
    // Check if this is a newly created schema (not communities.ts or places.ts)
    const isExisting = ['communities.ts', 'places.ts'].some((existing) =>
      schemaFile.includes(existing)
    );
    return !isExisting;
  }

  private async createSwaggerSchemas(schemaFile: string): Promise<void> {
    const entityName = this.getEntityName(schemaFile);
    const swaggerFile = `src/shared/schemas/${entityName}.swagger.ts`;

    // Generate comprehensive Swagger schemas including:
    // - Entity schema with all properties and validation
    // - Create schema (without read-only fields)
    // - Update schema (all fields optional, excluding read-only)
    // - Response schemas (single and list with pagination)
    // - Error schemas (ValidationError, NotFoundError, ConflictError, etc.)
    // - Parameter definitions (path, query, pagination)
    // - Complete examples for all schemas

    await this.generateSwaggerSchemaFile(swaggerFile, entityName);
  }

  private async createSwaggerTests(schemaFile: string): Promise<void> {
    const entityName = this.getEntityName(schemaFile);
    const testFile = `tests/shared/schemas/${entityName}.swagger.test.ts`;

    // Generate comprehensive tests covering:
    // - Schema structure validation
    // - Property type validation
    // - Required field validation
    // - Parameter validation
    // - Example validation
    // - Error schema validation

    await this.generateSwaggerTestFile(testFile, entityName);
  }

  private async registerWithFastify(schemaFile: string): Promise<void> {
    // Update src/shared/schemas/index.ts to export new schemas
    // Update src/app.ts to register schemas with Fastify Swagger
    await this.updateSchemaIndex(schemaFile);
    await this.updateFastifyRegistration(schemaFile);
  }
}
```

## Phase 7: COMMIT

```typescript
class CommitPhase {
  async execute(issueNumber: number): Promise<CommitResult> {
    console.log('\n📦 Phase 7: Creating branch and committing changes');

    // 1. Create feature branch FIRST
    const branchName = `feature/issue-${issueNumber}`;
    await exec(
      `git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName}`
    );

    // 2. Stage files
    const files = await this.getModifiedFiles();
    await exec(`git add ${files.join(' ')}`);

    // 3. Generate commit message
    const message = await this.generateCommitMessage(issueNumber, files);

    // 4. Create commit
    await exec(`git commit -m "${message}"`);

    // 5. Push to remote
    await exec(`git push -u origin ${branchName}`);

    // Save checkpoint
    await this.checkpoint.save('commit', {
      branch: branchName,
      commit: await this.getLastCommitHash(),
      message,
    });

    console.log(`  ✅ Committed to branch: ${branchName}`);

    return { branch: branchName, message };
  }

  private async generateCommitMessage(
    issueNumber: number,
    files: string[]
  ): Promise<string> {
    const issue = await this.getIssue(issueNumber);
    const type = this.detectCommitType(issue, files);
    const scope = this.detectScope(files);

    return `${type}(${scope}): ${issue.title.toLowerCase()}

- ${issue.acceptanceCriteria
      .filter((ac) => ac.completed)
      .map((ac) => ac.text)
      .join('\n- ')}

Closes #${issueNumber}`;
  }
}
```

## Phase 8: PULL REQUEST

```typescript
class PullRequestPhase {
  async execute(
    issueNumber: number,
    commitResult: CommitResult
  ): Promise<PRResult> {
    console.log('\n🔀 Phase 8: Creating pull request');

    // 1. Generate PR body
    const body = await this.generatePRBody(issueNumber);

    // 2. Create PR
    const pr = await exec(`gh pr create \
      --title "Closes #${issueNumber}: ${await this.getIssueTitle(issueNumber)}" \
      --body "${body}" \
      --base main \
      --head ${commitResult.branch} \
      --assignee @me`);

    const prNumber = this.extractPRNumber(pr);

    // 3. Add labels
    await exec(`gh pr edit ${prNumber} --add-label "ready-for-review"`);

    // 4. Request reviews
    await this.requestReviews(prNumber);

    // Save checkpoint
    await this.checkpoint.save('pr', {
      number: prNumber,
      url: `https://github.com/${await this.getRepo()}/pull/${prNumber}`,
    });

    console.log(`  ✅ PR #${prNumber} created and ready for review`);

    return { number: prNumber, url: pr.url };
  }

  private async generatePRBody(issueNumber: number): Promise<string> {
    const session = await this.loadSession(issueNumber);

    return `## 📋 Summary
Implements requirements from #${issueNumber}

## ✅ Changes Made
${this.summarizeChanges(session)}

## 🧪 Test Coverage
- Unit Tests: ${session.verify.coverage.unit}%
- Integration Tests: ${session.verify.coverage.integration}%
- Overall: ${session.verify.coverage.total}%

## 📊 Performance Impact
${await this.analyzePerformanceImpact()}

## 🔍 Review Checklist
- [ ] Code follows project conventions
- [ ] Tests are comprehensive and passing
- [ ] Documentation is updated
- [ ] No security vulnerabilities introduced
- [ ] Performance is acceptable

## 📸 Screenshots/Demos
${await this.generateDemos()}

## 🔗 Related Issues
- Closes #${issueNumber}
${await this.findRelatedIssues(issueNumber)}`;
  }
}
```

## Session Management

```typescript
class WorkflowOrchestrator {
  async executeWorkflow(
    issueNumber: number,
    options: WorkflowOptions = {}
  ): Promise<void> {
    const sessionManager = new SessionManager(issueNumber);

    try {
      // Check for existing session
      if (options.resumeFrom) {
        await sessionManager.resume(options.resumeFrom);
      }

      // Execute phases in order
      const phases = [
        { name: 'analyze', executor: new AnalyzePhase() },
        { name: 'plan', executor: new PlanPhase() },
        { name: 'test-first', executor: new TestFirstPhase() },
        { name: 'implement', executor: new ImplementPhase() },
        { name: 'verify', executor: new VerifyPhase() },
        { name: 'refactor', executor: new RefactorPhase() },
        { name: 'commit', executor: new CommitPhase() },
        { name: 'pr', executor: new PullRequestPhase() },
      ];

      for (const phase of phases) {
        if (
          options.resumeFrom &&
          !this.shouldExecute(phase.name, options.resumeFrom)
        ) {
          console.log(`⏭️ Skipping ${phase.name} (already completed)`);
          continue;
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Starting ${phase.name.toUpperCase()} phase`);
        console.log('='.repeat(60));

        const result = await phase.executor.execute(
          sessionManager.getContext()
        );
        sessionManager.updateContext(phase.name, result);

        // Save session after each phase
        await sessionManager.save();
      }

      // Final success message
      this.displaySuccess(sessionManager.getContext());
    } catch (error) {
      console.error('\n❌ Workflow failed:', error.message);
      console.log('\n💾 Session saved. Resume with:');
      console.log(
        `/work ${issueNumber} --resume-from ${sessionManager.getCurrentPhase()}`
      );
      throw error;
    }
  }
}
```

## Success Output

```markdown
🎉 WORKFLOW COMPLETED SUCCESSFULLY!

📊 Summary for Issue #[number]:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏱️ Time Metrics:

- Total duration: 45 minutes
- Analysis: 5 min
- Planning: 3 min
- Test writing: 12 min
- Implementation: 15 min
- Verification: 5 min
- Refactoring: 3 min
- PR creation: 2 min

📈 Quality Metrics:

- Tests written: 24
- Test coverage: 92%
- Type coverage: 100%
- Lint issues: 0
- Security issues: 0

📝 Deliverables:

- Files modified: 8
- Lines added: 450
- Lines removed: 120
- Tests passing: 24/24

🔗 Pull Request:
PR #123: https://github.com/[owner]/[repo]/pull/123
Status: Ready for review
Reviewers requested: 2

🎯 Next Steps:

1. Wait for PR reviews
2. Address any feedback with: /review-pr 123
3. Once approved, merge with: /merge-pr 123

💾 Session archived to:
.claude/work-sessions/issue-[number]/completed.json
```

## Error Recovery

```typescript
class WorkflowErrorRecovery {
  async handleError(error: Error, context: WorkflowContext): Promise<void> {
    const recovery = {
      phase: context.currentPhase,
      error: error.message,
      timestamp: new Date().toISOString(),
      context: this.sanitizeContext(context),
    };

    // Save recovery information
    await fs.writeFile(
      `.claude/work-sessions/issue-${context.issueNumber}/recovery.json`,
      JSON.stringify(recovery, null, 2)
    );

    // Attempt automatic recovery
    if (this.canAutoRecover(error)) {
      console.log('🔄 Attempting automatic recovery...');
      await this.autoRecover(error, context);
    } else {
      // Provide manual recovery instructions
      console.log('\n📋 Manual Recovery Instructions:');
      console.log(this.getRecoveryInstructions(error, context));
    }
  }
}
```

## Configuration

```yaml
# .claude/config/work.yaml
work:
  phases:
    all_required: true
    allow_skip: false

  confirmation:
    plan_approval: true
    auto_approve_small_changes: false

  testing:
    minimum_coverage: 80
    require_tests_first: true
    allow_test_skip: false

  verification:
    strict_mode: true
    auto_fix: true
    max_fix_attempts: 3

  commits:
    conventional: true
    sign_commits: false

  pr:
    auto_assign: true
    request_reviews: true
    add_labels: true

  session:
    save_checkpoints: true
    checkpoint_ttl_hours: 24
    archive_completed: true
```

## Pre-Work Validation

Before starting work on any issue:

```bash
# Verify issue alignment with roadmap
/sync-github-mapping

# This ensures:
# - Issue exists in GITHUB_ROADMAP_MAPPING.md
# - Alignment status is verified (✅ ALIGNED, ⚠️ BROADER, ❌ MISMATCH)
# - No scope mismatches before implementation begins
```

## Integration Points

This command integrates with:

- `/create-next-issue` - Creates issues for this command to work on
- `/review-pr` - Follows this command for PR review
- `/merge-pr` - Completes the workflow after review
- `/sync-github-mapping` - Validates issue alignment before starting work
- `/sync-issues-roadmap` - Updates progress after work completion
