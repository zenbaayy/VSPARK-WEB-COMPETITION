# VSpark Portal — System Workflow, Competition Data Isolation, and Deployment

This document describes the project in the Desktop folder used for deployment. It distinguishes changes that exist in this repository from steps that must still be applied to the live Supabase and Vercel projects.

## Current diagnosis

The Supabase public catalog has separate competition UUIDs for **CyberShield Challenge – Build a Safer Digital World** and **AI for Everyone – Future Web Challenge**. The portal had already stored a `competition_id` on each legacy participant row, but participant login/dashboard/submission code still treated the legacy `participants` table and global `competition_settings` row as the active workflow. That meant a participant could see a “single JSON object” connection error on hydration, and different competitions could share one participant record, timer, task, or settings.

The code in this Desktop copy now reads settings without PostgREST single-object coercion, loads a user's normalized registrations, routes each dashboard to its competition, uses per-competition duration/payment/Drive configuration, stores timer and submission state per registration, and uses per-registration admin counts/results. A database migration is required before the deployed frontend can use this path.

The public catalog IDs were visible through the project's public endpoint. Private participant rows and registration counts are protected by RLS; this audit did not inspect or change private participant data. The migration preserves the existing `participants` table and copies only records with a valid competition match. Verify the actual row counts in Supabase after running it.

## Workflows

### Participant registration and login

1. The participant opens a competition card. The selected competition UUID is carried in `/web-development-competition/register/<competition-uuid>`.
2. The browser checks that the competition is open, but the database trigger checks status, registration deadline, duplicate registration number, and the two-competition maximum again.
3. A first-time user signs up through Supabase Auth. The Auth trigger creates the profile, compatible legacy participant row, normalized `competition_registrations` row, and a blank `competition_submissions` row.
4. For a user who already has a Supabase account, the registration form accepts their existing email; they use the same password to sign in during registration and add a new competition registration. They must confirm their email first if Supabase requires it.
5. On login the portal loads all registrations belonging to that Auth UUID. The dashboard route carries the registration's competition UUID; the dashboard switcher lets a participant with multiple registrations move between them.

### Timer, drafts, final submissions

Each competition registration has one unique `competition_submissions.registration_id`. Starting a timer calls `start_registration_timer`; the database sets `started_at` once using server time. Drafts call `save_registration_submission_draft`. Final submissions call `submit_registration_project`, which verifies the registration owner, timer, competition-specific duration, deadline, required URLs, and API list on the server. The browser countdown is only a display; the database clock is authoritative.

### Organizer workflow

- **Manage competitions** stores task, rules, timing, status, registration open/closed, manual payment details, organizer Drive folder, and publication state on each competition.
- Participant counts, payment status, GitHub/live/participant Drive links, evaluation and winner status are associated with each normalized registration.
- **Archive** closes registration and keeps the competition and its records. It does not delete registrations, submissions, resources, or storage objects.
- Announcements/email, Google Drive Picker imports, and integrations have separate constraints described below. A Drive link is not an automatic upload and an email/WhatsApp link opens the user's mail/chat app; it does not send a message from the portal.

## Data model and separation

| Data | Table / service | Scope |
|---|---|---|
| Login identities | `auth.users` (Supabase Auth) | One account per email; same account may register for up to two competitions |
| Roles and names | `public.profiles` | One row per Auth UUID |
| Legacy roster | `public.participants` | Existing compatibility data; migration leaves it intact |
| Competition catalog/configuration | `public.competitions` | One row per competition UUID, including task, duration, payment, Drive link, and publication state |
| Competition-specific registration | `public.competition_registrations` | One row per `(competition_id, user_id)`; registration/team/contact/payment/winner fields |
| Timer, links, task deliverable, judging | `public.competition_submissions` | One row per registration; independent timer, draft, final submission, score, and feedback |
| Supporting documents/imported links | `public.competition_resources` | Competition UUID plus optional registration UUID; storage stays private |
| Organizer's old singleton settings | `public.competition_settings` | Compatibility for legacy/global UI; no longer the source for participant timer or per-competition task settings |

The migration performs additive DDL, installs RPCs/triggers/policies, and copies legacy participant records into normalized rows only when their `competition_id` references a real competition. It does not merge CyberShield with AI for Everyone, rewrite their UUIDs, delete participants, or delete storage objects. A participant registered to both must have two different `competition_registrations.id` values and two different `competition_submissions.registration_id` values.

## Integrations found in the project

- **Supabase**: Auth, Postgres via `@supabase/supabase-js`/PostgREST, RLS-protected database RPCs, and private Storage.
- **Google Identity Services + Google Picker**: optional client-side Drive selection, activated by the three `VITE_GOOGLE_*` values. Tokens are held in memory for the Picker session; selected file/folder identifiers and metadata are saved. Folder selection does not recursively enumerate its contents.
- **Google Fonts**: fonts loaded by the interface.
- **GitHub REST API and Vercel API**: organizer integration actions are handled by the authenticated `competition-integrations` Supabase Edge Function. GitHub public checks may work without a token; private repo access needs a restricted GitHub token. Vercel checks/redeploy affect only the organizer's configured Vercel project, not participant projects.
- **Not implemented**: automatic email/WhatsApp sending, payment processing, Google Sheets sync, automatic upload to the organizer's Drive, and participant Drive folder enumeration. Do not advertise these as working portal features.

Browser-exposed `VITE_` variables must contain only public identifiers/keys (Supabase URL + anon/publishable key, Google client ID/API key/project number). Never use a Supabase service-role key, OAuth client secret, GitHub token, Vercel token, SMTP/API mail secret, or other private credential in a `VITE_` variable. Provider tokens for the Edge Function belong in Supabase Function Secrets.

## Apply the fix to the deployed Desktop copy

1. Confirm this is the same folder connected to the GitHub repo/Vercel deployment. In VS Code terminal run `git status --short` and check the current folder path. Do not run a fresh destructive schema reset.
2. Back up the Supabase project (Dashboard → Database → Backups, or the available project backup/export workflow). Keep the backup before applying any SQL.
3. In the Supabase project used by Vercel, open **SQL Editor → New query** and open `supabase/migrations/20261107_competition_scoped_workflow.sql` from this folder. Review the migration, paste the complete file, and run it once. It is designed to be repeatable, but do not rerun if the first run reported a partial error until that error is resolved.
4. Inspect the SQL results. A successful DDL query may say “Success. No rows returned”; that is normal. Then run the read-only verification queries below.
5. Commit and push the code and migration from this same Desktop deployment folder. Vercel must build the commit that contains both `src/lib/supabase.js` and the migration. Wait for the deployment to become Ready, then hard-refresh the deployed site (Ctrl+F5).
6. Existing participant: log in with their existing Auth email/password (do not register the same competition again). For an unconfirmed Auth user, fix Supabase Auth email delivery/confirmation or confirm the account first. The earlier “email rate limit exceeded” screenshot was a Supabase Auth mail limit; this migration cannot send confirmation emails.

### Read-only Supabase verification queries

Run these after the migration. Do not paste private keys into SQL or screenshots.

```sql
-- Verify the two competition UUIDs and per-competition configuration.
select id, title, status, registration_open, duration_minutes, results_announced
from public.competitions
where title ilike '%CyberShield%' or title ilike '%AI for Everyone%'
order by title;

-- Check how legacy rows map to registrations, without exposing participant email.
select c.title,
       (select count(*) from public.participants p where p.competition_id=c.id) as legacy_rows,
       (select count(*) from public.competition_registrations r where r.competition_id=c.id) as registrations,
       (select count(*) from public.competition_submissions s join public.competition_registrations r on r.id=s.registration_id where r.competition_id=c.id) as submission_rows
from public.competitions c
where c.title ilike '%CyberShield%' or c.title ilike '%AI for Everyone%'
order by c.title;

-- Check there are no duplicate registrations per user and competition or missing submissions.
select r.competition_id, r.user_id, count(*)
from public.competition_registrations r
group by r.competition_id, r.user_id
having count(*) > 1;

select r.id as registration_id, r.competition_id
from public.competition_registrations r
left join public.competition_submissions s on s.registration_id=r.id
where s.registration_id is null;
```

Expected: duplicate and missing-submission queries return zero rows. The per-competition counts should be compared to the legacy row counts; if a migration constraint rejected historical data, stop and inspect that mismatch before inviting users.

## End-to-end smoke test for both competitions

Use two authorized test accounts or one existing account for both; use distinct valid test registration numbers. Do not change real participants' passwords or delete their records to test.

1. Open the CyberShield card and register/log in. Confirm the URL/dashboard identifies CyberShield, its task and duration match the organizer settings, and its registration count increases by one.
2. Start its timer. Save a draft and verify the database `started_at` is present only on CyberShield's submission row. Submit a valid test repository/live/Drive URL and one API. Confirm the submission appears on CyberShield only.
3. Open AI for Everyone and register the same authenticated account using its password, or use a second test account. Confirm AI gets its own registration UUID and an independent blank submission/timer.
4. Start the AI timer and save a different draft. Return to CyberShield: its first timer and draft must remain unchanged. Check organizer counts, payment, score, winners, and resources under the competition selector; rows must remain under the matching competition ID.
5. Test a late submission in a disposable test registration only. Change no production test user's start timestamp manually. Use a short-duration disposable competition, or wait until test deadline; server RPC must reject the late save.
6. Archive only a disposable test competition and verify its records remain. Never test archive/delete with the two real competitions.

This desktop agent cannot claim that the live migration, production deployment, authenticated private rows, or these end-to-end tests have passed until the owner runs the SQL and deploys the commit. The prior audit had only anonymous read access to the public competition catalog; it could not verify private rows or execute the Supabase migration.

## Fix / release checklist

- [ ] Back up the live Supabase project.
- [ ] Run `supabase/migrations/20261107_competition_scoped_workflow.sql` in the matching Supabase project and check for SQL errors.
- [ ] Confirm both real competition UUIDs and counts with the queries above.
- [ ] Push this Desktop copy's code and migration to the GitHub repository connected to Vercel.
- [ ] Confirm Vercel built that commit successfully and redeploy after environment changes.
- [ ] Run the two-competition smoke test with test participants; confirm isolation on the dashboard and in the database.
- [ ] Check Supabase Auth email delivery separately if confirmation emails are still delayed/limited.
