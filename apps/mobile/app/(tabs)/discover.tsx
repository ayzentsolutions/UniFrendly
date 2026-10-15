import React, { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { AppButton, Card, EmptyState, Field, Notice, Screen } from '@/components/ui';
import { HeaderActions } from '@/components/HeaderActions';
import { apiRequest, ApiError } from '@/lib/api';
import { usePalette } from '@/lib/theme';

type Student = { membership_id: string; display_name: string; department?: string | null; programme?: string | null; batch_year?: number | null; bio?: string; interests?: string[]; connected: boolean; my_request_status: string | null; their_request_status: string | null };
export default function DiscoverScreen() {
  const colors = usePalette();
  const [query, setQuery] = useState('');
  const [students, setStudents] = useState<Student[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState('Study circle');
  const [makingGroup, setMakingGroup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (search = query) => {
    setLoading(true); setError('');
    try { const data = await apiRequest<{ items: Student[] }>(`/students?limit=25${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`); setStudents(data.items); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Student discovery is unavailable.'); }
    finally { setLoading(false); }
  }, [query]);
  useFocusEffect(useCallback(() => { void load(''); }, []));
  const connect = async (student: Student) => {
    try { await apiRequest(`/students/${student.membership_id}/connect`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { Alert.alert('Connection request failed', e instanceof Error ? e.message : 'Please try again.'); }
  };
  const message = async (student: Student) => {
    try {
      const response = await apiRequest<{ conversation: { id: string } }>('/conversations', { method: 'POST', body: JSON.stringify({ kind: 'direct', memberIds: [student.membership_id] }) });
      router.push(`/messages/${response.conversation.id}`);
    } catch (e) { Alert.alert('Message unavailable', e instanceof Error ? e.message : 'Connect first or review your campus messaging settings.'); }
  };
  const createGroup = async () => {
    if (selected.length < 2) return;
    setMakingGroup(true); setError('');
    try {
      const response = await apiRequest<{ conversation: { id: string } }>('/conversations', { method: 'POST', body: JSON.stringify({ kind: 'group', title: groupTitle.trim() || 'Campus group', memberIds: selected }) });
      setSelected([]); router.push(`/messages/${response.conversation.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Group chat could not be created.'); }
    finally { setMakingGroup(false); }
  };
  return <Screen title="Find your people" subtitle="Discover verified students from your campus." right={<HeaderActions />}>
    {error ? <Notice message={error} tone="error" /> : null}
    <Card>
      <Field label="Search classmates" value={query} onChangeText={setQuery} placeholder="Name, department, programme…" returnKeyType="search" onSubmitEditing={() => void load()} />
      <AppButton title="Search campus" onPress={() => void load()} loading={loading} />
    </Card>
    {selected.length ? <Card><Text style={{ fontWeight: '800', color: colors.text }}>Create a group · {selected.length} classmates selected</Text><Field label="Group name" value={groupTitle} onChangeText={setGroupTitle} maxLength={100} /><AppButton title="Start group chat" onPress={() => void createGroup()} loading={makingGroup} /></Card> : null}
    {students.length === 0 && !loading ? <EmptyState title="No classmates found" text="Try another name or department, or come back after more students join your campus." /> : students.map((student) => {
      const isSelected = selected.includes(student.membership_id);
      return <Card key={student.membership_id} style={isSelected ? { borderColor: colors.primary, borderWidth: 2 } : undefined}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}><View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 17, fontWeight: '900', color: colors.primary }}>{student.display_name.trim().slice(0, 1).toUpperCase()}</Text></View><View style={{ flex: 1, gap: 4 }}><Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>{student.display_name}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{[student.department, student.programme, student.batch_year].filter(Boolean).join(' · ') || 'Verified campus member'}</Text>{student.bio ? <Text style={{ color: colors.text, lineHeight: 20 }}>{student.bio}</Text> : null}{student.interests?.length ? <Text style={{ color: colors.primary, fontSize: 12 }}>{student.interests.slice(0, 5).join(' · ')}</Text> : null}</View></View>
        <View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap' }}>
          {student.connected ? <AppButton title="Connected" variant="secondary" onPress={() => Alert.alert('Connected', 'You are connected with this student.')} /> : student.my_request_status === 'pending' ? <AppButton title="Request sent" variant="secondary" onPress={() => undefined} /> : student.their_request_status === 'pending' ? <AppButton title="Accept request" onPress={() => void apiRequest(`/connections/${student.membership_id}/accept`, { method: 'PATCH', body: JSON.stringify({}) }).then(() => load()).catch((e) => Alert.alert('Unable to accept', e.message))} /> : <AppButton title="Connect" onPress={() => void connect(student)} />}
          <AppButton title="Message" variant="ghost" onPress={() => void message(student)} />
          <AppButton title={isSelected ? 'Selected' : 'Add to group'} variant="ghost" onPress={() => setSelected((items) => isSelected ? items.filter((id) => id !== student.membership_id) : items.length < 49 ? [...items, student.membership_id] : items)} />
          <AppButton title="Block" variant="ghost" onPress={() => Alert.alert('Block student?', 'You will no longer see each other in discovery or start messages.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Block', style: 'destructive', onPress: () => void apiRequest(`/students/${student.membership_id}/block`, { method: 'POST', body: JSON.stringify({}) }).then(() => load()).catch((e) => Alert.alert('Unable to block', e.message)) }])} />
        </View>
      </Card>;
    })}
    <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>Only explicitly discoverable campus profiles appear here. Private contact information and exact location are never listed.</Text>
  </Screen>;
}
