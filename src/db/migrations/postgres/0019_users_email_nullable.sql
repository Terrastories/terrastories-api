-- migrator S2: users.email becomes nullable (Rails allows users without an email;
-- SPEC-V2 section 6.2 declares email optional). Unique indexes already tolerate NULL.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
