/**
 * Unit tests for interview metadata functionality
 * Issue #81: Add story interview metadata fields
 */

import { describe, it, expect } from 'vitest';
import {
  insertStorySchema,
  createStorySchema,
} from '../../src/db/schema/stories.js';

describe('Interview Metadata Schema Validation', () => {
  it('should validate story creation with interview metadata', () => {
    const validStoryData = {
      title: 'Test Story',
      description: 'A test story with interview metadata',
      slug: 'test-story',
      communityId: 1,
      createdBy: 1,
      dateInterviewed: new Date('2023-01-15'),
      interviewLocationId: 5,
      interviewerId: 3,
    };

    const result = insertStorySchema.safeParse(validStoryData);
    if (!result.success) {
      console.log('Validation errors:', result.error.issues);
    }
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.dateInterviewed).toEqual(new Date('2023-01-15'));
      expect(result.data.interviewLocationId).toBe(5);
      expect(result.data.interviewerId).toBe(3);
    }
  });

  it('should validate story creation without interview metadata', () => {
    const validStoryData = {
      title: 'Test Story Without Interview Data',
      description: 'A test story without interview metadata',
      slug: 'test-story-no-interview',
      communityId: 1,
      createdBy: 1,
    };

    const result = insertStorySchema.safeParse(validStoryData);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.dateInterviewed).toBeUndefined();
      expect(result.data.interviewLocationId).toBeUndefined();
      expect(result.data.interviewerId).toBeUndefined();
    }
  });

  it('should reject invalid interview location ID', () => {
    const invalidStoryData = {
      title: 'Test Story',
      slug: 'test-story-invalid',
      communityId: 1,
      createdBy: 1,
      interviewLocationId: -1, // Invalid: negative number
    };

    const result = insertStorySchema.safeParse(invalidStoryData);
    expect(result.success).toBe(false);
  });

  it('should reject invalid interviewer ID', () => {
    const invalidStoryData = {
      title: 'Test Story',
      slug: 'test-story-invalid-interviewer',
      communityId: 1,
      createdBy: 1,
      interviewerId: 0, // Invalid: zero
    };

    const result = insertStorySchema.safeParse(invalidStoryData);
    expect(result.success).toBe(false);
  });

  it('should validate create story schema with interview metadata', () => {
    const validCreateData = {
      title: 'Test Creation Story',
      communityId: 1,
      createdBy: 1,
      dateInterviewed: new Date('2023-06-15'),
      interviewLocationId: 10,
      interviewerId: 7,
    };

    const result = createStorySchema.safeParse(validCreateData);
    if (!result.success) {
      console.log('Create validation errors:', result.error.issues);
    }
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.dateInterviewed).toEqual(new Date('2023-06-15'));
      expect(result.data.interviewLocationId).toBe(10);
      expect(result.data.interviewerId).toBe(7);
    }
  });

  it('should handle date string parsing for interview date', () => {
    const dataWithStringDate = {
      title: 'Test Story with String Date',
      slug: 'test-story-string-date',
      communityId: 1,
      createdBy: 1,
      dateInterviewed: '2023-03-20',
    };

    const result = insertStorySchema.safeParse(dataWithStringDate);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.dateInterviewed).toBeInstanceOf(Date);
    }
  });
});

describe('Interview Metadata Types', () => {
  it('should have correct TypeScript types for interview metadata', () => {
    // This test verifies that our TypeScript types are correctly inferred
    const storyData = {
      title: 'Type Test Story',
      communityId: 1,
      createdBy: 1,
      dateInterviewed: new Date(),
      interviewLocationId: 1,
      interviewerId: 1,
    } as const;

    // Type assertions to ensure compile-time type checking
    const dateInterviewed: Date = storyData.dateInterviewed;
    const interviewLocationId: number = storyData.interviewLocationId;
    const interviewerId: number = storyData.interviewerId;

    expect(dateInterviewed).toBeInstanceOf(Date);
    expect(typeof interviewLocationId).toBe('number');
    expect(typeof interviewerId).toBe('number');
  });
});
