# SQL tests (local, no Supabase needed)

Runs the migration files on an in-process Postgres (PGlite) with Supabase-style roles, default grants and RLS.

    cd supabase/migration/test
    npm init -y && npm install @electric-sql/pglite
    node run.mjs

`t06.mjs` (15 checks) tests `06-locked-teasers.sql` and `06-rollback.sql` the same way: `node t06.mjs` (needs `@electric-sql/pglite`).
