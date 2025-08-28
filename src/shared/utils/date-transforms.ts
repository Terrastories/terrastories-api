/**
 * Date Transformation Utilities
 * 
 * Utility functions for standardizing date handling across the application.
 * Ensures consistent ISO string formatting regardless of input type.
 */

/**
 * Transform date-like value to ISO string format
 * Handles both Date objects and date strings/numbers consistently
 * 
 * @param dateValue - Date object, string, number, or other date-like value
 * @returns ISO string representation of the date
 */
export function toISOString(dateValue: Date | string | number | unknown): string {
  if (dateValue instanceof Date) {
    return dateValue.toISOString();
  }
  
  // Handle string/number dates by creating new Date instance
  return new Date(dateValue as string | number).toISOString();
}

/**
 * Transform date-like value to nullable ISO string format
 * Returns null for falsy values, otherwise converts to ISO string
 * 
 * @param dateValue - Date object, string, number, or other date-like value
 * @returns ISO string representation or null
 */
export function toISOStringOrNull(dateValue: Date | string | number | unknown | null | undefined): string | null {
  if (!dateValue) {
    return null;
  }
  
  return toISOString(dateValue);
}

/**
 * Transform multiple date fields in an object to ISO strings
 * Useful for transforming database results with multiple date fields
 * 
 * @param obj - Object containing date fields
 * @param dateFields - Array of field names to transform
 * @returns New object with transformed date fields
 */
export function transformDateFields<T extends Record<string, any>>(
  obj: T, 
  dateFields: (keyof T)[]
): T {
  const transformed = { ...obj };
  
  for (const field of dateFields) {
    if (transformed[field]) {
      transformed[field] = toISOString(transformed[field]) as T[keyof T];
    }
  }
  
  return transformed;
}