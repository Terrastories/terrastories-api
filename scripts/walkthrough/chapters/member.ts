/**
 * Chapter: Mateo, a member, also sees stories shared with the community.
 */
import { field, guarded, val, activate, type Ctx } from '../context.js';
import { readerNegatives, readerTour } from './reader-tour.js';

export const PERSONA_MEMBER = 'Member';

export async function memberChapter(ctx: Ctx): Promise<void> {
  const { w, s } = ctx;
  const acct = s.accounts.mateo!;
  w.chapter(
    PERSONA_MEMBER,
    'Mateo reads what the community shares',
    'Mateo is a member: besides Anonymous stories he sees stories with the Member audience, but never editor drafts.'
  );
  await guarded(ctx, 'member', async () => {
    const mateo = (s.actors.mateo = w.actor('Mateo', 'member'));
    await activate(ctx, mateo, acct, ['A06']);
    await w.step({
      who: mateo,
      say: 'opens the dashboard',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 200,
      covers: ['B01', 'B08', 'M12'],
      show: (r) => [field('Hello', val(r, 'user', 'displayName')), field('role badge', val(r, 'user', 'role'))],
    });
    await readerTour(ctx, mateo, {
      mustSee: ['How the river got its name', 'Imported open story', 'Imported members story'],
      mustNotSee: ['Editors-only draft'],
      hiddenStoryId: s.ids.draft,
    });
    await readerNegatives(ctx, mateo, { content: ['C02'] });
  });
}
