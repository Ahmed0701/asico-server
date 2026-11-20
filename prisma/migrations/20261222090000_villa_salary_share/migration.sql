-- A villa's salaries are its share of the Department Overhead monthly salaries: a percentage, kept in hundredths of a
-- percent (0 to 10000, 2500 = 25%). The hand-entered "salariesMinor" stays as it was but is no longer read. That all
-- villas together stay at or under 100% is checked by the application when a share is saved.

ALTER TABLE "VillaFinance" ADD COLUMN "salaryShareBp" INTEGER;

ALTER TABLE "VillaFinance"
    ADD CONSTRAINT "VillaFinance_salaryShareBp_check" CHECK ("salaryShareBp" BETWEEN 0 AND 10000);
