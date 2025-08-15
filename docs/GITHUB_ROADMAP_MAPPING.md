# GitHub Issues ↔ Roadmap Mapping

**Purpose**: Maintain alignment between GitHub Issues and ROADMAP.md items to prevent implementation mismatches.

## ⚠️ CRITICAL PROCESS

**Before starting ANY work**:

1. Verify GitHub issue matches roadmap item exactly
2. Report mismatches immediately
3. Do not proceed until alignment is confirmed

## Current Mapping Status

| GitHub Issue | Roadmap Item                                    | Status     | Notes                                              |
| ------------ | ----------------------------------------------- | ---------- | -------------------------------------------------- |
| #1           | Issue #1: Initialize TypeScript API project     | ✅ ALIGNED | Completed                                          |
| #3           | Multiple roadmap items (core schema)            | ❌ OPEN    | Database schema (Users, Stories, Places, Speakers) |
| #5           | Issue #3: Setup multi-environment configuration | ✅ MERGED  | Completed in PR #4, merged to main                 |

## Issue #3 Mismatch Details

**GitHub Issue #3**: `feat: implement core database schema for multi-tenant geostorytelling`

- **Scope**: Database schema implementation (Users, Stories, Places, Speakers, relations)
- **Acceptance Criteria**: 10 specific database-related criteria
- **Effort**: 2-3 days (Medium complexity)

**ROADMAP Issue #3**: `Setup multi-environment configuration system`

- **Scope**: Environment configuration (development, production, field-kit, offline)
- **Implementation**: Configuration files and validation system
- **Effort**: Different scope entirely

**Current Status**: PR #4 implements ROADMAP #3 but claims to close GitHub #3

## Resolution ✅ COMPLETED

**Action Taken**: Created new GitHub issue for configuration system, updated PR #4 to reference it

**Specific Changes**:

1. ✅ **Created Issue #5** for configuration system (matches PR #4 implementation)
2. ✅ **Updated PR #4** to reference Issue #5 instead of Issue #3
3. ✅ **Clarified Issue #3** remains open for original database schema requirements
4. ✅ **Closed Issue #5** as completed with PR #4

**Result**: Clean separation with correct issue/PR alignment

## Process Improvements

1. **Mandatory verification** steps added to CLAUDE.md workflow
2. **This mapping document** to track alignment
3. **Pre-work validation** to prevent future mismatches
4. **Regular audits** of issue/roadmap alignment

## Maintenance

- Update this document when new issues are created
- Verify alignment before starting any roadmap item
- Flag mismatches immediately in project comments
- Keep mapping current with issue status changes

---

**Last Updated**: 2025-08-15  
**Status**: ✅ Issue #3/PR #4 mismatch resolved, process improvements implemented
