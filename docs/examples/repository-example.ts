// Example: Repository pattern with Drizzle ORM
import { eq } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema'; // Import all schemas
import { users, User, NewUser } from '../db/schema/users';

// Define a type for the Drizzle database instance
export type DbType = PgDatabase<typeof schema>;

export class UserRepository {
  // Inject the database dependency via the constructor
  constructor(private db: DbType) {}

  async create(userData: NewUser): Promise<User> {
    const [user] = await this.db.insert(users).values(userData).returning();
    return user;
  }

  async findById(id: string): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return user || null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    return user || null;
  }

  async update(id: string, updates: Partial<User>): Promise<User | null> {
    const [user] = await this.db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    return user || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(users).where(eq(users.id, id));
    // rowCount is non-standard, but available in node-postgres driver
    // It's better to check if the operation affected any rows.
    return result.rowCount > 0;
  }

  async list(limit = 20, offset = 0): Promise<User[]> {
    return this.db.select().from(users).limit(limit).offset(offset);
  }
}
