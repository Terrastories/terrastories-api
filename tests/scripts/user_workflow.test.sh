#!/bin/bash

set -euo pipefail

SCRIPT_PATH="$(pwd)/scripts/user_workflow.sh"
TOTAL_TESTS=0
PASSED_TESTS=0

run_test() {
    local name="$1"
    shift
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if "$@"; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        printf '✓ %s\n' "$name"
    else
        printf '✗ %s\n' "$name"
    fi
}

help_contains() {
    local output
    output=$(bash "$SCRIPT_PATH" --help 2>&1)
    grep -q -- "$1" <<<"$output"
}

script_contains() {
    grep -q -- "$1" "$SCRIPT_PATH"
}

invalid_argument_rejected() {
    local output
    if output=$(bash "$SCRIPT_PATH" definitely-not-a-workflow 2>&1); then
        return 1
    fi
    grep -q 'Unknown option: definitely-not-a-workflow' <<<"$output"
}

printf 'Running user_workflow.sh contract tests...\n\n'

run_test 'Script has valid Bash syntax' bash -n "$SCRIPT_PATH"
run_test '--help documents super-admin-setup' help_contains 'super-admin-setup'
run_test '--help documents community-admin-flow' help_contains 'community-admin-flow'
run_test '--help documents community-user-mgmt' help_contains 'community-user-mgmt'
run_test '--help documents community-viewer-flow' help_contains 'community-viewer-flow'
run_test '--help documents interactive-map-flow' help_contains 'interactive-map-flow'
run_test '--help documents content-management' help_contains 'content-management'
run_test '--help documents data-sovereignty' help_contains 'data-sovereignty'
run_test '--help documents --all' help_contains '--all'
run_test 'Invalid workflow arguments fail closed' invalid_argument_rejected
run_test 'super_admin_setup_flow is implemented' script_contains '^super_admin_setup_flow()'
run_test 'community_admin_content_flow is implemented' script_contains '^community_admin_content_flow()'
run_test 'community_user_management_test is implemented' script_contains '^community_user_management_test()'
run_test 'community_viewer_access_flow is implemented' script_contains '^community_viewer_access_flow()'
run_test 'interactive_map_experience_flow is implemented' script_contains '^interactive_map_experience_flow()'
run_test 'content_management_flow is implemented' script_contains '^content_management_flow()'
run_test 'data_sovereignty_validation_flow is implemented' script_contains '^data_sovereignty_validation_flow()'
run_test 'complete workflow runner is implemented' script_contains '^run_complete_workflow()'

printf '\nTest Summary:\nTotal tests: %d\nPassed: %d\nFailed: %d\n' \
    "$TOTAL_TESTS" "$PASSED_TESTS" "$((TOTAL_TESTS - PASSED_TESTS))"

if [ "$PASSED_TESTS" -ne "$TOTAL_TESTS" ]; then
    exit 1
fi

printf '\nAll contract tests passed!\n'
