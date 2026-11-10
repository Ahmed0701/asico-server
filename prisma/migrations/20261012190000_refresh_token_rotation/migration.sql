-- A refresh token spent by a rotation points to the token that replaced it. That is how a token presented
-- again a moment after it was rotated (two tabs, a double fetch) is told apart from a stolen one: a rotated token
-- has replacedById set, and its revokedAt is the time of the rotation.

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "replacedById" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_replacedById_key" ON "RefreshToken"("replacedById");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
