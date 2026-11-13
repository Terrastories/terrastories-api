import { buildJourneys, type PersonaFixture } from './journeys.js';
export default (fixture: PersonaFixture) =>
  buildJourneys(fixture).find((journey) => journey.persona === 'admin')!;
