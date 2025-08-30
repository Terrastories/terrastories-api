/**
 * Deep JSON Response Comparison Utility
 */
export class ResponseDiffer {
  /**
   * Compare two API responses and determine if they match
   */
  compareResponses(
    response1: any,
    response2: any
  ): {
    match: boolean;
    differences: string[];
  } {
    const differences: string[] = [];

    // Compare status codes
    if (response1.statusCode !== response2.statusCode) {
      differences.push(
        `Status code mismatch: ${response1.statusCode} vs ${response2.statusCode}`
      );
    }

    // Parse and normalize response bodies
    const body1 = this.normalizeResponse(this.parseBody(response1.body));
    const body2 = this.normalizeResponse(this.parseBody(response2.body));

    // Compare structures
    const structureDiffs = this.compareStructure(body1, body2);
    differences.push(...structureDiffs);

    // Compare values
    const valueDiffs = this.compareValues(body1, body2);
    differences.push(...valueDiffs);

    return {
      match: differences.length === 0,
      differences,
    };
  }

  /**
   * Create detailed human-readable diff
   */
  createDetailedDiff(response1: any, response2: any): string {
    const comparison = this.compareResponses(response1, response2);

    if (comparison.match) {
      return 'Responses match perfectly';
    }

    let diff = '\n=== API Response Differences ===\n';

    comparison.differences.forEach((difference, index) => {
      diff += `${index + 1}. ${difference}\n`;
    });

    diff += '\n=== Rails Response ===\n';
    diff += JSON.stringify(response1, null, 2);

    diff += '\n\n=== TypeScript Response ===\n';
    diff += JSON.stringify(response2, null, 2);

    return diff;
  }

  /**
   * Normalize response for comparison (handle timestamps, dynamic IDs)
   */
  private normalizeResponse(response: any): any {
    if (!response || typeof response !== 'object') {
      return response;
    }

    if (Array.isArray(response)) {
      return response.map((item) => this.normalizeResponse(item));
    }

    const normalized: any = {};

    for (const [key, value] of Object.entries(response)) {
      // Normalize timestamps to ISO strings
      if (this.isTimestampField(key) && typeof value === 'string') {
        normalized[key] = this.normalizeTimestamp(value);
      }
      // Recursively normalize nested objects
      else if (typeof value === 'object' && value !== null) {
        normalized[key] = this.normalizeResponse(value);
      } else {
        normalized[key] = value;
      }
    }

    return normalized;
  }

  private parseBody(body: any): any {
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    return body;
  }

  private isTimestampField(fieldName: string): boolean {
    const timestampFields = [
      'createdAt',
      'updatedAt',
      'created_at',
      'updated_at',
      'timestamp',
    ];
    return timestampFields.includes(fieldName);
  }

  private normalizeTimestamp(timestamp: string): string {
    try {
      return new Date(timestamp).toISOString();
    } catch {
      return timestamp;
    }
  }

  /**
   * Compare JSON structure (field names, types, nesting)
   */
  private compareStructure(obj1: any, obj2: any): string[] {
    const differences: string[] = [];

    if (typeof obj1 !== typeof obj2) {
      differences.push(`Type mismatch: ${typeof obj1} vs ${typeof obj2}`);
      return differences;
    }

    if (Array.isArray(obj1) !== Array.isArray(obj2)) {
      differences.push(
        `Array type mismatch: ${Array.isArray(obj1)} vs ${Array.isArray(obj2)}`
      );
      return differences;
    }

    if (typeof obj1 === 'object' && obj1 !== null && obj2 !== null) {
      const keys1 = Object.keys(obj1);
      const keys2 = Object.keys(obj2);

      // Check for missing keys in obj2
      for (const key of keys1) {
        if (!keys2.includes(key)) {
          differences.push(`Missing key in response 2: ${key}`);
        }
      }

      // Check for extra keys in obj2
      for (const key of keys2) {
        if (!keys1.includes(key)) {
          differences.push(`Extra key in response 2: ${key}`);
        }
      }

      // Recursively check nested structures
      for (const key of keys1) {
        if (keys2.includes(key)) {
          const nestedDiffs = this.compareStructure(obj1[key], obj2[key]);
          differences.push(...nestedDiffs.map((diff) => `${key}.${diff}`));
        }
      }
    }

    return differences;
  }

  /**
   * Compare data values accounting for acceptable differences
   */
  private compareValues(obj1: any, obj2: any): string[] {
    const differences: string[] = [];

    if (obj1 === null && obj2 === null) {
      return differences;
    }

    if (obj1 === null || obj2 === null) {
      differences.push(`Null value mismatch: ${obj1} vs ${obj2}`);
      return differences;
    }

    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') {
      // For primitive values, check if they're equal or acceptably different
      if (obj1 !== obj2) {
        differences.push(`Value mismatch: ${obj1} vs ${obj2}`);
      }
      return differences;
    }

    if (Array.isArray(obj1) && Array.isArray(obj2)) {
      if (obj1.length !== obj2.length) {
        differences.push(
          `Array length mismatch: ${obj1.length} vs ${obj2.length}`
        );
      }

      const minLength = Math.min(obj1.length, obj2.length);
      for (let i = 0; i < minLength; i++) {
        const nestedDiffs = this.compareValues(obj1[i], obj2[i]);
        differences.push(...nestedDiffs.map((diff) => `[${i}].${diff}`));
      }

      return differences;
    }

    // Compare object properties
    const keys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);

    for (const key of keys) {
      if (!(key in obj1)) {
        differences.push(`Missing key in response 1: ${key}`);
        continue;
      }

      if (!(key in obj2)) {
        differences.push(`Missing key in response 2: ${key}`);
        continue;
      }

      // Handle timestamp fields with acceptable differences
      if (this.isTimestampField(key)) {
        if (!this.isAcceptableTimestampDiff(obj1[key], obj2[key])) {
          differences.push(
            `Timestamp difference too large: ${key} - ${obj1[key]} vs ${obj2[key]}`
          );
        }
        continue;
      }

      const nestedDiffs = this.compareValues(obj1[key], obj2[key]);
      differences.push(...nestedDiffs.map((diff) => `${key}.${diff}`));
    }

    return differences;
  }

  /**
   * Check if timestamp differences are within acceptable range
   */
  private isAcceptableTimestampDiff(time1: string, time2: string): boolean {
    try {
      const date1 = new Date(time1);
      const date2 = new Date(time2);

      // Allow up to 5 seconds difference for timestamps
      const diffMs = Math.abs(date1.getTime() - date2.getTime());
      const maxDiffMs = 5000; // 5 seconds

      return diffMs <= maxDiffMs;
    } catch {
      // If we can't parse as dates, compare as strings
      return time1 === time2;
    }
  }
}
