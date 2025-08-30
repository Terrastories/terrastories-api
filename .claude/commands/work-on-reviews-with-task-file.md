# Command: /work-on-reviews-with-task-file

## Purpose

Analyzes PR review comments, issue comments, and general PR feedback to create a temporary TASK.md file for systematically tracking and addressing all feedback. Provides a clear checklist and plan for passing all reviews with full validation.

## Usage

```
/work-on-reviews-with-task-file [pr-number]
/work-on-reviews-with-task-file [pr-number] --reset-tracking
/work-on-reviews-with-task-file [pr-number] --show-progress
/work-on-reviews-with-task-file [pr-number] --task-file TODO.md
```

## Workflow Overview

1. **Fetch & Analyze Feedback** → Extract all review comments, issue comments, and PR feedback
2. **Generate TASK.md** → Create temporary tracking file with checklist
3. **Execute Plan** → Work through tasks systematically
4. **Validate & Update** → Run checks and update progress
5. **Cleanup** → Remove TASK.md when complete

## TASK.md File Structure

````markdown
# PR Review Resolution Tasks

**PR #[number]**: [title]
**Created**: [timestamp]
**Status**: IN PROGRESS | COMPLETED
**Progress**: [resolved]/[total] tasks completed ([percentage]%)

---

## 📋 Task Checklist

### 🔴 Critical Issues (Security, Logic, Breaking Changes)

- [ ] **SECURITY-001**: Add input validation for user endpoints
  - **File**: `src/routes/auth.ts:45`
  - **Source**: Review comment by @security-expert
  - **Issue**: "Missing input sanitization could lead to injection attacks"
  - **Priority**: CRITICAL
  - **Status**: PENDING
  - **Plan**: Add Zod validation schema and sanitize all inputs
  - **Validation**: Run security tests after fix

### 🟡 Major Issues (Code Quality, Performance, Architecture)

- [ ] **MAJOR-001**: Refactor database queries to use async/await
  - **File**: `src/services/place.service.ts:23-45`
  - **Source**: Review comment by @code-reviewer
  - **Issue**: "Using .then() chains instead of async/await makes code harder to read"
  - **Priority**: MAJOR
  - **Status**: PENDING
  - **Plan**: Convert all Promise chains to async/await pattern
  - **Validation**: Ensure tests still pass, no functional changes

### 🟢 Minor Issues (Style, Documentation, Suggestions)

- [ ] **MINOR-001**: Add JSDoc comments to public methods
  - **File**: `src/services/*.ts`
  - **Source**: Issue comment by @docs-maintainer
  - **Issue**: "Public methods should have JSDoc documentation"
  - **Priority**: MINOR
  - **Status**: PENDING
  - **Plan**: Add comprehensive JSDoc to all public service methods
  - **Validation**: Documentation builds successfully

- [ ] **COMMENT-001**: Consider adding error handling for edge cases
  - **File**: `src/controllers/story.controller.ts:67`
  - **Source**: PR comment by @reviewer-name
  - **Issue**: "What happens if the story doesn't exist? Should return 404"
  - **Priority**: MAJOR
  - **Status**: PENDING
  - **Plan**: Add proper error handling and 404 response
  - **Validation**: Test error scenarios

---

## 🔄 Progress Tracking

### Completed Tasks ✅

- _(Tasks will move here as they're completed)_

### In Progress Tasks 🔄

- _(Current task being worked on)_

### Failed/Blocked Tasks ❌

- _(Tasks that couldn't be completed with reasons)_

---

## 🧪 Validation Checklist

After each task completion, run:

- [ ] **TypeScript**: `npm run type-check`
- [ ] **Linting**: `npm run lint`
- [ ] **Tests**: `npm test`
- [ ] **Build**: `npm run build`
- [ ] **Dev Server**: `npm run dev` (manual smoke test)

### Validation Results Log

| Task ID      | TS  | Lint | Tests | Build | Dev | Notes                        |
| ------------ | --- | ---- | ----- | ----- | --- | ---------------------------- |
| SECURITY-001 | ✅  | ✅   | ✅    | ✅    | ✅  | All checks passed            |
| MAJOR-001    | ❌  | -    | -     | -     | -   | Type error in async refactor |

---

## 📝 Resolution Notes

### SECURITY-001 Resolution

- **Source**: Review comment by @security-expert
- Added Zod schemas for all auth endpoints
- Implemented input sanitization middleware
- Updated tests to cover validation edge cases
- **Commit**: `abc123f - feat(auth): add input validation and sanitization`

### MAJOR-001 Resolution

- **Source**: Review comment by @code-reviewer
- Converted all .then() chains to async/await
- Maintained exact same functionality
- Improved error handling with try/catch blocks
- **Commit**: `def456a - refactor(services): convert to async/await pattern`

### COMMENT-001 Resolution

- **Source**: PR comment by @reviewer-name
- Added proper 404 error handling for missing stories
- Implemented comprehensive error response middleware
- Added test cases for all error scenarios
- **Commit**: `ghi789b - fix(controllers): add proper error handling for missing resources`

---

## 🎯 Next Steps

1. **Current Focus**: Working on SECURITY-001
2. **Next Priority**: MAJOR-001 after security fixes
3. **Estimated Completion**: 2-3 hours remaining

---

## 🔧 Commands Reference

```bash
# Quick validation
npm run validate

# Individual checks
npm run type-check
npm run lint
npm test
npm run build

# Development
npm run dev

# Git workflow
git add [files]
git commit -m "fix(scope): resolve review comment"
git push
```
````

---

_This file will be automatically deleted when all review comments are resolved._

````

## Implementation Workflow

### Phase 1: Review Analysis & TASK.md Generation

```typescript
interface ReviewTask {
  id: string;
  title: string;
  file?: string;
  line?: number;
  source: 'review_comment' | 'pr_comment' | 'issue_comment' | 'discussion';
  author: string;
  issue: string;
  priority: 'CRITICAL' | 'MAJOR' | 'MINOR';
  category: 'security' | 'logic' | 'performance' | 'style' | 'docs' | 'tests';
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';
  plan: string;
  validationSteps: string[];
  resolutionNotes?: string;
  commitHash?: string;
  originalUrl?: string; // Link back to the original comment/review
}

interface FeedbackSource {
  type: 'review_comment' | 'pr_comment' | 'issue_comment';
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
  // Review-specific fields
  path?: string;
  line?: number;
  diffHunk?: string;
  // Issue/PR comment specific fields
  issueNumber?: number;
}

class TaskFileGenerator {
  async generateTaskFile(prNumber: number, taskFileName = 'TASK.md'): Promise<void> {
    // 1. Fetch all feedback sources
    const reviews = await this.fetchReviews(prNumber);
    const comments = await this.fetchComments(prNumber);
    const issueComments = await this.fetchIssueComments(prNumber);

    // 2. Consolidate all feedback
    const allFeedback = [...reviews, ...comments, ...issueComments];

    // 3. Categorize and prioritize
    const tasks = await this.categorizeTasks(allFeedback);

    // 4. Generate TASK.md content
    const taskContent = await this.generateTaskContent(prNumber, tasks);

    // 5. Write to file
    await fs.writeFile(taskFileName, taskContent);

    console.log(`📋 Created ${taskFileName} with ${tasks.length} tasks`);
    console.log(`🎯 Feedback sources:`);
    console.log(`   📝 Review comments: ${reviews.length}`);
    console.log(`   💬 PR comments: ${comments.length}`);
    console.log(`   🔗 Issue comments: ${issueComments.length}`);
    console.log(`🎯 Priority breakdown:`);
    console.log(`   🔴 Critical: ${tasks.filter(t => t.priority === 'CRITICAL').length}`);
    console.log(`   🟡 Major: ${tasks.filter(t => t.priority === 'MAJOR').length}`);
    console.log(`   🟢 Minor: ${tasks.filter(t => t.priority === 'MINOR').length}`);
  }

  async fetchComments(prNumber: number): Promise<Comment[]> {
    // Fetch general PR comments (not tied to specific lines)
    const result = await exec(`gh pr view ${prNumber} --json comments`);
    return this.parseGeneralComments(result.stdout);
  }

  async fetchIssueComments(prNumber: number): Promise<Comment[]> {
    // Fetch issue comments if PR is linked to an issue
    const prData = await exec(`gh pr view ${prNumber} --json body`);
    const issueNumber = this.extractIssueNumber(prData.stdout);

    if (issueNumber) {
      const result = await exec(`gh issue view ${issueNumber} --json comments`);
      return this.parseIssueComments(result.stdout);
    }

    return [];
  }

  async fetchDiscussions(prNumber: number): Promise<Comment[]> {
    // Fetch any GitHub Discussions related to the PR
    try {
      const result = await exec(`gh api graphql -f query='
        query {
          repository(owner: "Terrastories", name: "terrastories-api") {
            discussions(first: 10) {
              nodes {
                title
                body
                author { login }
                comments(first: 20) {
                  nodes {
                    body
                    author { login }
                    createdAt
                  }
                }
              }
            }
          }
        }'`);

      return this.parseDiscussions(result.stdout, prNumber);
    } catch (error) {
      console.warn('Could not fetch discussions:', error.message);
      return [];
    }
  }

  private categorizeFeedbackBySource(feedback: FeedbackSource[]): {
    critical: FeedbackSource[];
    major: FeedbackSource[];
    minor: FeedbackSource[];
  } {
    const critical = [];
    const major = [];
    const minor = [];

    for (const item of feedback) {
      const priority = this.determinePriority(item);

      switch (priority) {
        case 'CRITICAL':
          critical.push(item);
          break;
        case 'MAJOR':
          major.push(item);
          break;
        case 'MINOR':
          minor.push(item);
          break;
      }
    }

    return { critical, major, minor };
  }

  private determinePriority(feedback: FeedbackSource): 'CRITICAL' | 'MAJOR' | 'MINOR' {
    const body = feedback.body.toLowerCase();

    // Critical indicators
    if (body.includes('security') ||
        body.includes('vulnerability') ||
        body.includes('breaking') ||
        body.includes('critical') ||
        body.includes('urgent')) {
      return 'CRITICAL';
    }

    // Major indicators
    if (body.includes('performance') ||
        body.includes('architecture') ||
        body.includes('refactor') ||
        body.includes('logic') ||
        body.includes('error') ||
        body.includes('bug')) {
      return 'MAJOR';
    }

    // Everything else is minor (style, docs, suggestions)
    return 'MINOR';
  }
}
````

### Phase 2: Task Execution with Real-time Updates

```typescript
class TaskExecutor {
  async executeTaskPlan(taskFileName = 'TASK.md'): Promise<void> {
    const tasks = await this.loadTasksFromFile(taskFileName);

    for (const task of this.prioritizeTasksForExecution(tasks)) {
      console.log(`🔧 Starting: ${task.title}`);

      // Update task status to IN_PROGRESS
      await this.updateTaskStatus(taskFileName, task.id, 'IN_PROGRESS');

      try {
        // Execute the task resolution
        const resolution = await this.resolveTask(task);

        // Run validation after each task
        const validationResult = await this.runValidation(task.validationSteps);

        if (validationResult.success) {
          // Mark as completed and log resolution
          await this.completeTask(taskFileName, task.id, resolution);
          console.log(`✅ Completed: ${task.title}`);
        } else {
          // Handle validation failures
          await this.handleValidationFailure(
            taskFileName,
            task.id,
            validationResult
          );
        }

        // Update progress display
        await this.updateProgressDisplay(taskFileName);
      } catch (error) {
        await this.markTaskBlocked(taskFileName, task.id, error.message);
        console.error(`❌ Blocked: ${task.title} - ${error.message}`);
      }
    }
  }

  async updateTaskStatus(
    fileName: string,
    taskId: string,
    status: string
  ): Promise<void> {
    // Read current TASK.md
    const content = await fs.readFile(fileName, 'utf8');

    // Update specific task checkbox and status
    const updatedContent = this.updateTaskInMarkdown(content, taskId, status);

    // Write back to file
    await fs.writeFile(fileName, updatedContent);
  }
}
```

### Phase 3: Validation Integration

```typescript
class ValidationIntegration {
  async runValidation(validationSteps: string[]): Promise<ValidationResult> {
    const results = {
      typescript: { success: false, errors: [] },
      lint: { success: false, errors: [] },
      tests: { success: false, errors: [] },
      build: { success: false, errors: [] },
      dev: { success: false, errors: [] },
    };

    // Run each validation step
    for (const step of validationSteps) {
      console.log(`🔍 Running: ${step}`);

      switch (step) {
        case 'typescript':
          results.typescript = await this.runCommand('npm run type-check');
          break;
        case 'lint':
          results.lint = await this.runCommand('npm run lint');
          break;
        case 'tests':
          results.tests = await this.runCommand('npm test');
          break;
        case 'build':
          results.build = await this.runCommand('npm run build');
          break;
        case 'dev':
          results.dev = await this.testDevServer();
          break;
      }

      // Stop on first failure for critical fixes
      if (!results[step].success && this.isCriticalValidation(step)) {
        break;
      }
    }

    return this.consolidateValidationResults(results);
  }

  async updateValidationLog(
    fileName: string,
    taskId: string,
    results: ValidationResult
  ): Promise<void> {
    const content = await fs.readFile(fileName, 'utf8');

    // Find validation table and add/update row
    const updatedContent = this.updateValidationTable(content, taskId, results);

    await fs.writeFile(fileName, updatedContent);
  }
}
```

## Command Implementation

### Core Command Structure

```bash
#!/bin/bash

# work-on-reviews-with-task-file command

PR_NUMBER=$1
TASK_FILE=${2:-"TASK.md"}
FLAG=$3

case $FLAG in
  "--reset-tracking")
    echo "🗑️ Resetting tracking and creating new TASK.md..."
    rm -f $TASK_FILE
    ;;
  "--show-progress")
    echo "📊 Current Progress:"
    if [ -f "$TASK_FILE" ]; then
      # Extract and display progress from TASK.md
      grep -A 10 "Progress Tracking" $TASK_FILE
    else
      echo "❌ No task file found. Run without flags to create one."
    fi
    exit 0
    ;;
  "--task-file")
    TASK_FILE=$3
    ;;
esac

echo "🔄 Starting PR Review Resolution with Task File"
echo "📋 Task File: $TASK_FILE"
echo "🎯 PR Number: $PR_NUMBER"

# Step 1: Generate TASK.md if it doesn't exist
if [ ! -f "$TASK_FILE" ]; then
  echo "📝 Generating task file..."

  # Fetch all feedback sources
  echo "🔍 Fetching PR reviews..."
  gh pr view $PR_NUMBER --json reviews > /tmp/reviews.json

  echo "🔍 Fetching PR comments..."
  gh pr view $PR_NUMBER --json comments > /tmp/comments.json

  echo "🔍 Checking for linked issue comments..."
  gh pr view $PR_NUMBER --json body > /tmp/pr-body.json

  echo "🔍 Searching for related discussions..."
  gh api graphql -f query='
    query {
      repository(owner: "Terrastories", name: "terrastories-api") {
        discussions(first: 10) {
          nodes {
            title
            body
            author { login }
            comments(first: 20) {
              nodes {
                body
                author { login }
                createdAt
              }
            }
          }
        }
      }
    }' > /tmp/discussions.json 2>/dev/null || echo "No discussions found"

  # Generate TASK.md (this would call the TypeScript implementation)
  node -e "
    const generator = require('./scripts/task-generator');
    generator.generateTaskFile($PR_NUMBER, '$TASK_FILE');
  "

  echo "✅ Created $TASK_FILE"
  echo "📖 Review the task list and plan before proceeding"
  echo ""
  echo "Next steps:"
  echo "1. Review $TASK_FILE carefully"
  echo "2. Run this command again to start execution"
  echo "3. Monitor progress in real-time"

else
  echo "📋 Found existing $TASK_FILE, resuming work..."

  # Step 2: Execute task plan
  node -e "
    const executor = require('./scripts/task-executor');
    executor.executeTaskPlan('$TASK_FILE');
  "

fi

# Step 3: Final summary
if [ $? -eq 0 ]; then
  echo ""
  echo "🎉 All review comments resolved!"
  echo "📊 Final summary available in $TASK_FILE"
  echo ""
  echo "📝 Next steps:"
  echo "1. Review all changes"
  echo "2. Run final validation: npm run validate"
  echo "3. Request re-review from reviewers"
  echo "4. Delete $TASK_FILE when PR is approved"
else
  echo "❌ Some tasks failed or are blocked"
  echo "📋 Check $TASK_FILE for details and resolution steps"
fi
```

## Integration with Existing Validation Commands

```bash
# Add to package.json scripts
{
  "scripts": {
    "work-on-reviews": "bash .claude/commands/work-on-reviews-with-task-file.sh",
    "validate-task": "npm run type-check && npm run lint && npm test && npm run build",
    "task-progress": "bash .claude/commands/work-on-reviews-with-task-file.sh --show-progress"
  }
}
```

## Key Benefits of This Approach

1. **Visible Progress**: TASK.md shows exactly what needs to be done
2. **Systematic Execution**: Work through tasks by priority
3. **Validation Integration**: Automated checks after each resolution
4. **Resume Capability**: Can pick up where you left off
5. **Clear Communication**: Easy to see what's done, in progress, blocked
6. **Documentation**: Resolution notes help with future similar issues
7. **Cleanup**: Temporary file gets removed when complete

## TASK.md Lifecycle

```
1. CREATED     → Generated from PR review analysis
2. IN_PROGRESS → Tasks being executed systematically
3. VALIDATED   → Each task validated before marking complete
4. UPDATED     → Real-time progress updates in file
5. COMPLETED   → All tasks resolved, ready for cleanup
6. DELETED     → Removed after PR approval
```

This approach transforms the complex review resolution process into a clear, trackable checklist that ensures nothing gets missed while maintaining full validation throughout.
