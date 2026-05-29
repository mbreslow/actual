BEGIN TRANSACTION;

ALTER TABLE transactions ADD COLUMN categorization_source TEXT;
ALTER TABLE transactions ADD COLUMN categorization_date INTEGER;
ALTER TABLE transactions ADD COLUMN categorization_note TEXT;

UPDATE transactions
SET
  categorization_source = 'manual',
  categorization_date = 20260529,
  categorization_note = 'Backfilled during migration; original source unknown'
WHERE category IS NOT NULL;

COMMIT;
