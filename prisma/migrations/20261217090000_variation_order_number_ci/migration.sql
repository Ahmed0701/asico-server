-- A variation order's number is unique in its villa ignoring case, in the database itself: the service checks it too, but
-- two requests at the same instant ("VO-1" and "vo-1") could both pass that check. Prisma cannot declare an index on an
-- expression, so it is written here; the case-sensitive unique index of the schema stays.

CREATE UNIQUE INDEX "VariationOrder_villaId_voNumber_ci_key" ON "VariationOrder" ("villaId", lower("voNumber"));
