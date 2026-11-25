import { Dispatch, SetStateAction } from 'react';
import { Post, PostMedia, Profile } from '../types';
import { getSupabase } from './supabase';
import { sendNotification } from './notifications';

export const POST_SELECT = '*, author:profiles!posts_author_id_fkey(*)';

/** Adds media defaults, "liked by me" and the original post behind each repost. */
export async function hydratePostRows(rows: unknown[], userId: string): Promise<Post[]> {
  if (rows.length === 0) return [];
  const supabase = getSupabase();
  const posts = rows as Post[];
  const originalIds = posts.map((p) => p.repost_of_id).filter((id): id is string => Boolean(id));
  let originals: Post[] = [];
  if (originalIds.length > 0) {
    const { data } = await supabase.from('posts').select(POST_SELECT).in('id', originalIds);
    originals = (data || []) as unknown as Post[];
  }
  const { data: likes } = await supabase
    .from('post_likes')
    .select('post_id')
    .eq('user_id', userId)
    .in('post_id', [...posts, ...originals].map((p) => p.id));
  const liked = new Set((likes || []).map((l) => l.post_id as string));
  const normalize = (p: Post): Post => ({
    ...p,
    media_urls: Array.isArray(p.media_urls) ? (p.media_urls as PostMedia[]) : [],
    liked_by_me: liked.has(p.id),
  });
  const originalMap = new Map(originals.map((p) => [p.id, normalize(p)]));
  return (
    posts
      .map((p) => ({
        ...normalize(p),
        repost_of: p.repost_of_id ? originalMap.get(p.repost_of_id) || null : null,
      }))
      // A repost whose original is hidden (for example a blocked author) has nothing to show.
      .filter((p) => !p.repost_of_id || p.repost_of || p.content)
  );
}

/** Like, repost and delete for any list of posts. */
export function postActions(
  currentUser: Profile,
  setPosts: Dispatch<SetStateAction<Post[]>>,
  onError: (message: string) => void
) {
  /** Applies a change to a post wherever it appears, including inside reposts. */
  const patch = (id: string, change: (p: Post) => Post) =>
    setPosts((prev) =>
      prev.map((p) => {
        const next = p.id === id ? change(p) : p;
        return next.repost_of?.id === id ? { ...next, repost_of: change(next.repost_of) } : next;
      })
    );

  const toggleLike = async (post: Post) => {
    const supabase = getSupabase();
    const wasLiked = Boolean(post.liked_by_me);
    const flip = (liked: boolean) =>
      patch(post.id, (p) => ({
        ...p,
        liked_by_me: liked,
        likes_count: Math.max(0, p.likes_count + (liked ? 1 : -1)),
      }));
    flip(!wasLiked);
    const { error } = wasLiked
      ? await supabase.from('post_likes').delete().eq('post_id', post.id).eq('user_id', currentUser.id)
      : await supabase.from('post_likes').insert({ post_id: post.id, user_id: currentUser.id });
    if (error) {
      flip(wasLiked);
      onError('Could not update your like.');
    } else if (!wasLiked && post.author_id !== currentUser.id) {
      await sendNotification({
        recipient_id: post.author_id,
        actor_id: currentUser.id,
        type: 'post_like',
        entity_id: post.id,
        dedupe_key: `like_${post.id}_${currentUser.id}`,
      });
    }
  };

  /** `target` is the original post being reposted. Returns the new repost row. */
  const repost = async (target: Post): Promise<Post | null> => {
    const { data, error } = await getSupabase()
      .from('posts')
      .insert({ author_id: currentUser.id, content: '', repost_of_id: target.id })
      .select(POST_SELECT)
      .single();
    if (error) {
      onError(error.code === '23505' ? 'You have already reposted this post.' : 'Could not repost this post.');
      return null;
    }
    patch(target.id, (p) => ({ ...p, reposts_count: p.reposts_count + 1 }));
    if (target.author_id !== currentUser.id) {
      await sendNotification({
        recipient_id: target.author_id,
        actor_id: currentUser.id,
        type: 'post_repost',
        entity_id: target.id,
        dedupe_key: `repost_${target.id}_${currentUser.id}`,
      });
    }
    return {
      ...(data as unknown as Post),
      media_urls: [],
      liked_by_me: false,
      repost_of: { ...target, reposts_count: target.reposts_count + 1 },
    };
  };

  const remove = async (postId: string) => {
    const { error } = await getSupabase().from('posts').delete().eq('id', postId);
    if (error) onError('Could not delete the post.');
    else setPosts((prev) => prev.filter((p) => p.id !== postId && p.repost_of_id !== postId));
  };

  const replyCountDelta = (postId: string, delta: number) =>
    patch(postId, (p) => ({ ...p, replies_count: Math.max(0, p.replies_count + delta) }));

  return { toggleLike, repost, remove, replyCountDelta };
}
