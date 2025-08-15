// Example: Repository pattern with Drizzle ORM
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { users, User, NewUser } from '../db/schema/users';

export class UserRepository {
  async create(userData: NewUser): Promise<User> {
    const db = await getDb();
    const [user] = await db.insert(users).values(userData).returning();

    return user;
  }

  async findById(id: string): Promise<User | null> {
    const db = await getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return user || null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const db = await getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    return user || null;
  }

  async update(id: string, updates: Partial<User>): Promise<User> {
    const db = await getDb();
    const [user] = await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(users).where(eq(users.id, id));
  }

  async list(limit = 20, offset = 0): Promise<User[]> {
    const db = await getDb();
    return db.select().from(users).limit(limit).offset(offset);
  }
}
