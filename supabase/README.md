# Supabase setup

1. Create a Supabase project for Nexus-ARSEO.
2. Run migrations from `supabase/migrations` in order using the Supabase CLI or SQL Editor.
3. Copy the Project URL and publishable key to `.env.local` using `.env.example`.
4. Create the first employee account in Supabase Auth. The database trigger creates a matching `profiles` row.
5. Assign the first administrator by inserting the matching user and `administrator` role into `user_roles` from the SQL Editor.
6. For invitations from the Nexus user-management screen, add the server-only `SUPABASE_SECRET_KEY` to `.env.local` and later to Vercel. A legacy `SUPABASE_SERVICE_ROLE_KEY` is also supported. Never prefix either key with `NEXT_PUBLIC_`, paste it into chat, or commit it.

Migration order:

1. `202609260001_identity_and_access.sql` — Supabase Auth profiles, roles and base RLS.
2. `202609270001_phase0_access_control.sql` — detailed permissions, personal overrides, access audit and admin safeguards.

The browser never receives a service-role key. Authorization is enforced with PostgreSQL grants and RLS in addition to application checks.
