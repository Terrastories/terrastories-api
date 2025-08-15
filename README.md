# Terrastories API

[![Build Status](https://github.com/terrastories/terrastories-api/workflows/CI/badge.svg)](https://github.com/terrastories/terrastories-api/actions)
[![Coverage Status](https://codecov.io/gh/terrastories/terrastories-api/branch/main/graph/badge.svg)](https://codecov.io/gh/terrastories/terrastories-api)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-black.svg)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-13+-blue.svg)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![Indigenous Data Sovereignty](https://img.shields.io/badge/Indigenous%20Data-Sovereignty-purple.svg)](https://www.gida-global.org/care)

**Terrastories API** is an open-source geostorytelling backend service built with TypeScript. It empowers Indigenous communities to map, manage, and preserve their oral histories, traditional stories, and cultural knowledge tied to specific geographic locations.

> "Every place has a story, and every story deserves to be preserved for future generations."

## About

Terrastories API provides the robust backend infrastructure for the Terrastories platform, enabling communities to:

🗺️ **Map Stories to Places** - Connect oral histories and traditional knowledge to specific geographic locations  
🏛️ **Preserve Cultural Heritage** - Archive stories, photos, audio, and video in a secure, community-controlled environment  
🌐 **Work Offline** - Access and contribute content even in remote areas with limited internet connectivity  
🔒 **Maintain Data Sovereignty** - Communities retain full control over their cultural data and who can access it  
👥 **Collaborate Safely** - Role-based permissions ensure sensitive stories are shared appropriately  
📱 **Enable Multi-Platform Access** - RESTful API supports all platforms

### Built for Communities, by Communities

This project emerged from direct collaboration with Indigenous communities worldwide who needed a platform that respects their protocols around cultural knowledge sharing while providing modern digital tools for preservation and education.

## Key Features

### 🏗️ **Community-First Architecture**

- **Multi-tenant by Design** - Each community operates in a secure, isolated environment
- **Flexible Permissions** - Granular role-based access control respects cultural protocols
- **Data Sovereignty** - Communities own and control their data completely

### 🌍 **Geographic Storytelling**

- **Spatial Data Management** - PostGIS-powered geographic queries and mapping
- **Place-Based Stories** - Link narratives to specific locations with precision
- **Regional Organization** - Organize content by traditional territories and boundaries

### 📱 **Offline-First Design**

- **Remote Area Support** - Full functionality without internet connectivity
- **Smart Synchronization** - Intelligent conflict resolution for concurrent edits
- **Progressive Enhancement** - Graceful degradation from online to offline modes

### 🎬 **Rich Media Support**

- **Audio Stories** - High-quality audio recording and playback
- **Video Content** - Support for traditional ceremonies and demonstrations
- **Photo Archives** - Historical and contemporary image collections
- **Document Storage** - Traditional texts, translations, and written materials

## Technical Overview

### Core Technologies

```
🚀 Runtime:     Node.js 18+ with TypeScript 5.7
⚡ Framework:   Fastify 5 (high-performance, low overhead)
🗄️ Database:    PostgreSQL 13+ with PostGIS spatial extension
🔍 ORM:         Drizzle (type-safe, performant queries)
✅ Validation:  Zod (runtime type checking & API schemas)
🧪 Testing:     Vitest (fast, modern test runner)
📋 Docs:        OpenAPI/Swagger (auto-generated from schemas)
```

### Architecture Principles

- **Type Safety First** - Strict TypeScript with no `any` types
- **API-First Design** - RESTful endpoints with comprehensive documentation
- **Performance Optimized** - Sub-100ms response times for most operations
- **Security Hardened** - JWT authentication, input validation, SQL injection prevention
- **Developer Friendly** - Hot reloading, comprehensive testing, clear error messages

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL 13+ with PostGIS extension
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/terrastories/terrastories-api.git
cd terrastories-api

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your database credentials and JWT secret

# Initialize the database
npm run db:migrate
npm run db:seed  # Optional: add sample data

# Start development server with hot reloading
npm run dev

# 🎉 Server is running at http://localhost:3000
# 📚 Health check at http://localhost:3000/health
```

The API will be available at `http://localhost:3000` with health check at `/health`.

### Environment Configuration

Create a `.env` file in the project root:

```env
# Server Configuration
NODE_ENV=development
PORT=3000
HOST=localhost

# Database Connection
DATABASE_URL=postgresql://username:password@localhost:5432/terrastories_dev

# Authentication
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
JWT_EXPIRES_IN=7d

# Media Storage (optional)
S3_BUCKET=terrastories-media
S3_REGION=us-west-2
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key

# Logging
LOG_LEVEL=debug
LOG_FORMAT=pretty

# Feature Flags
ENABLE_SWAGGER_UI=true
ENABLE_METRICS=true
ENABLE_RATE_LIMITING=false
```

> ⚠️ **Security Note**: Never commit `.env` files to version control. Use strong, unique secrets in production.

## Development Guide

### Project Structure

```
src/
├── server.ts          # Fastify setup and plugins
├── routes/            # API route handlers with validation
├── services/          # Business logic layer
├── repositories/      # Data access layer
├── db/
│   ├── schema/        # Drizzle table definitions
│   └── migrations/    # Database migration files
└── shared/
    ├── types/         # Shared TypeScript types
    └── middleware/    # Auth and multi-tenancy middleware
```

### Available Scripts

```bash
# Development
npm run dev         # 🚀 Start development server with hot-reload

# Testing
npm test            # 🧪 Run test suite
npm run test:coverage # 📊 Run tests with coverage report

# Quality Assurance
npm run lint        # ✨ Run ESLint checks
npm run format      # 🎨 Format code with Prettier
npm run format:check # 🔍 Check formatting without changes
npm run type-check  # 🔍 TypeScript compilation check
npm run validate    # ✅ Run all checks (lint, type-check, test)

# Database
npm run db:generate # 📝 Generate new migration
npm run db:migrate  # 📊 Run pending migrations
npm run db:seed     # 🌱 Add sample data

# Production
npm run build       # 📦 Build for production
npm start           # ▶️ Start production server
```

### Development Workflow

1. **Analyze & Plan**: Understand requirements and break into subtasks
2. **Test First**: Write failing tests before implementation
3. **Code**: Implement with proper types and error handling
4. **Verify**: Run `npm run validate` before committing
5. **Commit**: Follow conventional commit format
6. **Review**: Create PR with tests passing

### API Conventions

- **Base URL**: `/api/v1`
- **Authentication**: Bearer token in Authorization header
- **Pagination**: `?page=1&limit=20`
- **Filtering**: Query parameters for resource filtering
- **Responses**: Consistent JSON structure with `data`, `meta`, and `error` fields

## Core Data Models

- **Community**: Tenant organization with locale settings
- **User**: Authentication and role-based access (super_admin, admin, editor, viewer)
- **Story**: Cultural narratives with media attachments
- **Place**: Geographic locations with spatial coordinates
- **Speaker**: Community storytellers and knowledge keepers
- **Relations**: Many-to-many mappings between stories, places, and speakers

## Testing

The project uses a comprehensive testing strategy:

- **Unit Tests**: Services and utilities with mocked dependencies
- **Integration Tests**: Route handlers with test database
- **End-to-End Tests**: Critical user workflows
- **Coverage Target**: Minimum 80% across all metrics

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm test -- --watch
```

## Database

### Migrations

```bash
# Generate new migration
npm run db:generate

# Run pending migrations
npm run db:migrate

# Seed database with sample data
npm run db:seed
```

### Spatial Data

The API leverages PostGIS for geographic functionality:

- Point-based place locations
- Polygon regions for administrative boundaries
- Spatial queries for proximity and containment
- Geographic indexing for performance

## API Documentation

### Interactive Documentation

When running the development server, comprehensive API documentation is available at:

- **🔍 Health Check**: `http://localhost:3000/health` - Server status
- **📋 Coverage Report**: `coverage/index.html` - Test coverage details (after running tests)

### Development Documentation

- ✅ **Code Examples** - Check `docs/examples/` for implementation patterns
- 🔍 **API Design** - TypeScript types and Zod schemas define contracts
- 📊 **Test Coverage** - Coverage reports generated after test runs
- ⚠️ **Error Handling** - Centralized error handling patterns
- 🌐 **Multi-tenancy** - Community-scoped data isolation
- 📋 **Migration Guide** - See `docs/MIGRATION.md` for Rails migration context

### Current API Endpoints

```
GET    /health                     # Health check endpoint

# Additional endpoints will be added as development progresses
# See docs/ISSUES_ROADMAP.md for planned API features
```

## Deployment

### Production Build

```bash
npm run build
npm start
```

### Docker

```bash
# Build image
docker build -t terrastories-api .

# Run container
docker run -p 3000:3000 -e DATABASE_URL=your-db-url terrastories-api
```

### Environment Considerations

- Set `NODE_ENV=production`
- Use secure JWT secrets
- Configure proper logging levels
- Set up database connection pooling
- Enable CORS for frontend domains

## Contributing

🚀 **We welcome contributions from developers, Indigenous community members, and anyone passionate about preserving cultural heritage through technology!**

### Ways to Contribute

- 🐛 **Report bugs** - Help us identify and fix issues
- 💡 **Suggest features** - Share ideas for new functionality
- 📝 **Improve documentation** - Make it easier for others to contribute
- 💻 **Submit code** - Fix bugs, add features, improve performance
- 🌍 **Localization** - Help translate the platform for global communities
- 🧑‍🏫 **Community outreach** - Connect with Indigenous communities who might benefit

### Development Prerequisites

- Familiarity with TypeScript and Node.js ecosystem
- Understanding of REST API design and OpenAPI specifications
- Basic knowledge of PostgreSQL and spatial data concepts
- Respect for Indigenous data sovereignty principles

### Code Standards

- ✅ **TypeScript strict mode** - No `any` types allowed
- 🧪 **Test coverage** - Minimum 80% across all metrics
- 📝 **Documentation** - All public APIs documented
- 🌈 **Accessibility** - Consider diverse user needs
- 🔒 **Security** - Follow OWASP guidelines

### Getting Started

1. **Fork the repository** and create a feature branch
2. **Read the docs** - Check `docs/` for detailed guides, especially `SETUP.md` and `MIGRATION.md`
3. **Join discussions** - Connect with maintainers and community
4. **Start small** - Look for "good first issue" labels
5. **Ask questions** - We're here to help!

### Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). We are committed to providing a welcoming and inclusive environment for all contributors, especially those from Indigenous communities whose knowledge and stories this platform serves.

## Architecture Decisions

### Multi-tenancy

Data isolation is achieved through:

- Community-scoped middleware for all routes
- Database-level constraints and indexes
- Repository pattern with automatic tenant filtering
- Service layer validation of cross-tenant access

### Security

Security measures include:

- JWT-based authentication
- Role-based authorization per community
- Input validation with Zod schemas
- SQL injection prevention through ORM
- Rate limiting and request validation

## Migration from Rails

This project is migrating from the original Rails Terrastories application. Key considerations:

- Maintaining API compatibility where possible
- Preserving existing database schema structure
- Implementing equivalent business logic
- Supporting existing client applications

## Community & Ecosystem

### Related Projects

- 🌐 **[Terrastories Explore](https://github.com/Terrastories/explore-terrastories)** - React-based frontend application
- 🛫 **[Legacy Rails API](https://github.com/terrastories/terrastories)** - Original Ruby on Rails implementation being migrated

### Community Resources

- 💬 **[Discussions](https://github.com/terrastories/terrastories-api/discussions)** - Ask questions, share ideas
- 🐛 **[Issues](https://github.com/terrastories/terrastories-api/issues)** - Bug reports and feature requests
- 📺 **[Project Board](https://github.com/orgs/terrastories/projects)** - Development roadmap
- 📧 **[Mailing List](mailto:terrastories@example.com)** - Community updates

### Supporting Organizations

- **[Awana Digital](https://awana.digital)** - Platform development and community partnerships
- **[Indigenous Communities](https://terrastories.app/communities)** - Real-world testing and requirements
- **Open Source Contributors** - Volunteer developers and designers worldwide

## License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

We chose MIT to ensure maximum accessibility and reuse by Indigenous communities and supporting organizations worldwide.

## Support

### Need Help?

- 🐛 **Bug reports**: [Create an issue](https://github.com/terrastories/terrastories-api/issues/new/choose)
- 💬 **Questions**: [Start a discussion](https://github.com/terrastories/terrastories-api/discussions)
- 📧 **Community support**: [Join our mailing list](mailto:terrastories@example.com)
- 🎆 **Urgent matters**: Contact maintainers directly

### Community Guidelines

When seeking support, please:

- Be respectful and patient
- Provide clear, detailed information
- Search existing issues and discussions first
- Follow our Code of Conduct

## Acknowledgments

🙏 **This project exists thanks to:**

- **Indigenous communities worldwide** who shared their knowledge, requirements, and trust
- **[Awana Digital](https://awana.digital)** for platform development and community partnerships
- **Original Terrastories contributors** who built the foundation we're migrating from
- **Open source maintainers** whose libraries and tools make this work possible
- **Community partners** who provide testing, feedback, and real-world validation

> _"Technology should serve communities, not the other way around."_

---

**[Join our community](https://github.com/terrastories/terrastories-api/discussions) • [Report issues](https://github.com/terrastories/terrastories-api/issues) • [Contribute code](CONTRIBUTING.md)**
