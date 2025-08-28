/**
 * Super Admin Audit Logger
 * 
 * Provides audit logging for super admin actions to ensure transparency
 * and compliance with Indigenous data sovereignty requirements.
 */

/**
 * Super admin audit log entry
 */
export interface SuperAdminAuditLog {
  action: 'community_create' | 'community_update' | 'community_delete' | 'community_view' | 
          'user_create' | 'user_update' | 'user_delete' | 'user_view' | 'user_list';
  resource: 'community' | 'user';
  resourceId?: number;
  adminUserId: number;
  adminEmail: string;
  details?: Record<string, any>;
  success: boolean;
  reason?: string;
  timestamp: Date;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Super Admin Audit Logger class
 */
export class SuperAdminAuditLogger {
  private static instance: SuperAdminAuditLogger;
  private loggers: ((entry: SuperAdminAuditLog) => void)[] = [];

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): SuperAdminAuditLogger {
    if (!SuperAdminAuditLogger.instance) {
      SuperAdminAuditLogger.instance = new SuperAdminAuditLogger();
    }
    return SuperAdminAuditLogger.instance;
  }

  /**
   * Add a logger function
   */
  addLogger(logger: (entry: SuperAdminAuditLog) => void): void {
    this.loggers.push(logger);
  }

  /**
   * Log a super admin action
   */
  log(entry: SuperAdminAuditLog): void {
    this.loggers.forEach(logger => {
      try {
        logger(entry);
      } catch (error) {
        console.error('Failed to write audit log:', error);
      }
    });
  }

  /**
   * Create audit log entry for community operations
   */
  static createCommunityEntry(
    action: SuperAdminAuditLog['action'],
    adminUserId: number,
    adminEmail: string,
    success: boolean,
    resourceId?: number,
    details?: Record<string, any>,
    reason?: string
  ): SuperAdminAuditLog {
    return {
      action,
      resource: 'community',
      resourceId,
      adminUserId,
      adminEmail,
      details,
      success,
      reason,
      timestamp: new Date(),
    };
  }

  /**
   * Create audit log entry for user operations
   */
  static createUserEntry(
    action: SuperAdminAuditLog['action'],
    adminUserId: number,
    adminEmail: string,
    success: boolean,
    resourceId?: number,
    details?: Record<string, any>,
    reason?: string
  ): SuperAdminAuditLog {
    return {
      action,
      resource: 'user',
      resourceId,
      adminUserId,
      adminEmail,
      details,
      success,
      reason,
      timestamp: new Date(),
    };
  }
}

/**
 * Convenience function to get audit logger instance
 */
export function getAuditLogger(): SuperAdminAuditLogger {
  return SuperAdminAuditLogger.getInstance();
}