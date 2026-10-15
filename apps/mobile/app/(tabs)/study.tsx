import React, { useCallback, useState } from 'react';
import { Alert, Linking, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useFocusEffect } from 'expo-router';
import { AppButton, Card, EmptyState, Field, Notice, Screen, SectionTitle } from '@/components/ui';
import { HeaderActions } from '@/components/HeaderActions';
import { ApiError, apiRequest, mediaDownloadUrl, uploadPrivateFile } from '@/lib/api';
import { usePalette } from '@/lib/theme';

type Resource = { id: string; title: string; description: string; subject: string; semester?: string | null; programme?: string | null; created_at: string; contributor_name: string; byte_size: number; media_id: string };
export default function StudyScreen() {
  const colors = usePalette();
  const [resources, setResources] = useState<Resource[]>([]);
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [semester, setSemester] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try { const result = await apiRequest<{ items: Resource[] }>(`/study/resources?limit=30${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`); setResources(result.items); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Study resources could not be loaded.'); }
    finally { setLoading(false); }
  }, [q]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const submit = async () => {
    setError('');
    if (!title.trim() || !subject.trim()) { setError('Add a title and subject first.'); return; }
    const picked = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', multiple: false, copyToCacheDirectory: true });
    if (picked.canceled) return;
    const file = picked.assets[0];
    if (!file) return;
    if (!file.size || file.size > 10_485_760) { setError('Select a PDF no larger than 10 MB.'); return; }
    setUploading(true);
    try {
      const media = await uploadPrivateFile({ purpose: 'study_pdf', uri: file.uri, fileName: file.name, mimeType: 'application/pdf', sizeBytes: file.size });
      const resource = await apiRequest<{ resource: { id: string } }>('/study/resources', { method: 'POST', body: JSON.stringify({ mediaId: media.id, title: title.trim(), subject: subject.trim(), semester: semester.trim() || undefined, description: description.trim(), visibility: 'campus' }) });
      setTitle(''); setSubject(''); setSemester(''); setDescription('');
      Alert.alert('Submitted for review', 'The PDF passed file validation and will appear to campus members after moderation.');
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Study resource upload failed.'); }
    finally { setUploading(false); }
  };
  const download = async (resource: Resource) => { try { const url = await mediaDownloadUrl(resource.media_id); await Linking.openURL(url); } catch (e) { Alert.alert('Unable to open PDF', e instanceof Error ? e.message : 'Please retry.'); } };
  return <Screen title="Study together" subtitle="Shared notes from students at your institution." right={<HeaderActions />}>
    {error ? <Notice message={error} tone="error" /> : null}
    <Card>
      <Text style={{ fontWeight: '800', color: colors.text, fontSize: 16 }}>Contribute a PDF</Text>
      <Field label="Resource title" value={title} onChangeText={setTitle} placeholder="e.g. Data Structures — revision notes" maxLength={160} />
      <Field label="Subject" value={subject} onChangeText={setSubject} placeholder="e.g. Data Structures" maxLength={120} />
      <Field label="Semester (optional)" value={semester} onChangeText={setSemester} placeholder="e.g. Semester 3" maxLength={40} />
      <Field label="Description (optional)" value={description} onChangeText={setDescription} placeholder="What classmates will find inside" maxLength={1000} multiline />
      <AppButton title="Choose PDF and submit" onPress={() => void submit()} loading={uploading} disabled={!title.trim() || !subject.trim()} />
      <Text style={{ color: colors.muted, fontSize: 12 }}>PDF only · 10 MB maximum · institution moderation before campus release</Text>
    </Card>
    <SectionTitle>Browse campus notes</SectionTitle>
    <Card><Field label="Search title or subject" value={q} onChangeText={setQ} placeholder="Search notes…" onSubmitEditing={() => void load()} /><AppButton title="Search resources" variant="secondary" onPress={() => void load()} loading={loading} /></Card>
    {!loading && resources.length === 0 ? <EmptyState title="No approved notes yet" text="Upload helpful notes for review, or try searching for another subject." /> : resources.map((item) => <Card key={item.id}>
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>{item.title}</Text>
      <Text style={{ color: colors.primary, fontWeight: '700' }}>{item.subject}{item.semester ? ` · ${item.semester}` : ''}</Text>
      {item.description ? <Text style={{ color: colors.text, lineHeight: 20 }}>{item.description}</Text> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}><Text style={{ color: colors.muted, fontSize: 12 }}>{item.contributor_name} · {(item.byte_size / 1024 / 1024).toFixed(1)} MB</Text><AppButton title="Open PDF" onPress={() => void download(item)} /></View>
      <AppButton title="Report resource" variant="ghost" onPress={() => Alert.alert('Report study material?', 'Campus moderation will review this resource.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Report', style: 'destructive', onPress: () => void apiRequest('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'study_resource', targetId: item.id, reason: 'copyright', details: '' }) }).catch((e) => Alert.alert('Report failed', e.message)) }])} />
    </Card>)}
  </Screen>;
}
