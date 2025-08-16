# **1. Terrastories Project Overview**

## **1.1. Executive Summary**

Terrastories is a sophisticated **offline-first geostorytelling application** designed for Indigenous and local communities to map, manage, and share place-based oral histories. The core mission is to support data sovereignty through community-based data isolation. The application is built to operate completely offline in "Field Kit" deployments.

## **1.2. High-Level Architecture**

- **Original Stack**: Ruby on Rails (v5.2+) backend with a hybrid React frontend (react-rails gem).
- **Database**: PostgreSQL with PostGIS for spatial data.
- **Storage**: Rails ActiveStorage for media files (audio, video, images).
- **Deployment**: Dockerized multi-service architecture (Rails, PostgreSQL, Nginx, Tileserver).
- **Key Feature**: Multi-tenant design where each "Community" is a distinct data silo.

## **1.3. Migration Goal**

The primary goal is to perform a **1:1 migration of the backend API from Ruby on Rails to a modern TypeScript stack** (Fastify, Drizzle ORM).

- **No new features**: The new API must have exact feature parity with the existing Rails API.
- **Database preservation**: The PostgreSQL/PostGIS database schema and data will be preserved.
- **Frontend is out of scope**: The frontend will be addressed in a separate, future migration phase.
