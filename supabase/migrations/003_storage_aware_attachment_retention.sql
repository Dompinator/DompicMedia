-- Keep chat attachments indefinitely unless Storage usage exceeds 1 GiB.
-- The server cleanup job then removes only chat attachments older than two months.

DROP TRIGGER IF EXISTS trg_attachments_expiration ON public.attachments;
DROP FUNCTION IF EXISTS public.set_attachment_expiration();

-- Restore metadata for attachments that were marked as expiring after 24 hours.
-- The cleanup job no longer uses expires_at for deletion decisions.
UPDATE public.attachments
SET expires_at = NULL
WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN public.attachments.expires_at IS
  'Deprecated: attachment retention is governed by Storage usage (over 1 GiB) and uploaded_at age (over two months).';
