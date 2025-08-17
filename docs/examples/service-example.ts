// Example: Service layer with error handling
import { UserRepository } from '../repositories/userRepository';
import { hashPassword, comparePassword, validatePasswordStrength } from '../services/password.service';

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

export class WeakPasswordError extends Error {
  constructor(message = 'Password does not meet security requirements') {
    super(message);
    this.name = 'WeakPasswordError';
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

    // Validate password strength before hashing
    const passwordValidation = validatePasswordStrength(userData.password);
    if (!passwordValidation.isValid) {
      throw new WeakPasswordError(
        `Password requirements not met: ${passwordValidation.errors.join(', ')}`
      );
    }

    // Hash the password securely before storing
    const passwordHash = await hashPassword(userData.password);
    
    // Remove plain password and add hash
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, ...userDataWithoutPassword } = userData;
    const userToCreate = {
      ...userDataWithoutPassword,
      passwordHash
    };

    return this.userRepository.create(userToCreate);
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

  /**
   * Authenticate user by email and password
   * 
   * Example usage of password comparison service
   */
  async authenticateUser(email: string, password: string): Promise<User> {
    const user = await this.userRepository.findByEmail(email);
    if (!user) {
      throw new UserNotFoundError('Invalid email or password');
    }

    // Use secure password comparison
    const isValidPassword = await comparePassword(password, user.passwordHash);
    if (!isValidPassword) {
      throw new UserNotFoundError('Invalid email or password');
    }

    return user;
  }

  /**
   * Change user password with validation
   */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.getUserById(userId);

    // Verify old password
    const isValidOldPassword = await comparePassword(oldPassword, user.passwordHash);
    if (!isValidOldPassword) {
      throw new Error('Current password is incorrect');
    }

    // Validate new password strength
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      throw new WeakPasswordError(
        `New password requirements not met: ${passwordValidation.errors.join(', ')}`
      );
    }

    // Hash and update password
    const newPasswordHash = await hashPassword(newPassword);
    await this.userRepository.update(userId, { passwordHash: newPasswordHash });
  }
}
