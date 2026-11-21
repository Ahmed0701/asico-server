-- The user account of an electrical engineer: a user linked to an engineer (not an ADMIN) sees only that engineer's
-- villas. One user per engineer; deleting the user leaves the engineer without one.

ALTER TABLE "ElectricalEngineer" ADD COLUMN "userId" TEXT;

CREATE UNIQUE INDEX "ElectricalEngineer_userId_key" ON "ElectricalEngineer"("userId");

ALTER TABLE "ElectricalEngineer" ADD CONSTRAINT "ElectricalEngineer_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
