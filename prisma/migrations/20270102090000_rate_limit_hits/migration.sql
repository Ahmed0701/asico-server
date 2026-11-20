-- The rate limit counters shared by the server processes of a cluster (WEB_CONCURRENCY above 1), so a limit such as ten
-- logins per fifteen minutes is the same however many processes serve the API. One row per limiter and client.

CREATE TABLE "RateLimitHit" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL,
    "resetAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimitHit_resetAt_idx" ON "RateLimitHit"("resetAt");
