import React, { useCallback, useEffect, useState } from 'react';
import {
  Image as ImageIcon,
  Smile,
  X,
} from 'lucide-react';
import { GlobalEmoji, Post, PostMedia, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { categorizeMime, formatFileSize, validateAttachmentFile } from '../lib/utils';
import { playSound } from '../lib/sounds';
import { Avatar } from './Avatar';
import { EmojiPicker } from './CustomEmoji';
import { CommentNode, fetchCommentsMapForPosts, PostCard } from './PostCard';

interface SocialFeedViewProps {
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  onOpenProfile: (userId: string) => void;
  onOpenProfileByUsername: (username: string) => void;
}

const PAGE_SIZE = 15;

export function SocialFeedView({
  currentUser,
  globalEmojis,
  onOpenProfile,
  onOpenProfileByUsername,
}: SocialFeedViewProps) {
  const [tab, setTab] = useState<'following' | 'discover'>('following');
  const [posts, setPosts] = useState<Post[]>([]);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, CommentNode[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Composer state
  const [content, setContent] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [posting, setPosting] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const hydratePosts = useCallback(
    async (rawPosts: Array<Record<string, unknown>>): Promise<Post[]> => {
      if (rawPosts.length === 0) return [];
      const supabase = getSupabase();
      const postIds = rawPosts.map((p) => p.id as string);
      const { data: myLikes } = await supabase
        .from('post_likes')
        .select('post_id')
        .eq('user_id', currentUser.id)
        .in('post_id', postIds);

      const likedSet = new Set((myLikes || []).map((l) => l.post_id as string));

      return rawPosts.map((row) => ({
        ...(row as unknown as Post),
        media_urls: Array.isArray(row.media_urls) ? (row.media_urls as PostMedia[]) : [],
        liked_by_me: likedSet.has(row.id as string),
      }));
    },
    [currentUser.id]
  );

  const fetchFeed = useCallback(
    async (offset = 0, append = false) => {
      if (!append) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        const supabase = getSupabase();
        let authorIds: string[] | null = null;

        if (tab === 'following') {
          const { data: followsData } = await supabase
            .from('follows')
            .select('following_id')
            .eq('follower_id', currentUser.id);
          const ids = (followsData || []).map((f) => f.following_id as string);
          ids.push(currentUser.id);
          authorIds = ids;
        }

        let query = supabase
          .from('posts')
          .select('*, author:profiles!posts_author_id_fkey(*)')
          .is('reply_to_id', null)
          .order('created_at', { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);

        if (authorIds) {
          query = query.in('author_id', authorIds);
        }

        const { data, error: fetchErr } = await query;
        if (fetchErr) throw fetchErr;

        const hydrated = await hydratePosts(data || []);

        const repostIds = hydrated
          .map((p) => p.repost_of_id)
          .filter((id): id is string => Boolean(id));
        if (repostIds.length > 0) {
          const { data: origPosts } = await supabase
            .from('posts')
            .select('*, author:profiles!posts_author_id_fkey(*)')
            .in('id', repostIds);
          const origHydrated = await hydratePosts(origPosts || []);
          const origMap = new Map<string, Post>();
          for (const op of origHydrated) {
            origMap.set(op.id, op);
          }
          for (const p of hydrated) {
            if (p.repost_of_id) {
              p.repost_of = origMap.get(p.repost_of_id) || null;
            }
          }
        }

        const displayIds = Array.from(
          new Set(hydrated.map((p) => (p.repost_of ? p.repost_of.id : p.id)))
        );
        const fetchedComments = await fetchCommentsMapForPosts(displayIds, currentUser.id);

        setHasMore((data || []).length === PAGE_SIZE);
        setPosts((prev) => (append ? [...prev, ...hydrated] : hydrated));
        setCommentsByPost((prev) => (append ? { ...prev, ...fetchedComments } : fetchedComments));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load feed.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [currentUser.id, hydratePosts, tab]
  );

  useEffect(() => {
    fetchFeed(0, false);
  }, [fetchFeed]);

  // Realtime listener for new top-level posts
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('vesper-feed-posts')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'posts' },
        async (payload) => {
          const inserted = payload.new as Post;
          if (inserted.reply_to_id) return;
          if (tab === 'following' && inserted.author_id !== currentUser.id) {
            const { data: isFollowing } = await supabase
              .from('follows')
              .select('following_id')
              .eq('follower_id', currentUser.id)
              .eq('following_id', inserted.author_id)
              .maybeSingle();
            if (!isFollowing) return;
          }
          const { data: full } = await supabase
            .from('posts')
            .select('*, author:profiles!posts_author_id_fkey(*)')
            .eq('id', inserted.id)
            .single();
          if (full) {
            const [hydrated] = await hydratePosts([full]);
            setPosts((prev) => {
              if (prev.some((p) => p.id === hydrated.id)) return prev;
              return [hydrated, ...prev];
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUser.id, hydratePosts, tab]);

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      const err = validateAttachmentFile(f);
      if (err) {
        setError(err);
        return;
      }
    }
    setPendingFiles((prev) => [...prev, ...files].slice(0, 4));
    e.target.value = '';
  };

  const handleCreatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() && pendingFiles.length === 0) return;
    setPosting(true);
    setError(null);

    try {
      const supabase = getSupabase();
      const uploadedMedia: PostMedia[] = [];

      for (const file of pendingFiles) {
        const ext = file.name.split('.').pop() || 'bin';
        const storagePath = `${currentUser.id}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('post-media')
          .upload(storagePath, file, { contentType: file.type });
        if (upErr) throw upErr;

        const { data: pub } = supabase.storage.from('post-media').getPublicUrl(storagePath);
        uploadedMedia.push({
          url: pub.publicUrl,
          category: categorizeMime(file.type),
          name: file.name,
          mimeType: file.type,
          size: file.size,
        });
      }

      const { data: inserted, error: insErr } = await supabase
        .from('posts')
        .insert({
          author_id: currentUser.id,
          content: content.trim(),
          media_urls: uploadedMedia,
        })
        .select('*, author:profiles!posts_author_id_fkey(*)')
        .single();

      if (insErr) throw insErr;

      playSound('post');

      const [hydrated] = await hydratePosts([inserted]);
      setPosts((prev) => (prev.some((p) => p.id === hydrated.id) ? prev : [hydrated, ...prev]));
      setContent('');
      setPendingFiles([]);
      setShowEmojiPicker(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish post.');
    } finally {
      setPosting(false);
    }
  };

  const toggleLike = async (post: Post) => {
    const supabase = getSupabase();
    const targetId = post.id;
    const currentlyLiked = Boolean(post.liked_by_me);

    setPosts((prev) =>
      prev.map((p) => {
        if (p.id === targetId) {
          return {
            ...p,
            liked_by_me: !currentlyLiked,
            likes_count: Math.max(0, p.likes_count + (currentlyLiked ? -1 : 1)),
          };
        }
        if (p.repost_of && p.repost_of.id === targetId) {
          return {
            ...p,
            repost_of: {
              ...p.repost_of,
              liked_by_me: !currentlyLiked,
              likes_count: Math.max(0, p.repost_of.likes_count + (currentlyLiked ? -1 : 1)),
            },
          };
        }
        return p;
      })
    );

    if (currentlyLiked) {
      await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', targetId)
        .eq('user_id', currentUser.id);
    } else {
      const { error: likeErr } = await supabase
        .from('post_likes')
        .insert({ post_id: targetId, user_id: currentUser.id });
      if (!likeErr && post.author_id !== currentUser.id) {
        await supabase.from('notifications').upsert(
          {
            recipient_id: post.author_id,
            actor_id: currentUser.id,
            type: 'post_like',
            entity_id: post.id,
            dedupe_key: `like_${post.id}_${currentUser.id}`,
          },
          { onConflict: 'recipient_id,dedupe_key', ignoreDuplicates: true }
        );
      }
    }
  };

  const handleRepost = async (post: Post) => {
    const supabase = getSupabase();
    const originalId = post.repost_of_id || post.id;
    const originalAuthorId = post.repost_of?.author_id || post.author_id;
    const { data, error: repErr } = await supabase
      .from('posts')
      .insert({
        author_id: currentUser.id,
        content: '',
        repost_of_id: originalId,
      })
      .select('*, author:profiles!posts_author_id_fkey(*)')
      .single();

    if (repErr) {
      setError('You have already reposted this post.');
      return;
    }

    if (originalAuthorId !== currentUser.id) {
      await supabase.from('notifications').upsert(
        {
          recipient_id: originalAuthorId,
          actor_id: currentUser.id,
          type: 'post_repost',
          entity_id: originalId,
          dedupe_key: `repost_${originalId}_${currentUser.id}`,
        },
        { onConflict: 'recipient_id,dedupe_key', ignoreDuplicates: true }
      );
    }

    if (data) {
      const target = post.repost_of || post;
      const hydrated: Post = {
        ...(data as unknown as Post),
        media_urls: [],
        repost_of: target,
        liked_by_me: false,
      };
      setPosts((prev) => [
        hydrated,
        ...prev.map((p) => (p.id === originalId ? { ...p, reposts_count: p.reposts_count + 1 } : p)),
      ]);
    }
  };

  const handleDeletePost = async (postId: string) => {
    const supabase = getSupabase();
    const { error: delErr } = await supabase.from('posts').delete().eq('id', postId);
    if (!delErr) {
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    }
  };

  const handleReplyCountDelta = (postId: string, delta: number) => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, replies_count: Math.max(0, p.replies_count + delta) }
          : p
      )
    );
  };

  return (
    <div className="max-w-5xl mx-auto w-full px-4 py-6">
      {/* Segmented Feed Filter */}
      <div className="flex items-center justify-between border-b border-white/8 pb-4 mb-5">
        <h2 className="font-display text-lg font-bold text-white">Home Feed</h2>
        <div className="flex items-center gap-1 p-1 bg-[#12151C] border border-white/8 rounded-lg">
          <button
            type="button"
            onClick={() => setTab('following')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'following' ? 'bg-[#5B7CFA] text-white' : 'text-[#9CA3AF] hover:text-white'
            }`}
          >
            Following
          </button>
          <button
            type="button"
            onClick={() => setTab('discover')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'discover' ? 'bg-[#5B7CFA] text-white' : 'text-[#9CA3AF] hover:text-white'
            }`}
          >
            Discover
          </button>
        </div>
      </div>

      {/* Composer */}
      <form
        onSubmit={handleCreatePost}
        className="bg-[#12151C] border border-white/8 rounded-2xl p-4 mb-6 max-w-3xl"
      >
        <div className="flex gap-3">
          <Avatar src={currentUser.avatar_url} name={currentUser.display_name} size="md" />
          <div className="flex-1 min-w-0">
            <textarea
              rows={3}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={1000}
              placeholder="Share an update, thought, or :emoji:..."
              className="w-full bg-transparent text-sm text-white placeholder-[#6B7280] resize-none focus:outline-none leading-relaxed"
            />

            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {pendingFiles.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#0B0D11] border border-white/10 text-xs text-[#D1D5DB]"
                  >
                    <span className="truncate max-w-[140px]">{file.name}</span>
                    <span className="text-[#6B7280] font-mono">{formatFileSize(file.size)}</span>
                    <button
                      type="button"
                      onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-[#9CA3AF] hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-3 mt-3 border-t border-white/8 relative">
              <div className="flex items-center gap-1">
                <label className="p-2 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 cursor-pointer transition-colors" title="Attach media">
                  <ImageIcon className="w-4 h-4" />
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/mp4,video/webm,audio/*"
                    onChange={handleFilePick}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  className="p-2 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 transition-colors"
                  title="Insert custom emoji"
                >
                  <Smile className="w-4 h-4" />
                </button>

                {showEmojiPicker && (
                  <div className="absolute left-0 top-12 z-30">
                    <EmojiPicker
                      globalEmojis={globalEmojis}
                      onSelect={(code) => setContent((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}:${code}: `)}
                      onClose={() => setShowEmojiPicker(false)}
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <span className="text-xs font-mono tabular-nums text-[#6B7280]">
                  {content.length}/1000
                </span>
                <button
                  type="submit"
                  data-sound-custom="true"
                  disabled={posting || (!content.trim() && pendingFiles.length === 0)}
                  className="px-4 py-1.5 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-white text-xs font-semibold transition-colors whitespace-nowrap"
                >
                  {posting ? 'Posting...' : 'Post'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>

      {error && (
        <div className="mb-4 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 px-4 py-3 text-xs text-[#FCA5A5] flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-white/70 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Posts Feed */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-44 rounded-2xl bg-[#12151C] border border-white/6 animate-pulse" />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-16 px-4 bg-[#12151C] border border-white/8 rounded-2xl">
          <p className="text-sm font-medium text-white mb-1">
            {tab === 'following' ? 'Your following feed is quiet' : 'No posts yet'}
          </p>
          <p className="text-xs text-[#9CA3AF] mb-4">
            {tab === 'following'
              ? 'Follow creators in Discover or publish your first post above.'
              : 'Be the first to share a post with the community.'}
          </p>
          {tab === 'following' && (
            <button
              type="button"
              onClick={() => setTab('discover')}
              className="px-4 py-2 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/20 text-xs font-semibold text-white"
            >
              Browse Discover Feed
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => {
            const targetId = post.repost_of ? post.repost_of.id : post.id;
            return (
              <PostCard
                key={post.id}
                post={post}
                currentUser={currentUser}
                globalEmojis={globalEmojis}
                initialComments={commentsByPost[targetId]}
                onOpenProfile={onOpenProfile}
                onOpenProfileByUsername={onOpenProfileByUsername}
                onToggleLikePost={toggleLike}
                onRepostPost={handleRepost}
                onDeletePost={handleDeletePost}
                onReplyCountDelta={handleReplyCountDelta}
              />
            );
          })}
        </div>
      )}

      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => fetchFeed(posts.length, true)}
            className="px-5 py-2 rounded-lg bg-[#12151C] border border-white/10 hover:border-white/20 text-xs font-semibold text-white transition-colors"
          >
            {loadingMore ? 'Loading...' : 'Load older posts'}
          </button>
        </div>
      )}
    </div>
  );
}
