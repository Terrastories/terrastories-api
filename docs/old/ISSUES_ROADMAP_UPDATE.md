# **Terrastories TypeScript Backend API Migration Roadmap**

**Scope**: This roadmap focuses exclusively on backend API migration from Rails to TypeScript, maintaining exact feature parity with the existing Rails implementation.
**Principle**: No new features beyond what exists in the current Rails API. Exact 1:1 migration only.

## **Scope & Approach**

- ✅ **Backend API Only**: Migrating the Rails backend to TypeScript/Fastify.
- ✅ **Database Preservation**: Using the existing PostgreSQL/PostGIS schema. ORM migration only.
- ✅ **Authentication Parity**: Replicating the existing session-based authentication.
- ✅ **Media Handling**: Replacing ActiveStorage with a direct file system approach.
- ❌ **No Frontend Changes**: The frontend is out of scope for this project.
- ❌ **No New Features**: The goal is a 1:1 feature match with the Rails API.

## **Phase 1: Foundation & Infrastructure ✅ COMPLETED**

_(Issues in this phase are already completed and do not require documentation links.)_

## **Phase 2: Authentication & Authorization**

### **Issue #6: Implement User Model & Authentication**

Description: Implement the Drizzle schema for the User model and create the core authentication logic (login/logout) to replicate Rails Devise's session management.
Context: docs/2-DATA_MODELS.md, docs/4-AUTHENTICATION.md, docs/6-DATABASE_SCHEMA.md
Acceptance Criteria:

- users table schema is defined in Drizzle.
- A /login endpoint exists that accepts email/password.
- Successful login returns a connect.sid session cookie.
- A /logout endpoint exists that destroys the session.

### **Issue #10: Implement User Registration**

Description: Create an endpoint for new user registration.
Context: docs/2-DATA_MODELS.md, docs/4-AUTHENTICATION.md
Acceptance Criteria:

- A /register (or similar) endpoint exists.
- New users are correctly associated with a Community.
- Password hashing is implemented correctly.

### **Issue #12: Implement Authorization Middleware**

Description: Create middleware to protect routes based on user roles (super_admin, admin, editor, viewer).
Context: docs/4-AUTHENTICATION.md, docs/3-API_ENDPOINTS.md
Acceptance Criteria:

- Middleware function exists that can check a user's role from the session.
- Routes can be protected to only allow access for specific roles.
- Unauthorized requests receive a 403 Forbidden response.

## **Phase 3: Core Models CRUD Logic**

### **Issue #15: Implement CRUD for Communities**

Description: Create the service logic for full CRUD operations on the Community model.
Context: docs/2-DATA_MODELS.md, docs/6-DATABASE_SCHEMA.md
Acceptance Criteria:

- Drizzle schema for communities is defined.
- Service functions exist for create, get, update, and delete a community.

### **Issue #18: Implement CRUD for Stories**

Description: Implement CRUD logic for the Story model, including handling its many-to-many associations with Places and Speakers.
Context: docs/2-DATA_MODELS.md, docs/6-DATABASE_SCHEMA.md
Acceptance Criteria:

- Drizzle schema for stories, story_places, and story_speakers is defined.
- Service functions for story CRUD operations correctly manage the join tables.

### **Issue #20: Implement CRUD for Places**

Description: Implement CRUD logic for the Place model.
Context: docs/2-DATA_MODELS.md, docs/6-DATABASE_SCHEMA.md
Acceptance Criteria:

- Drizzle schema for places is defined.
- Service functions for place CRUD operations are implemented.

### **Issue #22: Implement CRUD for Speakers**

Description: Implement CRUD logic for the Speaker model.
Context: docs/2-DATA_MODELS.md, docs/6-DATABASE_SCHEMA.md
Acceptance Criteria:

- Drizzle schema for speakers is defined.
- Service functions for speaker CRUD operations are implemented.

## **Phase 4: Media Handling**

### **Issue #25: Implement File Upload System**

Description: Create a service for handling multipart/form-data file uploads to replace ActiveStorage.
Context: docs/5-MEDIA_HANDLING.md
Acceptance Criteria:

- A file upload handler (e.g., using fastify-multipart) is configured.
- Uploaded files are saved to a designated directory on the server's file system.
- The handler returns the path to the saved file.

### **Issue #28: Associate Uploads with Models**

Description: Integrate the file upload system with the CRUD services for Stories, Places, and Speakers.
Context: docs/5-MEDIA_HANDLING.md, docs/2-DATA_MODELS.md
Acceptance Criteria:

- The update services for Stories, Places, and Speakers can accept a file path.
- The file path is correctly saved to the appropriate column in the database (e.g., photo_url).

## **Phase 5: API Endpoint Implementation**

### **Issue #30: Implement Public API Endpoints (/api)**

Description: Build the read-only, public-facing /api namespace.
Context: docs/3-API_ENDPOINTS.md
Acceptance Criteria:

- All GET routes under /api/communities/... are implemented.
- The JSON response structure exactly matches the Rails API output.
- No authentication is required for these endpoints.

### **Issue #35: Implement Member Dashboard Endpoints (/member)**

Description: Build the authenticated /member namespace for content management.
Context: docs/3-API_ENDPOINTS.md, docs/4-AUTHENTICATION.md
Acceptance Criteria:

- All CRUD endpoints for Stories, Places, and Speakers under /member are implemented.
- Endpoints are protected by the authentication and authorization middleware.

### **Issue #38: Implement Super Admin Endpoints (/super_admin)**

Description: Build the /super_admin namespace for managing communities and users.
Context: docs/3-API_ENDPOINTS.md, docs/4-AUTHENTICATION.md
Acceptance Criteria:

- All CRUD endpoints for Communities and Users under /super_admin are implemented.
- Endpoints are protected and only accessible to users with the super_admin role.

## **Phase 6: Integration, Testing & Deployment**

### **Issue #40: Finalize Docker Configuration**

Description: Ensure the Docker Compose setup is production-ready.
Context: docs/7-DEPLOYMENT.md
Acceptance Criteria:

- docker-compose.yml defines all necessary services (api, db, nginx, tileserver).
- Environment variables are correctly passed to the containers.
- Database volume is configured for data persistence.

### **Issue #42: API Comparison Testing**

Description: Create a suite of tests that runs against both the old Rails API and the new TypeScript API to ensure identical responses.
Context: docs/3-API_ENDPOINTS.md
Acceptance Criteria:

- A testing script (e.g., using curl or a testing library) is created.
- The script covers all public and authenticated endpoints.
- The script asserts that the JSON output from both APIs is identical for the same requests.

### **Issue #43: Create Data Migration Guide**

Description: Document the one-time data migration process, including the script for moving data from ActiveStorage.
Context: docs/5-MEDIA_HANDLING.md, docs/7-DEPLOYMENT.md
Acceptance Criteria:

- A markdown document outlines the step-by-step migration process.
- A script is provided to read ActiveStorage tables and update the new file path columns.
