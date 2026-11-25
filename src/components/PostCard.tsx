import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Flag,
  Heart,
  Loader2,
  MessageSquare,
  Repeat2,
  Send,
  Trash2,
} from 'lucide-react';
import { GlobalEmoji, Post, PostMedia, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { formatRelativeTime } from '../lib/utils';
import { playSound } from '../lib/sounds';
import { Avatar } from './Avatar';
import { RichTextWithEmojis } from './CustomEmoji';
import { MentionInput } from './MentionInput';
import { SongPlayer } from './SongPlayer';
import { sendNotification } from '../lib/notifications';
import { useAppActions } from '../lib/appContext';

export interface CommentNode extends Post {
  replies: Post[];
}

export async function fetchCommentsMapForPosts(
  postIds: string[],
  currentUserId: string
): Promise<Record<string, CommentNode[]>> {
  const result: Record<string, CommentNode[]> = {};
  if (postIds.length === 0) return result;

  const supabase = getSupabase();
  const { data: topRaw } = await supabase
    .from('posts')
    .select('*, author:profiles!posts_author_id_fkey(*)')
    .in('reply_to_id', postIds)
    .order('created_at', { ascending: true })
    .limit(200);

  const topComments = (topRaw || []) as unknown as Post[];
  if (topComments.length === 0) return result;

  const commentIds = topComments.map((c) => c.id);
  const { data: nestedRaw } = await supabase
    .from('posts')
    .select('*, author:profiles!posts_author_id_fkey(*)')
    .in('reply_to_id', commentIds)
    .order('created_at', { ascending: true })
    .limit(300);

  const nestedReplies = (nestedRaw || []) as unknown as Post[];
  const allCommentIds = [...commentIds, ...nestedReplies.map((r) => r.id)];

  const { data: likesRaw } = await supabase
    .from('post_likes')
    .select('post_id')
    .eq('user_id', currentUserId)
    .in('post_id', allCommentIds);

  const likedSet = new Set((likesRaw || []).map((l) => l.post_id as string));

  const nestedByParent = new Map<string, Post[]>();
  for (const r of nestedReplies) {
    if (!r.reply_to_id) continue;
    const list = nestedByParent.get(r.reply_to_id) || [];
    list.push({
      ...r,
      media_urls: Array.isArray(r.media_urls) ? (r.media_urls as PostMedia[]) : [],
      liked_by_me: likedSet.has(r.id),
    });
    nestedByParent.set(r.reply_to_id, list);
  }

  for (const c of topComments) {
    if (!c.reply_to_id) continue;
    const node: CommentNode = {
      ...c,
      media_urls: Array.isArray(c.media_urls) ? (c.media_urls as PostMedia[]) : [],
      liked_by_me: likedSet.has(c.id),
      replies: nestedByParent.get(c.id) || [],
    };
    const arr = result[c.reply_to_id] || [];
    arr.push(node);
    result[c.reply_to_id] = arr;
  }

  return result;
}

interface PostCardProps {
  post: Post;
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  initialComments?: CommentNode[];
  expandThreads?: boolean;
  onOpenProfile: (userId: string) => void;
  onOpenProfileByUsername: (username: string) => void;
  onToggleLikePost: (post: Post) => void;
  onRepostPost?: (post: Post) => void;
  onDeletePost?: (postId: string) => void;
  onReplyCountDelta?: (postId: string, delta: number) => void;
}

export function PostCard({
  post,
  currentUser,
  globalEmojis,
  initialComments,
  expandThreads,
  onOpenProfile,
  onOpenProfileByUsername,
  onToggleLikePost,
  onRepostPost,
  onDeletePost,
  onReplyCountDelta,
}: PostCardProps) {
  const displayPost = post.repost_of || post;
  const author = displayPost.author;
  const isSong = Boolean(displayPost.song_title);
  // The song player shows the sound file and cover art itself.
  const songCover = isSong ? displayPost.media_urls.find((m) => m.category === 'image') : undefined;
  const songAudio = isSong ? displayPost.media_urls.find((m) => m.category === 'audio') : undefined;
  const otherMedia = displayPost.media_urls.filter((m) => m !== songCover && m !== songAudio);
  const { report } = useAppActions();
  const [commentError, setCommentError] = useState<string | null>(null);

  const [comments, setComments] = useState<CommentNode[]>(initialComments || []);
  const [commentText, setCommentText] = useState('');
  const [commentFocused, setCommentFocused] = useState(false);
  const [submittingComment, setSubmittingComment] = useState(false);

  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({});
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
  const [nestedReplyText, setNestedReplyText] = useState('');
  const [submittingNested, setSubmittingNested] = useState(false);

  const commentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialComments) {
      setComments(initialComments);
    }
  }, [initialComments]);

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = commentText.trim();
    if (!trimmed) return;
    setSubmittingComment(true);
    setCommentError(null);
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('posts')
        .insert({
          author_id: currentUser.id,
          content: trimmed,
          reply_to_id: displayPost.id,
        })
        .select('*, author:profiles!posts_author_id_fkey(*)')
        .single();
      if (error) {
        setCommentError('Could not post your comment.');
        return;
      }

      playSound('post');

      if (displayPost.author_id !== currentUser.id) {
        await sendNotification({
          recipient_id: displayPost.author_id,
          actor_id: currentUser.id,
          type: 'post_reply',
          entity_id: displayPost.id,
          metadata: { preview: trimmed.slice(0, 80) },
        });
      }

      const newComment: CommentNode = {
        ...(data as unknown as Post),
        media_urls: [],
        liked_by_me: false,
        replies: [],
      };
      setComments((prev) => [...prev, newComment]);
      onReplyCountDelta?.(displayPost.id, 1);
      setCommentText('');
      setCommentFocused(false);
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleSubmitNestedReply = async (e: React.FormEvent, parentComment: CommentNode) => {
    e.preventDefault();
    const trimmed = nestedReplyText.trim();
    if (!trimmed) return;
    setSubmittingNested(true);
    setCommentError(null);
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('posts')
        .insert({
          author_id: currentUser.id,
          content: trimmed,
          reply_to_id: parentComment.id,
        })
        .select('*, author:profiles!posts_author_id_fkey(*)')
        .single();
      if (error) {
        setCommentError('Could not post your comment.');
        return;
      }

      playSound('post');

      if (parentComment.author_id !== currentUser.id) {
        await sendNotification({
          recipient_id: parentComment.author_id,
          actor_id: currentUser.id,
          type: 'post_reply',
          entity_id: displayPost.id,
          metadata: { preview: trimmed.slice(0, 80) },
        });
      }

      const newReply: Post = {
        ...(data as unknown as Post),
        media_urls: [],
        liked_by_me: false,
      };
      setComments((prev) =>
        prev.map((c) =>
          c.id === parentComment.id
            ? { ...c, replies_count: c.replies_count + 1, replies: [...c.replies, newReply] }
            : c
        )
      );
      setExpandedThreads((prev) => ({ ...prev, [parentComment.id]: true }));
      setNestedReplyText('');
      setReplyingToCommentId(null);
    } finally {
      setSubmittingNested(false);
    }
  };

  const toggleCommentLike = async (target: Post, parentCommentId?: string) => {
    const supabase = getSupabase();
    const wasLiked = Boolean(target.liked_by_me);
    if (!wasLiked) {
      playSound('like');
    }

    setComments((prev) =>
      prev.map((c) => {
        if (!parentCommentId && c.id === target.id) {
          return {
            ...c,
            liked_by_me: !wasLiked,
            likes_count: Math.max(0, c.likes_count + (wasLiked ? -1 : 1)),
          };
        }
        if (parentCommentId && c.id === parentCommentId) {
          return {
            ...c,
            replies: c.replies.map((r) =>
              r.id === target.id
                ? {
                    ...r,
                    liked_by_me: !wasLiked,
                    likes_count: Math.max(0, r.likes_count + (wasLiked ? -1 : 1)),
                  }
                : r
            ),
          };
        }
        return c;
      })
    );

    if (wasLiked) {
      await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', target.id)
        .eq('user_id', currentUser.id);
    } else {
      await supabase.from('post_likes').insert({ post_id: target.id, user_id: currentUser.id });
    }
  };

  const deleteCommentOrReply = async (targetId: string, parentCommentId?: string) => {
    const { error } = await getSupabase().from('posts').delete().eq('id', targetId);
    if (error) return;
    if (!parentCommentId) {
      setComments((prev) => prev.filter((c) => c.id !== targetId));
      onReplyCountDelta?.(displayPost.id, -1);
    } else {
      setComments((prev) =>
        prev.map((c) =>
          c.id === parentCommentId
            ? {
                ...c,
                replies_count: Math.max(0, c.replies_count - 1),
                replies: c.replies.filter((r) => r.id !== targetId),
              }
            : c
        )
      );
    }
  };

  return (
    <article className="bg-[#12151C] border border-white/8 rounded-2xl p-4 sm:p-5 hover:border-white/14 transition-colors">
      <div className="flex flex-col lg:flex-row gap-5">
        {/* Left: Main Post Content + Bottom Action Bar (Like Left, Reply Middle, Repost Right) */}
        <div className="flex-1 min-w-0 flex flex-col justify-between">
          <div>
            {post.repost_of && (
              <div className="flex items-center gap-1.5 text-xs text-[#9CA3AF] mb-2.5 pl-12">
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
                <div className="flex items-center gap-2 min-w-0 text-sm mb-1.5">
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
                  <span className="text-[#6B7280]" aria-hidden="true">
                    ·
                  </span>
                  <time className="text-xs font-mono text-[#9CA3AF] whitespace-nowrap">
                    {formatRelativeTime(displayPost.created_at)}
                  </time>
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

                {isSong && <SongPlayer key={displayPost.id} post={displayPost} />}

                {otherMedia.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                    {otherMedia.map((media, idx) => (
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
              </div>
            </div>
          </div>

          {/* Action Bar: Like (Left) · Reply (Middle) · Repost (Right) */}
          <div className="flex items-center justify-between pt-3 mt-2 border-t border-white/8 pl-12 text-xs text-[#9CA3AF]">
            <button
              type="button"
              data-sound-custom="true"
              onClick={() => {
                if (!displayPost.liked_by_me) {
                  playSound('like');
                }
                onToggleLikePost(displayPost);
              }}
              className={`inline-flex items-center gap-1.5 transition-colors ${
                displayPost.liked_by_me ? 'text-[#EF4444]' : 'hover:text-[#EF4444]'
              }`}
            >
              <Heart className={`w-4 h-4 ${displayPost.liked_by_me ? 'fill-current' : ''}`} />
              <span className="font-mono tabular-nums">{displayPost.likes_count}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCommentFocused(true);
                commentInputRef.current?.focus();
              }}
              className="inline-flex items-center gap-1.5 hover:text-[#5B7CFA] transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
              <span className="font-mono tabular-nums">{comments.length || displayPost.replies_count}</span>
            </button>

            {onRepostPost ? (
              <button
                type="button"
                onClick={() => onRepostPost(displayPost)}
                className="inline-flex items-center gap-1.5 hover:text-[#22C55E] transition-colors"
              >
                <Repeat2 className="w-4 h-4" />
                <span className="font-mono tabular-nums">{displayPost.reposts_count}</span>
              </button>
            ) : (
              <div className="inline-flex items-center gap-1.5 text-[#6B7280]">
                <Repeat2 className="w-4 h-4" />
                <span className="font-mono tabular-nums">{displayPost.reposts_count}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Delete Button at Top-Right + YouTube-Style Comments & Replies Underneath */}
        <div className="w-full lg:w-[370px] xl:w-[400px] shrink-0 border-t lg:border-t-0 lg:border-l border-white/8 pt-4 lg:pt-0 lg:pl-5 flex flex-col">
          {/* Header Row with Delete Button on top right */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="text-xs font-semibold text-white">
              Comments{' '}
              <span className="font-mono tabular-nums text-[#9CA3AF]">
                {comments.length}
              </span>
            </span>

            {post.author_id !== currentUser.id && (
              <button
                type="button"
                onClick={() => report('post', displayPost.id)}
                title="Report post"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-[#9CA3AF] hover:text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
              >
                <Flag className="w-3.5 h-3.5" />
                <span>Report</span>
              </button>
            )}

            {post.author_id === currentUser.id && onDeletePost && (
              <button
                type="button"
                onClick={() => onDeletePost(post.id)}
                title="Delete post"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-[#9CA3AF] hover:text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            )}
          </div>

          {/* Add a Comment (YouTube style) */}
          <form onSubmit={handleSubmitComment} className="mb-3">
            <div className="flex items-center gap-2.5">
              <Avatar src={currentUser.avatar_url} name={currentUser.display_name} size="xs" />
              <MentionInput
                inputRef={commentInputRef}
                wrapperClassName="flex-1"
                type="text"
                value={commentText}
                onFocus={() => setCommentFocused(true)}
                onValueChange={setCommentText}
                placeholder="Add a comment..."
                maxLength={1000}
                className="w-full bg-transparent border-b border-white/15 focus:border-[#5B7CFA] py-1.5 text-xs text-white placeholder-[#6B7280] focus:outline-none transition-colors"
              />
            </div>

            {(commentFocused || commentText.trim().length > 0) && (
              <div className="flex items-center justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setCommentText('');
                    setCommentFocused(false);
                  }}
                  className="px-2.5 py-1 rounded-full text-[11px] text-[#9CA3AF] hover:text-white hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-sound-custom="true"
                  disabled={submittingComment || !commentText.trim()}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-[11px] font-semibold text-white"
                >
                  {submittingComment ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <span>Comment</span>
                  )}
                </button>
              </div>
            )}
          </form>

          {commentError && <p className="mb-2 text-[11px] text-[#FCA5A5]">{commentError}</p>}

          {/* Comments + Collapsible Nested Replies */}
          <div className="flex-1 max-h-[300px] overflow-y-auto space-y-3.5 pr-1">
            {comments.length === 0 ? (
              <p className="text-[11px] text-[#6B7280] py-2">
                No comments yet. Be the first to comment.
              </p>
            ) : (
              comments.map((comment) => {
                const isExpanded = expandedThreads[comment.id] ?? Boolean(expandThreads);
                const replyCount = comment.replies.length;
                return (
                  <div key={comment.id} className="space-y-2">
                    <div className="flex gap-2.5 items-start group">
                      <button
                        type="button"
                        onClick={() => comment.author && onOpenProfile(comment.author.id)}
                        className="shrink-0 mt-0.5"
                      >
                        <Avatar
                          src={comment.author?.avatar_url}
                          name={comment.author?.display_name || 'U'}
                          size="xs"
                        />
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0 text-[11px]">
                            <button
                              type="button"
                              onClick={() => comment.author && onOpenProfile(comment.author.id)}
                              className="font-semibold text-white hover:underline truncate"
                            >
                              @{comment.author?.username || 'user'}
                            </button>
                            <span className="text-[#6B7280] font-mono shrink-0">
                              {formatRelativeTime(comment.created_at)}
                            </span>
                          </div>

                          {comment.author_id !== currentUser.id && (
                            <button
                              type="button"
                              onClick={() => report('post', comment.id)}
                              title="Report comment"
                              className="p-1 rounded text-[#6B7280] hover:text-[#EF4444]"
                            >
                              <Flag className="w-3 h-3" />
                            </button>
                          )}

                          {comment.author_id === currentUser.id && (
                            <button
                              type="button"
                              onClick={() => deleteCommentOrReply(comment.id)}
                              title="Delete comment"
                              className="opacity-0 group-hover:opacity-100 p-1 rounded text-[#6B7280] hover:text-[#EF4444] transition-opacity"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>

                        <div className="text-xs text-[#E5E7EB] mt-0.5 leading-relaxed">
                          <RichTextWithEmojis
                            text={comment.content}
                            globalEmojis={globalEmojis}
                            onMentionClick={onOpenProfileByUsername}
                          />
                        </div>

                        {/* YouTube-style Comment Actions: Like + Reply */}
                        <div className="flex items-center gap-4 mt-1 text-[11px] text-[#9CA3AF]">
                          <button
                            type="button"
                            data-sound-custom="true"
                            onClick={() => toggleCommentLike(comment)}
                            className={`inline-flex items-center gap-1 transition-colors ${
                              comment.liked_by_me ? 'text-[#EF4444]' : 'hover:text-white'
                            }`}
                          >
                            <Heart className={`w-3 h-3 ${comment.liked_by_me ? 'fill-current' : ''}`} />
                            {comment.likes_count > 0 && (
                              <span className="font-mono tabular-nums">{comment.likes_count}</span>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              if (replyingToCommentId === comment.id) {
                                setReplyingToCommentId(null);
                              } else {
                                setReplyingToCommentId(comment.id);
                                setNestedReplyText('');
                              }
                            }}
                            className="font-semibold hover:text-white transition-colors"
                          >
                            Reply
                          </button>
                        </div>

                        {/* Inline Nested Reply Box */}
                        {replyingToCommentId === comment.id && (
                          <form
                            onSubmit={(e) => handleSubmitNestedReply(e, comment)}
                            className="mt-2 space-y-1.5"
                          >
                            <div className="flex items-center gap-2">
                              <Avatar
                                src={currentUser.avatar_url}
                                name={currentUser.display_name}
                                size="xs"
                              />
                              <MentionInput
                                wrapperClassName="flex-1"
                                type="text"
                                autoFocus
                                value={nestedReplyText}
                                onValueChange={setNestedReplyText}
                                placeholder={`Reply to @${comment.author?.username || 'user'}...`}
                                maxLength={1000}
                                className="w-full bg-transparent border-b border-white/15 focus:border-[#5B7CFA] py-1 text-xs text-white placeholder-[#6B7280] focus:outline-none"
                              />
                            </div>
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setReplyingToCommentId(null)}
                                className="px-2 py-0.5 text-[11px] text-[#9CA3AF] hover:text-white"
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                data-sound-custom="true"
                                disabled={submittingNested || !nestedReplyText.trim()}
                                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#5B7CFA] hover:bg-[#4B6CF0] disabled:opacity-40 text-[11px] font-semibold text-white"
                              >
                                {submittingNested ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <>
                                    <Send className="w-2.5 h-2.5" />
                                    <span>Reply</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </form>
                        )}

                        {/* YouTube-style "▾ N replies" Toggle */}
                        {replyCount > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedThreads((prev) => ({
                                ...prev,
                                [comment.id]: !isExpanded,
                              }))
                            }
                            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#7C96FF] hover:text-[#93C5FD] transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                            </span>
                          </button>
                        )}

                        {/* Expanded Nested Replies */}
                        {isExpanded && replyCount > 0 && (
                          <div className="mt-2 pl-3 border-l border-white/10 space-y-2.5">
                            {comment.replies.map((reply) => (
                              <div key={reply.id} className="flex gap-2 items-start group/reply">
                                <button
                                  type="button"
                                  onClick={() => reply.author && onOpenProfile(reply.author.id)}
                                  className="shrink-0 mt-0.5"
                                >
                                  <Avatar
                                    src={reply.author?.avatar_url}
                                    name={reply.author?.display_name || 'U'}
                                    size="xs"
                                  />
                                </button>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1.5 min-w-0 text-[11px]">
                                      <button
                                        type="button"
                                        onClick={() => reply.author && onOpenProfile(reply.author.id)}
                                        className="font-semibold text-white hover:underline truncate"
                                      >
                                        @{reply.author?.username || 'user'}
                                      </button>
                                      <span className="text-[#6B7280] font-mono shrink-0">
                                        {formatRelativeTime(reply.created_at)}
                                      </span>
                                    </div>
                                    {reply.author_id !== currentUser.id && (
                                      <button
                                        type="button"
                                        onClick={() => report('post', reply.id)}
                                        title="Report reply"
                                        className="p-0.5 rounded text-[#6B7280] hover:text-[#EF4444]"
                                      >
                                        <Flag className="w-3 h-3" />
                                      </button>
                                    )}
                                    {reply.author_id === currentUser.id && (
                                      <button
                                        type="button"
                                        onClick={() => deleteCommentOrReply(reply.id, comment.id)}
                                        title="Delete reply"
                                        className="opacity-0 group-hover/reply:opacity-100 p-0.5 rounded text-[#6B7280] hover:text-[#EF4444] transition-opacity"
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                  <div className="text-xs text-[#E5E7EB] mt-0.5 leading-relaxed">
                                    <RichTextWithEmojis
                                      text={reply.content}
                                      globalEmojis={globalEmojis}
                                      onMentionClick={onOpenProfileByUsername}
                                    />
                                  </div>
                                  <div className="flex items-center gap-3 mt-1 text-[11px] text-[#9CA3AF]">
                                    <button
                                      type="button"
                                      data-sound-custom="true"
                                      onClick={() => toggleCommentLike(reply, comment.id)}
                                      className={`inline-flex items-center gap-1 transition-colors ${
                                        reply.liked_by_me ? 'text-[#EF4444]' : 'hover:text-white'
                                      }`}
                                    >
                                      <Heart
                                        className={`w-3 h-3 ${reply.liked_by_me ? 'fill-current' : ''}`}
                                      />
                                      {reply.likes_count > 0 && (
                                        <span className="font-mono tabular-nums">{reply.likes_count}</span>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setReplyingToCommentId(comment.id);
                                        setNestedReplyText(
                                          reply.author?.username ? `@${reply.author.username} ` : ''
                                        );
                                      }}
                                      className="font-semibold hover:text-white"
                                    >
                                      Reply
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
