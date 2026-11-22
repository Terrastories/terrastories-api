# Persona walkthroughs

Scripts that a person can read and follow. They drive the real V2 HTTP API as
every persona (anonymous visitor, viewer, member, editor, community admin,
super admin, steward, field-kit operator) and write one narrated transcript
per persona. There is no UI yet; these stand in for it. The source of truth is
[`V2-FRONTEND-HANDOFF.md`](V2-FRONTEND-HANDOFF.md) sections 4 and 5
(89 interaction rows) and [`V2-ROUTE-REGISTRY.md`](V2-ROUTE-REGISTRY.md).

## Run it

Everything that changes data runs in a **disposable play community** that the
script creates itself: the super admin creates and claims
`wt-<runid>-play`, and its admin is a script-created account ("Ana"). The
community given with `--community` (the real, migrated one) is only **read**.

```sh
export WT_SUPER_IDENTIFIER=...   # super admin: required to create the play community
export WT_SUPER_PASSWORD=...     # never printed, never written
npm run walkthrough -- --base-url https://staging.example --community barbara \
  --persona all --out walkthrough-out --super-credentials-env --allow-destructive

# also sign in as the real admin for the read-only check (see below)
export WT_ADMIN_IDENTIFIER=... WT_ADMIN_PASSWORD=...
npm run walkthrough -- ... --admin-credentials-env --login-real-admin

# no server at hand: an in-process stand-in (SQLite, local files)
npm run walkthrough -- --local --allow-destructive
```

| Option                             | Meaning                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--base-url`                       | API origin. Required unless `--local`.                                                                                                                                                                           |
| `--community`                      | Slug of the real community. Read-only. Default `barbara`.                                                                                                                                                        |
| `--persona`                        | `anonymous`, `viewer`, `member`, `editor`, `admin`, `super`, `steward`, `fieldkit` or `all`. Coverage is enforced only for `all`.                                                                                |
| `--super-credentials-env [PREFIX]` | Super admin (`PREFIX_IDENTIFIER`, `PREFIX_PASSWORD`, default `WT_SUPER`). Without it no play community can be made: the run says which personas did not run, lists the uncovered rows and fails.                 |
| `--admin-credentials-env [PREFIX]` | Real admin credentials (default `WT_ADMIN`). Used only with `--login-real-admin`.                                                                                                                                |
| `--login-real-admin`               | Explicitly sign in as the real admin in the read-only check. A successful login of a migrated bcrypt account upgrades the stored verifier to Argon2id: expected product behaviour, but a write, so it is opt-in. |
| `--setup-from-bootstrap`           | Fresh install: the field-kit operator creates the community and its admin through `/v2/bootstrap` (reads `WT_BOOTSTRAP_SECRET`); that community is the play community. Only this flag ever sends the secret.     |
| `--allow-destructive`              | Also walks steward notices, withdrawal and erasure (on the lab community). Without it those steps appear as "deferred".                                                                                          |
| `--out`                            | Output folder.                                                                                                                                                                                                   |

Exit code is non-zero when any step fails, when `--persona all` leaves a
non-dropped handoff row without a step, or when a requested persona could not
run (for example no super admin credentials).

### Migrated community check (read-only)

The first chapter only reads the real community: public community page,
stories, places, speakers, media serving and counts. With
`--login-real-admin` the real admin also signs in and the check reads the
community record, the map-config renderer block and the readable counts. It
never generates recovery codes, and never changes steward, visibility,
settings, profile or password. Counts are written into the transcript
(`migrated-community-check.md`).

## Follow it

Open `<out>/summary.md` first: the coverage table maps every handoff row (A01
to V21) to the step numbers that exercised it, and prints each dropped row as
"skipped by decision Dxx". Then read the persona transcripts
(`community-admin.md`, `editor.md`, ...). Each step has a number
(chapter.step), a sentence in plain language, the request it sends, the
result, and what a UI screen would show. Negative checks (for example a viewer
trying to edit) say "must be refused". `results.json` holds the same data.

Chapters run in this order: the read-only check of the real community; Sam prepares the play community; Ana opens the community and invites the team;
Elena (editor) writes; Vera (viewer); Mateo (member); Pia (anonymous); Ana
manages maps, branding, export, sovereignty and a second admin, Adrian; Sam
(super admin); Samir (steward, destructive); Kofi (field-kit operator); Ana
and Sam tidy up.

## Safety on a shared staging

- Everything the run creates is prefixed `wt-<runid>`. Accounts come from the
  real V2 flows (admin creates user, one-time login code, redeem), never from
  database writes. Passwords, derived keys, cookies, tokens and recovery codes
  stay in memory and are masked in every output; the real admin identifier is
  masked too.
- The real community is never written to. Visibility, map settings,
  description, branding, steward, sovereignty and export all run in the play
  community; settings are restored first in the cleanup chapter.
- Lab (`wt-<runid>-lab`, withdrawal and erasure) and play communities are
  created even without `--allow-destructive`, and always disabled at cleanup.
  Erasure runs only with `--allow-destructive`, only on the lab, and the steps
  refuse any slug that is not run-prefixed or equals `--community`.
- Cleanup is a set of independent tasks (one failure never stops the rest) and
  also runs on SIGINT/SIGTERM. There is no user delete (D12): created users are
  disabled. Audit rows and the erasure record stay by design. An unclaimed
  `wt-<runid>-gone` community is deprovisioned during the run.
- Login throttle: the server blocks after 10 failed attempts per 15 minutes
  per IP. The run makes at most 5 deliberate failed login or step-up attempts,
  only against accounts it created, spaced 3 seconds apart on a remote server.
- The export runs on the (small) play community so Workers Free limits are not
  hit.

## Known limits

- Client-only rows (language picker, cluster expansion, intro popup, ...) are
  printed as explicit skip lines; browser and offline field-kit proof (V21)
  stays with the frontend phase (#147, #185).
- A08 and A09 (first install) are fully walked only with
  `--setup-from-bootstrap`. Otherwise the summary shows them as "partially
  covered: closed-setup check only" (a refused second bootstrap, sent with a
  made-up secret); that does not fail the run.
- Discarding an import preview and then exporting is walked as a normal step
  (the old `export_failed` defect was fixed in #280).
- Coverage gate: an API row counts as covered only when a step actually ran.
  A deferred row (V04-V06 without `--allow-destructive`) is uncovered, so
  `--persona all` fails without that flag. Only explicit labels soften this:
  "partially covered" (A08/A09 closed-setup check, V18 copy-for-publication
  with no handler). Client-only rows (including M05 filter control and M06 sort
  select) are skip lines, never API-tested.
- Cookies: a Secure session cookie is never sent over plain HTTP (except to
  localhost); the run stops with a clear error instead.
- Map settings: if the play community had no map configuration the cleanup
  does not write a blank one (there is no delete endpoint); the community is
  disabled anyway. Every uploaded file is cleared at the end, including a
  stray one left by a failed step.

## Test

`npm run walkthrough:sqlite` runs every persona against an in-process app and
asserts a complete coverage table, no failed step, no secret in any output,
that the cleanup restored the play settings and disabled play and lab, that the
real community's rows (community, steward, visibility, settings, admin and
recovery-code state) are byte-identical before and after, and that a run without
super admin credentials fails clearly and changes nothing.
