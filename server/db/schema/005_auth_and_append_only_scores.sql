-- =====================================================================
-- 005_auth_and_append_only_scores.sql
-- Run AFTER 001_schema.sql, 002_scoring.sql, 003_seed_data.sql,
-- 004_views.sql.
--
-- Two changes:
--   1. Adds login capability to judges (username/password_hash/sessions)
--   2. Converts run_scores and video_scores to append-only: a
--      correction is a NEW row (is_correction = true), never an
--      UPDATE to an existing one. Full history stays intact for
--      disputes. The "current" score is whichever row is latest by
--      scored_at for a given (run/video, criteria, judge).
--
-- This second change REQUIRES patching v_run_score_breakdown and
-- v_leaderboard, since they previously assumed one row per judge per
-- criteria and would otherwise average/sum stale corrections in
-- alongside the current score.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Auth columns on judges
-- ---------------------------------------------------------------------

ALTER TABLE judges ADD COLUMN username      TEXT;
ALTER TABLE judges ADD COLUMN password_hash TEXT;
ALTER TABLE judges ADD COLUMN created_at    TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE judges ADD CONSTRAINT judges_username_unique UNIQUE (username);

-- Not NOT NULL yet, to avoid breaking any judges already inserted
-- (e.g. the seed 'Dr. Aoki' row) without a username/password. Once
-- every real judge has both set:
--   ALTER TABLE judges ALTER COLUMN username SET NOT NULL;
--   ALTER TABLE judges ALTER COLUMN password_hash SET NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    judge_id    INTEGER NOT NULL REFERENCES judges(judge_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------
-- 2. Convert run_scores to append-only
-- ---------------------------------------------------------------------

ALTER TABLE run_scores DROP CONSTRAINT run_scores_run_id_criteria_id_judge_id_key;
ALTER TABLE run_scores ADD COLUMN is_correction BOOLEAN NOT NULL DEFAULT false;

COMMENT ON TABLE run_scores IS
    'Append-only: a corrected score is a NEW row with is_correction = true, never an UPDATE. Current score for a (run_id, criteria_id, judge_id) is whichever row is latest by scored_at.';

-- ---------------------------------------------------------------------
-- 3. Convert video_scores to append-only (same reasoning)
-- ---------------------------------------------------------------------

ALTER TABLE video_scores DROP CONSTRAINT video_scores_video_id_criteria_id_judge_id_key;
ALTER TABLE video_scores ADD COLUMN is_correction BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE video_scores ADD COLUMN scored_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON TABLE video_scores IS
    'Append-only, same pattern as run_scores. Current score is latest by scored_at per (video_id, criteria_id, judge_id).';

-- ---------------------------------------------------------------------
-- 4. Patch v_run_score_breakdown to use only the latest row per
--    (run_id, criteria_id, judge_id) before averaging across judges
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW v_run_score_breakdown AS
WITH latest_scores AS (
    SELECT DISTINCT ON (run_id, criteria_id, judge_id)
        run_id, criteria_id, judge_id, points_awarded
    FROM run_scores
    ORDER BY run_id, criteria_id, judge_id, scored_at DESC
)
SELECT
    r.run_id,
    t.team_name,
    sc.name          AS category_name,
    scr.name         AS criteria_name,
    scr.max_points,
    ROUND(AVG(ls.points_awarded), 2) AS avg_points_awarded,
    COUNT(ls.judge_id)               AS judges_scored
FROM runs r
JOIN teams t ON t.team_id = r.team_id
JOIN scoring_categories sc ON TRUE
JOIN scoring_criteria scr ON scr.category_id = sc.category_id
LEFT JOIN latest_scores ls ON ls.run_id = r.run_id AND ls.criteria_id = scr.criteria_id
GROUP BY r.run_id, t.team_name, sc.name, scr.name, scr.max_points, sc.display_order, scr.display_order
ORDER BY r.run_id, sc.display_order, scr.display_order;

-- ---------------------------------------------------------------------
-- 5. Patch v_leaderboard's video-scoring CTE the same way
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW v_leaderboard AS
WITH run_side AS (
    SELECT team_id, SUM(total_score) AS run_points
    FROM v_run_totals
    WHERE NOT disqualified
    GROUP BY team_id
),
team_criteria AS (
    SELECT r.team_id, SUM(vb.avg_points_awarded) AS bonus_points
    FROM v_run_score_breakdown vb
    JOIN runs r ON r.run_id = vb.run_id
    WHERE vb.category_name IN (
        'Innovation Bonus', 'CAD Design & Presentation', 'Virtual SLAM',
        'Poster Presentation', 'Technical Report', 'Industrial Scalability'
    )
    GROUP BY r.team_id
),
latest_video_scores AS (
    SELECT DISTINCT ON (video_id, criteria_id, judge_id)
        video_id, criteria_id, judge_id, points_awarded
    FROM video_scores
    ORDER BY video_id, criteria_id, judge_id, scored_at DESC
),
video_side AS (
    SELECT tv.team_id,
           COALESCE(SUM(lvs.points_awarded), 0) + COALESCE(MAX(ve.bonus_points_awarded), 0) AS video_points
    FROM team_videos tv
    LEFT JOIN latest_video_scores lvs ON lvs.video_id = tv.video_id
    LEFT JOIN video_engagement ve ON ve.video_id = tv.video_id
    GROUP BY tv.team_id
)
SELECT
    t.team_id,
    t.team_name,
    COALESCE(rs.run_points, 0)      AS task_and_route_points,
    COALESCE(tc.bonus_points, 0)    AS technical_bonus_points,
    COALESCE(vs2.video_points, 0)   AS video_points,
    COALESCE(rs.run_points, 0) + COALESCE(tc.bonus_points, 0) + COALESCE(vs2.video_points, 0) AS grand_total,
    RANK() OVER (ORDER BY COALESCE(rs.run_points, 0) + COALESCE(tc.bonus_points, 0) + COALESCE(vs2.video_points, 0) DESC) AS rank
FROM teams t
LEFT JOIN run_side rs ON rs.team_id = t.team_id
LEFT JOIN team_criteria tc ON tc.team_id = t.team_id
LEFT JOIN video_side vs2 ON vs2.team_id = t.team_id
ORDER BY rank;

COMMENT ON VIEW v_leaderboard IS
    'The main scoreboard: what the judges'' big screen shows between runs. Uses only the latest (non-superseded) score per judge per criteria, so historical corrections do not get double-counted.';
