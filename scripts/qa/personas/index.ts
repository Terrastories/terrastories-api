export type { PersonaFixture } from './journeys.js';
import p0 from './anonymous.js';
import p1 from './viewer.js';
import p2 from './member.js';
import p3 from './editor.js';
import p4 from './admin.js';
import p5 from './restricted-holder.js';
import p6 from './super_admin.js';
import p7 from './field-kit.js';
import type { PersonaFixture } from './journeys.js';
export function createJourneys(fixture: PersonaFixture) {
  return [p0, p1, p2, p3, p4, p5, p6, p7].map((build) => build(fixture));
}
