# Terrastories Migration Roadmap

## Current Focus: Backend API Migration (TypeScript)

We are currently executing the **Backend TypeScript API Migration** to modernize the Rails backend while maintaining full compatibility with the existing React-Rails hybrid frontend.

### 📍 Active Roadmap: [docs/ISSUES_ROADMAP.md](./docs/ISSUES_ROADMAP.md)

- 25 structured issues across 6 phases (Rails API parity focused)
- Each issue maps to GitHub issues for tracking
- **Phase 1 COMPLETED** ✅ Foundation & Infrastructure (Issues #1, #5, #6, #7)
- **Phase 2 COMPLETED** ✅ Schema & Data Layer Definition (Issue #3 completed in PR #25)

### 🔮 Future: Frontend Separation

Once the backend migration is complete, we'll proceed with frontend modernization:

- Reference: [docs/FRONTEND_MIGRATION_GUIDE.md](./docs/FRONTEND_MIGRATION_GUIDE.md)
- Standalone React application with modern tooling
- State management (Zustand/Redux Toolkit)
- Maintained offline-first capabilities

## Migration Strategy

### Phase A: Backend API (Current) 🚧

**Goal**: Replace Rails backend with TypeScript API
**Approach**: Follow the detailed roadmap for issue-by-issue progress.
**Status**: ✅ **IN PROGRESS** - See our detailed progress tracker: **[Active Backend Roadmap](./docs/ISSUES_ROADMAP.md)**

**Critical Priority Changes**:

- **PostGIS Integration**: Moved to Phase 1 (foundational requirement)
- **Data Sovereignty Validation**: Added to Phase 2 (cannot be assumed)
- **Offline-First Design**: Integrated from Phase 1 (affects all decisions)
- **ActiveStorage Migration**: Dedicated phase for complexity management

### Phase B: Frontend Separation (Future)

**Goal**: Extract React from Rails into standalone app
**Approach**: Follow [docs/FRONTEND_MIGRATION_GUIDE.md](./docs/FRONTEND_MIGRATION_GUIDE.md)

### Phase C: Community Validation & Production Deployment

**Goal**: Indigenous community testing, production deployment, and stability
**Includes**: Cultural protocol validation, offline scenario testing, performance optimization

## Quick Links

- **Current Sprint**: Check [GitHub Issues](https://github.com/Terrastories/terrastories-api/issues)
- **Backend Progress**: See [docs/ISSUES_ROADMAP.md](./docs/ISSUES_ROADMAP.md)
- **Frontend Plans**: See [docs/FRONTEND_MIGRATION_GUIDE.md](./docs/FRONTEND_MIGRATION_GUIDE.md)
- **Setup Guide**: See [docs/SETUP.md](./docs/SETUP.md)

## Critical Migration Insights (Based on Analysis)

### 🚨 Key Realizations

1. **PostGIS is Foundational**: Geographic data is core to Terrastories identity, not optional
2. **Offline-First Affects Everything**: Must be designed from Phase 1, not added later
3. **Data Sovereignty Cannot Be Assumed**: Requires dedicated validation and testing
4. **ActiveStorage Complexity**: Polymorphic associations need careful migration strategy
5. **Cultural Sensitivity**: Missing from original roadmap, essential for Indigenous communities

### 📈 Updated Velocity Targets

Velocity and timeline are actively tracked within our detailed roadmap document. Please refer to **[Active Backend Roadmap](./docs/ISSUES_ROADMAP.md)** for the most current estimates.

---

## Success Metrics

### Technical Metrics

- **Foundation Complete** ✅: PostGIS spatial system, multi-environment config, testing infrastructure
- **API Parity** (IN PROGRESS): Full feature compatibility with Rails API
- **Performance**: ≤ 200ms response times, optimized spatial queries
- **Testing**: ≥ 80% coverage (currently maintained)
- **Documentation**: Complete API docs with deployment guides

### Community-Centric Metrics

- **Data Sovereignty**: 100% validation that super admins cannot access community data
- **Cultural Protocols**: Elder knowledge protection, restricted content management
- **Offline Capability**: Field Kit deployment working in remote areas
- **Indigenous Community Validation**: Successful testing with actual community partners
- **Internationalization**: Support for 6 languages including Indigenous languages

**Last Updated**: 2025-08-20
**Next Review**: After Phase 2 Schema & Data Layer completion
