# Task Completion Checklist

## MANDATORY: For Each Task

### 1. ANALYZE

- Read requirements completely
- Check existing code/patterns
- Identify dependencies
- ❓ ASK if anything unclear

### 2. PLAN

- Break into subtasks (max 30 min each)
- Write acceptance criteria
- Identify test scenarios
- Choose appropriate patterns

### 3. TEST FIRST

- Write failing test
- Run: `npm test [filename]`
- Verify test fails correctly
- Never skip this step

### 4. CODE

- Implement minimum to pass test
- Add types (no 'any')
- Handle errors properly
- Follow existing patterns

### 5. VERIFY (ALL must pass)

□ `npm test [file]` # Test passes
□ `npm run type-check` # No TS errors
□ `npm run lint` # No lint errors
□ `npm run dev` # Server runs
□ Manual test # Feature works

### 6. REFACTOR

- Improve code quality
- Add comments for "why"
- Ensure tests still pass

### 7. COMMIT

- Stage files: `git add [files]`
- Commit: `git commit -m "type(scope): message"`
- Types: feat|fix|docs|test|chore|refactor

### 8. TRACK

- Update issue checkboxes
- Comment any blockers
- Note decisions made

## STOP Conditions

STOP and ask for help if:

- Test won't pass after 3 attempts
- TypeScript errors unclear
- Unsure about architectural decision
- Breaking existing functionality
