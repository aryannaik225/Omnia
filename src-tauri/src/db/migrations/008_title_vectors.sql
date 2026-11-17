-- Migration v8: persisted composite "vibe" vectors per title (content only, never user data).
-- One row per title and embedding model. `doc_hash` fingerprints the metadata the vector was
-- built from, so a title whose keywords / credits / overview changed is re-embedded on its next
-- use. Lets the info-page nearest-neighbour search cover the whole local catalog without
-- re-running the ONNX model over thousands of titles.
CREATE TABLE IF NOT EXISTS title_vectors (
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
    model_id TEXT NOT NULL,
    doc_hash TEXT NOT NULL,
    vector_blob BLOB NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tmdb_id, media_type, model_id)
);
