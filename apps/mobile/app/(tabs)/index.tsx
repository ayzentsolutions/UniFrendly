import React, { useCallback, useState } from 'react';
import { Alert, Image, ScrollView, Share, Text, View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { AppButton, Card, EmptyState, Field, Notice, Screen, SectionTitle } from '@/components/ui';
import { HeaderActions } from '@/components/HeaderActions';
import { MediaPhoto } from '@/components/MediaPhoto';
import { ApiError, apiRequest, uploadPrivateFile } from '@/lib/api';
import { useAuth } from '@/providers/AuthProvider';
import { usePalette } from '@/lib/theme';

type Post = { id: string; body: string; visibility: string; created_at: string; author_membership_id: string; author_name: string; department?: string | null; programme?: string | null; media: Array<{ id: string; mimeType: string; byteSize: number }>; comment_count: number; reaction_count: number; reacted_by_me: boolean; bookmarked_by_me: boolean };
export default function HomeScreen() {
  const { me } = useAuth();
  const colors = usePalette();
  const [posts, setPosts] = useState<Post[]>([]);
  const [stories, setStories] = useState<Post[]>([]);
  const [asStory, setAsStory] = useState(false);
  const [body, setBody] = useState('');
  const [images, setImages] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const [feed, storyFeed] = await Promise.all([apiRequest<{ items: Post[] }>('/feed?mode=posts&limit=20'), apiRequest<{ items: Post[] }>('/feed?mode=stories&limit=20')]); setPosts(feed.items); setStories(storyFeed.items); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Feed could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const choosePhotos = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { setError('Photo access was not granted. You can enable it in device settings.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: Math.max(1, 4 - images.length), quality: 0.8 });
    if (!result.canceled) setImages((current) => [...current, ...result.assets].slice(0, 4));
  };
  const createPost = async () => {
    if (!body.trim() && !images.length) { setError('Write something or add a photo first.'); return; }
    setPosting(true); setError('');
    try {
      const mediaIds: string[] = [];
      for (const image of images) {
        const compressed = await ImageManipulator.manipulateAsync(image.uri, [{ resize: { width: Math.min(image.width, 1440) } }], { compress: 0.68, format: ImageManipulator.SaveFormat.JPEG });
        const blob = await (await fetch(compressed.uri)).blob();
        if (blob.size > 1_048_576) throw new Error('A photo is still larger than 1 MB after compression. Please choose a smaller image.');
        const media = await uploadPrivateFile({ purpose: 'post_image', uri: compressed.uri, fileName: `campus-photo-${Date.now()}.jpg`, mimeType: 'image/jpeg', sizeBytes: blob.size });
        mediaIds.push(media.id);
      }
      await apiRequest('/posts', { method: 'POST', body: JSON.stringify({ body: body.trim(), mediaIds, visibility: 'campus', story: asStory }) });
      setBody(''); setImages([]); setAsStory(false); await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Post could not be published.'); }
    finally { setPosting(false); }
  };
  const react = async (post: Post) => {
    try { if (post.reacted_by_me) await apiRequest(`/posts/${post.id}/reaction`, { method: 'DELETE' }); else await apiRequest(`/posts/${post.id}/reaction`, { method: 'PUT', body: JSON.stringify({ reaction: 'like' }) }); await load(); }
    catch (e) { Alert.alert('Unable to react', e instanceof Error ? e.message : 'Please try again.'); }
  };
  const bookmark = async (post: Post) => {
    try { await apiRequest(`/posts/${post.id}/bookmark`, { method: post.bookmarked_by_me ? 'DELETE' : 'PUT' }); await load(); }
    catch (e) { Alert.alert('Unable to save post', e instanceof Error ? e.message : 'Please try again.'); }
  };
  const sharePost = async (post: Post) => { await Share.share({ message: `${post.author_name} on UniFrendly\n${post.body}\n\nunifrendly://posts/${post.id}` }); };
  const reportPost = (post: Post) => Alert.alert('Report post', 'Choose Report to send this post to campus moderation.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Report', style: 'destructive', onPress: () => { void apiRequest('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: post.id, reason: 'other', details: 'Reported from the feed' }) }).then(() => Alert.alert('Report submitted', 'Campus moderators will review it.')).catch((e) => Alert.alert('Unable to report', e instanceof Error ? e.message : 'Try again.')); } }]);

  return <Screen title={`Good vibes, ${me?.user.displayName?.split(' ')[0] ?? 'campus'}`} subtitle={me?.membership.institution_name ?? 'Your campus community'} right={<HeaderActions />}>
    {error ? <Notice message={error} tone="error" /> : null}
    <Card>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>What's happening on campus?</Text>
      <Field label="Your post" value={body} onChangeText={setBody} placeholder="Share a thought, a win, or a question…" multiline maxLength={5000} />
      {images.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{images.map((image, index) => <View key={`${image.uri}-${index}`} style={{ position: 'relative' }}><Image source={{ uri: image.uri }} style={{ width: 76, height: 76, borderRadius: 12 }} /><Text onPress={() => setImages((items) => items.filter((_, i) => i !== index))} accessibilityRole="button" style={{ position: 'absolute', right: -5, top: -5, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.danger, color: '#fff', fontWeight: '800' }}>×</Text></View>)}</View> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}><AppButton title="Add photos" variant="secondary" onPress={() => void choosePhotos()} disabled={images.length >= 4} /><View style={{ flex: 1 }}><AppButton title={asStory ? 'Share story' : 'Post to feed'} onPress={() => void createPost()} loading={posting} disabled={!body.trim() && !images.length} /></View></View>
      <AppButton title={asStory ? '24-hour story selected · Tap to switch back' : 'Share as a 24-hour story'} variant={asStory ? 'primary' : 'ghost'} onPress={() => setAsStory((value) => !value)} disabled={posting || (!body.trim() && !images.length)} />
      <Text style={{ color: colors.muted, fontSize: 12 }}>Up to 4 compressed photos · 1 MB per image · stories expire after 24 hours</Text>
    </Card>
    {stories.length ? <View style={{ gap: 8 }}><SectionTitle>Campus stories · 24 hours</SectionTitle><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>{stories.map((story) => <View key={story.id} style={{ width: 240, gap: 8, padding: 12, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}><Text style={{ fontWeight: '800', color: colors.text }}>{story.author_name}</Text>{story.body ? <Text numberOfLines={4} style={{ color: colors.text, lineHeight: 20 }}>{story.body}</Text> : null}{story.media.map((media) => <MediaPhoto key={media.id} mediaId={media.id} />)}</View>)}</ScrollView></View> : null}
    <SectionTitle action={<AppButton title="Refresh" variant="ghost" onPress={() => void load()} />}>Your campus feed</SectionTitle>
    {loading ? <Card><Text style={{ color: colors.muted }}>Loading recent campus posts…</Text></Card> : posts.length === 0 ? <EmptyState title="It's a fresh start" text="Share something or connect with classmates to get your campus feed going." /> : posts.map((post) => <Card key={post.id}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}><View style={{ flex: 1, gap: 3 }}><Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{post.author_name}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{[post.department, post.programme].filter(Boolean).join(' · ') || 'Verified campus member'} · {new Date(post.created_at).toLocaleDateString()}</Text></View><Text onPress={() => reportPost(post)} accessibilityRole="button" accessibilityLabel="Report post" style={{ color: colors.muted, fontSize: 21, paddingHorizontal: 6 }}>•••</Text></View>
      {post.body ? <Text style={{ color: colors.text, fontSize: 15, lineHeight: 23 }}>{post.body}</Text> : null}
      {post.media.map((media) => <MediaPhoto key={media.id} mediaId={media.id} />)}
      <View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap', paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border }}>
        <AppButton title={`${post.reacted_by_me ? '♥ Liked' : '♡ Like'} · ${post.reaction_count}`} variant="ghost" onPress={() => void react(post)} />
        <AppButton title={`Comment · ${post.comment_count}`} variant="ghost" onPress={() => router.push(`/posts/${post.id}`)} />
        <AppButton title={post.bookmarked_by_me ? 'Saved' : 'Save'} variant="ghost" onPress={() => void bookmark(post)} />
        <AppButton title="Share" variant="ghost" onPress={() => void sharePost(post)} />
      </View>
    </Card>)}
  </Screen>;
}
