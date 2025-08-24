# Command: /work-on-reviews

## Purpose

Analyzes PR review comments and systematically addresses all feedback. Tracks progress to avoid duplicate work and ensures all issues are resolved with full validation.

## Usage

```
/work-on-reviews [pr-number]
/work-on-reviews [pr-number] --reset-tracking
/work-on-reviews [pr-number] --show-progress
```

## Workflow Architecture

### Phase 1: Review Analysis

```typescript
interface ReviewComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  category: 'code' | 'style' | 'logic' | 'security' | 'performance' | 'test';
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  status: 'pending' | 'in_progress' | 'resolved' | 'wont_fix';
  resolution?: string;
  commits?: string[];
}

class ReviewAnalyzer {
  async analyzeComments(prNumber: number): Promise<ReviewComment[]> {
    // Fetch all review comments from GitHub
    const reviews = await exec(`gh pr view ${prNumber} --json reviews`);
    const comments = await exec(`gh pr diff ${prNumber} --name-only`);

    // Parse and categorize each comment
    return this.categorizeComments(reviews, comments);
  }

  private categorizeComments(reviews: any[], files: string[]): ReviewComment[] {
    // Intelligent categorization based on content and context
    // - Code quality issues
    // - Security concerns
    // - Performance problems
    // - Test coverage gaps
    // - Style/formatting
    // - Logic errors
  }
}
```

### Phase 2: Progress Tracking

**State Management**:

```json
{
  "prNumber": 123,
  "startTime": "2024-01-15T10:00:00Z",
  "totalComments": 8,
  "resolvedComments": 3,
  "inProgressComments": 2,
  "pendingComments": 3,
  "comments": [
    {
      "id": "comment-456",
      "author": "reviewer1",
      "body": "Consider using async/await instead of .then()",
      "path": "src/services/place.service.ts",
      "line": 45,
      "category": "style",
      "severity": "minor",
      "status": "resolved",
      "resolution": "Refactored to use async/await pattern",
      "commits": ["abc123f"]
    }
  ]
}
```

**Persistence Strategy**:

- Store in `.claude/work-sessions/pr-reviews/pr-${number}.json`
- Track individual comment resolution
- Prevent duplicate work through state checking
- Enable resume capability

### Phase 3: Systematic Resolution

```typescript
class ReviewResolver {
  async resolveAllComments(prNumber: number): Promise<ResolutionResult> {
    const tracker = await this.loadProgressTracker(prNumber);

    // Get pending comments only
    const pendingComments = tracker.comments.filter(
      (c) => c.status === 'pending'
    );

    for (const comment of pendingComments) {
      console.log(`🔧 Resolving: ${comment.body.substring(0, 80)}...`);

      // Mark as in progress
      await this.updateCommentStatus(comment.id, 'in_progress');

      try {
        // Resolve the specific issue
        const resolution = await this.resolveComment(comment);

        // Update status and track changes
        await this.updateCommentStatus(comment.id, 'resolved', resolution);

        // Run validation after each resolution
        const validationResult = await this.runValidation();

        if (!validationResult.success) {
          // If validation fails, fix issues before continuing
          await this.handleValidationFailures(validationResult);
        }
      } catch (error) {
        console.error(`Failed to resolve comment ${comment.id}:`, error);
        await this.updateCommentStatus(comment.id, 'pending', error.message);
      }
    }

    // Final validation
    await this.runFinalValidation();

    return this.generateResolutionReport(tracker);
  }

  private async resolveComment(comment: ReviewComment): Promise<string> {
    switch (comment.category) {
      case 'code':
        return await this.resolveCodeIssue(comment);
      case 'style':
        return await this.resolveStyleIssue(comment);
      case 'logic':
        return await this.resolveLogicIssue(comment);
      case 'security':
        return await this.resolveSecurityIssue(comment);
      case 'performance':
        return await this.resolvePerformanceIssue(comment);
      case 'test':
        return await this.resolveTestIssue(comment);
      default:
        return await this.resolveGenericIssue(comment);
    }
  }
}
```

### Phase 4: Validation Integration

**Continuous Validation**:

- Run `/validate-code` after each comment resolution
- Ensure changes don't break existing functionality
- Maintain code quality throughout process
- Track validation results per resolution

**Validation Strategy**:

```typescript
class ValidationIntegration {
  async validateAfterResolution(commentId: string): Promise<ValidationResult> {
    console.log(`🔍 Validating changes for comment ${commentId}...`);

    // Run full validation suite
    const result = await this.runCommand('/validate-code');

    if (!result.success) {
      // Log validation failures with context
      await this.logValidationFailure(commentId, result.errors);

      // Attempt automatic fixes
      const fixResult = await this.attemptAutoFix(result.errors);

      if (fixResult.success) {
        return await this.validateAfterResolution(commentId);
      } else {
        throw new Error(
          `Validation failed after resolving comment ${commentId}`
        );
      }
    }

    return result;
  }
}
```

## Comment Resolution Strategies

### Code Quality Issues

**Pattern Recognition**:

- Variable naming conventions
- Function complexity
- Code duplication
- Error handling patterns

**Resolution Approach**:

```typescript
async resolveCodeIssue(comment: ReviewComment): Promise<string> {
  if (comment.body.includes('async/await')) {
    return await this.refactorToAsyncAwait(comment.path, comment.line);
  }

  if (comment.body.includes('error handling')) {
    return await this.addErrorHandling(comment.path, comment.line);
  }

  if (comment.body.includes('naming')) {
    return await this.improveVariableNaming(comment.path, comment.line);
  }

  // Generic code improvement
  return await this.improveCodeQuality(comment);
}
```

### Security Issues

**Critical Resolution**:

- Input validation
- SQL injection prevention
- Authentication/authorization
- Data sanitization

**Pattern**:

```typescript
async resolveSecurityIssue(comment: ReviewComment): Promise<string> {
  // Security issues are always critical
  console.log(`🛡️ SECURITY: ${comment.body}`);

  if (comment.body.includes('input validation')) {
    return await this.addInputValidation(comment.path, comment.line);
  }

  if (comment.body.includes('authorization')) {
    return await this.addAuthorizationCheck(comment.path, comment.line);
  }

  // Comprehensive security review
  return await this.performSecurityFix(comment);
}
```

### Performance Issues

**Optimization Strategy**:

- Database query optimization
- Caching implementation
- Algorithm improvements
- Memory leak prevention

### Test Coverage Issues

**Test Enhancement**:

- Add missing test cases
- Improve test assertions
- Add edge case coverage
- Mock external dependencies

## Progress Tracking & Reporting

### Real-time Progress Display

```
🔄 PR REVIEW RESOLUTION PROGRESS

PR #123: "Add user authentication system"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Overall Progress: 5/8 comments resolved (62.5%)

✅ Resolved (5):
  - comment-123: "Use async/await pattern" → Refactored service methods
  - comment-456: "Add input validation" → Added Zod schemas
  - comment-789: "Fix naming convention" → Renamed variables
  - comment-012: "Add error handling" → Added try/catch blocks
  - comment-345: "Update tests" → Added missing test cases

🔄 In Progress (1):
  - comment-678: "Optimize database queries" → Adding indexes...

⏳ Pending (2):
  - comment-901: "Add JSDoc comments"
  - comment-234: "Extract common logic"

🎯 Next: Resolving database optimization...
```

### Session State Persistence

```json
{
  "sessionId": "pr-123-2024-01-15",
  "prNumber": 123,
  "startTime": "2024-01-15T10:00:00Z",
  "lastUpdate": "2024-01-15T11:30:00Z",
  "status": "in_progress",
  "progress": {
    "total": 8,
    "resolved": 5,
    "inProgress": 1,
    "pending": 2,
    "percentage": 62.5
  },
  "validationsPassed": 3,
  "validationsFailed": 1,
  "estimatedTimeRemaining": "45 minutes"
}
```

## Integration with Validation

### Automated Validation Flow

```bash
# After each comment resolution:
echo "Comment resolved, running validation..."
/validate-code

if [ $? -eq 0 ]; then
  echo "✅ Validation passed, continuing..."
  # Update comment status to resolved
else
  echo "❌ Validation failed, fixing issues..."
  # Run validation loop until passing
  # Then mark comment as resolved
fi
```

### Quality Gates

**Mandatory Checks**:

1. **Type Safety**: No TypeScript errors
2. **Code Quality**: ESLint passing
3. **Test Coverage**: All tests pass, coverage maintained
4. **Build Success**: Clean compilation
5. **Functionality**: Feature still works as expected

## Command Flags

**`--reset-tracking`**: Clear existing progress and start fresh
**`--show-progress`**: Display current resolution status without working
**`--category [type]`**: Focus on specific comment category
**`--severity [level]`**: Address only comments of certain severity
**`--author [username]`**: Focus on comments from specific reviewer
**`--auto-resolve-style`**: Automatically fix style/formatting issues

## Success Output

```
🎉 ALL PR REVIEW COMMENTS RESOLVED!

📊 Resolution Summary:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Total Comments: 8
✅ Successfully Resolved: 8
✅ Auto-Fixed: 3 (style/formatting)
✅ Manual Fixes: 5 (logic/security)

⏱️ Time Metrics:
- Total Duration: 2h 15m
- Average per Comment: 16m
- Validation Runs: 12
- Validation Failures: 2 (auto-fixed)

🔧 Changes Made:
- Files Modified: 6
- Lines Added: 156
- Lines Removed: 89
- Tests Added: 12

🚀 Final Validation: ALL CHECKS PASSED

✅ TypeScript: 0 errors
✅ ESLint: 0 warnings
✅ Tests: 94% coverage
✅ Build: Clean

📝 Ready for re-review request
🎯 All reviewer feedback addressed
```

## Error Handling

**Unresolvable Comments**:

- Comments requesting architectural changes beyond scope
- Conflicting feedback from multiple reviewers
- Comments requiring external dependencies not approved

**Resolution Strategy**:

1. **Document Reasoning**: Explain why comment cannot be resolved
2. **Propose Alternative**: Suggest alternative approaches
3. **Seek Clarification**: Comment on PR requesting guidance
4. **Mark as "Won't Fix"**: With clear justification

## Resume Capability

```bash
# Resume interrupted session
/work-on-reviews 123

# Command detects existing progress:
"📋 Found existing session for PR #123
 Progress: 3/8 comments resolved
 Resume from comment-456? [y/N]"
```

## Best Practices

1. **Read Carefully**: Understand reviewer intent before making changes
2. **Test Thoroughly**: Validate each fix before moving to next
3. **Communicate**: Comment on resolved issues to show completion
4. **Stay Focused**: Address one comment at a time completely
5. **Maintain Quality**: Don't sacrifice code quality for speed
6. **Document Decisions**: Explain non-obvious resolution choices
