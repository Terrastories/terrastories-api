/**
 * File Operations Metrics Collector (Issue #89)
 *
 * Simple metrics collection for file upload, access, and deletion operations.
 * Tracks counts, failures, bytes transferred, and p95 duration.
 */

export interface FileOperationMetrics {
  operation: 'upload' | 'access' | 'delete' | 'dual_read';
  count: number;
  failures: number;
  totalBytes: number;
  durations: number[]; // in milliseconds
}

class FileOperationsMetrics {
  private metrics: Map<string, FileOperationMetrics> = new Map();

  /**
   * Record a file operation for metrics collection
   */
  recordOperation(
    operation: 'upload' | 'access' | 'delete' | 'dual_read',
    success: boolean = true,
    bytesTransferred: number = 0,
    duration: number = 0
  ): void {
    const key = operation;
    const existing = this.metrics.get(key) || {
      operation,
      count: 0,
      failures: 0,
      totalBytes: 0,
      durations: [],
    };

    existing.count += 1;
    if (!success) {
      existing.failures += 1;
    }
    existing.totalBytes += bytesTransferred;
    existing.durations.push(duration);

    // Keep only last 1000 durations for p95 calculation
    if (existing.durations.length > 1000) {
      existing.durations = existing.durations.slice(-1000);
    }

    this.metrics.set(key, existing);
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): Record<string, FileOperationMetrics & { p95Duration: number }> {
    const result: Record<
      string,
      FileOperationMetrics & { p95Duration: number }
    > = {};

    for (const [key, metrics] of this.metrics.entries()) {
      const p95Duration = this.calculateP95(metrics.durations);
      result[key] = {
        ...metrics,
        p95Duration,
      };
    }

    return result;
  }

  /**
   * Calculate 95th percentile duration
   */
  private calculateP95(durations: number[]): number {
    if (durations.length === 0) return 0;

    const sorted = [...durations].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[index] || 0;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear();
  }
}

// Singleton instance
export const fileOperationsMetrics = new FileOperationsMetrics();
