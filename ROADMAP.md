# Terrastories Migration Roadmap

## Current Focus: Backend API Migration (TypeScript)

We are currently executing the **Backend TypeScript API Migration** to modernize the Rails backend while maintaining full compatibility with the existing React-Rails hybrid frontend.

### 📍 Active Roadmap: [docs/ISSUES_ROADMAP.md](./docs/ISSUES_ROADMAP.md)

- 65+ structured issues across 13+ phases (expanded from feedback analysis)
- Each issue maps to GitHub issues for tracking
- Currently on **Phase 1: Foundation & Infrastructure** (40% complete)

### 🔮 Future: Frontend Separation

Once the backend migration is complete, we'll proceed with frontend modernization:

- Reference: [docs/FRONTEND_MIGRATION_GUIDE.md](./docs/FRONTEND_MIGRATION_GUIDE.md)
- Standalone React application with modern tooling
- State management (Zustand/Redux Toolkit)
- Maintained offline-first capabilities

## Migration Strategy

### Phase A: Backend API (Current) 🚧

**Timeline**: 7-8 months (updated from 3-4 months)  
**Goal**: Replace Rails backend with TypeScript API  
**Approach**: Follow [docs/ISSUES_ROADMAP.md](./docs/ISSUES_ROADMAP.md)  
**Status**: Phase 1 - 40% complete (Issues #1, #5 done; #2, #4, #6 remaining)

**Critical Priority Changes**:

- **PostGIS Integration**: Moved to Phase 1 (foundational requirement)
- **Data Sovereignty Validation**: Added to Phase 2 (cannot be assumed)
- **Offline-First Design**: Integrated from Phase 1 (affects all decisions)
- **ActiveStorage Migration**: Dedicated phase for complexity management

### Phase B: Frontend Separation (Future)

**Timeline**: 3-4 months (updated for complexity)  
**Goal**: Extract React from Rails into standalone app  
**Approach**: Follow [docs/FRONTEND_MIGRATION_GUIDE.md](./docs/FRONTEND_MIGRATION_GUIDE.md)

### Phase C: Community Validation & Production Deployment

**Timeline**: 2-3 months  
**Goal**: Indigenous community testing, production deployment, and stability
**Includes**: Cultural protocol validation, offline scenario testing, performance optimization

## Quick Links

- **Current Sprint**: Check [GitHub Issues](https://github.com/Terrastories/terrastories-api/issues)
- **Backend Progress**: See [docs/ISSUES_ROADMAP.md](./docs/ISSUES_ROADMAP.md)
- **Frontend Plans**: See [docs/FRONTEND_MIGRATION_GUIDE.md](./docs/FRONTEND_MIGRATION_GUIDE.md)
- **Architecture Context**: See [docs/TERRASTORIES_CONTEXT.md](./docs/TERRASTORIES_CONTEXT.md)
- **Setup Guide**: See [docs/SETUP.md](./docs/SETUP.md)

## Critical Migration Insights (Based on Analysis)

### 🚨 Key Realizations

1. **PostGIS is Foundational**: Geographic data is core to Terrastories identity, not optional
2. **Offline-First Affects Everything**: Must be designed from Phase 1, not added later
3. **Data Sovereignty Cannot Be Assumed**: Requires dedicated validation and testing
4. **ActiveStorage Complexity**: Polymorphic associations need careful migration strategy
5. **Cultural Sensitivity**: Missing from original roadmap, essential for Indigenous communities

### ⚠️ Current Issue Status

- **Issue #6**: PostgreSQL/PostGIS setup (in progress, correctly prioritized)
- **Issue #7**: Testing infrastructure (open, Phase 1 requirement)
- **Issue #3**: Database schema (open, but should wait for PostGIS completion)

### 📈 Revised Velocity Targets

- **Phase 1-3**: Foundation with spatial & offline (6 weeks instead of 4)
- **Phase 4-6**: Core features with sovereignty validation (8 weeks instead of 6)
- **Phase 7-12**: Advanced features with community testing (16 weeks)
- **Total**: 30-32 weeks (7-8 months) for production-ready system

---

## Success Metrics

### Technical Metrics

- **Foundation Complete**: PostGIS spatial system, offline-first data structures, multi-environment config
- **API Parity**: Full feature compatibility with Rails API including cultural protocols
- **Performance**: ≤ 200ms response times, 99.9% uptime, optimized spatial queries
- **Testing**: ≥ 80% coverage with data sovereignty validation suite
- **Documentation**: Complete API docs, cultural sensitivity guides, offline deployment instructions

### Community-Centric Metrics

- **Data Sovereignty**: 100% validation that super admins cannot access community data
- **Cultural Protocols**: Elder knowledge protection, restricted content management
- **Offline Capability**: Field Kit deployment working in remote areas
- **Indigenous Community Validation**: Successful testing with actual community partners
- **Internationalization**: Support for 6 languages including Indigenous languages

**Last Updated**: 2025-08-15  
**Next Review**: After PostGIS and offline-first foundation completion
