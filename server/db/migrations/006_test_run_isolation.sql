-- Migration 006: Identify test runs separately from official competition runs.
--
-- Existing runs are classified as official by default.
-- Only explicitly marked test runs may be removed during initialization.

ALTER TABLE runs
ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Speeds up initialization when looking for test runs.
CREATE INDEX IF NOT EXISTS idx_runs_test
ON runs (run_id)
WHERE is_test = TRUE;

COMMENT ON COLUMN runs.is_test IS
    'TRUE for test/sample runs that may be safely cleared during game initialization.';
