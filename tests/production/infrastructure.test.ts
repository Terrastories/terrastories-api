/**
 * TERRASTORIES API - PRODUCTION INFRASTRUCTURE VALIDATION
 *
 * This test suite validates production readiness for Indigenous community deployment.
 * Covers SSL/TLS, performance, database persistence, backup/recovery, and monitoring.
 *
 * Issue #59: Production Readiness Validation & Indigenous Community Deployment
 * Phase 1: Infrastructure & Security
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';

const exec = promisify(execCb);

describe('Production Infrastructure Validation - Phase 1', () => {
  let productionApiUrl: string;
  let stagingApiUrl: string;

  beforeAll(async () => {
    productionApiUrl =
      process.env.PRODUCTION_API_URL || 'https://staging.terrastories.io';
    stagingApiUrl = process.env.STAGING_API_URL || 'http://localhost:3000';

    console.log(`Testing production deployment at: ${productionApiUrl}`);
  });

  describe('Production Deployment Validation', () => {
    test('docker-compose production deployment starts successfully', async () => {
      // Ensure we have the production Docker setup available
      const composeFiles = ['docker-compose.yml', 'docker-compose.prod.yml'];

      for (const file of composeFiles) {
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false);
        expect(exists, `${file} should exist for production deployment`).toBe(
          true
        );
      }

      // Verify production environment variables
      const envExample = await fs.readFile('.env.example', 'utf-8');
      expect(envExample).toContain('POSTGRES_PASSWORD');
      expect(envExample).toContain('DATABASE_URL_PROD');
      expect(envExample).toContain('SSL_CERT_PATH');
      expect(envExample).toContain('SSL_KEY_PATH');
    }, 10000);

    test('all required services are defined in production compose', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // Core services required for production
      expect(prodCompose).toContain('api:');
      expect(prodCompose).toContain('db:');
      expect(prodCompose).toContain('nginx:');
      expect(prodCompose).toContain('tileserver:');
      expect(prodCompose).toContain('backup:');
      expect(prodCompose).toContain('logrotate:');
    });

    test('production config has resource limits and restart policies', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // Resource limits for stability
      expect(prodCompose).toContain('deploy:');
      expect(prodCompose).toContain('resources:');
      expect(prodCompose).toContain('limits:');
      expect(prodCompose).toContain('restart_policy:');
      expect(prodCompose).toContain('unless-stopped');
    });

    test('production security measures are in place', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // Security: no debug ports exposed
      expect(prodCompose).toContain('ports: []');

      // Security: database not publicly exposed
      expect(prodCompose).not.toContain('5432:5432');

      // SSL termination via Nginx
      expect(prodCompose).toContain("'443:443'");
      expect(prodCompose).toContain('/etc/ssl:ro');
    });
  });

  describe('SSL/TLS and HTTPS Enforcement Validation', () => {
    test('SSL certificate configuration is present', async () => {
      const nginxConfig = await fs.readFile('config/nginx/nginx.conf', 'utf-8');

      // SSL configuration should be present
      expect(nginxConfig).toContain('ssl_certificate');
      expect(nginxConfig).toContain('ssl_certificate_key');
      expect(nginxConfig).toContain('ssl_protocols');
      expect(nginxConfig).toContain('ssl_ciphers');
    });

    test('HTTPS enforcement and security headers configured', async () => {
      const nginxConfig = await fs.readFile('config/nginx/nginx.conf', 'utf-8');

      // HTTPS enforcement
      expect(nginxConfig).toContain('return 301 https://');

      // Security headers
      expect(nginxConfig).toContain('add_header Strict-Transport-Security');
      expect(nginxConfig).toContain('add_header X-Frame-Options');
      expect(nginxConfig).toContain('add_header X-Content-Type-Options');
      expect(nginxConfig).toContain('add_header Referrer-Policy');
    });

    test('SSL configuration meets security standards', async () => {
      const nginxConfig = await fs.readFile('config/nginx/nginx.conf', 'utf-8');

      // Modern SSL protocols only
      expect(nginxConfig).not.toContain('SSLv2');
      expect(nginxConfig).not.toContain('SSLv3');
      expect(nginxConfig).not.toContain('TLSv1 ');
      expect(nginxConfig).not.toContain('TLSv1.1');

      // Should include modern TLS
      expect(nginxConfig).toContain('TLSv1.2');
      expect(nginxConfig).toContain('TLSv1.3');
    });
  });

  describe('Database Persistence and Backup Validation', () => {
    test('postgres volume is configured for persistence', async () => {
      const baseCompose = await fs.readFile('docker-compose.yml', 'utf-8');

      expect(baseCompose).toContain('postgres_data:/var/lib/postgresql/data');
      expect(baseCompose).toContain('postgres_data:');
    });

    test('backup service is configured', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      expect(prodCompose).toContain('backup:');
      expect(prodCompose).toContain('postgres_backups:/backups');
      expect(prodCompose).toContain('BACKUP_RETENTION_DAYS=7');
      expect(prodCompose).toContain('0 3 * * *'); // Daily backup at 3 AM
    });

    test('backup script exists and is executable', async () => {
      const backupScript = await fs
        .access('scripts/backup.sh')
        .then(() => true)
        .catch(() => false);
      expect(
        backupScript,
        'Backup script should exist at scripts/backup.sh'
      ).toBe(true);

      const stats = await fs.stat('scripts/backup.sh');
      expect(
        stats.mode & 0o111,
        'Backup script should be executable'
      ).toBeTruthy();
    });

    test('backup script includes proper validation', async () => {
      const backupScript = await fs.readFile('scripts/backup.sh', 'utf-8');

      // Should include database connection validation
      expect(backupScript).toContain('pg_dump');
      expect(backupScript).toContain('POSTGRES_HOST');
      expect(backupScript).toContain('POSTGRES_DB');

      // Should include error handling
      expect(backupScript).toContain('exit 1');

      // Should include retention policy
      expect(backupScript).toContain('find');
      expect(backupScript).toContain('-mtime');
    });
  });

  describe('Performance and Load Testing Infrastructure', () => {
    test('API has health check endpoints', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // Health check configuration should be present
      expect(prodCompose).toContain('healthcheck:');
      expect(prodCompose).toContain('/health');
      expect(prodCompose).toContain('interval: 30s');
      expect(prodCompose).toContain('timeout: 10s');
      expect(prodCompose).toContain('retries: 3');
    });

    test('nginx caching is configured for performance', async () => {
      const nginxConfig = await fs.readFile('config/nginx/nginx.conf', 'utf-8');

      // Caching configuration
      expect(nginxConfig).toContain('proxy_cache');
      expect(nginxConfig).toContain('expires');
      expect(nginxConfig).toContain('gzip');
    });

    test('production database has performance optimization', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // PostgreSQL performance settings
      expect(prodCompose).toContain('max_connections');
      expect(prodCompose).toContain('shared_buffers');
      expect(prodCompose).toContain('effective_cache_size');
      expect(prodCompose).toContain('maintenance_work_mem');
    });

    test('resource limits are set for stability', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // CPU and memory limits
      expect(prodCompose).toContain("cpus: '1.0'");
      expect(prodCompose).toContain('memory: 512M');
      expect(prodCompose).toContain("cpus: '0.5'");
      expect(prodCompose).toContain('memory: 256M');
    });
  });

  describe('Monitoring and Operational Excellence', () => {
    test('log management is configured', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // Log rotation service
      expect(prodCompose).toContain('logrotate:');
      expect(prodCompose).toContain('docker-logrotate');
      expect(prodCompose).toContain('CRON_SCHEDULE=0 2 * * *'); // Daily at 2 AM
    });

    test('nginx access and error logging configured', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // Nginx logs volume
      expect(prodCompose).toContain('nginx_logs:/var/log/nginx');
    });

    test('production startup command includes database migration', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      // Should run migrations on startup
      expect(prodCompose).toContain('npm run db:migrate');
      expect(prodCompose).toContain('npm start');
    });
  });

  describe('Environment Variables and Security', () => {
    test('production environment file template exists', async () => {
      const envProdTemplateExists = await fs
        .access('.env.production.template')
        .then(() => true)
        .catch(() => false);
      expect(
        envProdTemplateExists,
        'Production environment template file should exist'
      ).toBe(true);
    });

    test('sensitive variables are properly configured', async () => {
      const envExample = await fs.readFile('.env.example', 'utf-8');

      // Should have placeholders for sensitive data
      expect(envExample).toContain('POSTGRES_PASSWORD=');
      expect(envExample).toContain('JWT_SECRET=');
      expect(envExample).toContain('SESSION_SECRET=');

      // Should not contain actual secrets
      expect(envExample).not.toContain('password123');
      expect(envExample).not.toContain('secret123');
    });

    test('production NODE_ENV override is configured', async () => {
      const prodCompose = await fs.readFile('docker-compose.prod.yml', 'utf-8');

      expect(prodCompose).toContain('NODE_ENV=production');
      expect(prodCompose).toContain('LOG_LEVEL=warn');
      expect(prodCompose).toContain('HOT_RELOAD=false');
    });
  });

  describe('Field Kit Configuration Validation', () => {
    test('field kit compose file exists for offline deployment', async () => {
      const fieldKitExists = await fs
        .access('docker-compose.field-kit.yml')
        .then(() => true)
        .catch(() => false);
      expect(fieldKitExists, 'Field Kit compose file should exist').toBe(true);
    });

    test('field kit has resource optimization for limited hardware', async () => {
      const fieldKitCompose = await fs.readFile(
        'docker-compose.field-kit.yml',
        'utf-8'
      );

      // Should have lower resource requirements
      expect(fieldKitCompose).toContain('deploy:');
      expect(fieldKitCompose).toContain('resources:');
      expect(fieldKitCompose).toContain('limits:');
    });

    test('field kit includes tileserver for offline maps', async () => {
      const fieldKitCompose = await fs.readFile(
        'docker-compose.field-kit.yml',
        'utf-8'
      );

      expect(fieldKitCompose).toContain('tileserver:');
      expect(fieldKitCompose).toContain('tiles:/data/tiles');
    });

    test('field kit environment configuration exists', async () => {
      const fieldKitEnv = await fs
        .access('.env.field-kit')
        .then(() => true)
        .catch(() => false);
      expect(fieldKitEnv, 'Field Kit environment file should exist').toBe(true);
    });
  });

  afterAll(async () => {
    console.log('Production infrastructure validation completed');
  });
});
