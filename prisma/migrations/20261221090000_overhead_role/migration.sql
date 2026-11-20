-- An overhead employee's role is one of five, picked from a list: ENGINEER, FOREMAN, WORKER, DRIVER or OTHER. A role
-- typed before that becomes the matching one when it names it, and OTHER when it does not.

UPDATE "OverheadEmployee"
SET "role" = CASE
    WHEN lower(btrim("role")) IN ('engineer', 'site engineer', 'electrical engineer', 'civil engineer') THEN 'ENGINEER'
    WHEN lower(btrim("role")) IN ('foreman', 'forman') THEN 'FOREMAN'
    WHEN lower(btrim("role")) IN ('worker', 'labour', 'labor', 'labourer') THEN 'WORKER'
    WHEN lower(btrim("role")) = 'driver' THEN 'DRIVER'
    ELSE 'OTHER'
END
WHERE "role" NOT IN ('ENGINEER', 'FOREMAN', 'WORKER', 'DRIVER', 'OTHER');

ALTER TABLE "OverheadEmployee"
    ADD CONSTRAINT "OverheadEmployee_role_check" CHECK ("role" IN ('ENGINEER', 'FOREMAN', 'WORKER', 'DRIVER', 'OTHER'));
