import { getSupabase } from './supabase';

/**
 * Creates an in-app notification for another user. A repeat with the same dedupe key
 * is rejected by the unique index, which is fine. (An upsert is not usable here:
 * row-level security would require the sender to be able to read the recipient's row.)
 */
export async function sendNotification(row: {
  recipient_id: string;
  actor_id: string;
  type: 'friend_request' | 'server_invite' | 'post_like' | 'post_reply' | 'post_repost';
  entity_id: string;
  dedupe_key?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getSupabase().from('notifications').insert(row);
}
