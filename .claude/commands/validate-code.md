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

# 3. Test suite (with JSON output for analysis)
npm test -- --reporter=json --outputFile=test-results.json

# 4. Build verification
npm run build
```

**Note**: Tests are run with JSON output to `test-results.json` for detailed failure analysis and automated fixing. This file is gitignored.

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

    // Run tests with JSON output and increased timeout for long-running tests
    console.log('🧪 Running tests (this may take several minutes)...');
    const test = await this.runCommand(
      'npm test -- --reporter=json --outputFile=test-results.json --run',
      { timeout: 300000 } // 5 minute timeout
    );

    const build = await this.runCommand('npm run build');

    return {
      allPassed:
        typeCheck.success && lint.success && test.success && build.success,
      typeErrors: this.parseTypeErrors(typeCheck.output),
      lintErrors: this.parseLintErrors(lint.output),
      testFailures: await this.parseTestFailuresFromJson(),
      buildErrors: this.parseBuildErrors(build.output),
    };
  }

  private async parseTestFailuresFromJson(): Promise<TestFailure[]> {
    try {
      const testResults = await this.readFile('test-results.json');
      const results = JSON.parse(testResults);

      const failures: TestFailure[] = [];

      // Parse Vitest JSON format
      if (results.testResults) {
        for (const suite of results.testResults) {
          if (suite.status === 'failed') {
            for (const test of suite.assertionResults || []) {
              if (test.status === 'failed') {
                failures.push({
                  testName: test.title,
                  suiteName: suite.name,
                  errorMessage:
                    test.failureMessages?.join('\n') || 'Test failed',
                  filePath: suite.name,
                  location: test.location,
                });
              }
            }
          }
        }
      }

      return failures;
    } catch (error) {
      console.warn('Could not parse test results JSON:', error.message);
      return [];
    }
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

**JSON-Based Analysis & Resolution**:

1. **Parse JSON Results**: Read `test-results.json` for structured failure data
2. **Categorize Failures**: Group by error type, file, or test suite
3. **Analyze Root Cause**: Use structured error messages and stack traces
4. **Fix Implementation**: Update code to pass failing tests
5. **Update Test**: If requirements changed or test is outdated
6. **Verify Coverage**: Ensure coverage thresholds met

**Automated Fixing Strategy**:

```typescript
private async fixTestFailures(failures: TestFailure[]): Promise<void> {
  // Group failures by file for efficient fixing
  const failuresByFile = this.groupFailuresByFile(failures);

  for (const [filePath, fileFailures] of Object.entries(failuresByFile)) {
    console.log(`🔧 Fixing ${fileFailures.length} test failures in ${filePath}`);

    // Analyze error patterns
    const errorPatterns = this.analyzeErrorPatterns(fileFailures);

    // Apply targeted fixes based on common patterns
    await this.applyAutomaticFixes(filePath, errorPatterns);

    // Re-run tests for this file to verify fixes
    await this.runTestsForFile(filePath);
  }
}
```

**Common Test Error Patterns & Auto-Fixes**:

- **Import/Module Errors**: Fix import paths and module resolution
- **Type Assertion Failures**: Add proper type guards and assertions
- **Async/Promise Issues**: Add proper await/async handling
- **Mock/Stub Problems**: Update mocks to match new interfaces
- **Database/Setup Issues**: Ensure proper test database setup

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
**`--timeout [ms]`**: Override test timeout (default: 300000ms/5min)

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

## Practical Implementation

### Manual Validation Command Sequence

```bash
#!/bin/bash
# validate-code.sh - Comprehensive validation with JSON test output

set -e  # Exit on first error

echo "🔍 Starting comprehensive code validation..."

# 1. Type checking
echo "📝 Running TypeScript type check..."
npm run type-check

# 2. Linting
echo "🧹 Running ESLint..."
npm run lint

# 3. Tests with JSON output (long-running)
echo "🧪 Running test suite (this may take several minutes)..."
echo "   • Generating JSON output for failure analysis"
echo "   • Timeout set to 5 minutes"

# Run tests with JSON reporter, handling both success and failure
if npm test -- --reporter=json --outputFile=test-results.json --run; then
  echo "✅ All tests passed"
else
  echo "❌ Tests failed - analyzing results..."

  # Check if JSON file was created
  if [ -f "test-results.json" ]; then
    echo "📊 Test results saved to test-results.json for analysis"
    # Parse and display summary of failures
    node -e "
      try {
        const results = JSON.parse(require('fs').readFileSync('test-results.json', 'utf8'));
        if (results.numFailedTests > 0) {
          console.log(\`❌ \${results.numFailedTests} test(s) failed out of \${results.numTotalTests}\`);
          console.log(\`⏱️  Total time: \${(results.testResults?.reduce((acc, r) => acc + (r.endTime - r.startTime), 0) || 0)}ms\`);
        }
      } catch (e) {
        console.log('Could not parse test results');
      }
    "
  fi
  exit 1
fi

# 4. Build verification
echo "🏗️  Running build verification..."
npm run build

echo ""
echo "🎉 VALIDATION COMPLETE - All checks passed!"
echo ""
echo "📊 Summary:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ TypeScript: 0 errors, 0 warnings"
echo "✅ ESLint: 0 errors, 0 warnings"
echo "✅ Tests: All tests passing"
echo "✅ Build: Clean compilation"
echo ""
echo "🚀 Ready for review/merge"
```

### JSON Test Results Analysis

```bash
# Analyze test failures from JSON output
analyze_test_failures() {
  if [ ! -f "test-results.json" ]; then
    echo "No test results file found"
    return 1
  fi

  echo "🔍 Analyzing test failures..."

  # Extract failure information
  node -e "
    const results = JSON.parse(require('fs').readFileSync('test-results.json', 'utf8'));

    if (results.success) {
      console.log('✅ All tests passed');
      process.exit(0);
    }

    console.log(\`❌ \${results.numFailedTests} test(s) failed\`);
    console.log('');

    // Group failures by file
    const failuresByFile = {};

    if (results.testResults) {
      results.testResults.forEach(suite => {
        if (suite.status === 'failed' && suite.message) {
          const file = suite.name || 'unknown';
          if (!failuresByFile[file]) failuresByFile[file] = [];
          failuresByFile[file].push(suite.message);
        }
      });
    }

    // Display grouped failures
    Object.entries(failuresByFile).forEach(([file, failures]) => {
      console.log(\`🔴 \${file}:\`);
      failures.forEach((failure, i) => {
        console.log(\`  \${i + 1}. \${failure.split('\\n')[0]}\`);
      });
      console.log('');
    });
  "
}

# Quick validation without build (for development)
quick_validate() {
  echo "⚡ Running quick validation (no build)..."
  npm run type-check && npm run lint && echo "✅ Quick validation passed"
}
```

## Best Practices

1. **Run Early**: Don't wait until end to validate
2. **Fix Incrementally**: Address issues as they appear
3. **Understand Errors**: Don't just silence warnings
4. **Maintain Standards**: Keep coverage and quality high
5. **Document Decisions**: Note any exceptions in comments
6. **Monitor Test Duration**: Use JSON output to track slow tests
7. **Incremental Testing**: Run specific test files during development
