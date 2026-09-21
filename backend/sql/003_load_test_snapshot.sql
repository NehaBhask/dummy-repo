-- 003_load_test_snapshot.sql — additive. Lets any server process answer GET /api/loadtests/:id
-- (needed once the API runs as several worker processes): the process running a test writes its
-- live state here, instead of it living only in that process's memory.
ALTER TABLE load_test_runs ADD COLUMN IF NOT EXISTS snapshot JSONB;
