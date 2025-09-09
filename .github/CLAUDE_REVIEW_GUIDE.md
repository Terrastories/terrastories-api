# Smart Claude Code Review Workflow Guide

This guide explains how the enhanced Claude Code Review workflow provides intelligent, context-aware reviews that evolve with your PR.

## 🧠 How It Works

### Smart Review Types

The workflow automatically detects the state of your PR and provides different types of reviews:

#### 1. 🔍 **Initial Review** (First time)

- **Trigger**: No previous Claude comments exist
- **Scope**: Comprehensive analysis of entire PR
- **Focus**: Full code quality, security, testing, and architecture review
- **Output**: Detailed feedback with prioritized issues (CRITICAL > MAJOR > MINOR)

#### 2. 🔄 **Follow-up Review** (After new commits)

- **Trigger**: New commits since last Claude comment
- **Scope**: Only analyzes new changes and commits
- **Focus**:
  - ✅ Acknowledges resolved issues from previous reviews
  - 🔍 Reviews only net-new changes
  - ⚠️ Identifies new issues or regressions
  - 💡 Provides fresh insights without repetition
- **Output**: Incremental feedback building on previous reviews

#### 3. ⏭️ **Status Check** (No new changes)

- **Trigger**: Workflow runs but no new commits since last review
- **Scope**: Quick status assessment
- **Focus**: PR readiness and pending issue summary
- **Output**: Concise status update without full re-review

### Key Features

#### 📚 **Comment History Awareness**

- Analyzes all previous Claude comments and timestamps
- Extracts previously mentioned issues for context
- Avoids repeating resolved feedback

#### 🎯 **Differential Analysis**

- Identifies commits made since last review
- Focuses review scope on new changes only
- Generates diffs for incremental analysis

#### 🔄 **Progress Tracking**

- Tracks review count and PR evolution
- Acknowledges improvements and issue resolution
- Maintains context across multiple review cycles

#### 🎨 **Dynamic Prompting**

- Generates contextual prompts based on PR state
- Adapts review focus to current needs
- Provides relevant guidance for each review type

## 🚀 Benefits

### For Developers

- **No Repetitive Feedback**: Only get fresh, relevant insights
- **Progress Recognition**: Improvements are acknowledged
- **Focused Reviews**: Attention on what actually changed
- **Efficient Iterations**: Faster review cycles on updates

### For Teams

- **Consistent Quality**: Maintains review standards across iterations
- **Better PR Evolution**: Encourages incremental improvements
- **Reduced Review Fatigue**: Avoids redundant feedback
- **Smart Automation**: Adapts to different PR scenarios

## 📝 Review Examples

### Initial Review Example

```
🔍 Initial Code Review

CRITICAL Issues:
- SQL injection vulnerability in user input handling
- Missing authentication validation on admin endpoints

MAJOR Issues:
- Inefficient database queries causing performance issues
- Missing error handling in API endpoints

MINOR Issues:
- Inconsistent code formatting
- Missing JSDoc comments on public methods
```

### Follow-up Review Example

```
🔄 Follow-up Review - New Changes Analysis

Great progress! This PR has been updated with 3 new commits since the last review.

✅ Issues Resolved:
- SQL injection vulnerability has been fixed with proper parameterization
- Authentication validation added to admin endpoints

🔍 New Changes Analysis:
- Added comprehensive error handling (excellent improvement!)
- Database query optimization looks good

⚠️ New Issue Identified:
- New endpoint in commit abc123 is missing rate limiting

Overall: Strong improvements addressing previous feedback. Just one new security concern to address.
```

### Status Check Example

```
⏭️ No New Changes Detected

Quick Status Check:
✅ All CRITICAL and MAJOR issues from previous review have been addressed
✅ Code quality improvements are in place
✅ Test coverage is adequate

Status: This PR appears ready for approval based on previous feedback.
```

## 🛠️ Configuration Options

### Customizing Review Focus

You can customize the review prompts by modifying the workflow file:

```yaml
# Example: Focus on specific areas for your team
PROMPT="Review focusing on:
  - Security vulnerabilities and authentication
  - Performance and scalability concerns
  - Test coverage and quality
  - TypeScript best practices"
```

### Adjusting Trigger Conditions

```yaml
# Only run on specific file changes
paths:
  - 'src/**/*.ts'
  - 'src/**/*.tsx'
  - 'tests/**/*.test.ts'

# Skip certain PR types
if: |
  !contains(github.event.pull_request.title, '[skip-review]') &&
  !contains(github.event.pull_request.title, '[WIP]')
```

### Team-Specific Prompts

```yaml
# Different prompts for different contributors
direct_prompt: |
  ${{ github.event.pull_request.author_association == 'FIRST_TIME_CONTRIBUTOR' && 
  'Welcome! Provide encouraging feedback with detailed explanations.' ||
  'Standard review focusing on team coding standards.' }}
```

## 🎛️ Advanced Features

### Sticky Comments

- Follow-up reviews use sticky comments to maintain context
- Previous review content is updated rather than creating new comments
- Keeps PR comment history clean and organized

### Tool Integration

- Automatically runs tests, linting, and type checking
- Analyzes git history and commit diffs
- Can execute project-specific validation commands

### Review Logging

- Tracks review completion and metadata
- Logs review types and commit counts
- Useful for analytics and workflow optimization

## 🔧 Troubleshooting

### Common Issues

**No Comments Detected**

- Ensure the workflow has proper permissions (`pull-requests: write`)
- Check that Claude comments are properly identified by username/content

**Wrong Review Type**

- Verify git history is available (`fetch-depth: 0`)
- Check timestamp parsing and commit analysis logic

**Missing Context**

- Ensure previous comments are being extracted correctly
- Verify jq and GitHub API calls are working

### Debug Mode

Add this step to debug workflow behavior:

```yaml
- name: Debug Review Context
  run: |
    echo "Review type: ${{ steps.pr-analysis.outputs.review_type }}"
    echo "Comment count: ${{ steps.pr-analysis.outputs.comment_count }}"
    echo "New commits: ${{ steps.new-commits.outputs.new_commit_count }}"
    cat claude_comments.json
    cat previous_issues.txt
```

## 📊 Workflow Metrics

The workflow automatically tracks:

- Review completion timestamps
- PR numbers and review types
- Commit counts for each review
- Review type distribution

This data helps optimize the review process over time.

---

This intelligent workflow ensures that Claude provides maximum value by:

- 🎯 **Focusing** on what's actually new
- 📚 **Remembering** previous feedback and context
- 🔄 **Evolving** with your PR development process
- ⚡ **Optimizing** review efficiency and quality
