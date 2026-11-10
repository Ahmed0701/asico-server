-- The search of the daily reports looks in four columns: the work done, the issues, who prepared the report, and the villa's
-- number. Only the first had a trigram index, and the villa's number sat in the same OR as the others, behind a join, so
-- PostgreSQL could not use any index and read every report twice (the count and the page): 0.8 to 1.0 s at 48,000 reports (400
-- villas for 120 days), measured by `npm run load:check`.
--
-- This gives the other two columns the same index as the first. The repository now looks the villa's number up on its own and
-- keeps the four conditions on the reports' own columns, so one bitmap of the three indexes finds the matches (a rare word:
-- 1 to 9 ms). Additive only: two indexes, no data touched. (pg_trgm comes from the "extras" migration.)

CREATE INDEX "DailyReport_issues_trgm_idx" ON "DailyReport" USING GIN ("issues" gin_trgm_ops);
CREATE INDEX "DailyReport_preparedBy_trgm_idx" ON "DailyReport" USING GIN ("preparedBy" gin_trgm_ops);
