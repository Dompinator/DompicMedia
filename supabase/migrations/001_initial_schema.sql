-- Vesper Social & Community Servers Platform
-- Migration 001: Core Schema, Indexes, Triggers, RLS Policies, and Atomic RPCs

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. PROFILES
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  banner_url TEXT,
  dm_privacy TEXT NOT NULL DEFAULT 'everyone' CHECK (dm_privacy IN ('everyone', 'friends', 'following', 'none')),
  friend_request_privacy TEXT NOT NULL DEFAULT 'everyone' CHECK (friend_request_privacy IN ('everyone', 'none')),
  platform_role TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user', 'platform_admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (username ~ '^[a-z0-9_]{3,24}$'),
  CONSTRAINT username_not_reserved CHECK (
    lower(username) NOT IN (
      'admin', 'administrator', 'system', 'root', 'support', 'moderator',
      'mod', 'staff', 'official', 'dompic', 'dompicmedia', 'vesper', 'security', 'help', 'api',
      'null', 'undefined', 'everyone', 'here'
    )
  ),
  CONSTRAINT display_name_length CHECK (char_length(trim(display_name)) BETWEEN 1 AND 48),
  CONSTRAINT bio_length CHECK (char_length(bio) <= 280)
);

CREATE INDEX IF NOT EXISTS idx_profiles_username_trgm ON public.profiles (username text_pattern_ops);

-- Protect platform_role from self-escalation via trigger
CREATE OR REPLACE FUNCTION public.prevent_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.platform_role IS DISTINCT FROM OLD.platform_role THEN
    IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Only service role can modify platform_role';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_protect_role ON public.profiles;
CREATE TRIGGER trg_profiles_protect_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_role_escalation();

-- Auto-create profile on auth.users signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_username TEXT;
  clean_username TEXT;
  raw_display TEXT;
BEGIN
  raw_username := lower(trim(COALESCE(NEW.raw_user_meta_data->>'username', '')));
  IF raw_username = '' OR raw_username !~ '^[a-z0-9_]{3,24}$' OR raw_username IN (
    'admin', 'administrator', 'system', 'root', 'support', 'moderator',
    'mod', 'staff', 'official', 'vesper', 'dompic', 'dompicmedia',
    'security', 'help', 'api', 'null', 'undefined', 'everyone', 'here'
  ) THEN
    clean_username := 'user_' || substr(replace(NEW.id::text, '-', ''), 1, 10);
  ELSE
    clean_username := raw_username;
  END IF;

  raw_display := trim(COALESCE(NEW.raw_user_meta_data->>'display_name', ''));
  IF raw_display = '' THEN
    raw_display := clean_username;
  END IF;

  INSERT INTO public.profiles (id, username, display_name)
  VALUES (NEW.id, clean_username, left(raw_display, 48))
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 2. FOLLOWS
CREATE TABLE IF NOT EXISTS public.follows (
  follower_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CONSTRAINT cannot_follow_self CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_following ON public.follows (following_id, created_at DESC);

-- 3. FRIEND REQUESTS & FRIENDSHIPS
CREATE TABLE IF NOT EXISTS public.friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cannot_friend_self CHECK (sender_id <> receiver_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_pair
  ON public.friend_requests (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver ON public.friend_requests (receiver_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.friendships (
  user_a UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CONSTRAINT ordered_friendship CHECK (user_a < user_b)
);

CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON public.friendships (user_b);

-- 4. POSTS, LIKES, REPLIES, REPOSTS
CREATE TABLE IF NOT EXISTS public.posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  media_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to_id UUID REFERENCES public.posts(id) ON DELETE CASCADE,
  repost_of_id UUID REFERENCES public.posts(id) ON DELETE CASCADE,
  likes_count INTEGER NOT NULL DEFAULT 0,
  replies_count INTEGER NOT NULL DEFAULT 0,
  reposts_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT post_content_not_empty CHECK (
    char_length(trim(content)) > 0 OR jsonb_array_length(media_urls) > 0 OR repost_of_id IS NOT NULL
  ),
  CONSTRAINT post_content_length CHECK (char_length(content) <= 1000)
);

CREATE INDEX IF NOT EXISTS idx_posts_author_created ON public.posts (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created ON public.posts (created_at DESC) WHERE reply_to_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_reply_to ON public.posts (reply_to_id, created_at ASC) WHERE reply_to_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_unique_repost ON public.posts (author_id, repost_of_id) WHERE repost_of_id IS NOT NULL AND char_length(trim(content)) = 0;

CREATE TABLE IF NOT EXISTS public.post_likes (
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_user ON public.post_likes (user_id, created_at DESC);

-- Triggers for post counters
CREATE OR REPLACE FUNCTION public.update_post_like_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_likes_count ON public.post_likes;
CREATE TRIGGER trg_post_likes_count
  AFTER INSERT OR DELETE ON public.post_likes
  FOR EACH ROW EXECUTE FUNCTION public.update_post_like_count();

CREATE OR REPLACE FUNCTION public.update_post_reply_repost_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reply_to_id IS NOT NULL THEN
      UPDATE public.posts SET replies_count = replies_count + 1 WHERE id = NEW.reply_to_id;
    END IF;
    IF NEW.repost_of_id IS NOT NULL THEN
      UPDATE public.posts SET reposts_count = reposts_count + 1 WHERE id = NEW.repost_of_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.reply_to_id IS NOT NULL THEN
      UPDATE public.posts SET replies_count = GREATEST(0, replies_count - 1) WHERE id = OLD.reply_to_id;
    END IF;
    IF OLD.repost_of_id IS NOT NULL THEN
      UPDATE public.posts SET reposts_count = GREATEST(0, reposts_count - 1) WHERE id = OLD.repost_of_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_posts_reply_repost_count ON public.posts;
CREATE TRIGGER trg_posts_reply_repost_count
  AFTER INSERT OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.update_post_reply_repost_count();

-- 5. PRIVATE DIRECT MESSAGES (TEXT + ATTACHMENTS ONLY, NO DM CALLS)
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ordered_conversation CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_a ON public.conversations (user_a, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_b ON public.conversations (user_b, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.conversation_reads (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.direct_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dm_content_length CHECK (char_length(content) <= 4000)
);

CREATE INDEX IF NOT EXISTS idx_direct_messages_convo_created ON public.direct_messages (conversation_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.bump_conversation_last_message()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  INSERT INTO public.conversation_reads (conversation_id, user_id, last_read_at)
  VALUES (NEW.conversation_id, NEW.sender_id, NEW.created_at)
  ON CONFLICT (conversation_id, user_id)
  DO UPDATE SET last_read_at = EXCLUDED.last_read_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dm_bump_convo ON public.direct_messages;
CREATE TRIGGER trg_dm_bump_convo
  AFTER INSERT ON public.direct_messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_conversation_last_message();

-- 6. SERVERS, ROLES, MEMBERS, INVITATIONS, CHANNELS, MESSAGES
CREATE TABLE IF NOT EXISTS public.servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_url TEXT,
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT server_name_length CHECK (char_length(trim(name)) BETWEEN 2 AND 60)
);

CREATE TABLE IF NOT EXISTS public.server_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  permissions JSONB NOT NULL DEFAULT '{
    "manage_server": false,
    "manage_channels": false,
    "manage_members": false,
    "invite_members": true,
    "send_messages": true,
    "connect_voice": true
  }'::jsonb,
  UNIQUE (server_id, name)
);

CREATE TABLE IF NOT EXISTS public.server_members (
  server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
  role_id UUID REFERENCES public.server_roles(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_server_members_user ON public.server_members (user_id);

CREATE TABLE IF NOT EXISTS public.server_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invitee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cannot_invite_self CHECK (inviter_id <> invitee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_server_invitations_pending_unique
  ON public.server_invitations (server_id, invitee_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_server_invitations_invitee ON public.server_invitations (invitee_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.server_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  topic TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_name_length CHECK (char_length(trim(name)) BETWEEN 1 AND 48)
);

CREATE INDEX IF NOT EXISTS idx_server_channels_server_pos ON public.server_channels (server_id, position ASC);

CREATE TABLE IF NOT EXISTS public.channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.server_channels(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  CONSTRAINT channel_msg_length CHECK (char_length(content) <= 4000)
);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created ON public.channel_messages (channel_id, created_at DESC);

-- 7. MESSAGE REACTIONS (TEXT CHANNELS & DMS)
CREATE TABLE IF NOT EXISTS public.message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_type TEXT NOT NULL CHECK (message_type IN ('channel', 'dm')),
  message_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji_shortcode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_type, message_id, user_id, emoji_shortcode)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_lookup ON public.message_reactions (message_type, message_id);

-- 8. ATTACHMENTS (24-HOUR EXPIRATION FOR CHAT ATTACHMENTS)
CREATE TABLE IF NOT EXISTS public.attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL CHECK (context_type IN ('post', 'dm', 'channel')),
  context_id UUID NOT NULL,
  message_id UUID,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size > 0 AND file_size <= 26214400),
  category TEXT NOT NULL CHECK (category IN ('image', 'video', 'audio', 'file')),
  storage_bucket TEXT NOT NULL,
  storage_path TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  last_cleanup_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON public.attachments (context_type, message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_expired_pending ON public.attachments (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- Automatically enforce 24-hour expiration on chat attachments (dm & channel)
CREATE OR REPLACE FUNCTION public.set_attachment_expiration()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.uploaded_at := COALESCE(NEW.uploaded_at, now());
  IF NEW.context_type IN ('dm', 'channel') THEN
    NEW.expires_at := NEW.uploaded_at + interval '24 hours';
  ELSE
    NEW.expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attachments_expiration ON public.attachments;
CREATE TRIGGER trg_attachments_expiration
  BEFORE INSERT ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION public.set_attachment_expiration();

-- 9. GLOBAL CUSTOM EMOJIS (128x128 TRANSPARENT PNGS)
CREATE TABLE IF NOT EXISTS public.global_emojis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcode TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 128 CHECK (width = 128),
  height INTEGER NOT NULL DEFAULT 128 CHECK (height = 128),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT emoji_shortcode_format CHECK (shortcode ~ '^[a-z0-9_]{2,32}$')
);

-- 10. NOTIFICATIONS & UNIFIED INBOX
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'friend_request', 'friend_accepted', 'server_invite',
    'post_like', 'post_reply', 'post_repost', 'mention'
  )),
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON public.notifications (recipient_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON public.notifications (recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- 11. VOICE CHANNEL PARTICIPANTS (TRANSIENT PRESENCE TABLE)
CREATE TABLE IF NOT EXISTS public.voice_channel_participants (
  channel_id UUID NOT NULL REFERENCES public.server_channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  muted BOOLEAN NOT NULL DEFAULT false,
  video_enabled BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_participants_server ON public.voice_channel_participants (server_id);

-- HELPER SECURITY FUNCTIONS
CREATE OR REPLACE FUNCTION public.is_server_member(p_server_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.server_members
    WHERE server_id = p_server_id AND user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.has_server_management_role(p_server_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.server_members
    WHERE server_id = p_server_id
      AND user_id = p_user_id
      AND role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_server_owner(p_server_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.servers
    WHERE id = p_server_id AND owner_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user_id AND platform_role = 'platform_admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.are_friends(p_u1 UUID, p_u2 UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.friendships
    WHERE user_a = LEAST(p_u1, p_u2) AND user_b = GREATEST(p_u1, p_u2)
  );
$$;

-- ATOMIC RPCS
CREATE OR REPLACE FUNCTION public.create_server_with_defaults(p_name TEXT, p_description TEXT DEFAULT '', p_icon_url TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_server_id UUID;
  v_owner_role_id UUID;
  v_member_role_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  INSERT INTO public.servers (name, description, icon_url, owner_id)
  VALUES (trim(p_name), COALESCE(p_description, ''), p_icon_url, v_uid)
  RETURNING id INTO v_server_id;

  INSERT INTO public.server_roles (server_id, name, position, permissions)
  VALUES
    (v_server_id, 'Owner', 0, '{"manage_server":true,"manage_channels":true,"manage_members":true,"invite_members":true,"send_messages":true,"connect_voice":true}'::jsonb),
    (v_server_id, 'Admin', 1, '{"manage_server":false,"manage_channels":true,"manage_members":true,"invite_members":true,"send_messages":true,"connect_voice":true}'::jsonb),
    (v_server_id, 'Moderator', 2, '{"manage_server":false,"manage_channels":false,"manage_members":true,"invite_members":true,"send_messages":true,"connect_voice":true}'::jsonb),
    (v_server_id, 'Member', 3, '{"manage_server":false,"manage_channels":false,"manage_members":false,"invite_members":true,"send_messages":true,"connect_voice":true}'::jsonb);

  SELECT id INTO v_owner_role_id FROM public.server_roles WHERE server_id = v_server_id AND name = 'Owner';

  INSERT INTO public.server_members (server_id, user_id, role, role_id)
  VALUES (v_server_id, v_uid, 'owner', v_owner_role_id);

  INSERT INTO public.server_channels (server_id, name, type, topic, position)
  VALUES
    (v_server_id, 'general', 'text', 'General community discussion', 0),
    (v_server_id, 'announcements', 'text', 'Server updates and announcements', 1),
    (v_server_id, 'Lounge', 'voice', 'Hang out in voice or video', 2);

  RETURN v_server_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_friend_request(p_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_req public.friend_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_req FROM public.friend_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.receiver_id <> v_uid OR v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Invalid or unauthorized friend request';
  END IF;

  UPDATE public.friend_requests SET status = 'accepted', updated_at = now() WHERE id = p_request_id;

  INSERT INTO public.friendships (user_a, user_b)
  VALUES (LEAST(v_req.sender_id, v_req.receiver_id), GREATEST(v_req.sender_id, v_req.receiver_id))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.notifications (recipient_id, actor_id, type, entity_id, dedupe_key)
  VALUES (v_req.sender_id, v_uid, 'friend_accepted', p_request_id, 'friend_accepted_' || p_request_id::text)
  ON CONFLICT (recipient_id, dedupe_key) DO NOTHING;

  UPDATE public.notifications SET read_at = now()
  WHERE recipient_id = v_uid AND type = 'friend_request' AND entity_id = p_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_friend_request(p_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_req public.friend_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_req FROM public.friend_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_req.receiver_id <> v_uid OR v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Invalid or unauthorized friend request';
  END IF;

  UPDATE public.friend_requests SET status = 'declined', updated_at = now() WHERE id = p_request_id;
  UPDATE public.notifications SET read_at = now()
  WHERE recipient_id = v_uid AND type = 'friend_request' AND entity_id = p_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_server_invitation(p_invite_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_inv public.server_invitations%ROWTYPE;
  v_member_role_id UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_inv FROM public.server_invitations WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR v_inv.invitee_id <> v_uid OR v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'Invalid or unauthorized server invitation';
  END IF;

  UPDATE public.server_invitations SET status = 'accepted', updated_at = now() WHERE id = p_invite_id;

  SELECT id INTO v_member_role_id FROM public.server_roles WHERE server_id = v_inv.server_id AND name = 'Member';

  INSERT INTO public.server_members (server_id, user_id, role, role_id)
  VALUES (v_inv.server_id, v_uid, 'member', v_member_role_id)
  ON CONFLICT DO NOTHING;

  UPDATE public.notifications SET read_at = now()
  WHERE recipient_id = v_uid AND type = 'server_invite' AND entity_id = p_invite_id;

  RETURN v_inv.server_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_server_invitation(p_invite_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_inv public.server_invitations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_inv FROM public.server_invitations WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR v_inv.invitee_id <> v_uid OR v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'Invalid or unauthorized server invitation';
  END IF;

  UPDATE public.server_invitations SET status = 'declined', updated_at = now() WHERE id = p_invite_id;
  UPDATE public.notifications SET read_at = now()
  WHERE recipient_id = v_uid AND type = 'server_invite' AND entity_id = p_invite_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_or_create_dm_conversation(p_target_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_a UUID;
  v_b UUID;
  v_convo_id UUID;
  v_target_privacy TEXT;
  v_follows_sender BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_uid = p_target_user_id THEN RAISE EXCEPTION 'Cannot message yourself'; END IF;

  v_a := LEAST(v_uid, p_target_user_id);
  v_b := GREATEST(v_uid, p_target_user_id);

  SELECT id INTO v_convo_id FROM public.conversations WHERE user_a = v_a AND user_b = v_b;
  IF v_convo_id IS NOT NULL THEN
    RETURN v_convo_id;
  END IF;

  SELECT dm_privacy INTO v_target_privacy FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  IF v_target_privacy = 'none' THEN
    RAISE EXCEPTION 'This user does not accept direct messages';
  ELSIF v_target_privacy = 'friends' AND NOT public.are_friends(v_uid, p_target_user_id) THEN
    RAISE EXCEPTION 'Only friends can start a conversation with this user';
  ELSIF v_target_privacy = 'following' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.follows WHERE follower_id = p_target_user_id AND following_id = v_uid
    ) INTO v_follows_sender;
    IF NOT v_follows_sender AND NOT public.are_friends(v_uid, p_target_user_id) THEN
      RAISE EXCEPTION 'This user only accepts DMs from accounts they follow or friends';
    END IF;
  END IF;

  INSERT INTO public.conversations (user_a, user_b)
  VALUES (v_a, v_b)
  ON CONFLICT (user_a, user_b) DO UPDATE SET user_a = EXCLUDED.user_a
  RETURNING id INTO v_convo_id;

  RETURN v_convo_id;
END;
$$;

-- ENABLE ROW LEVEL SECURITY ON ALL TABLES
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_emojis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY;

-- PROFILES POLICIES
CREATE POLICY "Profiles are publicly readable" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- FOLLOWS POLICIES
CREATE POLICY "Follows are readable" ON public.follows FOR SELECT USING (true);
CREATE POLICY "Users can follow as themselves" ON public.follows FOR INSERT WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "Users can unfollow own follows" ON public.follows FOR DELETE USING (auth.uid() = follower_id);

-- FRIEND REQUESTS & FRIENDSHIPS POLICIES
CREATE POLICY "Users see own friend requests" ON public.friend_requests FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can send friend requests respecting privacy" ON public.friend_requests FOR INSERT WITH CHECK (
  auth.uid() = sender_id
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = receiver_id AND p.friend_request_privacy = 'everyone')
  AND NOT public.are_friends(sender_id, receiver_id)
);
CREATE POLICY "Senders can cancel pending requests" ON public.friend_requests FOR DELETE USING (auth.uid() = sender_id AND status = 'pending');

CREATE POLICY "Friendships readable by authenticated users" ON public.friendships FOR SELECT USING (auth.uid() = user_a OR auth.uid() = user_b);
CREATE POLICY "Friends can remove friendship" ON public.friendships FOR DELETE USING (auth.uid() = user_a OR auth.uid() = user_b);

-- POSTS & LIKES POLICIES
CREATE POLICY "Posts are readable" ON public.posts FOR SELECT USING (true);
CREATE POLICY "Users create posts as themselves" ON public.posts FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Users delete own posts" ON public.posts FOR DELETE USING (auth.uid() = author_id);

CREATE POLICY "Likes are readable" ON public.post_likes FOR SELECT USING (true);
CREATE POLICY "Users like as themselves" ON public.post_likes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users unlike own likes" ON public.post_likes FOR DELETE USING (auth.uid() = user_id);

-- DIRECT MESSAGES POLICIES
CREATE POLICY "Conversation participants read conversations" ON public.conversations FOR SELECT USING (auth.uid() = user_a OR auth.uid() = user_b);
CREATE POLICY "Participants manage own read cursors" ON public.conversation_reads FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Participants read DMs" ON public.direct_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_id AND (c.user_a = auth.uid() OR c.user_b = auth.uid()))
);
CREATE POLICY "Participants send DMs as themselves" ON public.direct_messages FOR INSERT WITH CHECK (
  auth.uid() = sender_id AND
  EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_id AND (c.user_a = auth.uid() OR c.user_b = auth.uid()))
);
CREATE POLICY "Senders delete own DMs" ON public.direct_messages FOR DELETE USING (auth.uid() = sender_id);

-- SERVERS, ROLES, MEMBERS, INVITATIONS, CHANNELS, MESSAGES POLICIES
CREATE POLICY "Server members and invitees can view server" ON public.servers FOR SELECT USING (
  owner_id = auth.uid()
  OR public.is_server_member(id, auth.uid())
  OR EXISTS (SELECT 1 FROM public.server_invitations si WHERE si.server_id = id AND si.invitee_id = auth.uid() AND si.status = 'pending')
);
CREATE POLICY "Authenticated users can create servers" ON public.servers FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Server owner can update server" ON public.servers FOR UPDATE USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "Server owner can delete server" ON public.servers FOR DELETE USING (auth.uid() = owner_id);

CREATE POLICY "Members view server roles" ON public.server_roles FOR SELECT USING (public.is_server_member(server_id, auth.uid()));
CREATE POLICY "Owners manage server roles" ON public.server_roles FOR ALL USING (public.is_server_owner(server_id, auth.uid()));

CREATE POLICY "Members view server roster" ON public.server_members FOR SELECT USING (public.is_server_member(server_id, auth.uid()));
CREATE POLICY "Owners/admins update member roles" ON public.server_members FOR UPDATE USING (public.has_server_management_role(server_id, auth.uid()) AND role <> 'owner');
CREATE POLICY "Members can leave or owners/admins can remove non-owners" ON public.server_members FOR DELETE USING (
  (auth.uid() = user_id AND role <> 'owner')
  OR (public.has_server_management_role(server_id, auth.uid()) AND role <> 'owner')
);

CREATE POLICY "Inviters/invitees/admins view invitations" ON public.server_invitations FOR SELECT USING (
  auth.uid() = invitee_id OR auth.uid() = inviter_id OR public.has_server_management_role(server_id, auth.uid())
);
CREATE POLICY "Members can invite others if not already member" ON public.server_invitations FOR INSERT WITH CHECK (
  auth.uid() = inviter_id
  AND public.is_server_member(server_id, auth.uid())
  AND NOT public.is_server_member(server_id, invitee_id)
);

CREATE POLICY "Members view server channels" ON public.server_channels FOR SELECT USING (public.is_server_member(server_id, auth.uid()));
CREATE POLICY "Owners and admins manage channels" ON public.server_channels FOR ALL USING (public.has_server_management_role(server_id, auth.uid())) WITH CHECK (public.has_server_management_role(server_id, auth.uid()));

CREATE POLICY "Members read channel messages" ON public.channel_messages FOR SELECT USING (public.is_server_member(server_id, auth.uid()));
CREATE POLICY "Members send channel messages as themselves" ON public.channel_messages FOR INSERT WITH CHECK (
  auth.uid() = author_id AND public.is_server_member(server_id, auth.uid())
);
CREATE POLICY "Authors or server admins delete channel messages" ON public.channel_messages FOR DELETE USING (
  auth.uid() = author_id OR public.has_server_management_role(server_id, auth.uid())
);

-- MESSAGE REACTIONS POLICIES
CREATE POLICY "Authorized users view reactions" ON public.message_reactions FOR SELECT USING (
  (message_type = 'channel' AND EXISTS (
    SELECT 1 FROM public.channel_messages cm WHERE cm.id = message_id AND public.is_server_member(cm.server_id, auth.uid())
  ))
  OR
  (message_type = 'dm' AND EXISTS (
    SELECT 1 FROM public.direct_messages dm
    JOIN public.conversations c ON c.id = dm.conversation_id
    WHERE dm.id = message_id AND (c.user_a = auth.uid() OR c.user_b = auth.uid())
  ))
);
CREATE POLICY "Authorized users add reactions" ON public.message_reactions FOR INSERT WITH CHECK (
  auth.uid() = user_id AND (
    (message_type = 'channel' AND EXISTS (
      SELECT 1 FROM public.channel_messages cm WHERE cm.id = message_id AND public.is_server_member(cm.server_id, auth.uid())
    ))
    OR
    (message_type = 'dm' AND EXISTS (
      SELECT 1 FROM public.direct_messages dm
      JOIN public.conversations c ON c.id = dm.conversation_id
      WHERE dm.id = message_id AND (c.user_a = auth.uid() OR c.user_b = auth.uid())
    ))
  )
);
CREATE POLICY "Users remove own reactions" ON public.message_reactions FOR DELETE USING (auth.uid() = user_id);

-- ATTACHMENTS POLICIES
CREATE POLICY "Authorized users view non-expired attachment metadata" ON public.attachments FOR SELECT USING (
  context_type = 'post'
  OR (context_type = 'dm' AND EXISTS (
    SELECT 1 FROM public.conversations c WHERE c.id = context_id AND (c.user_a = auth.uid() OR c.user_b = auth.uid())
  ))
  OR (context_type = 'channel' AND public.is_server_member(context_id, auth.uid()))
);
CREATE POLICY "Users upload attachments as themselves" ON public.attachments FOR INSERT WITH CHECK (
  auth.uid() = uploader_id
  AND (
    context_type = 'post'
    OR (context_type = 'dm' AND EXISTS (
      SELECT 1 FROM public.conversations c WHERE c.id = context_id AND (c.user_a = auth.uid() OR c.user_b = auth.uid())
    ))
    OR (context_type = 'channel' AND public.is_server_member(context_id, auth.uid()))
  )
);

-- GLOBAL EMOJIS POLICIES
CREATE POLICY "Global emojis are readable by everyone" ON public.global_emojis FOR SELECT USING (true);
CREATE POLICY "Only platform admins manage global emojis" ON public.global_emojis FOR ALL USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

-- NOTIFICATIONS POLICIES
CREATE POLICY "Users read own notifications" ON public.notifications FOR SELECT USING (auth.uid() = recipient_id);
CREATE POLICY "Authenticated users can trigger notifications as actor" ON public.notifications FOR INSERT WITH CHECK (auth.uid() = actor_id);
CREATE POLICY "Users mark own notifications read" ON public.notifications FOR UPDATE USING (auth.uid() = recipient_id) WITH CHECK (auth.uid() = recipient_id);
CREATE POLICY "Users delete own notifications" ON public.notifications FOR DELETE USING (auth.uid() = recipient_id);

-- VOICE CHANNEL PARTICIPANTS POLICIES
CREATE POLICY "Server members view voice channel participants" ON public.voice_channel_participants FOR SELECT USING (public.is_server_member(server_id, auth.uid()));
CREATE POLICY "Members join/update own voice presence" ON public.voice_channel_participants FOR INSERT WITH CHECK (
  auth.uid() = user_id AND public.is_server_member(server_id, auth.uid())
);
CREATE POLICY "Members update own voice state" ON public.voice_channel_participants FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Members leave voice channel" ON public.voice_channel_participants FOR DELETE USING (auth.uid() = user_id);

-- REALTIME PUBLICATION
ALTER PUBLICATION supabase_realtime ADD TABLE
  public.posts,
  public.direct_messages,
  public.channel_messages,
  public.message_reactions,
  public.notifications,
  public.voice_channel_participants,
  public.server_channels,
  public.friend_requests,
  public.server_invitations;

ALTER TABLE public.voice_channel_participants REPLICA IDENTITY FULL;
