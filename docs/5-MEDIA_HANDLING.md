# **5. Media & File Handling**

## **5.1. Current System (Rails ActiveStorage)**

The Rails application uses **ActiveStorage** to handle all media uploads (images, audio, video). ActiveStorage manages file uploads, storage on a local disk or cloud provider (like S3), and associations with the core models (Story, Place, Speaker).
It works by using three key database tables:

- active_storage_blobs: Stores metadata about each file (filename, content type, size, checksum).
- active_storage_attachments: A polymorphic join table that links blobs to the specific model records (e.g., this Story record has this blob).
- active_storage_variant_records: Stores information about transformed versions of images (e.g., thumbnails).

## **5.2. Migration Strategy**

The goal is to move away from ActiveStorage while preserving the existing files and their associations.

1. **Direct File System Storage**: The new TypeScript API will manage files directly on the file system, organized in a structure that mirrors the community/model hierarchy.
2. **Database Columns**: Instead of relying on ActiveStorage tables, the core model tables (stories, places, speakers) will be updated with columns that store the file paths or URLs directly. For example, the places table will have a photo_url and name_audio_url column.
3. **Data Migration**: A one-time script will be required to:
   - Read the active_storage_attachments and active_storage_blobs tables.
   - Copy the files from the ActiveStorage directory to the new file system structure.
   - Update the new columns in the stories, places, and speakers tables with the new file paths.
4. **API for Uploads**: The new API will have dedicated endpoints for handling file uploads (likely using a library like multer with Fastify), which will save the file to the correct location and update the corresponding database record.
