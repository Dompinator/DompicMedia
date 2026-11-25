import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { GlobalEmoji, Post, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { hydratePostRows, POST_SELECT } from '../lib/posts';
import { PostList } from './PostList';

/** One post and its thread. Opened from notifications. */
export function PostDetailView({
  postId,
  currentUser,
  globalEmojis,
  onOpenProfile,
  onOpenProfileByUsername,
}: {
  postId: string;
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  onOpenProfile: (userId: string) => void;
  onOpenProfileByUsername: (username: string) => void;
}) {
  const [posts, setPosts] = useState<Post[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPosts(null);
    (async () => {
      const fetchOne = async (id: string) =>
        (await getSupabase().from('posts').select(POST_SELECT).eq('id', id).maybeSingle()).data as Post | null;
      let row = await fetchOne(postId);
      // A comment or reply is shown inside the post that started the thread.
      for (let depth = 0; row?.reply_to_id && depth < 3; depth++) {
        row = await fetchOne(row.reply_to_id);
      }
      const hydrated = row ? await hydratePostRows([row], currentUser.id) : [];
      if (!cancelled) setPosts(hydrated);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser.id, postId]);

  return (
    <div className="max-w-5xl mx-auto w-full px-4 py-6">
      <h2 className="font-display text-lg font-bold text-white border-b border-white/8 pb-4 mb-5">Post</h2>
      {posts === null ? (
        <div className="py-12 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-[#5B7CFA]" />
        </div>
      ) : posts.length === 0 ? (
        <p className="py-12 text-center text-sm text-[#9CA3AF]">This post is no longer available.</p>
      ) : (
        <PostList
          initialPosts={posts}
          currentUser={currentUser}
          globalEmojis={globalEmojis}
          onOpenProfile={onOpenProfile}
          onOpenProfileByUsername={onOpenProfileByUsername}
          expandThreads
        />
      )}
    </div>
  );
}
