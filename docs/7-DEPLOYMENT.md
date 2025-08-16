# **7. Deployment & Infrastructure**

## **7.1. Docker Configuration**

The project uses **Docker Compose** to manage its multi-service architecture, ensuring consistency between development and production environments. The target architecture will mirror the existing setup.

- **api service**: The new TypeScript/Fastify application.
- **db service**: PostgreSQL 12+ with the PostGIS extension enabled.
- **nginx service**: Acts as a reverse proxy, routing traffic to the API service and serving static assets.
- **tileserver service**: Serves map tiles for offline map functionality.

The database volume will be managed by Docker to ensure data persistence across container restarts.

## **7.2. Environment Variables**

The application will be configured using environment variables, following the 12-factor app methodology. A .env.example file will be provided to document all required variables.
Key variables include:

- DATABASE_URL: The connection string for the PostgreSQL database.
- SESSION_SECRET: A secret key for signing session cookies.
- CORS_ORIGIN: The URL of the frontend application for Cross-Origin Resource Sharing.
- PORT: The port on which the API server will listen.

## **7.3. Database Migrations**

Database schema changes will be managed using **Drizzle ORM's migration tool**.

- drizzle-kit generate:pg: To generate new SQL migration files based on changes to the schema defined in schema.ts.
- drizzle-kit migrate: To apply pending migrations to the database.

The migration command will be run as part of the deployment process to ensure the database schema is up-to-date before the application starts.
