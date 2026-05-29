BEGIN TRANSACTION;

CREATE TABLE ai_classification_memories (
  id TEXT PRIMARY KEY,
  imported_payee TEXT,
  payee_name TEXT,
  category_id TEXT,
  tombstone INTEGER DEFAULT 0
);

COMMIT;
