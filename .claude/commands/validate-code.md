# Command: /validate-code

## Purpose

Comprehensive code validation ensuring all quality gates pass before considering work complete. Runs all project checks and iteratively fixes issues until completely passing.

## Usage

```
/validate-code
/validate-code --fix
/validate-code --verbose
```

## Workflow

### Phase 1: Full Validation Suite

Run all quality checks in sequence:

```bash
# 1. Type checking
npm run type-check

# 2. Linting
npm run lint

# 3. Test suite
npm test

# 4. Build verification
npm run build
```

### Phase 2: Issue Detection & Resolution

**Error Categories**:

- **TypeScript Errors**: Type mismatches, missing types, compilation failures
- **Lint Errors**: Code style, best practices, ESLint rule violations
- **Test Failures**: Unit tests, integration tests, coverage thresholds
- **Build Errors**: Compilation issues, missing dependencies

**Resolution Strategy**:

1. **Categorize Issues**: Group by type for efficient fixing
2. **Priority Order**: TypeScript → Lint → Tests → Build
3. **Fix & Validate**: Fix one category, re-run checks, repeat
4. **Loop Until Clean**: Continue until all checks pass

### Phase 3: Completion Validation

**Success Criteria**:

- ✅ `npm run type-check` - 0 errors, 0 warnings
- ✅ `npm run lint` - 0 errors, 0 warnings
- ✅ `npm test` - All tests pass, coverage ≥80%
- ✅ `npm run build` - Clean build, no errors

**Integration with Work Command**:

- Auto-runs after `/work` command completion
- Required for Serena memory `completion_checklist.md`
- Blocks work completion until all checks pass

## Implementation Logic

```typescript
class ValidateCodeCommand {
  async execute(options: ValidationOptions): Promise<ValidationResult> {
    let allPassed = false;
    let iterationCount = 0;
    const maxIterations = 5;

    while (!allPassed && iterationCount < maxIterations) {
      console.log(`🔍 Validation Iteration ${iterationCount + 1}`);

      // Run all checks
      const results = await this.runAllChecks();

      if (results.allPassed) {
        allPassed = true;
        await this.updateCompletionChecklist();
        break;
      }

      // Fix issues by category
      if (results.typeErrors.length > 0) {
        await this.fixTypeScriptErrors(results.typeErrors);
      }

      if (results.lintErrors.length > 0) {
        await this.fixLintErrors(results.lintErrors);
      }

      if (results.testFailures.length > 0) {
        await this.fixTestFailures(results.testFailures);
      }

      if (results.buildErrors.length > 0) {
        await this.fixBuildErrors(results.buildErrors);
      }

      iterationCount++;
    }

    if (!allPassed) {
      throw new Error(`Validation failed after ${maxIterations} iterations`);
    }

    return { success: true, iterations: iterationCount };
  }

  private async runAllChecks(): Promise<ValidationResults> {
    const typeCheck = await this.runCommand('npm run type-check');
    const lint = await this.runCommand('npm run lint');
    const test = await this.runCommand('npm test');
    const build = await this.runCommand('npm run build');

    return {
      allPassed:
        typeCheck.success && lint.success && test.success && build.success,
      typeErrors: this.parseTypeErrors(typeCheck.output),
      lintErrors: this.parseLintErrors(lint.output),
      testFailures: this.parseTestFailures(test.output),
      buildErrors: this.parseBuildErrors(build.output),
    };
  }

  private async updateCompletionChecklist(): Promise<void> {
    // Update Serena memory with validation success
    const checklist = {
      timestamp: new Date().toISOString(),
      typeCheck: '✅ PASSED',
      lint: '✅ PASSED',
      tests: '✅ PASSED',
      build: '✅ PASSED',
      readyForReview: true,
    };

    await this.writeToSerenaMemory('completion_checklist.md', checklist);
  }
}
```

## Error Fixing Strategies

### TypeScript Errors

**Common Issues & Fixes**:

- **Type mismatches**: Add proper type annotations
- **Missing imports**: Add import statements
- **Strict null checks**: Add null/undefined guards
- **Generic constraints**: Add proper type parameters

**Example Fix Pattern**:

```typescript
// Error: Property 'id' does not exist on type 'unknown'
// Fix: Add proper typing
interface User {
  id: string;
  name: string;
}
const user: User = userData as User;
```

### Lint Errors

**Auto-Fix Strategy**:

```bash
# Try auto-fix first
npm run lint -- --fix

# Then handle remaining issues manually
```

**Common Manual Fixes**:

- Remove unused variables/imports
- Fix naming conventions
- Add missing JSDoc comments
- Resolve complexity issues

### Test Failures

**Resolution Approach**:

1. **Analyze Failure**: Read test output carefully
2. **Identify Root Cause**: Code bug vs test issue
3. **Fix Implementation**: Update code to pass test
4. **Update Test**: If requirements changed
5. **Verify Coverage**: Ensure coverage thresholds met

### Build Errors

**Common Issues**:

- Missing dependencies: `npm install [package]`
- Import path errors: Fix relative/absolute paths
- Configuration issues: Check tsconfig.json, build scripts
- Environment variables: Verify .env setup

## Integration Points

### Work Command Integration

```bash
# In work.md command, final step:
echo "Running validation before completion..."
/validate-code

if [ $? -eq 0 ]; then
  echo "✅ All validation checks passed"
  # Update Serena completion checklist
else
  echo "❌ Validation failed - work not complete"
  exit 1
fi
```

### Serena Memory Integration

```markdown
# .serena/memories/completion_checklist.md

## Validation Status

- TypeScript: ✅ PASSED (0 errors)
- ESLint: ✅ PASSED (0 errors)
- Tests: ✅ PASSED (95% coverage)
- Build: ✅ PASSED (clean)

## Ready for Review: ✅ YES

Last validated: 2024-01-15T10:30:00Z
```

## Flags

**`--fix`**: Attempt automatic fixes where possible
**`--verbose`**: Show detailed output for each check
**`--skip-build`**: Skip build verification (for speed)
**`--coverage-threshold [number]`**: Override coverage requirement

## Success Output

```
🎉 VALIDATION COMPLETE

📊 Summary:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ TypeScript: 0 errors, 0 warnings
✅ ESLint: 0 errors, 0 warnings
✅ Tests: All 24 tests passing (92% coverage)
✅ Build: Clean compilation

🔄 Iterations: 2
⏱️ Total time: 45 seconds

📝 Updated completion checklist in Serena memory
🚀 Ready for review/merge
```

## Error Output

```
❌ VALIDATION FAILED

Issues found:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔴 TypeScript (3 errors):
  - src/services/place.service.ts:45 - Type 'string' not assignable to 'number'
  - src/routes/places.ts:123 - Property 'geometry' missing in type

🟡 ESLint (2 warnings):
  - Unused variable 'data' in src/utils/helpers.ts:12
  - Missing return type annotation in src/services/user.service.ts:67

🔧 Attempting fixes...
```

## Best Practices

1. **Run Early**: Don't wait until end to validate
2. **Fix Incrementally**: Address issues as they appear
3. **Understand Errors**: Don't just silence warnings
4. **Maintain Standards**: Keep coverage and quality high
5. **Document Decisions**: Note any exceptions in comments
