import React, { useCallback, useEffect, useState } from 'react';
import {
  Image as ImageIcon,
  Music,
  Smile,
  X,
} from 'lucide-react';
import { GlobalEmoji, Post, PostMedia, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { categorizeMime, formatFileSize, validateAttachmentFile } from '../lib/utils';
import { AUDIO_ACCEPT, formatDuration, MAX_SONG_BYTES, probeAudio, withResolvedType } from '../lib/audio';
import { hydratePostRows, POST_SELECT, postActions } from '../lib/posts';
import { MentionInput } from './MentionInput';
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

  // Song Post state
  const [songMode, setSongMode] = useState(false);
  const [songTitle, setSongTitle] = useState('');
  const [song, setSong] = useState<{ file: File; duration: number } | null>(null);
  const [songCover, setSongCover] = useState<File | null>(null);

  const hydratePosts = useCallback(
    (rawPosts: unknown[]) => hydratePostRows(rawPosts, currentUser.id),
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
    e.target.value = '';
    for (const f of files) {
      const err = validateAttachmentFile(f);
      if (err) {
        setError(err);
        return;
      }
    }
    setPendingFiles((prev) => [...prev, ...files].slice(0, 4));
  };

  const handleSongPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    setError(null);
    const file = withResolvedType(picked);
    if (!file.type.startsWith('audio/')) {
      setError('Choose a sound file for a Song Post.');
      return;
    }
    if (file.size <= 0 || file.size > MAX_SONG_BYTES) {
      setError('Songs must be 50 MB or smaller.');
      return;
    }
    const duration = await probeAudio(file);
    if (duration === null) {
      setError('This browser cannot play that format. Try MP3, WAV, OGG, M4A or FLAC.');
      return;
    }
    setSong({ file, duration });
    setSongTitle((prev) => prev || file.name.replace(/\.[^.]+$/, '').slice(0, 100));
  };

  const clearSong = () => {
    setSongMode(false);
    setSong(null);
    setSongCover(null);
    setSongTitle('');
  };

  const canPost = songMode
    ? Boolean(song && songTitle.trim())
    : Boolean(content.trim() || pendingFiles.length > 0);

  const handleCreatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true);
    setError(null);
    const uploadedPaths: string[] = [];

    try {
      const supabase = getSupabase();
      const uploadedMedia: PostMedia[] = [];
      const files = songMode ? [song!.file, ...(songCover ? [songCover] : [])] : pendingFiles;

      for (const original of files) {
        const file = withResolvedType(original);
        const ext = file.name.split('.').pop() || 'bin';
        const storagePath = `${currentUser.id}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('post-media')
          .upload(storagePath, file, { contentType: file.type });
        if (upErr) throw upErr;
        uploadedPaths.push(storagePath);

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
          ...(songMode
            ? { song_title: songTitle.trim(), song_duration: Math.round(song!.duration) }
            : {}),
        })
        .select(POST_SELECT)
        .single();

      if (insErr) throw insErr;

      playSound('post');

      const [hydrated] = await hydratePosts([inserted]);
      setPosts((prev) => (prev.some((p) => p.id === hydrated.id) ? prev : [hydrated, ...prev]));
      setContent('');
      setPendingFiles([]);
      clearSong();
      setShowEmojiPicker(false);
    } catch (err) {
      // Don't leave files behind for a post that was never created.
      if (uploadedPaths.length > 0) {
        await getSupabase().storage.from('post-media').remove(uploadedPaths);
      }
      const message = (err as { message?: string })?.message;
      setError(message || 'Failed to publish post.');
    } finally {
      setPosting(false);
    }
  };

  const actions = postActions(currentUser, setPosts, setError);

  const handleRepost = async (post: Post) => {
    const created = await actions.repost(post);
    if (created) setPosts((prev) => [created, ...prev]);
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
            {songMode && (
              <div className="mb-3 rounded-xl border border-[#5B7CFA]/40 bg-[#0B0D11] p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#7C96FF]">
                    <Music className="w-4 h-4" /> Song Post
                  </span>
                  <button type="button" onClick={clearSong} aria-label="Cancel Song Post" className="text-[#9CA3AF] hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <input
                  type="text"
                  value={songTitle}
                  maxLength={100}
                  onChange={(e) => setSongTitle(e.target.value)}
                  placeholder="Song title"
                  aria-label="Song title"
                  className="w-full rounded-lg bg-[#12151C] border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
                />
                <div className="flex flex-wrap gap-2 text-xs">
                  <label className="px-3 py-2 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] text-white font-semibold cursor-pointer">
                    {song ? 'Change sound file' : 'Upload sound file'}
                    <input type="file" accept={AUDIO_ACCEPT} onChange={handleSongPick} className="hidden" />
                  </label>
                  <label className="px-3 py-2 rounded-lg bg-[#181C25] border border-white/10 text-[#D1D5DB] cursor-pointer">
                    {songCover ? 'Change cover' : 'Add cover art (optional)'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (!f) return;
                        const err = f.type.startsWith('image/') ? validateAttachmentFile(f) : 'Cover art must be an image.';
                        if (err) setError(err);
                        else setSongCover(f);
                      }}
                      className="hidden"
                    />
                  </label>
                </div>
                {song && (
                  <p className="text-xs text-[#9CA3AF] truncate">
                    {song.file.name} · {formatDuration(song.duration)} · {formatFileSize(song.file.size)}
                  </p>
                )}
                {songCover && <p className="text-xs text-[#9CA3AF] truncate">Cover: {songCover.name}</p>}
              </div>
            )}

            <MentionInput
              multiline
              rows={songMode ? 2 : 3}
              value={content}
              onValueChange={setContent}
              maxLength={1000}
              placeholder={songMode ? 'Say something about your song (optional)...' : 'Share an update, thought, or :emoji:...'}
              className="w-full bg-transparent text-sm text-white placeholder-[#6B7280] resize-none focus:outline-none leading-relaxed"
            />

            {!songMode && pendingFiles.length > 0 && (
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
                {!songMode && (
                  <label className="p-2 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 cursor-pointer transition-colors" title="Attach images, video or sound files">
                    <ImageIcon className="w-4 h-4" />
                    <input
                      type="file"
                      multiple
                      accept={`image/*,video/mp4,video/webm,${AUDIO_ACCEPT}`}
                      onChange={handleFilePick}
                      className="hidden"
                    />
                  </label>
                )}

                <button
                  type="button"
                  onClick={() => (songMode ? clearSong() : setSongMode(true))}
                  aria-pressed={songMode}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                    songMode ? 'bg-[#5B7CFA]/20 text-[#7C96FF]' : 'text-[#9CA3AF] hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Music className="w-4 h-4" />
                  <span>Song Post</span>
                </button>

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
                  disabled={posting || !canPost}
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
                onToggleLikePost={actions.toggleLike}
                onRepostPost={handleRepost}
                onDeletePost={actions.remove}
                onReplyCountDelta={actions.replyCountDelta}
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
