# SQL tests (local, no Supabase needed)

Runs the migration files on an in-process Postgres (PGlite) with Supabase-style roles, default grants and RLS.

    cd supabase/migration/test
    npm init -y && npm install @electric-sql/pglite
    node run.mjs
