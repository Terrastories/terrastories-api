// Example: Service layer with error handling
import { User, NewUser } from '../db/schema/users';
import { UserRepository } from '../repositories/userRepository';

export class UserService {
  constructor(private userRepository: UserRepository) {}

  async createUser(userData: NewUser): Promise<User> {
    // Business logic validation
    if (!userData.email || !userData.name) {
      throw new Error('Email and name are required');
    }

    // Check if user exists
    const existing = await this.userRepository.findByEmail(userData.email);
    if (existing) {
      throw new Error('User with this email already exists');
    }

    // Create user
    return this.userRepository.create(userData);
  }

  async getUserById(id: string): Promise<User | null> {
    if (!id) {
      throw new Error('User ID is required');
    }

    return this.userRepository.findById(id);
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const user = await this.getUserById(id);
    if (!user) {
      throw new Error('User not found');
    }

    // Business rules
    if (updates.email && updates.email !== user.email) {
      const existing = await this.userRepository.findByEmail(updates.email);
      if (existing && existing.id !== id) {
        throw new Error('Email already in use');
      }
    }

    return this.userRepository.update(id, updates);
  }

  async deleteUser(id: string): Promise<void> {
    const user = await this.getUserById(id);
    if (!user) {
      throw new Error('User not found');
    }

    await this.userRepository.delete(id);
  }
}
