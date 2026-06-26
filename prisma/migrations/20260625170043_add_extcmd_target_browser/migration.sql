-- Optional per-command browser targeting so Firefox-triggered syncs
-- don't get picked up by the Chrome extension and vice versa.
ALTER TABLE "ExtensionCommand" ADD COLUMN "targetBrowser" TEXT;
