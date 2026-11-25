export type DmPrivacy = 'everyone' | 'friends' | 'following' | 'none';
export type FriendRequestPrivacy = 'everyone' | 'none';
export type PlatformRole = 'user' | 'platform_admin';

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  banner_url: string | null;
  dm_privacy: DmPrivacy;
  friend_request_privacy: FriendRequestPrivacy;
  platform_role: PlatformRole;
  created_at: string;
  updated_at: string;
}

export interface GlobalEmoji {
  id: string;
  shortcode: string;
  label: string;
  storage_path: string;
  public_url: string;
  width: number;
  height: number;
  created_by: string | null;
  created_at: string;
}

export interface PostMedia {
  url: string;
  category: 'image' | 'video' | 'audio' | 'file';
  name: string;
  mimeType: string;
  size: number;
}

export interface Post {
  id: string;
  author_id: string;
  content: string;
  media_urls: PostMedia[];
  reply_to_id: string | null;
  repost_of_id: string | null;
  likes_count: number;
  replies_count: number;
  reposts_count: number;
  /** Set only on Song Posts. */
  song_title?: string | null;
  song_duration?: number | null;
  streams_count?: number;
  created_at: string;
  author?: Profile;
  repost_of?: Post | null;
  liked_by_me?: boolean;
}

export interface FriendRequest {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
  sender?: Profile;
  receiver?: Profile;
}

export interface Conversation {
  id: string;
  user_a: string;
  user_b: string;
  last_message_at: string;
  created_at: string;
  other_user?: Profile;
  last_message?: DirectMessage | null;
  unread?: boolean;
}

export interface AttachmentRecord {
  id: string;
  uploader_id: string;
  context_type: 'post' | 'dm' | 'channel';
  context_id: string;
  message_id: string | null;
  file_name: string;
  mime_type: string;
  file_size: number;
  category: 'image' | 'video' | 'audio' | 'file';
  storage_bucket: string;
  storage_path: string | null;
  uploaded_at: string;
  expires_at: string | null;
  deleted_at: string | null;
}

export interface MessageReaction {
  id: string;
  message_type: 'channel' | 'dm';
  message_id: string;
  user_id: string;
  emoji_shortcode: string;
}

export interface DirectMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  edited_at?: string | null;
  sender?: Profile;
  attachments?: AttachmentRecord[];
  reactions?: MessageReaction[];
}

export interface Server {
  id: string;
  name: string;
  description: string;
  icon_url: string | null;
  owner_id: string;
  created_at: string;
}

export type ServerMemberRole = 'owner' | 'admin' | 'moderator' | 'member';

export interface ServerMember {
  server_id: string;
  user_id: string;
  role: ServerMemberRole;
  joined_at: string;
  profile?: Profile;
}

export interface ServerChannel {
  id: string;
  server_id: string;
  name: string;
  type: 'text' | 'voice';
  topic: string;
  position: number;
  created_at: string;
}

export interface ChannelMessage {
  id: string;
  channel_id: string;
  server_id: string;
  author_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  author?: Profile;
  attachments?: AttachmentRecord[];
  reactions?: MessageReaction[];
}

export interface ServerInvitation {
  id: string;
  server_id: string;
  inviter_id: string;
  invitee_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
  server?: Server;
  inviter?: Profile;
  invitee?: Profile;
}

export interface NotificationItem {
  id: string;
  recipient_id: string;
  actor_id: string | null;
  type:
    | 'friend_request'
    | 'friend_accepted'
    | 'server_invite'
    | 'post_like'
    | 'post_reply'
    | 'post_repost'
    | 'mention';
  entity_id: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
  actor?: Profile;
}

export interface VoiceParticipant {
  channel_id: string;
  user_id: string;
  server_id: string;
  muted: boolean;
  video_enabled: boolean;
  joined_at: string;
  profile?: Profile;
}

export type AppView =
  | { kind: 'feed' }
  | { kind: 'explore'; query?: string }
  | { kind: 'messages'; conversationId?: string }
  | { kind: 'inbox' }
  | { kind: 'profile'; userId: string }
  | { kind: 'post'; postId: string }
  | { kind: 'server'; serverId: string; channelId?: string }
  | { kind: 'reports' }
  | { kind: 'settings' };

export type ReportTargetType = 'post' | 'profile' | 'channel_message' | 'dm';

export interface Report {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  target_type: ReportTargetType;
  target_id: string;
  reason: string;
  details: string;
  snapshot: string;
  status: 'open' | 'resolved' | 'dismissed';
  created_at: string;
  reporter?: Profile;
  reported_user?: Profile;
}
