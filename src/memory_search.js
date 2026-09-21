const { resolve } = require('node:path')
const Database = require('better-sqlite3')

const DB_PATH = resolve(process.cwd(), '.data', 'checkpointer.db')
const query = '"水果" OR "喜好"'

const sql = `
WITH candidates AS (
    SELECT
        m.*,

        -- FTS5 分数越小，相关性越高
        bm25(memory_fts, 1.0, 2.0) AS bm25_score,

        -- 距离最近更新时间的天数
        max(
            0.0,
            julianday('now') -
            julianday(coalesce(m.updated_at, m.created_at))
        ) AS age_days

    FROM memory_fts
    JOIN memory AS m
      ON m.id = memory_fts.rowid

    WHERE memory_fts MATCH :query

    -- 先选出相关性最高的一批候选，避免后续计算过多
    ORDER BY bm25_score ASC
    LIMIT 200
),

bounds AS (
    SELECT
        candidates.*,
        min(bm25_score) OVER () AS min_bm25,
        max(bm25_score) OVER () AS max_bm25
    FROM candidates
),

normalized AS (
    SELECT
        bounds.*,

        -- 归一化为 0～1，越相关越接近 1
        CASE
            WHEN max_bm25 = min_bm25 THEN 1.0
            ELSE
                (max_bm25 - bm25_score) /
                (max_bm25 - min_bm25)
        END AS relevance_score,

        -- importance: 1～5 映射为 0～1
        min(
            1.0,
            max(
                0.0,
                (coalesce(importance, 3) - 1) / 4.0
            )
        ) AS importance_score,

        -- 30 天时约为 0.5，90 天时约为 0.25
        1.0 / (1.0 + age_days / 30.0) AS recency_score

    FROM bounds
)

SELECT
    id,
    type,
    content,
    keywords,
    importance,
    session_id,
    created_at,
    updated_at,
    bm25_score,
    relevance_score,
    importance_score,
    recency_score,

    0.70 * relevance_score +
    0.20 * importance_score +
    0.10 * recency_score AS final_score

FROM normalized
ORDER BY
    final_score DESC,
    bm25_score ASC,
    updated_at DESC
LIMIT 10;
`

const db = new Database(DB_PATH, { readonly: true })

try {
    const rows = db.prepare(sql).all({ query })
    console.table(rows)
} finally {
    db.close()
}
