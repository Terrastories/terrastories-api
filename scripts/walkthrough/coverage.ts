/**
 * Every interaction of docs/V2-FRONTEND-HANDOFF.md section 4 (Rails list) and
 * section 5 (V2-only screens V01-V21). The run fails when a row that is not
 * dropped has no step: an executed step, or for client-only rows an explicit
 * "skipped" step that names the reason.
 */
export type RowKind = 'api' | 'client' | 'dropped';

export interface CoverageRow {
  id: string;
  title: string;
  /** api: needs an executed, passing step. client: a skip line is enough. dropped: skip line names the decision. */
  kind: RowKind;
  decision?: string;
  note?: string;
}

export const COVERAGE_ROWS: readonly CoverageRow[] = [
  {
    id: 'A01',
    title:
      'Welcome page > Page load: background image, logo, sponsor logos, "Enter Site" button, login/logout/dashboar...',
    kind: 'api',
  },
  {
    id: 'A02',
    title:
      'Every page (welcome, login, onboarding, dashboard sidebar) > Language picker: click locale link; URL prefix...',
    kind: 'client',
    note: 'language picker is client-only i18n',
  },
  {
    id: 'A03',
    title: 'Welcome page > Click "Enter Site" -> /home map',
    kind: 'client',
    note: '"Enter Site" is client-side navigation',
  },
  {
    id: 'A04',
    title:
      'Community search landing (online, no community resolved) > Page load; click "Start Exploring" (external lin...',
    kind: 'api',
  },
  {
    id: 'A05',
    title:
      'Login > Page load: fields login (username OR email), password, language picker, flash errors',
    kind: 'api',
  },
  { id: 'A06', title: 'Login > Submit login form', kind: 'api' },
  {
    id: 'A07',
    title:
      'Onboarding start (offline install only) > Page load: intro + "Begin"; side effect creates super admin terra...',
    kind: 'api',
  },
  {
    id: 'A08',
    title: 'Onboarding > admin account > Fill name, username, password; submit',
    kind: 'api',
  },
  {
    id: 'A09',
    title: 'Onboarding > community > Fill name, country, locale; submit',
    kind: 'api',
  },
  {
    id: 'M01',
    title: 'Map > Page load: stories + place points + map theme + current user',
    kind: 'api',
  },
  {
    id: 'M02',
    title:
      'Map > Pan, zoom, rotate/pitch, nav control, minimap, home button, globe/3D terrain',
    kind: 'client',
    note: 'pan/zoom/rotate is client-side (map-config data is read below)',
  },
  {
    id: 'M03',
    title: 'Map > Click cluster -> zoom to cluster expansion; hover cursor',
    kind: 'client',
    note: 'cluster expansion is client-side',
  },
  {
    id: 'M04',
    title:
      "Map > Click a place marker: popup + list narrows to that point's stories",
    kind: 'api',
  },
  {
    id: 'M05',
    title:
      'Map > Filter bar > Select filter category (Region, Type of place, Speaker, Topic, Language, Speaker communi...',
    kind: 'client',
  },
  {
    id: 'M06',
    title: 'Map > Story card > Sort select: Most recent (default), A-Z, Z-A',
    kind: 'client',
  },
  {
    id: 'M07',
    title:
      'Map > Story card > Click a story: flies to its first place, highlights card (isActive), opens that place popup',
    kind: 'client',
    note: 'fly-to is client-side (story detail data is read below)',
  },
  {
    id: 'M08',
    title:
      'Map > Story card > Render story: speaker photos + names, title (lock icon if not anonymous), HTML descripti...',
    kind: 'api',
  },
  {
    id: 'M09',
    title:
      'Map > Story card > Play/pause video/audio; playing one video pauses all others; video height set from aspec...',
    kind: 'api',
  },
  {
    id: 'M10',
    title: 'Map > Card chrome > Toggle card tray (arrow/close), logo',
    kind: 'client',
    note: 'card tray is client-side chrome',
  },
  {
    id: 'M11',
    title: 'Map > Intro popup > Close "What\'s a terrastory?" intro card',
    kind: 'client',
    note: 'intro popup is client-side',
  },
  {
    id: 'M12',
    title:
      'Map > Card footer > Show "Hello {display_name}" + "Back to welcome"; admin only: "Member dashboard" link',
    kind: 'api',
  },
  {
    id: 'M13',
    title:
      'Map > Popup / Story > Clicking links to external media (media_links)',
    kind: 'api',
  },
  {
    id: 'B01',
    title:
      'Dashboard layout > user menu > Open dropdown: Profile / Change password / Logout; display name + photo',
    kind: 'api',
  },
  {
    id: 'B02',
    title:
      'Profile > Edit name, username, email, photo (png/jpeg, <=5 MB); submit',
    kind: 'api',
  },
  {
    id: 'B03',
    title:
      'Profile / Edit user > Remove current photo (hover overlay, confirm, AJAX; image replaced by default avatar)',
    kind: 'api',
  },
  {
    id: 'B04',
    title:
      'Change password > Enter password + confirmation; submit (no current password asked)',
    kind: 'api',
  },
  { id: 'B05', title: 'Dashboard > Logout', kind: 'api' },
  {
    id: 'B06',
    title:
      'Dashboard top bar > Global search box (search term) -> results rows with highlighted match + "Show {resourc...',
    kind: 'api',
  },
  {
    id: 'B07',
    title:
      'Dashboard sidebar > Language picker (locale badges with tooltip names)',
    kind: 'client',
    note: 'language picker is client-only i18n',
  },
  {
    id: 'B08',
    title:
      'Dashboard sidebar / top > Navigation: Stories, Speakers, Places; admin: Users, Theme, Import, Community set...',
    kind: 'client',
    note: 'navigation is client-side',
  },
  {
    id: 'B09',
    title:
      'Stories list > Filter form: place, speaker, visibility (hidden for viewer); submit; infinite-scroll paginat...',
    kind: 'api',
  },
  {
    id: 'B10',
    title:
      'Story page > View story: title, topic, language/permission badges, description, media gallery, places list ...',
    kind: 'api',
  },
  {
    id: 'B11',
    title:
      'Places list > Browse place cards (photo or default icon, region, name, type badge, description); infinite s...',
    kind: 'api',
  },
  {
    id: 'B12',
    title:
      'Place page > View place: photo, name, region, type, play name audio (icon toggles play/pause), description,...',
    kind: 'api',
  },
  {
    id: 'B13',
    title:
      'Speakers list > Browse speaker cards (photo or default); infinite scroll',
    kind: 'api',
  },
  {
    id: 'B14',
    title:
      'Speaker page > View speaker: photo, speaker_community, name, birthdate (localised long), birthplace, stories',
    kind: 'api',
  },
  {
    id: 'C01',
    title: 'Stories list > Click "New" -> story form',
    kind: 'client',
    note: '"New" opens a client-side form',
  },
  {
    id: 'C02',
    title:
      'Story form (new) > Create story: title, description (textarea), language (text), topic (text), date_intervi...',
    kind: 'api',
  },
  {
    id: 'C03',
    title:
      'Story form (edit) > Edit all story fields; replace places/speakers; add more media',
    kind: 'api',
  },
  {
    id: 'C04',
    title:
      'Story form (edit) > existing media list > Remove one media item (confirm dialog, AJAX, element removed)',
    kind: 'api',
  },
  {
    id: 'C06',
    title: 'Story page > Delete story (confirm dialog)',
    kind: 'api',
  },
  {
    id: 'C10',
    title:
      'Place form (new/edit) > Create place: name, name audio (file), description, photo, type of place, region, s...',
    kind: 'api',
  },
  { id: 'C11', title: 'Place form (edit) > Update place fields', kind: 'api' },
  {
    id: 'C12',
    title: 'Place form (edit) > Remove name audio (confirm, AJAX)',
    kind: 'api',
  },
  { id: 'C13', title: 'Place form (edit) > Remove photo', kind: 'api' },
  { id: 'C14', title: 'Place page > Delete place (confirm)', kind: 'api' },
  {
    id: 'C20',
    title:
      'Speaker form (new/edit) > Create/edit speaker: name, photo, speaker community, birthdate, birthplace (selec...',
    kind: 'api',
  },
  {
    id: 'C21',
    title:
      'Speaker form (edit) > Remove speaker photo (hover overlay, confirm; default avatar restored)',
    kind: 'api',
  },
  { id: 'C22', title: 'Speaker page > Delete speaker (confirm)', kind: 'api' },
  {
    id: 'C30',
    title:
      'Import page > Pick a CSV per model (places, speakers, stories); client reads header row and shows a column-...',
    kind: 'api',
  },
  {
    id: 'C31',
    title:
      'Import page > Submit import; Rails writes immediately, non-atomic, per-model result',
    kind: 'api',
  },
  {
    id: 'C32',
    title:
      'Import results page > Review: successful count, duplicated rows table, skipped rows table, invalid rows tab...',
    kind: 'api',
  },
  {
    id: 'D01',
    title:
      'Users list > Browse user cards (photo/default, display name, role badge); infinite scroll; "New"',
    kind: 'api',
  },
  {
    id: 'D02',
    title:
      'User form (new) > Create user: username (no spaces, unique), password, role (admin/editor/member/viewer, no...',
    kind: 'api',
  },
  {
    id: 'D03',
    title:
      'User page > View user: photo, username/email, display name, role badge; Edit; Delete (not self)',
    kind: 'api',
  },
  {
    id: 'D04',
    title:
      'User form (edit) > Edit username, email, role (hidden for self), reset password field (blank = unchanged), ...',
    kind: 'api',
  },
  {
    id: 'D05',
    title: 'User page > Delete user (confirm, not self)',
    kind: 'dropped',
    decision: 'D12',
    note: 'No user delete; admins disable users instead',
  },
  {
    id: 'D06',
    title:
      'Theme / map settings > Edit map: centre lat/long (draggable marker + inputs), bounds SW/NE with "unrestrict...',
    kind: 'api',
  },
  {
    id: 'D07',
    title:
      'Theme page / Community settings > Upload/remove welcome background image; upload/remove sponsor logos (mult...',
    kind: 'api',
  },
  {
    id: 'D08',
    title:
      'Community settings (flag-gated) > Toggle "make public" (needs slug); description; display image upload/remo...',
    kind: 'api',
  },
  {
    id: 'S01',
    title:
      'Admin home (Metrics) > View counts: places, stories, speakers, communities, users',
    kind: 'dropped',
    decision: 'D14',
    note: 'super_admin metrics page dropped',
  },
  {
    id: 'S02',
    title:
      'Communities list > Filter by name; sort by field + direction; infinite scroll; "New"',
    kind: 'api',
  },
  {
    id: 'S03',
    title:
      'Community form (new) > Create community: name, country, locale, slug, first admin (username, password, emai...',
    kind: 'api',
  },
  {
    id: 'S04',
    title:
      'Community page > View community: name, slug, public badge, metrics, feature flags table (Enable/Disable per...',
    kind: 'api',
  },
  {
    id: 'S05',
    title: 'Community form (edit) > Edit name, country, locale, slug',
    kind: 'dropped',
    decision: 'D16',
    note: 'super_admin cannot edit community content or settings',
  },
  {
    id: 'S06',
    title: 'Community page > Delete community (confirm) - destroys all content',
    kind: 'api',
  },
  {
    id: 'S07',
    title:
      'Features list / new / edit / show > List flags (state, enabled-for badges), create (snake-case key + descri...',
    kind: 'dropped',
    decision: 'D15',
    note: 'feature flags dropped; outcomes always on',
  },
  {
    id: 'S08',
    title:
      'Dashboard > Cannot open map/stories (Pundit denial); sidebar shows Metrics / Communities / Features',
    kind: 'client',
    note: 'sidebar is client-side (the Pundit denial is shown as a 403 below)',
  },
  { id: 'V01', title: 'Community export', kind: 'api' },
  { id: 'V02', title: 'Sovereignty status page', kind: 'api' },
  { id: 'V03', title: 'Designate / replace / remove steward', kind: 'api' },
  { id: 'V04', title: 'Withdraw community', kind: 'api' },
  { id: 'V05', title: 'Request erasure (irreversible)', kind: 'api' },
  { id: 'V06', title: 'Cancel steward request during notice', kind: 'api' },
  {
    id: 'V07',
    title: 'Recovery codes (generate / regenerate, shown once)',
    kind: 'api',
  },
  {
    id: 'V08',
    title: 'Forced recovery-code gate for community admins',
    kind: 'api',
  },
  {
    id: 'V09',
    title: 'Redeem recovery / admin_issued code (forgot password)',
    kind: 'api',
  },
  {
    id: 'V10',
    title: 'Admin issues one-time login code to a user',
    kind: 'api',
  },
  {
    id: 'V11',
    title:
      "Sessions: revoke all own sessions; admin lists and revokes a user's device sessions",
    kind: 'api',
  },
  { id: 'V12', title: 'Community audit log', kind: 'api' },
  { id: 'V13', title: 'System audit log (super_admin)', kind: 'api' },
  { id: 'V14', title: 'Erasure records (super_admin)', kind: 'api' },
  {
    id: 'V15',
    title: 'Provision/claim lifecycle for hosted communities',
    kind: 'api',
  },
  { id: 'V16', title: 'Story external links CRUD + reorder', kind: 'api' },
  {
    id: 'V17',
    title: 'Attachment reorder (story media, sponsor logos)',
    kind: 'api',
  },
  {
    id: 'V18',
    title: 'Media metadata, staging delete, copy-for-publication',
    kind: 'api',
  },
  {
    id: 'V19',
    title:
      'Visibility audience "community" semantics, #162 hidden rows, place near/bbox search',
    kind: 'api',
  },
  {
    id: 'V20',
    title: 'Readiness/health, password-reset email (optional, not launch)',
    kind: 'api',
  },
  {
    id: 'V21',
    title: 'Field-kit / offline install specifics',
    kind: 'client',
    note: 'field-kit browser and offline proof is out of scope of the API (D31, #147, #185); the API-level bootstrap and import steps run in the field-kit chapter',
  },
];

export const ROW_IDS: ReadonlySet<string> = new Set(
  COVERAGE_ROWS.map((row) => row.id)
);
