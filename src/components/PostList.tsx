import React, { useEffect, useState } from 'react';
import { GlobalEmoji, Post, Profile } from '../types';
import { postActions } from '../lib/posts';
import { CommentNode, fetchCommentsMapForPosts, PostCard } from './PostCard';

/** A self-contained list of posts with comments, likes, reposts and delete. */
export function PostList({
  initialPosts,
  currentUser,
  globalEmojis,
  onOpenProfile,
  onOpenProfileByUsername,
  expandThreads,
}: {
  initialPosts: Post[];
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  onOpenProfile: (userId: string) => void;
  onOpenProfileByUsername: (username: string) => void;
  expandThreads?: boolean;
}) {
  const [posts, setPosts] = useState(initialPosts);
  const [comments, setComments] = useState<Record<string, CommentNode[]>>({});
  const [error, setError] = useState<string | null>(null);
  const actions = postActions(currentUser, setPosts, setError);

  useEffect(() => {
    setPosts(initialPosts);
    let cancelled = false;
    fetchCommentsMapForPosts(
      initialPosts.map((p) => p.repost_of?.id || p.id),
      currentUser.id
    ).then((map) => !cancelled && setComments(map));
    return () => {
      cancelled = true;
    };
  }, [currentUser.id, initialPosts]);

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-[#FCA5A5]">{error}</p>}
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          currentUser={currentUser}
          globalEmojis={globalEmojis}
          initialComments={comments[post.repost_of?.id || post.id]}
          expandThreads={expandThreads}
          onOpenProfile={onOpenProfile}
          onOpenProfileByUsername={onOpenProfileByUsername}
          onToggleLikePost={actions.toggleLike}
          onRepostPost={async (target) => {
            const created = await actions.repost(target);
            if (created) setError(null);
          }}
          onDeletePost={actions.remove}
          onReplyCountDelta={actions.replyCountDelta}
        />
      ))}
    </div>
  );
}
