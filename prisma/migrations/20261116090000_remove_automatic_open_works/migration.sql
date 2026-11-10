-- The automatic open works are removed: open works are no longer made or changed by the electrical phase progress, and
-- every open work is added by hand. The ones the progress made ("source" = 'PHASE') are deleted, with their notifications
-- (ON DELETE CASCADE). The "source" column stays, and every open work written from now on is MANUAL.

DELETE FROM "WorkItem" WHERE "source" = 'PHASE';
