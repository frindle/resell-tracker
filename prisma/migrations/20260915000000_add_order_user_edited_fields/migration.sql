-- Add per-field user-edit tracking to Order (JSON array of field names)
ALTER TABLE "Order" ADD COLUMN "userEditedFields" TEXT;
