# Supabase setup

1. Create a Supabase project for Nexus-ARSEO.
2. Run migrations from `supabase/migrations` in order using the Supabase CLI or SQL Editor.
3. Copy the Project URL and publishable key to `.env.local` using `.env.example`.
4. Create employee accounts in Supabase Auth. The database trigger creates a matching `profiles` row.
5. Assign the first administrator by inserting the matching user and `administrator` role into `user_roles` from the SQL Editor.

The browser never receives a service-role key. Authorization is enforced with PostgreSQL grants and RLS in addition to application checks.
