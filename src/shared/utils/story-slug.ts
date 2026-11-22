/**
 * Slug base shared by the runtime story writers and the Rails migration
 * transform, so a migrated story slug is derived exactly like a runtime one.
 */
export function storySlugBase(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
