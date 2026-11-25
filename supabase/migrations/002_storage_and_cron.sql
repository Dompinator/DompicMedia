-- Vesper Social & Community Servers Platform
-- Migration 002: Storage Buckets, Storage RLS Policies, and 24-Hour Attachment Expiration

-- Create buckets
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('avatars', 'avatars', true, 5242880, ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  ('banners', 'banners', true, 8388608, ARRAY['image/png', 'image/jpeg', 'image/webp']),
  ('server-icons', 'server-icons', true, 5242880, ARRAY['image/png', 'image/jpeg', 'image/webp']),
  ('emojis', 'emojis', true, 1048576, ARRAY['image/png']),
  ('post-media', 'post-media', true, 26214400, ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav']),
  ('chat-attachments', 'chat-attachments', false, 26214400, ARRAY[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4',
    'application/pdf', 'text/plain', 'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ])
ON CONFLICT (id) DO NOTHING;

-- Avatars & Banners: public read, user owns folder {uid}/*
CREATE POLICY "Public read avatars" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
CREATE POLICY "Users upload own avatar" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users update own avatar" ON storage.objects FOR UPDATE USING (
  bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users delete own avatar" ON storage.objects FOR DELETE USING (
  bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Public read banners" ON storage.objects FOR SELECT USING (bucket_id = 'banners');
CREATE POLICY "Users upload own banner" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'banners' AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users update own banner" ON storage.objects FOR UPDATE USING (
  bucket_id = 'banners' AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users delete own banner" ON storage.objects FOR DELETE USING (
  bucket_id = 'banners' AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Server Icons: public read, authenticated upload to {uid}/*
CREATE POLICY "Public read server icons" ON storage.objects FOR SELECT USING (bucket_id = 'server-icons');
CREATE POLICY "Authenticated upload server icons" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'server-icons' AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Global Emojis: public read, platform_admin only write
CREATE POLICY "Public read global emojis" ON storage.objects FOR SELECT USING (bucket_id = 'emojis');
CREATE POLICY "Platform admins manage global emojis storage" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'emojis' AND public.is_platform_admin(auth.uid())
);
CREATE POLICY "Platform admins delete global emojis storage" ON storage.objects FOR DELETE USING (
  bucket_id = 'emojis' AND public.is_platform_admin(auth.uid())
);

-- Post Media: public read, user owns folder {uid}/*
CREATE POLICY "Public read post media" ON storage.objects FOR SELECT USING (bucket_id = 'post-media');
CREATE POLICY "Users upload own post media" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'post-media' AND auth.uid()::text = (storage.foldername(name))[1]
);
CREATE POLICY "Users delete own post media" ON storage.objects FOR DELETE USING (
  bucket_id = 'post-media' AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Chat Attachments (PRIVATE BUCKET):
-- Only uploaders can write into {uid}/*; reading happens strictly via server-verified signed URLs
-- or authorized database checks before expiration.
CREATE POLICY "Users upload own chat attachments" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'chat-attachments' AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Note on Scheduled 24-Hour Expiration Cleanup:
-- 1. Vesper's Express server runs /api/attachments/cleanup (and an automatic background sweep
--    when SUPABASE_SERVICE_ROLE_KEY is configured) to delete actual storage objects via
--    supabaseAdmin.storage.from('chat-attachments').remove(paths) and mark attachments.deleted_at = now().
-- 2. You can also schedule pg_cron + pg_net in Supabase to POST to <APP_URL>/api/attachments/cleanup
--    every 15 minutes with Authorization: Bearer <CRON_SECRET>.
