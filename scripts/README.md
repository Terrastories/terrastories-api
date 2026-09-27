# Terrastories API User Workflow Testing

## Overview

This script provides comprehensive testing of the Terrastories API by simulating different user flows and testing all major endpoints. It's designed to match the frontend calls documented in `@docs/FRONTEND_CALLS.md` but adapted for the TypeScript API.

## Quick Start

```bash
# Make executable (first time only)
chmod +x scripts/user_workflow.sh

# Run interactive menu
./scripts/user_workflow.sh

# Or run specific flow directly
./scripts/user_workflow.sh 11  # Sequential demo
./scripts/user_workflow.sh 1   # Complete journey
```

## Available User Flows

### 🌊 **Option 11: All Flows Sequential (RECOMMENDED)**

**The complete demonstration showing the entire user journey in logical order:**

**Phase 1: System Health & Public Access**

- Anonymous access testing
- Health checks and public endpoints

**Phase 2: Super Admin Operations**

- Community management capabilities
- Data sovereignty enforcement testing

**Phase 3: Content Creation**

- Community admin content creation
- Elder cultural content management

**Phase 4: Specialized Operations**

- Media upload and management
- Geographic search and places
- Story management with cultural protocols
- Theme and map configuration

**Phase 5: User Access Validation**

- Viewer read-only access restrictions
- Permission validation across roles

### Individual Flows

1. **Complete User Journey** - Single user testing all features
2. **Super Admin Flow** - Community management and data sovereignty
3. **Community Admin Flow** - Content creation and management
4. **Viewer Flow** - Read-only access with permission testing
5. **Elder Flow** - Cultural content and protocol management
6. **Anonymous Flow** - Public content access testing
7. **Media Upload Flow** - Various upload scenarios
8. **Geographic Flow** - Places and spatial search testing
9. **Story Management Flow** - Cultural protocols and permissions
10. **Theme Configuration Flow** - Map themes and settings

## Features

### 🎨 Visual Output

- Colorized terminal output with emojis
- Clear section dividers and progress indicators
- Success/failure indicators with detailed feedback

### 🔍 Comprehensive Testing

- **Authentication**: Registration, login, logout, password reset
- **Authorization**: Role-based access control, data sovereignty
- **Content Management**: Stories, places, speakers with cultural protocols
- **Media Handling**: Upload with cultural restrictions
- **Geographic Operations**: Spatial search, bounds queries
- **Theme Management**: Map configuration and validation

### 📊 Results Tracking

- Success/failure tracking across all flows
- Detailed error reporting with API responses
- Integration readiness assessment
- Comprehensive summary reports

## Usage Examples

### Interactive Demo (Recommended)

```bash
./scripts/user_workflow.sh
# Select option 11 for the complete sequential demonstration
```

### Automated Testing

```bash
# Test specific functionality
./scripts/user_workflow.sh 8  # Geographic features only
./scripts/user_workflow.sh 4  # Viewer permissions only

# Full sequential demo (non-interactive)
./scripts/user_workflow.sh 11
```

### Development Workflow

```bash
# After implementing a new feature, test relevant flow
./scripts/user_workflow.sh 7  # After implementing media upload
./scripts/user_workflow.sh 9  # After implementing cultural protocols
```

## Requirements

- **API Server**: Must be running at `http://localhost:3000`
- **Database**: Functional database connection
- **Dependencies**: `curl`, `jq` for JSON parsing
- **Default Community**: Community ID 1 should exist

## Output

The script provides detailed feedback including:

- ✅ Success indicators with operation details
- ❌ Error messages with API response details
- ⚠️ Warnings for optional features not yet implemented
- 📊 Summary statistics and integration readiness assessment

## Integration Ready Checklist

When Option 11 completes successfully, you'll see:

- ✅ Authentication & Authorization
- ✅ Content Management (Stories, Places, Speakers)
- ✅ Media Upload & Management
- ✅ Geographic Operations & Spatial Search
- ✅ Cultural Protocols & Permissions
- ✅ Theme & Map Configuration
- ✅ Data Sovereignty & Community Isolation
- ✅ Role-Based Access Control

## Troubleshooting

### Common Issues

1. **Health check failed**: Ensure API server is running with `npm run dev`
2. **Database errors**: Check database connection and migrations
3. **Permission denied**: Ensure script is executable with `chmod +x`
4. **JSON parsing errors**: Install `jq` package

### Development Notes

- The script creates temporary test data that accumulates over runs
- Each flow uses unique email addresses to avoid conflicts
- Session cookies are managed automatically
- All flows include proper cleanup procedures
