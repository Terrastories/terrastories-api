#!/bin/bash

set -e

# GitHub Actions Runner Toggle Script
# Toggles between ubuntu-latest and self-hosted runners

WORKFLOWS_DIR=".github/workflows"
UBUNTU_RUNNER="ubuntu-latest"
SELF_HOSTED_RUNNER="self-hosted"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to display usage
usage() {
    echo "Usage: $0 [ubuntu|self-hosted|status]"
    echo ""
    echo "Commands:"
    echo "  ubuntu      Switch all workflows to use ubuntu-latest runners"
    echo "  self-hosted Switch all workflows to use self-hosted runners"
    echo "  status      Show current runner configuration"
    echo ""
    exit 1
}

# Function to check if workflows directory exists
check_workflows_dir() {
    if [ ! -d "$WORKFLOWS_DIR" ]; then
        echo -e "${RED}Error: $WORKFLOWS_DIR directory not found${NC}"
        echo "Make sure you're running this script from the repository root"
        exit 1
    fi
}

# Function to get current runner status
get_status() {
    echo -e "${YELLOW}Current GitHub Actions runner configuration:${NC}"
    echo ""
    
    if [ ! -d "$WORKFLOWS_DIR" ]; then
        echo -e "${RED}No workflows directory found${NC}"
        return
    fi
    
    local ubuntu_count=0
    local self_hosted_count=0
    
    for file in "$WORKFLOWS_DIR"/*.yml "$WORKFLOWS_DIR"/*.yaml; do
        if [ -f "$file" ]; then
            local filename=$(basename "$file")
            local ubuntu_lines=$(grep -c "runs-on: $UBUNTU_RUNNER" "$file" 2>/dev/null || echo "0")
            local self_hosted_lines=$(grep -c "runs-on: $SELF_HOSTED_RUNNER" "$file" 2>/dev/null || echo "0")
            
            # Ensure we have valid integers
            ubuntu_lines=${ubuntu_lines//[^0-9]/}
            self_hosted_lines=${self_hosted_lines//[^0-9]/}
            ubuntu_lines=${ubuntu_lines:-0}
            self_hosted_lines=${self_hosted_lines:-0}
            
            if [ "$ubuntu_lines" -gt 0 ] || [ "$self_hosted_lines" -gt 0 ]; then
                if [ "$ubuntu_lines" -gt 0 ] && [ "$self_hosted_lines" -gt 0 ]; then
                    echo "  $filename: MIXED ($ubuntu_lines ubuntu, $self_hosted_lines self-hosted)"
                elif [ "$ubuntu_lines" -gt 0 ]; then
                    echo "  $filename: ubuntu-latest ($ubuntu_lines jobs)"
                    ubuntu_count=$((ubuntu_count + ubuntu_lines))
                elif [ "$self_hosted_lines" -gt 0 ]; then
                    echo "  $filename: self-hosted ($self_hosted_lines jobs)"
                    self_hosted_count=$((self_hosted_count + self_hosted_lines))
                fi
            fi
        fi
    done
    
    echo ""
    echo -e "Summary: ${GREEN}$ubuntu_count${NC} ubuntu jobs, ${GREEN}$self_hosted_count${NC} self-hosted jobs"
}

# Function to switch runners
switch_runners() {
    local target_runner="$1"
    local source_runner="$2"
    
    echo -e "${YELLOW}Switching from $source_runner to $target_runner...${NC}"
    echo ""
    
    local changed_files=0
    
    for file in "$WORKFLOWS_DIR"/*.yml "$WORKFLOWS_DIR"/*.yaml; do
        if [ -f "$file" ]; then
            local filename=$(basename "$file")
            
            # Check if file contains the source runner
            if grep -q "runs-on: $source_runner" "$file"; then
                echo "  Updating $filename..."
                
                # Create backup
                cp "$file" "$file.bak"
                
                # Replace runners
                sed -i "s/runs-on: $source_runner/runs-on: $target_runner/g" "$file"
                
                # Verify the change was made
                if grep -q "runs-on: $target_runner" "$file"; then
                    echo -e "    ${GREEN}✓${NC} Successfully updated"
                    rm "$file.bak"
                    changed_files=$((changed_files + 1))
                else
                    echo -e "    ${RED}✗${NC} Update failed, restoring backup"
                    mv "$file.bak" "$file"
                fi
            fi
        fi
    done
    
    echo ""
    if [ "$changed_files" -gt 0 ]; then
        echo -e "${GREEN}Successfully updated $changed_files workflow files${NC}"
        echo ""
        echo "Changed files:"
        git diff --name-only "$WORKFLOWS_DIR"
    else
        echo -e "${YELLOW}No files needed updating (already using $target_runner)${NC}"
    fi
}

# Function to switch to ubuntu runners
switch_to_ubuntu() {
    switch_runners "$UBUNTU_RUNNER" "$SELF_HOSTED_RUNNER"
}

# Function to switch to self-hosted runners
switch_to_self_hosted() {
    switch_runners "$SELF_HOSTED_RUNNER" "$UBUNTU_RUNNER"
}

# Main script logic
main() {
    check_workflows_dir
    
    case "$1" in
        "ubuntu")
            switch_to_ubuntu
            ;;
        "self-hosted")
            switch_to_self_hosted
            ;;
        "status")
            get_status
            ;;
        *)
            echo -e "${RED}Invalid command: $1${NC}"
            echo ""
            usage
            ;;
    esac
}

# Run main function with all arguments
main "$@"