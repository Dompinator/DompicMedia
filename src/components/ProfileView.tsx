import React, { useCallback, useEffect, useState } from 'react';
import {
  Camera,
  Check,
  Edit3,
  Loader2,
  Mail,
  UserCheck,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { DmPrivacy, FriendRequest, FriendRequestPrivacy, GlobalEmoji, Post, PostMedia, Profile } from '../types';
import { getSupabase } from '../lib/supabase';
import { Avatar } from './Avatar';
import { CommentNode, fetchCommentsMapForPosts, PostCard } from './PostCard';

interface ProfileViewProps {
  profileId: string;
  currentUser: Profile;
  globalEmojis: GlobalEmoji[];
  onProfileUpdated: (updated: Profile) => void;
  onStartDm: (conversationId: string) => void;
  onOpenProfile: (userId: string) => void;
}

export function ProfileView({
  profileId,
  currentUser,
  globalEmojis,
  onProfileUpdated,
  onStartDm,
  onOpenProfile,
}: ProfileViewProps) {
  const isOwn = profileId === currentUser.id;
  const [profile, setProfile] = useState<Profile | null>(isOwn ? currentUser : null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, CommentNode[]>>({});
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [friendsCount, setFriendsCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isFriend, setIsFriend] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<FriendRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit Profile Modal
  const [editing, setEditing] = useState(false);
  const [editDisplay, setEditDisplay] = useState('');
  const [editBio, setEditBio] = useState('');
  const [editDmPrivacy, setEditDmPrivacy] = useState<DmPrivacy>('everyone');
  const [editFrPrivacy, setEditFrPrivacy] = useState<FriendRequestPrivacy>('everyone');
  const [saving, setSaving] = useState(false);

  const loadProfileData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const { data: prof, error: profErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', profileId)
        .single();
      if (profErr) throw profErr;
      setProfile(prof as Profile);

      const [followersRes, followingRes, friendsARes, friendsBRes, postsRes] = await Promise.all([
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', profileId),
        supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', profileId),
        supabase.from('friendships').select('*', { count: 'exact', head: true }).eq('user_a', profileId),
        supabase.from('friendships').select('*', { count: 'exact', head: true }).eq('user_b', profileId),
        supabase
          .from('posts')
          .select('*, author:profiles!posts_author_id_fkey(*)')
          .eq('author_id', profileId)
          .is('reply_to_id', null)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      const rawPosts = (postsRes.data || []) as Array<Record<string, unknown>>;
      const postIds = rawPosts.map((p) => p.id as string);
      let likedSet = new Set<string>();
      if (postIds.length > 0) {
        const { data: myLikes } = await supabase
          .from('post_likes')
          .select('post_id')
          .eq('user_id', currentUser.id)
          .in('post_id', postIds);
        likedSet = new Set((myLikes || []).map((l) => l.post_id as string));
      }

      const hydratedPosts = rawPosts.map((r) => ({
        ...(r as unknown as Post),
        media_urls: Array.isArray(r.media_urls) ? (r.media_urls as PostMedia[]) : [],
        liked_by_me: likedSet.has(r.id as string),
      }));

      setFollowersCount(followersRes.count || 0);
      setFollowingCount(followingRes.count || 0);
      setFriendsCount((friendsARes.count || 0) + (friendsBRes.count || 0));
      setPosts(hydratedPosts);
      setCommentsByPost(await fetchCommentsMapForPosts(postIds, currentUser.id));

      if (!isOwn) {
        const uA = currentUser.id < profileId ? currentUser.id : profileId;
        const uB = currentUser.id < profileId ? profileId : currentUser.id;
        const [fCheck, frCheck, reqCheck] = await Promise.all([
          supabase
            .from('follows')
            .select('follower_id')
            .eq('follower_id', currentUser.id)
            .eq('following_id', profileId)
            .maybeSingle(),
          supabase
            .from('friendships')
            .select('user_a')
            .eq('user_a', uA)
            .eq('user_b', uB)
            .maybeSingle(),
          supabase
            .from('friend_requests')
            .select('*')
            .eq('status', 'pending')
            .or(
              `and(sender_id.eq.${currentUser.id},receiver_id.eq.${profileId}),and(sender_id.eq.${profileId},receiver_id.eq.${currentUser.id})`
            )
            .maybeSingle(),
        ]);
        setIsFollowing(Boolean(fCheck.data));
        setIsFriend(Boolean(frCheck.data));
        setPendingRequest((reqCheck.data as FriendRequest) || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile.');
    } finally {
      setLoading(false);
    }
  }, [currentUser.id, isOwn, profileId]);

  useEffect(() => {
    loadProfileData();
  }, [loadProfileData]);

  const toggleFollow = async () => {
    if (isOwn) return;
    const supabase = getSupabase();
    if (isFollowing) {
      await supabase
        .from('follows')
        .delete()
        .eq('follower_id', currentUser.id)
        .eq('following_id', profileId);
      setIsFollowing(false);
      setFollowersCount((c) => Math.max(0, c - 1));
    } else {
      const { error: insErr } = await supabase
        .from('follows')
        .insert({ follower_id: currentUser.id, following_id: profileId });
      if (!insErr) {
        setIsFollowing(true);
        setFollowersCount((c) => c + 1);
      }
    }
  };

  const sendFriendRequest = async () => {
    setError(null);
    const supabase = getSupabase();
    const { data, error: reqErr } = await supabase
      .from('friend_requests')
      .insert({ sender_id: currentUser.id, receiver_id: profileId })
      .select('*')
      .single();
    if (reqErr) {
      setError(reqErr.message);
      return;
    }
    setPendingRequest(data as FriendRequest);
    await supabase.from('notifications').upsert(
      {
        recipient_id: profileId,
        actor_id: currentUser.id,
        type: 'friend_request',
        entity_id: data.id,
        dedupe_key: `friend_req_${data.id}`,
      },
      { onConflict: 'recipient_id,dedupe_key', ignoreDuplicates: true }
    );
  };

  const acceptIncomingRequest = async () => {
    if (!pendingRequest) return;
    const supabase = getSupabase();
    const { error: rpcErr } = await supabase.rpc('accept_friend_request', {
      p_request_id: pendingRequest.id,
    });
    if (!rpcErr) {
      setPendingRequest(null);
      setIsFriend(true);
      setFriendsCount((c) => c + 1);
    }
  };

  const removeFriend = async () => {
    const supabase = getSupabase();
    const uA = currentUser.id < profileId ? currentUser.id : profileId;
    const uB = currentUser.id < profileId ? profileId : currentUser.id;
    await supabase.from('friendships').delete().eq('user_a', uA).eq('user_b', uB);
    setIsFriend(false);
    setFriendsCount((c) => Math.max(0, c - 1));
  };

  const handleMessageUser = async () => {
    setError(null);
    try {
      const supabase = getSupabase();
      const { data: convoId, error: rpcErr } = await supabase.rpc(
        'get_or_create_dm_conversation',
        { p_target_user_id: profileId }
      );
      if (rpcErr) throw rpcErr;
      onStartDm(convoId as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot message this user.');
    }
  };

  const handleImageUpload = async (file: File, kind: 'avatar' | 'banner') => {
    if (!isOwn) return;
    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file.');
      return;
    }
    const bucket = kind === 'avatar' ? 'avatars' : 'banners';
    const ext = file.name.split('.').pop() || 'png';
    const path = `${currentUser.id}/${kind}_${Date.now()}.${ext}`;
    const supabase = getSupabase();

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(path, file, { contentType: file.type, upsert: true });
    if (upErr) {
      setError(upErr.message);
      return;
    }
    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
    const column = kind === 'avatar' ? 'avatar_url' : 'banner_url';
    const { data: updated, error: updErr } = await supabase
      .from('profiles')
      .update({ [column]: pub.publicUrl })
      .eq('id', currentUser.id)
      .select('*')
      .single();
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setProfile(updated as Profile);
    onProfileUpdated(updated as Profile);
  };

  const openEditModal = () => {
    if (!profile) return;
    setEditDisplay(profile.display_name);
    setEditBio(profile.bio);
    setEditDmPrivacy(profile.dm_privacy);
    setEditFrPrivacy(profile.friend_request_privacy);
    setEditing(true);
  };

  const saveProfileChanges = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwn) return;
    setSaving(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const { data, error: updErr } = await supabase
        .from('profiles')
        .update({
          display_name: editDisplay.trim(),
          bio: editBio.trim(),
          dm_privacy: editDmPrivacy,
          friend_request_privacy: editFrPrivacy,
        })
        .eq('id', currentUser.id)
        .select('*')
        .single();
      if (updErr) throw updErr;
      setProfile(data as Profile);
      onProfileUpdated(data as Profile);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto w-full px-4 py-12 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[#5B7CFA]" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="max-w-3xl mx-auto w-full px-4 py-12 text-center text-sm text-[#9CA3AF]">
        Profile not found.
      </div>
    );
  }

  const openProfileByUsername = async (username: string) => {
    const { data } = await getSupabase()
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase())
      .maybeSingle();
    if (data?.id) {
      onOpenProfile(data.id as string);
    }
  };

  const toggleLikePost = async (target: Post) => {
    const supabase = getSupabase();
    const currentlyLiked = Boolean(target.liked_by_me);
    setPosts((prev) =>
      prev.map((p) =>
        p.id === target.id
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
        .eq('post_id', target.id)
        .eq('user_id', currentUser.id);
    } else {
      await supabase.from('post_likes').insert({ post_id: target.id, user_id: currentUser.id });
    }
  };

  const handleDeletePost = async (postId: string) => {
    const { error: delErr } = await getSupabase().from('posts').delete().eq('id', postId);
    if (!delErr) {
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    }
  };

  return (
    <div className="max-w-5xl mx-auto w-full px-4 py-6">
      {error && (
        <div className="mb-4 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/30 px-4 py-3 text-xs text-[#FCA5A5] flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-[#12151C] border border-white/8 rounded-2xl overflow-hidden mb-6">
        {/* Banner */}
        <div className="relative h-44 bg-[#181C25]">
          {profile.banner_url ? (
            <img
              src={profile.banner_url}
              alt={`${profile.display_name} banner`}
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-[#171C2B] via-[#12151C] to-[#1D2436]" />
          )}
          {isOwn && (
            <label className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/70 hover:bg-black/85 border border-white/15 text-xs font-medium text-white cursor-pointer transition-colors">
              <Camera className="w-3.5 h-3.5" />
              <span>Change Banner</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => e.target.files?.[0] && handleImageUpload(e.target.files[0], 'banner')}
                className="hidden"
              />
            </label>
          )}
        </div>

        {/* Avatar & Actions Row */}
        <div className="px-6 pb-6">
          <div className="flex flex-wrap items-end justify-between gap-4 -mt-12 mb-4 relative z-10">
            <div className="relative">
              <Avatar
                src={profile.avatar_url}
                name={profile.display_name}
                size="xl"
                className="ring-4 ring-[#12151C]"
              />
              {isOwn && (
                <label
                  title="Upload profile picture"
                  className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-[#5B7CFA] hover:bg-[#4B6CF0] text-white flex items-center justify-center cursor-pointer border-2 border-[#12151C]"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => e.target.files?.[0] && handleImageUpload(e.target.files[0], 'avatar')}
                    className="hidden"
                  />
                </label>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isOwn ? (
                <button
                  type="button"
                  onClick={openEditModal}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-semibold text-white transition-colors"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Edit Profile</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={toggleFollow}
                    className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                      isFollowing
                        ? 'bg-[#181C25] border border-white/15 text-white hover:border-white/30'
                        : 'bg-[#5B7CFA] hover:bg-[#4B6CF0] text-white'
                    }`}
                  >
                    {isFollowing ? 'Following' : 'Follow'}
                  </button>

                  {isFriend ? (
                    <button
                      type="button"
                      onClick={removeFriend}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#181C25] border border-white/10 hover:border-[#EF4444]/40 text-xs font-medium text-[#D1D5DB] hover:text-[#FCA5A5] transition-colors"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                      <span>Friends</span>
                    </button>
                  ) : pendingRequest ? (
                    pendingRequest.receiver_id === currentUser.id ? (
                      <button
                        type="button"
                        onClick={acceptIncomingRequest}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#22C55E] hover:bg-[#16A34A] text-xs font-semibold text-white"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Accept Friend</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#181C25] border border-white/10 text-xs text-[#9CA3AF]">
                        <UserCheck className="w-3.5 h-3.5" />
                        <span>Request Sent</span>
                      </span>
                    )
                  ) : (
                    profile.friend_request_privacy === 'everyone' && (
                      <button
                        type="button"
                        onClick={sendFriendRequest}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-semibold text-white transition-colors"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>Add Friend</span>
                      </button>
                    )
                  )}

                  {profile.dm_privacy !== 'none' && (
                    <button
                      type="button"
                      onClick={handleMessageUser}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#181C25] border border-white/10 hover:border-white/25 text-xs font-semibold text-white transition-colors"
                    >
                      <Mail className="w-3.5 h-3.5" />
                      <span>Message</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <h2 className="font-display text-xl font-bold text-white">{profile.display_name}</h2>
          <div className="text-sm text-[#9CA3AF] mb-3">@{profile.username}</div>

          {profile.bio && (
            <p className="text-sm text-[#E5E7EB] leading-relaxed mb-4 whitespace-pre-wrap">
              {profile.bio}
            </p>
          )}

          {/* Unboxed typographic metrics */}
          <div className="flex flex-wrap items-center gap-5 text-xs text-[#9CA3AF]">
            <div>
              <span className="font-mono tabular-nums font-semibold text-white">{followingCount}</span>{' '}
              Following
            </div>
            <span aria-hidden="true">·</span>
            <div>
              <span className="font-mono tabular-nums font-semibold text-white">{followersCount}</span>{' '}
              Followers
            </div>
            <span aria-hidden="true">·</span>
            <div>
              <span className="font-mono tabular-nums font-semibold text-white">{friendsCount}</span>{' '}
              Friends
            </div>
          </div>
        </div>
      </div>

      {/* User's Posts */}
      <h3 className="font-display text-sm font-semibold text-[#D1D5DB] mb-3">Posts</h3>
      {posts.length === 0 ? (
        <div className="bg-[#12151C] border border-white/8 rounded-2xl py-12 text-center text-xs text-[#9CA3AF]">
          No posts published yet.
        </div>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              currentUser={currentUser}
              globalEmojis={globalEmojis}
              initialComments={commentsByPost[post.id]}
              onOpenProfile={onOpenProfile}
              onOpenProfileByUsername={openProfileByUsername}
              onToggleLikePost={toggleLikePost}
              onDeletePost={isOwn ? handleDeletePost : undefined}
              onReplyCountDelta={(pid, delta) =>
                setPosts((prev) =>
                  prev.map((p) =>
                    p.id === pid ? { ...p, replies_count: Math.max(0, p.replies_count + delta) } : p
                  )
                )
              }
            />
          ))}
        </div>
      )}

      {/* Edit Profile Modal */}
      {editing && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={saveProfileChanges}
            className="w-full max-w-md bg-[#12151C] border border-white/10 rounded-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold text-white">Edit Profile</h3>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="p-1.5 rounded-lg text-[#9CA3AF] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5">Display Name</label>
              <input
                type="text"
                required
                maxLength={48}
                value={editDisplay}
                onChange={(e) => setEditDisplay(e.target.value)}
                className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5">Bio</label>
              <textarea
                rows={3}
                maxLength={280}
                value={editBio}
                onChange={(e) => setEditBio(e.target.value)}
                className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[#5B7CFA]"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                  Who can DM you
                </label>
                <select
                  value={editDmPrivacy}
                  onChange={(e) => setEditDmPrivacy(e.target.value as DmPrivacy)}
                  className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:border-[#5B7CFA]"
                >
                  <option value="everyone">Everyone</option>
                  <option value="friends">Friends only</option>
                  <option value="following">People I follow</option>
                  <option value="none">No one</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#D1D5DB] mb-1.5">
                  Friend requests
                </label>
                <select
                  value={editFrPrivacy}
                  onChange={(e) => setEditFrPrivacy(e.target.value as FriendRequestPrivacy)}
                  className="w-full rounded-lg bg-[#0B0D11] border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:border-[#5B7CFA]"
                >
                  <option value="everyone">Everyone</option>
                  <option value="none">Disabled</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-[#9CA3AF] hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-[#5B7CFA] hover:bg-[#4B6CF0] text-xs font-semibold text-white"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
