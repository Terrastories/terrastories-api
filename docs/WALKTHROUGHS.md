# Persona walkthroughs

Scripts that a person can read and follow. They drive the real V2 HTTP API as
every persona (anonymous visitor, viewer, member, editor, community admin,
super admin, steward, field-kit operator) and write one narrated transcript
per persona. There is no UI yet; these stand in for it. The source of truth is
[`V2-FRONTEND-HANDOFF.md`](V2-FRONTEND-HANDOFF.md) sections 4 and 5
(89 interaction rows) and [`V2-ROUTE-REGISTRY.md`](V2-ROUTE-REGISTRY.md).

## Run it

```sh
# against a deployed Worker or a local server (npm run dev:hono)
export WT_ADMIN_IDENTIFIER=...   # login of the community admin (username or email)
export WT_ADMIN_PASSWORD=...     # never printed, never written
export WT_SUPER_IDENTIFIER=...   # super admin, needed for --persona all
export WT_SUPER_PASSWORD=...
npm run walkthrough -- --base-url https://staging.example --community barbara \
  --persona all --out walkthrough-out --admin-credentials-env --super-credentials-env \
  --allow-destructive

# no server at hand: an in-process stand-in (SQLite, local files)
npm run walkthrough -- --local --allow-destructive
```

| Option                             | Meaning                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--base-url`                       | API origin. Required unless `--local`.                                                                                                                                            |
| `--community`                      | Slug of the community to visit. Default `barbara`.                                                                                                                                |
| `--persona`                        | `anonymous`, `viewer`, `member`, `editor`, `admin`, `super`, `steward`, `fieldkit` or `all`. A persona also runs the chapters it depends on. Coverage is enforced only for `all`. |
| `--admin-credentials-env [PREFIX]` | Reads `PREFIX_IDENTIFIER` and `PREFIX_PASSWORD` (default `WT_ADMIN`). A migrated Rails account works: the login shows the bcrypt wrap and the Argon2id upgrade.                   |
| `--super-credentials-env [PREFIX]` | Same for the super admin (default `WT_SUPER`).                                                                                                                                    |
| `--setup-from-bootstrap`           | Fresh install: the field-kit operator creates the community and its admin through `/v2/bootstrap` (reads `WT_BOOTSTRAP_SECRET`); that admin then plays Ana.                       |
| `--allow-destructive`              | Also walks steward notices, withdrawal and erasure. Without it those steps appear as "deferred" lines.                                                                            |
| `--out`                            | Output folder.                                                                                                                                                                    |

Exit code is non-zero when any step fails, or when `--persona all` leaves a
non-dropped handoff row without a step.

## Follow it

Open `<out>/summary.md` first: the coverage table maps every handoff row (A01
to V21) to the step numbers that exercised it, and prints each dropped row as
"skipped by decision Dxx". Then read the persona transcripts
(`community-admin.md`, `editor.md`, ...). Each step has a number
(chapter.step), a sentence in plain language, the request it sends, the
result, and what a UI screen would show. Negative checks (for example a viewer
trying to edit) say "must be refused". `results.json` holds the same data.

Chapters run in this order: Ana opens the community and invites the team;
Elena (editor) writes; Vera (viewer); Mateo (member); Pia (anonymous); Ana
manages maps, branding, export, sovereignty and a second admin, Adrian; Sam
(super admin); Samir (steward, destructive); Kofi (field-kit operator); Ana
tidies up.

## Safety on a shared staging

- Everything the run creates is prefixed `wt-<runid>`. Accounts come from the
  real V2 flows (admin creates user, one-time login code, redeem), never from
  database writes. Passwords, derived keys, cookies, tokens and recovery codes
  stay in memory and are masked in every output.
- The visited community's real admin never has the password, profile or
  recovery codes changed. Password, profile and session flows use the accounts
  the script created.
- Settings changed on the visited community (map settings including Mapbox,
  description, visibility, branding images) are saved first and restored in the
  last chapter. Visibility is briefly set to private to prove the Mapbox
  reset (#277), so run it when a short public blip is acceptable.
- Withdrawal and erasure run only on a disposable community the script
  provisions as `wt-<runid>-lab`, only with `--allow-destructive`, and the
  steps refuse to run when the slug is not the run-prefixed one or equals
  `--community`.
- There is no user delete (D12): created users are disabled at the end. Audit
  rows and the erasure record stay by design. An unclaimed second community
  (`wt-<runid>-gone`) is deprovisioned during the run.

## Known limits

- Client-only rows (language picker, cluster expansion, intro popup, ...) are
  printed as explicit skip lines; browser and offline field-kit proof (V21)
  stays with the frontend phase (#147, #185).
- The first-install path (A08, A09) is exercised only with
  `--setup-from-bootstrap`; on an installed community the run shows that setup
  is closed and refuses a second bootstrap.
- Import previews are left open until the cleanup chapter: discarding a
  preview removes its staged source bytes but leaves the file row, and a
  community export then fails with `export_failed` (observed on the Node
  entry). Open previews are discarded at the end of the run, so run the export
  chapter as shipped. See the walkthrough test and the final report.

## Test

`npm run walkthrough:sqlite` runs every persona against an in-process app and
asserts a complete coverage table, no failed step, and no secret in any output.
