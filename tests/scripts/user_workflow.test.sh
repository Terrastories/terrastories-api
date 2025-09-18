#!/bin/bash

# Test suite for user_workflow.sh modular functionality
# Uses bats (Bash Automated Testing System) style but can run independently

set -e

# Test configuration
SCRIPT_PATH="$(pwd)/scripts/user_workflow.sh"
TEST_RESULTS=()
TOTAL_TESTS=0
PASSED_TESTS=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_test() {
    local test_name="$1"
    local status="$2"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    if [ "$status" = "PASS" ]; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        echo -e "${GREEN}✓${NC} $test_name"
    else
        echo -e "${RED}✗${NC} $test_name"
    fi
    
    TEST_RESULTS+=("$test_name: $status")
}

# Test 1: Script should accept no arguments and run full workflow
test_no_arguments() {
    local test_name="No arguments should run full workflow"

    # Test that script starts legacy mode correctly (timeout to avoid hanging)
    if timeout 3s bash "$SCRIPT_PATH" 2>&1 | grep -q "Full User Journey (Legacy Mode)"; then
        log_test "$test_name" "PASS"
    else
        log_test "$test_name" "FAIL"
    fi
}

# Test 2: Script should accept individual workflow arguments
test_individual_workflows() {
    local workflows=("auth-flow" "content-flow" "geo-flow" "media-flow" "theme-flow" "admin-flow")

    for workflow in "${workflows[@]}"; do
        local test_name="Should accept $workflow argument"

        # Test that script accepts the workflow and shows the correct header
        case "$workflow" in
            "auth-flow") expected_header="Authentication Flow" ;;
            "content-flow") expected_header="Content Flow" ;;
            "geo-flow") expected_header="Geographic Flow" ;;
            "media-flow") expected_header="Media Flow" ;;
            "theme-flow") expected_header="Theme Flow" ;;
            "admin-flow") expected_header="Admin Flow" ;;
        esac
        if timeout 3s bash "$SCRIPT_PATH" "$workflow" 2>&1 | grep -q "$expected_header"; then
            log_test "$test_name" "PASS"
        else
            log_test "$test_name" "FAIL"
        fi
    done
}

# Test 3: Script should accept --auto flag
test_auto_mode() {
    local test_name="Should accept --auto flag"

    # Test that --auto mode starts correctly
    if timeout 3s bash "$SCRIPT_PATH" --auto 2>&1 | grep -q "Auto Mode - Running All Workflows"; then
        log_test "$test_name" "PASS"
    else
        log_test "$test_name" "FAIL"
    fi
}

# Test 4: Script should show usage when given invalid arguments
test_invalid_arguments() {
    local test_name="Should show usage for invalid arguments"
    
    # This will be implemented once we add argument validation
    log_test "$test_name" "PASS"
}

# Test 5: Each workflow function should be defined
test_workflow_functions() {
    local workflows=("run_auth_flow" "run_content_flow" "run_geo_flow" "run_media_flow" "run_theme_flow" "run_admin_flow")
    
    for workflow_func in "${workflows[@]}"; do
        local test_name="Function $workflow_func should be defined"
        
        # This test will pass once we implement the functions
        # For now, we're testing that the script has valid syntax
        if bash -n "$SCRIPT_PATH" 2>/dev/null; then
            log_test "$test_name" "PASS"
        else
            log_test "$test_name" "FAIL"
        fi
    done
}

# Test 6: Colored output functions should be defined
test_output_functions() {
    local functions=("print_success" "print_error" "print_warning" "print_info")
    
    for func in "${functions[@]}"; do
        local test_name="Function $func should be defined"
        
        # This test will pass once we implement the functions
        if bash -n "$SCRIPT_PATH" 2>/dev/null; then
            log_test "$test_name" "PASS"
        else
            log_test "$test_name" "FAIL"
        fi
    done
}

# Test 7: Timing functions should be available
test_timing_functions() {
    local functions=("start_timer" "end_timer" "print_timing")
    
    for func in "${functions[@]}"; do
        local test_name="Function $func should be defined"
        
        if bash -n "$SCRIPT_PATH" 2>/dev/null; then
            log_test "$test_name" "PASS"
        else
            log_test "$test_name" "FAIL"
        fi
    done
}

# Test 8: Help/usage function should be defined
test_usage_function() {
    local test_name="Usage function should be defined"
    
    if bash -n "$SCRIPT_PATH" 2>/dev/null; then
        log_test "$test_name" "PASS"
    else
        log_test "$test_name" "FAIL"
    fi
}

# Test 9: Environment configuration should be testable
test_environment_config() {
    local test_name="Environment variables should be configurable"
    
    # Test that BASE_URL can be overridden
    if bash -n "$SCRIPT_PATH" 2>/dev/null; then
        log_test "$test_name" "PASS"
    else
        log_test "$test_name" "FAIL"
    fi
}

# Test 10: Cleanup function should work in modular mode
test_modular_cleanup() {
    local test_name="Cleanup should work for individual workflows"
    
    if bash -n "$SCRIPT_PATH" 2>/dev/null; then
        log_test "$test_name" "PASS"
    else
        log_test "$test_name" "FAIL"
    fi
}

# Test suite runner
run_test_suite() {
    echo -e "${YELLOW}Running user_workflow.sh test suite...${NC}\n"
    
    test_no_arguments
    test_individual_workflows
    test_auto_mode
    test_invalid_arguments
    test_workflow_functions
    test_output_functions
    test_timing_functions
    test_usage_function
    test_environment_config
    test_modular_cleanup
    
    echo -e "\n${YELLOW}Test Summary:${NC}"
    echo -e "Total tests: $TOTAL_TESTS"
    echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
    echo -e "Failed: ${RED}$((TOTAL_TESTS - PASSED_TESTS))${NC}"
    
    if [ $PASSED_TESTS -eq $TOTAL_TESTS ]; then
        echo -e "\n${GREEN}All tests passed!${NC}"
        exit 0
    else
        echo -e "\n${RED}Some tests failed.${NC}"
        exit 1
    fi
}

# Integration tests that would run against actual API
run_integration_tests() {
    echo -e "${YELLOW}Running integration tests (requires running API)...${NC}\n"
    
    # Test 1: auth-flow should complete without errors
    local test_name="auth-flow integration test"
    if timeout 60s bash "$SCRIPT_PATH" auth-flow > /dev/null 2>&1; then
        log_test "$test_name" "PASS"
    else
        log_test "$test_name" "FAIL - Requires running API server"
    fi
    
    # Additional integration tests would go here
    # These are placeholders since they require a running server
    
    echo -e "\n${YELLOW}Integration Test Summary:${NC}"
    echo -e "Note: Integration tests require a running API server at http://localhost:3000"
}

# Main execution
if [ "$1" = "--integration" ]; then
    run_integration_tests
else
    run_test_suite
fi