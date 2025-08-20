# Command: /improve-workflow

# Command: /improve-workflow

## 🚀 Command Summary

- **Purpose**: To continuously analyze and improve the development workflow by examining past work sessions and updating command definitions and documentation.
- **Key Phases**: Analyze Sessions -> Identify Improvements -> Generate & Validate Changes -> Implement Updates.
- **Primary Outcome**: An updated `CLAUDE.md` and associated command files, along with a report detailing the improvements made.

## 🤖 Prompt to Agent

## As the workflow improvement agent, your task is to analyze the recent development activity and suggest concrete improvements to the workflow. Follow the phases outlined in this document. First, analyze recent sessions and patterns. Second, generate a prioritized list of improvements. Finally, present these changes in the specified "Workflow Improvement Report" format. You may be asked to apply these changes directly to the relevant files.

## Purpose

Continuously analyze and improve the Claude Code workflow by examining recent work sessions, identifying patterns, and updating CLAUDE.md with better instructions, commands, and configurations.

## Usage

```
/improve-workflow
/improve-workflow --focus [performance|quality|usability|commands]
/improve-workflow --analyze-sessions [number]
/improve-workflow --quick-fix
```

## When to Use

- After completing 3-5 work sessions
- When encountering repeated issues or inefficiencies
- During sprint retrospectives
- When onboarding new team members reveals gaps
- After major framework or tool updates

## Process

### Phase 1: ANALYZE RECENT SESSIONS

1. **Session History Review**
   - Examine last 5-10 work sessions in `.claude/work-sessions/`
   - Identify common pain points and bottlenecks
   - Analyze checkpoint recovery patterns
   - Review command usage frequency and success rates

2. **Pattern Detection**
   - Commands that frequently need manual intervention
   - Repeated errors or misunderstandings
   - Missing automation opportunities
   - Inconsistent responses to similar requests

3. **Performance Metrics Analysis**
   - Average time per phase in `/work` command
   - Success rate of auto-fixes in `/review-pr`
   - Frequency of checkpoint recoveries
   - Test coverage trends

### Phase 2: IDENTIFY IMPROVEMENTS

1. **Instruction Clarity**
   - Ambiguous command descriptions
   - Missing edge case handling
   - Inconsistent terminology
   - Unclear workflow transitions

2. **Command Optimization**
   - Parameters that could be automated
   - Missing commands for common tasks
   - Commands that could be combined or split
   - Better default behaviors

3. **Configuration Gaps**
   - Missing project-specific patterns
   - Outdated technology references
   - Missing quality gates
   - Insufficient context preservation

### Phase 3: GENERATE IMPROVEMENTS

1. **Prioritize Changes**

   ```
   Critical   → Blocking workflow execution
   High       → Significant time savings
   Medium     → Quality improvements
   Low        → Nice-to-have enhancements
   ```

2. **Create Specific Updates**
   - Updated command definitions
   - New configuration sections
   - Improved instruction clarity
   - Additional automation rules

3. **Validate Changes**
   - Check for consistency across commands
   - Ensure backward compatibility
   - Verify no breaking changes
   - Test with sample scenarios

### Phase 4: IMPLEMENT UPDATES

1. **Backup Current State**

   ```bash
   cp .claude/CLAUDE.md .claude/CLAUDE.md.backup.$(date +%Y%m%d)
   ```

2. **Apply Improvements**
   - Update CLAUDE.md with new instructions
   - Modify command files in `.claude/commands/`
   - Update configuration files
   - Add new patterns to context

3. **Document Changes**
   - Add entries to improvement log
   - Update version in CLAUDE.md
   - Create migration notes if needed
   - Update team documentation

### Phase 5: VALIDATE IMPROVEMENTS

1. **Test Critical Paths**
   - Run sample `/work` command
   - Test checkpoint recovery
   - Verify command parsing
   - Check configuration loading

2. **Performance Baseline**
   - Measure time for common operations
   - Check memory usage patterns
   - Validate quality metrics
   - Test edge cases

## Output Format

```markdown
## Workflow Improvement Report

### 📊 Analysis Summary

- Sessions analyzed: X
- Issues identified: Y
- Improvements proposed: Z

### 🔍 Key Findings

1. **[Issue Category]**: [Description]
   - Impact: [High/Medium/Low]
   - Frequency: [X times in Y sessions]
   - Proposed fix: [Brief description]

### ✅ Implemented Improvements

#### CLAUDE.md Updates

- [Section]: [What was changed and why]
- [Section]: [What was changed and why]

#### Command Updates

- `/command-name`: [Improvements made]
- New command: `/new-command` - [Purpose]

#### Configuration Changes

- [Config file]: [Changes made]

### 📈 Expected Impact

- Time savings: [X minutes per session]
- Quality improvement: [Specific metrics]
- Reduced manual intervention: [Y% reduction]

### 🔄 Next Review

- Recommended after: [X work sessions]
- Focus areas: [Specific aspects to monitor]
```

## Integration Points

### Called Automatically By:

- `/merge-pr` - After every 5th successful merge
- Weekly automation (if configured)
- `/work` - After detecting repeated issues in execution
- Session recovery failures (after 3 failed checkpoint recoveries)

### Called Manually By:

- `/retrospective` - During sprint reviews
- Developers when experiencing friction
- Team leads during workflow optimization
- After major framework or tool updates

### Calls Other Commands:

- `/analyze-patterns` - For deeper pattern analysis
- `/validate-config` - To verify configuration consistency
- `/backup-state` - Before making changes
- `/sync-issues-roadmap` - After updating workflow instructions

## Configuration

### Auto-Improvement Settings

```json
{
  "auto_improve": {
    "enabled": true,
    "trigger_after_merges": 5,
    "min_sessions_analyzed": 3,
    "backup_before_changes": true,
    "validate_after_changes": true
  },
  "improvement_focus": {
    "performance": 0.4,
    "quality": 0.3,
    "usability": 0.2,
    "automation": 0.1
  },
  "approval_required": {
    "critical_changes": true,
    "new_commands": true,
    "config_changes": false,
    "instruction_updates": false
  }
}
```

### Learning Patterns

```markdown
# Patterns to Learn From

## Common Issues

- Checkpoint corruption → Better validation
- Type errors → Stricter TypeScript config
- Test failures → Better test patterns

## Success Patterns

- Quick auto-fixes → Expand auto-fix rules
- Clean merges → Document successful patterns
- Fast development → Identify accelerators
```

## Quality Gates

### Before Implementation

- [ ] All proposed changes validated
- [ ] Backward compatibility maintained
- [ ] No breaking changes to existing workflows
- [ ] Changes align with project goals

### After Implementation

- [ ] CLAUDE.md syntax is valid
- [ ] All commands still parse correctly
- [ ] Configuration files are valid JSON/YAML
- [ ] Sample workflow executes successfully

## Examples

### Performance Improvement

```markdown
## Issue Identified

`/work` command taking 15+ minutes on Phase 2 (PLAN)

## Root Cause

Excessive dependency analysis on large codebases

## Solution

Add caching for dependency graphs:

- Cache analysis results for 24 hours
- Incremental updates for file changes
- Skip analysis for unrelated changes

## Implementation

Updated `/work` command with `--use-cache` flag
```

### Quality Enhancement

```markdown
## Issue Identified

Auto-fixes in `/review-pr` failing 40% of the time

## Root Cause

Insufficient context about project-specific patterns

## Solution

Enhanced pattern learning:

- Track successful fix patterns
- Learn from manual overrides
- Improve pattern matching

## Implementation

Added pattern storage to `.claude/context/patterns.md`
```

## Metrics Tracking

### Improvement Effectiveness

```typescript
interface ImprovementMetrics {
  timeToCompletion: {
    before: number;
    after: number;
    improvement: number;
  };

  errorReduction: {
    before: number;
    after: number;
    improvement: number;
  };

  automationIncrease: {
    manualSteps: number;
    automatedSteps: number;
    percentage: number;
  };
}
```

### Success Criteria

- 10%+ reduction in average session time
- 20%+ reduction in manual interventions
- 15%+ improvement in first-time success rate
- 90%+ user satisfaction with changes

## Rollback Procedure

If improvements cause issues:

```bash
# 1. Restore backup
cp .claude/CLAUDE.md.backup.YYYYMMDD .claude/CLAUDE.md

# 2. Reset configuration
git checkout HEAD -- .claude/config/

# 3. Clear problematic patterns
rm .claude/context/patterns.md.new

# 4. Restart session
/status --reset
```

## Advanced Features

### A/B Testing

```bash
# Test improvements on subset of work
/improve-workflow --test-mode --percentage 20
```

### Human-in-the-Loop

```bash
# Require approval for all changes
/improve-workflow --interactive
```

### Gradual Rollout

```bash
# Apply improvements incrementally
/improve-workflow --gradual --phases 3
```
