-- Clear overdueAt on orders that are already marked as paid
UPDATE "Order" SET "overdueAt" = NULL WHERE "salePriceSynced" = 1 AND "overdueAt" IS NOT NULL;
