-- ROLLBACK of 04-storage-admin-select.sql (the admin's remove() will then silently delete nothing again).
drop policy if exists "Admins can read property-images objects" on storage.objects;
