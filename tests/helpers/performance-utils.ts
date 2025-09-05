/**
 * Performance Optimization Utilities
 *
 * Helper functions for Issue #64: Performance Test Cleanup and Foreign Key Issues
 * Implements utilities for testing performance constraints and resource management
 * specifically for Indigenous community Field Kit hardware deployments.
 *
 * Key Features:
 * - Memory usage monitoring and validation
 * - File system operations with cleanup tracking
 * - Cultural protocol validation for Indigenous data sovereignty
 * - Resource constraint testing for 128MB RAM, slow storage environments
 * - Performance benchmarking for community workflow processing
 */

import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Calculate directory size recursively
 * @param dirPath Directory path to analyze
 * @returns Total size in bytes
 */
export async function getDirSize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = join(dirPath, item.name);

      if (item.isDirectory()) {
        totalSize += await getDirSize(fullPath);
      } else if (item.isFile()) {
        const stats = await fs.stat(fullPath);
        totalSize += stats.size;
      }
    }
  } catch (error) {
    // Directory doesn't exist or is not accessible
    return 0;
  }

  return totalSize;
}

/**
 * Clean up temporary files with proper error handling
 * @param filePaths Array of file paths to delete
 */
export async function cleanupTempFiles(filePaths: string[]): Promise<void> {
  const cleanupResults = await Promise.allSettled(
    filePaths.map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        // File might not exist or already deleted
        console.warn(
          `Could not delete temp file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  // Log any cleanup failures
  const failures = cleanupResults.filter(
    (result) => result.status === 'rejected'
  );
  if (failures.length > 0) {
    console.warn(`Failed to clean up ${failures.length} temp files`);
  }
}

/**
 * Validate cultural access permissions for Indigenous community protocols
 * @param speaker Speaker name
 * @param restrictionLevel Access restriction level
 * @returns true if access is valid, false otherwise
 */
export function validateCulturalAccess(
  speaker: string,
  restrictionLevel: string
): boolean {
  // Define cultural access rules for Indigenous community protocols
  const elderSpeakers = [
    'Elder Maria',
    'Elder Joseph',
    'Knowledge Keeper Sarah',
    'Knowledge Keeper John',
  ];
  const generalSpeakers = [
    'Community Member John',
    'Youth Representative Lisa',
  ];

  switch (restrictionLevel) {
    case 'elder-only':
      return elderSpeakers.includes(speaker);
    case 'community-member':
      return [...elderSpeakers, ...generalSpeakers].includes(speaker);
    case 'public':
      return true;
    default:
      return false;
  }
}

/**
 * Simulate community data isolation validation
 * @param communityId Community ID to validate
 * @param metadata Story metadata to validate
 */
export async function simulateCommunityDataIsolation(
  communityId: number,
  metadata: any
): Promise<void> {
  // Simulate validation process for Indigenous data sovereignty

  // Check if community ID is valid
  if (communityId <= 0) {
    throw new Error('Invalid community ID for data sovereignty validation');
  }

  // Validate cultural context is appropriate for community
  if (
    metadata.culturalContext &&
    typeof metadata.culturalContext !== 'string'
  ) {
    throw new Error(
      'Cultural context must be a string describing the cultural significance'
    );
  }

  // Validate restriction level is properly set
  const validRestrictionLevels = ['public', 'community-member', 'elder-only'];
  if (
    metadata.restrictionLevel &&
    !validRestrictionLevels.includes(metadata.restrictionLevel)
  ) {
    throw new Error('Invalid restriction level for community data isolation');
  }

  // Simulate checking that speakers belong to the correct community
  if (metadata.speakers) {
    for (const speaker of metadata.speakers) {
      // In a real implementation, this would check the database
      // For testing, we simulate community membership validation
      if (!speaker || typeof speaker !== 'string') {
        throw new Error(`Invalid speaker data for community ${communityId}`);
      }
    }
  }

  // Simulate delay for database lookups
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Calculate simple checksum for data integrity validation
 * @param data Buffer containing data to checksum
 * @returns Simple checksum as number
 */
export function calculateSimpleChecksum(data: Buffer): number {
  let checksum = 0;

  // Simple checksum algorithm (sum of all bytes)
  for (let i = 0; i < data.length; i++) {
    checksum += data[i];
  }

  // Return checksum modulo 2^32 to keep it as 32-bit integer
  return checksum >>> 0;
}

/**
 * Monitor memory usage during operation
 * @param operation Async operation to monitor
 * @returns Object containing operation result and peak memory usage
 */
export async function monitorMemoryUsage<T>(
  operation: () => Promise<T>
): Promise<{ result: T; peakMemory: number; initialMemory: number }> {
  const initialMemory = process.memoryUsage().heapUsed;
  let peakMemory = initialMemory;

  // Monitor memory usage every 10ms during operation
  const memoryMonitor = setInterval(() => {
    const currentMemory = process.memoryUsage().heapUsed;
    if (currentMemory > peakMemory) {
      peakMemory = currentMemory;
    }
  }, 10);

  try {
    const result = await operation();

    // Final memory check
    const finalMemory = process.memoryUsage().heapUsed;
    if (finalMemory > peakMemory) {
      peakMemory = finalMemory;
    }

    return {
      result,
      peakMemory,
      initialMemory,
    };
  } finally {
    clearInterval(memoryMonitor);
  }
}

/**
 * Create test files with specified sizes for performance testing
 * @param directory Directory to create files in
 * @param fileSizes Array of file sizes in bytes
 * @returns Array of created file paths
 */
export async function createTestFiles(
  directory: string,
  fileSizes: number[]
): Promise<string[]> {
  // Ensure directory exists
  await fs.mkdir(directory, { recursive: true });

  const filePaths: string[] = [];

  for (let i = 0; i < fileSizes.length; i++) {
    const fileName = `test-file-${i}.dat`;
    const filePath = join(directory, fileName);

    // Create file with specified size
    const content = Buffer.alloc(fileSizes[i], i % 256);
    await fs.writeFile(filePath, content);

    filePaths.push(filePath);
  }

  return filePaths;
}

/**
 * Measure operation performance
 * @param operation Operation to measure
 * @param name Operation name for logging
 * @returns Performance metrics
 */
export async function measurePerformance<T>(
  operation: () => Promise<T>,
  name: string
): Promise<{
  result: T;
  duration: number;
  memoryUsed: number;
}> {
  const startTime = Date.now();
  const startMemory = process.memoryUsage().heapUsed;

  console.log(`📊 Starting performance measurement: ${name}`);

  const result = await operation();

  const endTime = Date.now();
  const endMemory = process.memoryUsage().heapUsed;

  const duration = endTime - startTime;
  const memoryUsed = endMemory - startMemory;

  console.log(`📊 Performance measurement complete: ${name}`);
  console.log(`   Duration: ${duration}ms`);
  console.log(`   Memory used: ${(memoryUsed / 1024 / 1024).toFixed(2)}MB`);

  return {
    result,
    duration,
    memoryUsed,
  };
}

/**
 * Validate Field Kit hardware constraints
 * @param metrics Performance metrics to validate
 * @param constraints Hardware constraints
 * @returns Validation result
 */
export function validateFieldKitConstraints(
  metrics: { duration: number; memoryUsed: number; diskUsage: number },
  constraints: { maxDuration: number; maxMemory: number; maxDisk: number }
): {
  valid: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  if (metrics.duration > constraints.maxDuration) {
    violations.push(
      `Duration exceeded: ${metrics.duration}ms > ${constraints.maxDuration}ms`
    );
  }

  if (metrics.memoryUsed > constraints.maxMemory) {
    violations.push(
      `Memory exceeded: ${(metrics.memoryUsed / 1024 / 1024).toFixed(2)}MB > ${(constraints.maxMemory / 1024 / 1024).toFixed(2)}MB`
    );
  }

  if (metrics.diskUsage > constraints.maxDisk) {
    violations.push(
      `Disk usage exceeded: ${(metrics.diskUsage / 1024 / 1024).toFixed(2)}MB > ${(constraints.maxDisk / 1024 / 1024).toFixed(2)}MB`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Simulate Indigenous community workflow processing
 * @param workflow Workflow configuration
 * @returns Processing result
 */
export async function processIndigenousCommunityWorkflow(workflow: {
  storyMetadata: any;
  mediaFiles: Array<{ name: string; size: number }>;
  communityId: number;
}): Promise<{
  success: boolean;
  processedFiles: number;
  culturalValidationsPassed: number;
  duration: number;
}> {
  const startTime = Date.now();
  let processedFiles = 0;
  let culturalValidationsPassed = 0;

  try {
    // Validate story metadata for cultural appropriateness
    if (workflow.storyMetadata.culturalContext) {
      const isValid = validateCulturalAccess(
        workflow.storyMetadata.speakers[0],
        workflow.storyMetadata.restrictionLevel
      );
      if (isValid) {
        culturalValidationsPassed++;
      }
    }

    // Process media files with Indigenous community protocols
    for (const mediaFile of workflow.mediaFiles) {
      // Simulate file processing with cultural considerations
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(mediaFile.size / 1000000, 10))
      ); // Max 10ms per file

      // Validate file meets community standards
      if (
        mediaFile.name.includes('ceremony') &&
        workflow.storyMetadata.restrictionLevel !== 'elder-only'
      ) {
        throw new Error('Ceremony content must be elder-only restricted');
      }

      processedFiles++;
    }

    // Ensure community data isolation
    await simulateCommunityDataIsolation(
      workflow.communityId,
      workflow.storyMetadata
    );

    const duration = Date.now() - startTime;

    return {
      success: true,
      processedFiles,
      culturalValidationsPassed,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    return {
      success: false,
      processedFiles,
      culturalValidationsPassed,
      duration,
    };
  }
}
