-- DompicMEDIA
-- Migration 004: message editing, blocking, reports, mentions, post search,
-- unread DMs, sound file support, Song Posts and stream counts.
-- Safe to run more than once. Run after 001, 002 and 003.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =====================================================================
-- 1. NOTIFICATION DEDUPE
-- =====================================================================
-- A plain (non-partial) unique index. NULL dedupe keys remain distinct.
DROP INDEX IF EXISTS public.idx_notifications_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key
  ON public.notifications (recipient_id, dedupe_key);

-- =====================================================================
-- 2. BLOCKING
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.user_blocks (
  blocker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT cannot_block_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON public.user_blocks (blocked_id);
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own blocks" ON public.user_blocks;
CREATE POLICY "Users see own blocks" ON public.user_blocks
  FOR SELECT USING (auth.uid() = blocker_id);
DROP POLICY IF EXISTS "Users block as themselves" ON public.user_blocks;
CREATE POLICY "Users block as themselves" ON public.user_blocks
  FOR INSERT WITH CHECK (auth.uid() = blocker_id);
DROP POLICY IF EXISTS "Users unblock own blocks" ON public.user_blocks;
CREATE POLICY "Users unblock own blocks" ON public.user_blocks
  FOR DELETE USING (auth.uid() = blocker_id);

-- True when the signed-in user and p_other have a block in either direction.
-- Deliberately only answers about the caller, so it cannot be used to probe others.
CREATE OR REPLACE FUNCTION public.blocked_with(p_other UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_blocks
    WHERE (blocker_id = auth.uid() AND blocked_id = p_other)
       OR (blocker_id = p_other AND blocked_id = auth.uid())
  );
$$;

-- Blocking removes existing ties between the two accounts.
CREATE OR REPLACE FUNCTION public.apply_block()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a UUID := NEW.blocker_id;
  b UUID := NEW.blocked_id;
BEGIN
  DELETE FROM public.follows
    WHERE (follower_id = a AND following_id = b) OR (follower_id = b AND following_id = a);
  DELETE FROM public.friendships WHERE user_a = LEAST(a, b) AND user_b = GREATEST(a, b);
  DELETE FROM public.friend_requests
    WHERE (sender_id = a AND receiver_id = b) OR (sender_id = b AND receiver_id = a);
  DELETE FROM public.server_invitations
    WHERE status = 'pending'
      AND ((inviter_id = a AND invitee_id = b) OR (inviter_id = b AND invitee_id = a));
  DELETE FROM public.notifications
    WHERE (recipient_id = a AND actor_id = b) OR (recipient_id = b AND actor_id = a);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_apply_block ON public.user_blocks;
CREATE TRIGGER trg_apply_block AFTER INSERT ON public.user_blocks
  FOR EACH ROW EXECUTE FUNCTION public.apply_block();

-- RESTRICTIVE policies are combined with AND, on top of the existing rules.
DROP POLICY IF EXISTS "Blocks hide posts" ON public.posts;
CREATE POLICY "Blocks hide posts" ON public.posts AS RESTRICTIVE FOR SELECT
  USING (NOT public.blocked_with(author_id) OR public.is_platform_admin(auth.uid()));

-- The subquery runs under the caller's RLS, so a hidden (blocked) parent is not found.
DROP POLICY IF EXISTS "Blocks stop replies and reposts" ON public.posts;
CREATE POLICY "Blocks stop replies and reposts" ON public.posts AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    (reply_to_id IS NULL OR EXISTS (
      SELECT 1 FROM public.posts p WHERE p.id = posts.reply_to_id AND NOT public.blocked_with(p.author_id)))
    AND (repost_of_id IS NULL OR EXISTS (
      SELECT 1 FROM public.posts p WHERE p.id = posts.repost_of_id AND NOT public.blocked_with(p.author_id)))
  );

DROP POLICY IF EXISTS "Blocks stop likes" ON public.post_likes;
CREATE POLICY "Blocks stop likes" ON public.post_likes AS RESTRICTIVE FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.posts p WHERE p.id = post_id AND NOT public.blocked_with(p.author_id)));

DROP POLICY IF EXISTS "Blocks stop follows" ON public.follows;
CREATE POLICY "Blocks stop follows" ON public.follows AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.blocked_with(following_id));

DROP POLICY IF EXISTS "Blocks stop friend requests" ON public.friend_requests;
CREATE POLICY "Blocks stop friend requests" ON public.friend_requests AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.blocked_with(receiver_id));

DROP POLICY IF EXISTS "Blocks stop invitations" ON public.server_invitations;
CREATE POLICY "Blocks stop invitations" ON public.server_invitations AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.blocked_with(invitee_id));

DROP POLICY IF EXISTS "Blocks stop notifications" ON public.notifications;
CREATE POLICY "Blocks stop notifications" ON public.notifications AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.blocked_with(recipient_id));

DROP POLICY IF EXISTS "Blocks stop DMs" ON public.direct_messages;
CREATE POLICY "Blocks stop DMs" ON public.direct_messages AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id
      AND public.blocked_with(CASE WHEN c.user_a = auth.uid() THEN c.user_b ELSE c.user_a END)
  ));

CREATE OR REPLACE FUNCTION public.prevent_blocked_conversation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_blocks
    WHERE (blocker_id = NEW.user_a AND blocked_id = NEW.user_b)
       OR (blocker_id = NEW.user_b AND blocked_id = NEW.user_a)
  ) THEN
    RAISE EXCEPTION 'You cannot message this user';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_prevent_blocked_conversation ON public.conversations;
CREATE TRIGGER trg_prevent_blocked_conversation BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_blocked_conversation();

-- =====================================================================
-- 3. MESSAGE EDITING (server channels and DMs)
-- =====================================================================
ALTER TABLE public.direct_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- Only the text can change; edited_at is always set by the database.
CREATE OR REPLACE FUNCTION public.guard_message_edit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'content' - 'edited_at') IS DISTINCT FROM (to_jsonb(OLD) - 'content' - 'edited_at') THEN
    RAISE EXCEPTION 'Only the message text can be edited';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    IF char_length(trim(NEW.content)) = 0
       AND NOT EXISTS (SELECT 1 FROM public.attachments a WHERE a.message_id = OLD.id) THEN
      RAISE EXCEPTION 'A message cannot be empty';
    END IF;
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_channel_message_edit ON public.channel_messages;
CREATE TRIGGER trg_channel_message_edit BEFORE UPDATE ON public.channel_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_edit();
DROP TRIGGER IF EXISTS trg_dm_edit ON public.direct_messages;
CREATE TRIGGER trg_dm_edit BEFORE UPDATE ON public.direct_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_edit();

DROP POLICY IF EXISTS "Authors edit own channel messages" ON public.channel_messages;
CREATE POLICY "Authors edit own channel messages" ON public.channel_messages FOR UPDATE
  USING (auth.uid() = author_id AND public.is_server_member(server_id, auth.uid()))
  WITH CHECK (auth.uid() = author_id AND public.is_server_member(server_id, auth.uid()));

DROP POLICY IF EXISTS "Senders edit own DMs" ON public.direct_messages;
CREATE POLICY "Senders edit own DMs" ON public.direct_messages FOR UPDATE
  USING (auth.uid() = sender_id AND NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id
      AND public.blocked_with(CASE WHEN c.user_a = auth.uid() THEN c.user_b ELSE c.user_a END)
  ))
  WITH CHECK (auth.uid() = sender_id);

-- =====================================================================
-- 4. REPORTS
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reported_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'profile', 'channel_message', 'dm')),
  target_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'violence', 'copyright', 'other')),
  details TEXT NOT NULL DEFAULT '' CHECK (char_length(details) <= 500),
  snapshot TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open
  ON public.reports (reporter_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports (status, created_at DESC);
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

-- Rows are written only through the functions below.
DROP POLICY IF EXISTS "Reporters and admins read reports" ON public.reports;
CREATE POLICY "Reporters and admins read reports" ON public.reports FOR SELECT
  USING (auth.uid() = reporter_id OR public.is_platform_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.report_content(
  p_target_type TEXT, p_target_id UUID, p_reason TEXT, p_details TEXT DEFAULT ''
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_user UUID;
  v_snapshot TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  IF p_target_type = 'post' THEN
    SELECT author_id, concat_ws(E'\n', song_title, content, media_urls->0->>'url')
      INTO v_user, v_snapshot FROM public.posts WHERE id = p_target_id;
  ELSIF p_target_type = 'profile' THEN
    SELECT id, concat_ws(E'\n', display_name || ' (@' || username || ')', bio)
      INTO v_user, v_snapshot FROM public.profiles WHERE id = p_target_id;
  ELSIF p_target_type = 'channel_message' THEN
    SELECT author_id, content INTO v_user, v_snapshot FROM public.channel_messages
      WHERE id = p_target_id AND public.is_server_member(server_id, v_uid);
  ELSIF p_target_type = 'dm' THEN
    SELECT m.sender_id, m.content INTO v_user, v_snapshot
      FROM public.direct_messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = p_target_id AND (c.user_a = v_uid OR c.user_b = v_uid);
  END IF;

  IF v_user IS NULL THEN RAISE EXCEPTION 'That content was not found'; END IF;
  IF v_user = v_uid THEN RAISE EXCEPTION 'You cannot report yourself'; END IF;

  INSERT INTO public.reports (reporter_id, reported_user_id, target_type, target_id, reason, details, snapshot)
  VALUES (v_uid, v_user, p_target_type, p_target_id, p_reason,
          left(COALESCE(p_details, ''), 500), left(COALESCE(v_snapshot, ''), 1500))
  ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'open' DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_report(p_report_id UUID, p_action TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_report public.reports%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_platform_admin(v_uid) THEN
    RAISE EXCEPTION 'Platform admin required';
  END IF;
  IF p_action NOT IN ('dismiss', 'resolve', 'delete_content') THEN
    RAISE EXCEPTION 'Unknown action';
  END IF;
  SELECT * INTO v_report FROM public.reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report not found'; END IF;

  IF p_action = 'delete_content' THEN
    IF v_report.target_type = 'post' THEN
      DELETE FROM public.posts WHERE id = v_report.target_id;
    ELSIF v_report.target_type = 'channel_message' THEN
      DELETE FROM public.channel_messages WHERE id = v_report.target_id;
    ELSIF v_report.target_type = 'dm' THEN
      DELETE FROM public.direct_messages WHERE id = v_report.target_id;
    ELSE
      RAISE EXCEPTION 'Profiles cannot be deleted from reports';
    END IF;
  END IF;

  -- Close every open report about the same thing when its content is removed.
  UPDATE public.reports
    SET status = CASE WHEN p_action = 'dismiss' THEN 'dismissed' ELSE 'resolved' END,
        resolved_by = v_uid, resolved_at = now()
    WHERE id = p_report_id
       OR (p_action = 'delete_content' AND status = 'open'
           AND target_type = v_report.target_type AND target_id = v_report.target_id);
END;
$$;

-- =====================================================================
-- 5. SONG POSTS AND STREAMS
-- =====================================================================
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS song_title TEXT;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS song_duration INTEGER;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS streams_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS song_post_valid;
ALTER TABLE public.posts ADD CONSTRAINT song_post_valid CHECK (
  song_title IS NULL OR (
    char_length(trim(song_title)) BETWEEN 1 AND 100
    AND reply_to_id IS NULL
    AND repost_of_id IS NULL
    AND jsonb_path_exists(media_urls, '$[*] ? (@.category == "audio")')
  )
);
ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS song_duration_valid;
ALTER TABLE public.posts ADD CONSTRAINT song_duration_valid CHECK (
  song_duration IS NULL OR song_duration BETWEEN 0 AND 86400
);

-- New posts always start with zero counters, whatever the client sends.
CREATE OR REPLACE FUNCTION public.reset_post_counters()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.likes_count := 0;
  NEW.replies_count := 0;
  NEW.reposts_count := 0;
  NEW.streams_count := 0;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_posts_reset_counters ON public.posts;
CREATE TRIGGER trg_posts_reset_counters BEFORE INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.reset_post_counters();

CREATE TABLE IF NOT EXISTS public.song_streams (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  listener_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_song_streams_lookup
  ON public.song_streams (post_id, listener_id, created_at DESC);
-- No policies: only record_stream() reads or writes this table.
ALTER TABLE public.song_streams ENABLE ROW LEVEL SECURITY;

-- Counts one stream, at most once per listener per song length (30 seconds minimum).
-- Returns the song's current stream count.
CREATE OR REPLACE FUNCTION public.record_stream(p_post_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_post public.posts%ROWTYPE;
  v_count INTEGER;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_post FROM public.posts WHERE id = p_post_id AND song_title IS NOT NULL;
  IF NOT FOUND OR public.blocked_with(v_post.author_id) THEN
    RAISE EXCEPTION 'Song not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_post_id::text || v_uid::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.song_streams
    WHERE post_id = p_post_id AND listener_id = v_uid
      AND created_at > clock_timestamp() - make_interval(secs => GREATEST(30, COALESCE(v_post.song_duration, 0)))
  ) THEN
    RETURN v_post.streams_count;
  END IF;

  INSERT INTO public.song_streams (post_id, listener_id) VALUES (p_post_id, v_uid);
  UPDATE public.posts SET streams_count = streams_count + 1 WHERE id = p_post_id
    RETURNING streams_count INTO v_count;
  RETURN v_count;
END;
$$;

-- =====================================================================
-- 6. MENTIONS
-- =====================================================================
CREATE OR REPLACE FUNCTION public.notify_mentions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_server UUID;
  v_meta JSONB;
BEGIN
  IF TG_TABLE_NAME = 'channel_messages' THEN
    v_server := NEW.server_id;
    v_meta := jsonb_build_object('context', 'channel', 'server_id', NEW.server_id, 'channel_id', NEW.channel_id);
  ELSE
    v_meta := jsonb_build_object('context', 'post');
  END IF;
  v_meta := v_meta || jsonb_build_object('preview', left(NEW.content, 80));

  INSERT INTO public.notifications (recipient_id, actor_id, type, entity_id, metadata, dedupe_key)
  SELECT p.id, NEW.author_id, 'mention', NEW.id, v_meta, 'mention_' || NEW.id::text
  FROM (
    SELECT DISTINCT lower(m[1]) AS username
    FROM regexp_matches(NEW.content, '(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,24})(?![A-Za-z0-9_])', 'g') AS m
    LIMIT 10
  ) AS names
  JOIN public.profiles p ON p.username = names.username
  WHERE p.id <> NEW.author_id
    AND (v_server IS NULL OR public.is_server_member(v_server, p.id))
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks b
      WHERE (b.blocker_id = p.id AND b.blocked_id = NEW.author_id)
         OR (b.blocker_id = NEW.author_id AND b.blocked_id = p.id)
    )
  ON CONFLICT (recipient_id, dedupe_key) DO NOTHING;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_posts_mentions ON public.posts;
CREATE TRIGGER trg_posts_mentions AFTER INSERT ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.notify_mentions();
DROP TRIGGER IF EXISTS trg_channel_mentions ON public.channel_messages;
CREATE TRIGGER trg_channel_mentions AFTER INSERT OR UPDATE OF content ON public.channel_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_mentions();

-- =====================================================================
-- 7. POST SEARCH AND HASHTAGS
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_posts_content_trgm ON public.posts USING gin (content gin_trgm_ops);

-- "#tag" matches that exact hashtag; anything else is a case-insensitive text search.
-- Runs with the caller's permissions, so blocked users' posts stay hidden.
CREATE OR REPLACE FUNCTION public.search_posts(p_query TEXT, p_limit INTEGER DEFAULT 20, p_offset INTEGER DEFAULT 0)
RETURNS SETOF public.posts LANGUAGE plpgsql STABLE AS $$
DECLARE
  q TEXT := left(trim(COALESCE(p_query, '')), 100);
  pattern TEXT;
BEGIN
  IF char_length(q) < 2 THEN RETURN; END IF;

  IF q ~ '^#[[:alnum:]_]+$' THEN
    pattern := '(^|[^[:alnum:]_])' || q || '($|[^[:alnum:]_])';
    RETURN QUERY
      SELECT * FROM public.posts
      WHERE repost_of_id IS NULL AND (content ~* pattern OR song_title ~* pattern)
      ORDER BY created_at DESC
      LIMIT LEAST(p_limit, 50) OFFSET GREATEST(p_offset, 0);
  ELSE
    pattern := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    RETURN QUERY
      SELECT * FROM public.posts
      WHERE repost_of_id IS NULL AND (content ILIKE pattern OR song_title ILIKE pattern)
      ORDER BY created_at DESC
      LIMIT LEAST(p_limit, 50) OFFSET GREATEST(p_offset, 0);
  END IF;
END;
$$;

-- =====================================================================
-- 8. UNREAD DIRECT MESSAGES
-- =====================================================================
CREATE OR REPLACE FUNCTION public.unread_dm_conversations()
RETURNS SETOF UUID LANGUAGE sql STABLE AS $$
  SELECT c.id FROM public.conversations c
  LEFT JOIN public.conversation_reads r ON r.conversation_id = c.id AND r.user_id = auth.uid()
  WHERE (c.user_a = auth.uid() OR c.user_b = auth.uid())
    AND NOT public.blocked_with(CASE WHEN c.user_a = auth.uid() THEN c.user_b ELSE c.user_a END)
    AND EXISTS (
      SELECT 1 FROM public.direct_messages m
      WHERE m.conversation_id = c.id AND m.sender_id <> auth.uid()
        AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
    );
$$;

-- Uses the database clock, so a wrong device clock cannot leave messages "unread".
CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.conversation_reads (conversation_id, user_id, last_read_at)
  SELECT id, auth.uid(), clock_timestamp() FROM public.conversations
  WHERE id = p_conversation_id AND (user_a = auth.uid() OR user_b = auth.uid())
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversation_reads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_reads;
  END IF;
END $$;

-- =====================================================================
-- 9. SOUND FILES IN STORAGE
-- =====================================================================
-- Posts: any audio format, up to 50 MB.
UPDATE storage.buckets
SET file_size_limit = 52428800,
    allowed_mime_types = ARRAY[
      'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'audio/*'
    ]
WHERE id = 'post-media';

-- Chats: any audio format, still 25 MB.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime', 'audio/*',
      'application/pdf', 'text/plain', 'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
WHERE id = 'chat-attachments';
