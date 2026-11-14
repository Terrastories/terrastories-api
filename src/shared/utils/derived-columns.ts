import {
  descriptionPlainText,
  validateDescriptionForWrite,
  type PlainText,
} from './safe-description.js';
import { normalizeSearchText } from './search-normalize.js';

export interface DerivedTopicColumns {
  topic: string | null;
  topicNormalized: string | null;
}

export interface DerivedDescriptionColumns {
  description: string | null;
  descriptionPlain: PlainText | null;
}

/**
 * Derive normalized topic text for V2 story writes.
 * Empty/whitespace-only or nullish topics produce `null`.
 */
export function deriveTopicNormalized(
  topic: string | null | undefined
): string | null {
  if (topic == null) {
    return null;
  }
  const trimmed = topic.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return normalizeSearchText(trimmed);
}

/**
 * Derive stored `topic` and `topicNormalized` columns for V2 story writes.
 */
export function deriveTopicColumns(
  topic: string | null | undefined
): DerivedTopicColumns {
  if (topic == null) {
    return { topic: null, topicNormalized: null };
  }
  const trimmed = topic.trim();
  if (trimmed.length === 0) {
    return { topic: null, topicNormalized: null };
  }
  return {
    topic: trimmed,
    topicNormalized: deriveTopicNormalized(trimmed),
  };
}

/**
 * Derive plain-text description from already-validated HTML for V2 writes.
 */
export function deriveDescriptionPlain(
  validatedHtml: string | null | undefined
): PlainText | null {
  if (validatedHtml == null || validatedHtml.length === 0) {
    return null;
  }
  const plain = descriptionPlainText(validatedHtml);
  return plain.trim().length === 0 ? null : plain;
}

/**
 * Validate/sanitize rich-text input and derive `description` + `descriptionPlain`
 * in one step for V2 write paths.
 */
export function deriveDescriptionForWrite(
  input: string | null | undefined
): DerivedDescriptionColumns {
  if (input == null || input.trim().length === 0) {
    return { description: null, descriptionPlain: null };
  }
  const { html, plainText } = validateDescriptionForWrite(input);
  return {
    description: html.length === 0 ? null : html,
    descriptionPlain: plainText.length === 0 ? null : plainText,
  };
}
