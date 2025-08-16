// Example: Service layer with error handling
import { UserRepository } from '../repositories/userRepository';

// Custom Error classes for specific failure scenarios
export class UserNotFoundError extends Error {
  constructor(message = 'User not found') {
    super(message);
    this.name = 'UserNotFoundError';
  }
}

export class DuplicateEmailError extends Error {
  constructor(message = 'User with this email already exists') {
    super(message);
    this.name = 'DuplicateEmailError';
  }
}

export class UserService {
  // Inject the repository dependency
  constructor(private userRepository: UserRepository) {}

  async createUser(userData: NewUser): Promise<User> {
    // Business logic validation can remain, but input format validation
    // should be handled by Zod schemas in the route.
    const existing = await this.userRepository.findByEmail(userData.email);
    if (existing) {
      throw new DuplicateEmailError();
    }

    return this.userRepository.create(userData);
  }

  async getUserById(id: string): Promise<User> {
    const user = await this.userRepository.findById(id);
    if (!user) {
      throw new UserNotFoundError();
    }
    return user;
  }

  async updateUser(id: string, updates: Partial<NewUser>): Promise<User> {
    // Ensure the user exists before trying to update
    await this.getUserById(id);

    // If email is being updated, check for duplicates
    if (updates.email) {
      const existing = await this.userRepository.findByEmail(updates.email);
      if (existing && existing.id !== id) {
        throw new DuplicateEmailError('This email is already in use by another account.');
      }
    }

    const updatedUser = await this.userRepository.update(id, updates);
    if (!updatedUser) {
        // This case might happen in a race condition if user is deleted
        // between the check and the update.
        throw new UserNotFoundError('Failed to update user as they could not be found.');
    }
    return updatedUser;
  }

  async deleteUser(id: string): Promise<void> {
    const success = await this.userRepository.delete(id);
    if (!success) {
      throw new UserNotFoundError();
    }
  }
}
