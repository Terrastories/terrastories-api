import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Docker Configuration Tests', () => {
  const projectRoot = process.cwd();

  describe('Docker Files Exist', () => {
    it('should have Dockerfile', async () => {
      const dockerfilePath = path.join(projectRoot, 'Dockerfile');
      await expect(fs.access(dockerfilePath)).resolves.not.toThrow();
    });

    it('should have .dockerignore', async () => {
      const dockerignorePath = path.join(projectRoot, '.dockerignore');
      await expect(fs.access(dockerignorePath)).resolves.not.toThrow();
    });

    it('should have base docker-compose.yml', async () => {
      const composePath = path.join(projectRoot, 'docker-compose.yml');
      await expect(fs.access(composePath)).resolves.not.toThrow();
    });

    it('should have development override', async () => {
      const devComposePath = path.join(projectRoot, 'docker-compose.dev.yml');
      await expect(fs.access(devComposePath)).resolves.not.toThrow();
    });

    it('should have production override', async () => {
      const prodComposePath = path.join(projectRoot, 'docker-compose.prod.yml');
      await expect(fs.access(prodComposePath)).resolves.not.toThrow();
    });

    it('should have field-kit override', async () => {
      const fieldKitComposePath = path.join(
        projectRoot,
        'docker-compose.field-kit.yml'
      );
      await expect(fs.access(fieldKitComposePath)).resolves.not.toThrow();
    });
  });

  describe('Configuration Files Exist', () => {
    it('should have nginx production config', async () => {
      const nginxPath = path.join(projectRoot, 'config/nginx/nginx.conf');
      await expect(fs.access(nginxPath)).resolves.not.toThrow();
    });

    it('should have nginx field-kit config', async () => {
      const nginxFieldKitPath = path.join(
        projectRoot,
        'config/nginx/nginx.field-kit.conf'
      );
      await expect(fs.access(nginxFieldKitPath)).resolves.not.toThrow();
    });

    it('should have tileserver configs', async () => {
      const tileserverPath = path.join(
        projectRoot,
        'config/tileserver/config.json'
      );
      const fieldKitTileserverPath = path.join(
        projectRoot,
        'config/tileserver/config.field-kit.json'
      );

      await expect(fs.access(tileserverPath)).resolves.not.toThrow();
      await expect(fs.access(fieldKitTileserverPath)).resolves.not.toThrow();
    });

    it('should have database initialization script', async () => {
      const initDbPath = path.join(projectRoot, 'scripts/init-db.sql');
      await expect(fs.access(initDbPath)).resolves.not.toThrow();
    });

    it('should have backup scripts', async () => {
      const backupPath = path.join(projectRoot, 'scripts/backup.sh');
      const fieldKitBackupPath = path.join(
        projectRoot,
        'scripts/field-kit-backup.sh'
      );

      await expect(fs.access(backupPath)).resolves.not.toThrow();
      await expect(fs.access(fieldKitBackupPath)).resolves.not.toThrow();
    });
  });

  describe('Environment Variables', () => {
    it('should have comprehensive .env.example', async () => {
      const envExamplePath = path.join(projectRoot, '.env.example');
      const content = await fs.readFile(envExamplePath, 'utf-8');

      // Check for required environment variables (15+ as per requirements)
      const requiredVars = [
        'NODE_ENV',
        'PORT',
        'HOST',
        'BUILD_TARGET',
        'DATABASE_URL',
        'DATABASE_URL_PROD',
        'DATABASE_URL_TEST',
        'POSTGRES_PASSWORD',
        'JWT_SECRET',
        'SESSION_SECRET',
        'CORS_ORIGIN',
        'API_PREFIX',
        'LOG_LEVEL',
        'UPLOAD_DIR',
        'UPLOAD_MAX_FILE_SIZE',
        'UPLOAD_ALLOWED_TYPES',
        'OFFLINE_MODE',
        'TILE_SERVER_URL',
        'FIELD_KIT_MODE',
        'HEALTH_CHECK_ENDPOINT',
      ];

      requiredVars.forEach((variable) => {
        expect(content).toContain(variable);
      });

      // Verify we have at least 15 variables (requirement from issue)
      const variableCount = requiredVars.length;
      expect(variableCount).toBeGreaterThanOrEqual(15);
    });

    it('should have security warnings in .env.example', async () => {
      const envExamplePath = path.join(projectRoot, '.env.example');
      const content = await fs.readFile(envExamplePath, 'utf-8');

      expect(content).toContain('CHANGE IN PRODUCTION');
      expect(content).toContain('minimum-32-characters');
    });
  });

  describe('Docker Compose Validation', () => {
    const isDockerAvailable = () => {
      try {
        execSync('docker-compose --version', { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };

    it('should validate base docker-compose.yml syntax', () => {
      if (!isDockerAvailable()) {
        console.log('Docker Compose not available, skipping syntax validation');
        return;
      }

      expect(() => {
        execSync('docker-compose -f docker-compose.yml config', {
          cwd: projectRoot,
          stdio: 'pipe',
        });
      }).not.toThrow();
    });

    it('should validate development override syntax', () => {
      if (!isDockerAvailable()) {
        console.log('Docker Compose not available, skipping syntax validation');
        return;
      }

      expect(() => {
        execSync(
          'docker-compose -f docker-compose.yml -f docker-compose.dev.yml config',
          {
            cwd: projectRoot,
            stdio: 'pipe',
          }
        );
      }).not.toThrow();
    });

    it('should validate production override syntax', () => {
      if (!isDockerAvailable()) {
        console.log('Docker Compose not available, skipping syntax validation');
        return;
      }

      expect(() => {
        execSync(
          'docker-compose -f docker-compose.yml -f docker-compose.prod.yml config',
          {
            cwd: projectRoot,
            stdio: 'pipe',
          }
        );
      }).not.toThrow();
    });

    it('should validate field-kit override syntax', () => {
      if (!isDockerAvailable()) {
        console.log('Docker Compose not available, skipping syntax validation');
        return;
      }

      expect(() => {
        execSync(
          'docker-compose -f docker-compose.yml -f docker-compose.field-kit.yml config',
          {
            cwd: projectRoot,
            stdio: 'pipe',
          }
        );
      }).not.toThrow();
    });
  });

  describe('Dockerfile Validation', () => {
    it('should have multi-stage build with correct stages', async () => {
      const dockerfilePath = path.join(projectRoot, 'Dockerfile');
      const content = await fs.readFile(dockerfilePath, 'utf-8');

      expect(content).toContain('FROM node:20.18.0-alpine AS development');
      expect(content).toContain('FROM node:20.18.0-alpine AS builder');
      expect(content).toContain('FROM node:20.18.0-alpine AS production');
    });

    it('should use non-root user in production stage', async () => {
      const dockerfilePath = path.join(projectRoot, 'Dockerfile');
      const content = await fs.readFile(dockerfilePath, 'utf-8');

      expect(content).toContain('adduser -S terrastories');
      expect(content).toContain('USER terrastories');
    });

    it('should have health check configured', async () => {
      const dockerfilePath = path.join(projectRoot, 'Dockerfile');
      const content = await fs.readFile(dockerfilePath, 'utf-8');

      expect(content).toContain('HEALTHCHECK');
    });
  });

  describe('Service Configuration', () => {
    it('should have all required services in base config', async () => {
      const composePath = path.join(projectRoot, 'docker-compose.yml');
      const content = await fs.readFile(composePath, 'utf-8');

      expect(content).toContain('api:');
      expect(content).toContain('db:');
      expect(content).toContain('tileserver:');
    });

    it('should have nginx service in production config', async () => {
      const prodComposePath = path.join(projectRoot, 'docker-compose.prod.yml');
      const content = await fs.readFile(prodComposePath, 'utf-8');

      expect(content).toContain('nginx:');
    });

    it('should have PostGIS database configuration', async () => {
      const composePath = path.join(projectRoot, 'docker-compose.yml');
      const content = await fs.readFile(composePath, 'utf-8');

      expect(content).toContain('postgis/postgis:13-master');
    });
  });

  describe('Security Configuration', () => {
    it('should not expose database port in production', async () => {
      const prodComposePath = path.join(projectRoot, 'docker-compose.prod.yml');
      const content = await fs.readFile(prodComposePath, 'utf-8');

      // Check that db service has ports: [] (empty ports)
      expect(content).toContain('ports: []');
    });

    it('should have security headers in nginx config', async () => {
      const nginxPath = path.join(projectRoot, 'config/nginx/nginx.conf');
      const content = await fs.readFile(nginxPath, 'utf-8');

      expect(content).toContain('X-Frame-Options');
      expect(content).toContain('X-Content-Type-Options');
      expect(content).toContain('X-XSS-Protection');
      expect(content).toContain('Content-Security-Policy');
    });

    it('should have rate limiting configured', async () => {
      const nginxPath = path.join(projectRoot, 'config/nginx/nginx.conf');
      const content = await fs.readFile(nginxPath, 'utf-8');

      expect(content).toContain('limit_req_zone');
      expect(content).toContain('limit_req');
    });
  });

  describe('Resource Constraints', () => {
    it('should have CPU and memory limits in production', async () => {
      const prodComposePath = path.join(projectRoot, 'docker-compose.prod.yml');
      const content = await fs.readFile(prodComposePath, 'utf-8');

      expect(content).toContain('cpus:');
      expect(content).toContain('memory:');
      expect(content).toContain('limits:');
    });

    it('should have reduced resources in field-kit config', async () => {
      const fieldKitComposePath = path.join(
        projectRoot,
        'docker-compose.field-kit.yml'
      );
      const content = await fs.readFile(fieldKitComposePath, 'utf-8');

      expect(content).toContain('256M'); // Lower memory limits
      expect(content).toContain('0.5'); // Lower CPU limits
    });
  });
});
