import React, { useCallback, useEffect, useState } from 'react';
import {
  Heart,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Repeat2,
  Send,
  Smile,
  Trash2,
  X,
} from 'lucide-react';
import { GlobalEmoji, Post, PostMedia, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { categorizeMime, formatFileSize, formatRelativeTime, validateAttachmentFile } from '../lib/utils';
import { Avatar } from './Avatar';
import { EmojiPicker, RichTextWithEmojis } from './CustomEmoji';

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
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Composer state
  const [content, setContent] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [posting, setPosting] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Reply modal/drawer state
  const [activeReplyPost, setActiveReplyPost] = useState<Post | null>(null);
  const [replies, setReplies] = useState<Post[]>([]);
  const [loadingReplies, setLoadingReplies] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

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

        // Hydrate repost targets if any
        const repostIds = hydrated
          .map((p) => p.repost_of_id)
          .filter((id): id is string => Boolean(id));
        if (repostIds.length > 0) {
          const { data: origPosts } = await supabase
            .from('posts')
            .select('*, author:profiles!posts_author_id_fkey(*)')
            .in('id', repostIds);
          const origMap = new Map<string, Post>();
          for (const op of origPosts || []) {
            origMap.set(op.id as string, op as unknown as Post);
          }
          for (const p of hydrated) {
            if (p.repost_of_id) {
              p.repost_of = origMap.get(p.repost_of_id) || null;
            }
          }
        }

        setHasMore((data || []).length === PAGE_SIZE);
        setPosts((prev) => (append ? [...prev, ...hydrated] : hydrated));
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
      prev.map((p) =>
        p.id === targetId
          ? {
              ...p,
              liked_by_me: !currentlyLiked,
              likes_count: Math.max(0, p.likes_count + (currentlyLiked ? -1 : 1)),
            }
          : p
      )
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

  const openReplies = async (post: Post) => {
    setActiveReplyPost(post);
    setLoadingReplies(true);
    try {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('posts')
        .select('*, author:profiles!posts_author_id_fkey(*)')
        .eq('reply_to_id', post.id)
        .order('created_at', { ascending: true })
        .limit(50);
      setReplies((data || []) as unknown as Post[]);
    } finally {
      setLoadingReplies(false);
    }
  };

  const submitReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReplyPost || !replyText.trim()) return;
    setSendingReply(true);
    try {
      const supabase = getSupabase();
      const { data, error: repErr } = await supabase
        .from('posts')
        .insert({
          author_id: currentUser.id,
          content: replyText.trim(),
          reply_to_id: activeReplyPost.id,
        })
        .select('*, author:profiles!posts_author_id_fkey(*)')
        .single();
      if (repErr) throw repErr;

      if (activeReplyPost.author_id !== currentUser.id) {
        await supabase.from('notifications').insert({
          recipient_id: activeReplyPost.author_id,
          actor_id: currentUser.id,
          type: 'post_reply',
          entity_id: activeReplyPost.id,
          metadata: { preview: replyText.trim().slice(0, 80) },
        });
      }

      setReplies((prev) => [...prev, data as unknown as Post]);
      setPosts((prev) =>
        prev.map((p) =>
          p.id === activeReplyPost.id ? { ...p, replies_count: p.replies_count + 1 } : p
        )
      );
      setReplyText('');
    } finally {
      setSendingReply(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full px-4 py-6">
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
        className="bg-[#12151C] border border-white/8 rounded-2xl p-4 mb-6"
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
            <div key={i} className="h-32 rounded-2xl bg-[#12151C] border border-white/6 animate-pulse" />
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
        <div className="divide-y divide-white/8 bg-[#12151C] border border-white/8 rounded-2xl overflow-hidden">
          {posts.map((post) => {
            const displayPost = post.repost_of || post;
            const author = displayPost.author;
            return (
              <article key={post.id} className="p-4 hover:bg-white/[0.015] transition-colors">
                {post.repost_of && (
                  <div className="flex items-center gap-1.5 text-xs text-[#9CA3AF] mb-2 pl-12">
                    <Repeat2 className="w-3.5 h-3.5 text-[#22C55E]" />
                    <span>
                      Reposted by{' '}
                      <button
                        type="button"
                        onClick={() => onOpenProfile(post.author_id)}
                        className="text-white hover:underline font-medium"
                      >
                        {post.author?.display_name || 'User'}
                      </button>
                    </span>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => author && onOpenProfile(author.id)}
                    className="shrink-0 self-start"
                  >
                    <Avatar src={author?.avatar_url} name={author?.display_name || 'U'} size="md" />
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0 text-sm">
                        <button
                          type="button"
                          onClick={() => author && onOpenProfile(author.id)}
                          className="font-semibold text-white hover:underline truncate"
                        >
                          {author?.display_name || 'Unknown'}
                        </button>
                        <span className="text-xs text-[#9CA3AF] truncate">
                          @{author?.username || 'user'}
                        </span>
                        <span className="text-[#6B7280]" aria-hidden="true">·</span>
                        <time className="text-xs font-mono text-[#9CA3AF] whitespace-nowrap">
                          {formatRelativeTime(displayPost.created_at)}
                        </time>
                      </div>

                      {post.author_id === currentUser.id && (
                        <button
                          type="button"
                          onClick={() => handleDeletePost(post.id)}
                          title="Delete post"
                          className="p-1.5 rounded-lg text-[#6B7280] hover:text-[#EF4444] hover:bg-white/5 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {displayPost.content && (
                      <div className="text-sm text-[#E5E7EB] mb-3">
                        <RichTextWithEmojis
                          text={displayPost.content}
                          globalEmojis={globalEmojis}
                          onMentionClick={onOpenProfileByUsername}
                        />
                      </div>
                    )}

                    {displayPost.media_urls.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                        {displayPost.media_urls.map((media, idx) => (
                          <div key={idx} className="rounded-xl overflow-hidden border border-white/10 bg-[#0B0D11]">
                            {media.category === 'image' ? (
                              <img
                                src={media.url}
                                alt={media.name}
                                referrerPolicy="no-referrer"
                                className="w-full max-h-72 object-cover"
                              />
                            ) : media.category === 'video' ? (
                              <video src={media.url} controls className="w-full max-h-72" />
                            ) : media.category === 'audio' ? (
                              <div className="p-3">
                                <div className="text-xs text-[#D1D5DB] mb-1 truncate">{media.name}</div>
                                <audio src={media.url} controls className="w-full h-9" />
                              </div>
                            ) : (
                              <a
                                href={media.url}
                                target="_blank"
                                rel="noreferrer"
                                className="block p-3 text-xs text-[#5B7CFA] hover:underline truncate"
                              >
                                {media.name}
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Action Bar */}
                    <div className="flex items-center gap-6 pt-1 text-xs text-[#9CA3AF]">
                      <button
                        type="button"
                        onClick={() => openReplies(displayPost)}
                        className="inline-flex items-center gap-1.5 hover:text-[#5B7CFA] transition-colors"
                      >
                        <MessageSquare className="w-4 h-4" />
                        <span className="font-mono tabular-nums">{displayPost.replies_count}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleRepost(displayPost)}
                        className="inline-flex items-center gap-1.5 hover:text-[#22C55E] transition-colors"
                      >
                        <Repeat2 className="w-4 h-4" />
                        <span className="font-mono tabular-nums">{displayPost.reposts_count}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleLike(displayPost)}
                        className={`inline-flex items-center gap-1.5 transition-colors ${
                          displayPost.liked_by_me ? 'text-[#EF4444]' : 'hover:text-[#EF4444]'
                        }`}
                      >
                        <Heart className={`w-4 h-4 ${displayPost.liked_by_me ? 'fill-current' : ''}`} />
                        <span className="font-mono tabular-nums">{displayPost.likes_count}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </article>
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

      {/* Reply Modal */}
      {activeReplyPost && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#12151C] border border-white/10 rounded-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/8">
              <h3 className="font-display text-sm font-semibold text-white">
                Replies to @{activeReplyPost.author?.username}
              </h3>
              <button
                type="button"
                onClick={() => setActiveReplyPost(null)}
                className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-4 flex-1">
              <div className="pb-3 border-b border-white/8 text-sm text-[#D1D5DB]">
                <RichTextWithEmojis text={activeReplyPost.content} globalEmojis={globalEmojis} />
              </div>

              {loadingReplies ? (
                <div className="py-6 flex justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-[#5B7CFA]" />
                </div>
              ) : replies.length === 0 ? (
                <p className="text-xs text-[#9CA3AF] py-4 text-center">No replies yet.</p>
              ) : (
                <div className="space-y-3">
                  {replies.map((reply) => (
                    <div key={reply.id} className="flex gap-2.5">
                      <Avatar
                        src={reply.author?.avatar_url}
                        name={reply.author?.display_name || 'U'}
                        size="sm"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-white">
                            {reply.author?.display_name}
                          </span>
                          <span className="text-[#9CA3AF]">@{reply.author?.username}</span>
                          <span className="text-[#6B7280]">·</span>
                          <span className="font-mono text-[#6B7280]">
                            {formatRelativeTime(reply.created_at)}
                          </span>
                        </div>
                        <div className="text-sm text-[#E5E7EB] mt-0.5">
                          <RichTextWithEmojis text={reply.content} globalEmojis={globalEmojis} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <form onSubmit={submitReply} className="p-3 border-t border-white/8 flex items-center gap-2">
              <input
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Write a reply..."
                maxLength={1000}
                className="flex-1 rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white placeholder-[#6B7280] focus:outline-none focus:border-[#5B7CFA]"
              />
              <button
                type="submit"
                disabled={sendingReply || !replyText.trim()}
                className="p-2.5 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-white"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
