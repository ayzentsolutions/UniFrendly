import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppButton, Card, EmptyState, Field, Notice, Screen, SectionTitle } from '@/components/ui';
import { HeaderActions } from '@/components/HeaderActions';
import { apiRequest, ApiError } from '@/lib/api';
import { usePalette } from '@/lib/theme';
import { useAuth } from '@/providers/AuthProvider';

type Person = { membershipId: string; displayName: string; role: string };
type Conversation = { id: string; kind: 'direct'|'group'; title: string|null; created_at: string; updated_at: string; members: Person[]; my_request_status: 'pending'|'accepted'|'rejected'; last_message: { id:string; body:string; senderMembershipId:string; createdAt:string }|null; unread_count:number };
type StudentApi = { membership_id:string; display_name:string; department:string|null; programme:string|null };
type Student = { membershipId:string; displayName:string; department:string|null; programme:string|null };
export default function MessagesScreen() {
  const colors = usePalette(); const { me } = useAuth();
  const [items, setItems] = useState<Conversation[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [createMode, setCreateMode] = useState<'direct'|'group'|null>(null); const [query, setQuery] = useState(''); const [students, setStudents] = useState<Student[]>([]); const [selected, setSelected] = useState<Student[]>([]); const [groupTitle, setGroupTitle] = useState(''); const [creating, setCreating] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(''); try { const result = await apiRequest<{items:Conversation[]}>('/conversations'); setItems(result.items); } catch(e) { setError(e instanceof ApiError ? e.message : 'Messages could not be loaded.'); } finally { setLoading(false); } }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const search = async (value: string) => { setQuery(value); if (!value.trim()) { setStudents([]); return; } try { const result = await apiRequest<{items:StudentApi[]}>(`/students?q=${encodeURIComponent(value.trim())}&limit=12`); setStudents(result.items.map(p=>({membershipId:p.membership_id,displayName:p.display_name,department:p.department,programme:p.programme})).filter(p => p.membershipId !== me?.membership.membership_id)); } catch(e) { setError(e instanceof Error ? e.message : 'Student search failed.'); } };
  const toggle = (person: Student) => setSelected(current => current.some(p=>p.membershipId===person.membershipId) ? current.filter(p=>p.membershipId!==person.membershipId) : [...current,person]);
  const start = async () => { if (!selected.length) return; setCreating(true); setError(''); try { const kind = createMode ?? 'direct'; if (kind==='direct' && selected.length!==1) throw new Error('Choose one student for a direct conversation.'); if (kind==='group' && selected.length<2) throw new Error('Choose at least two students for a group.'); const result = await apiRequest<{conversation:{id:string}}>('/conversations',{method:'POST',body:JSON.stringify({kind,memberIds:selected.map(p=>p.membershipId),title:groupTitle.trim()||undefined})}); setCreateMode(null); setSelected([]); setStudents([]); setQuery(''); router.push(`/messages/${result.conversation.id}` as never); } catch(e) { setError(e instanceof Error ? e.message : 'Conversation could not be created.'); } finally { setCreating(false); } };
  const openCreate = (kind:'direct'|'group') => { setCreateMode(kind); setSelected([]); setStudents([]); setQuery(''); setGroupTitle(''); };
  return <Screen title="Messages" subtitle="Good conversations start here." right={<HeaderActions />}>
    {error ? <Notice message={error} tone="error"/> : null}
    {createMode ? <Card>
      <SectionTitle>{createMode==='direct'?'New message':'Create a group'}</SectionTitle>
      {createMode==='group' ? <Field label="Group name (optional)" value={groupTitle} onChangeText={setGroupTitle} maxLength={100} placeholder="Study circle, project team…"/> : null}
      <Field label="Find campus members" value={query} onChangeText={(v)=>void search(v)} placeholder="Name, department or programme" autoCapitalize="none" />
      {students.map(person=>{ const active=selected.some(p=>p.membershipId===person.membershipId); return <Pressable key={person.membershipId} onPress={()=>toggle(person)} accessibilityRole="checkbox" accessibilityState={{checked:active}} style={{paddingVertical:10,flexDirection:'row',alignItems:'center',gap:10,borderBottomWidth:1,borderBottomColor:colors.border}}><View style={{width:40,height:40,borderRadius:15,backgroundColor:colors.primarySoft,alignItems:'center',justifyContent:'center'}}><Text style={{color:colors.primary,fontWeight:'900'}}>{person.displayName.slice(0,1).toUpperCase()}</Text></View><View style={{flex:1}}><Text style={{color:colors.text,fontWeight:'800'}}>{person.displayName}</Text><Text style={{color:colors.muted,fontSize:12}}>{[person.department,person.programme].filter(Boolean).join(' · ')||'Verified campus member'}</Text></View><Ionicons name={active?'checkmark-circle':'ellipse-outline'} size={22} color={active?colors.primary:colors.muted}/></Pressable>; })}
      <AppButton title={`Start ${createMode==='group'?'group':'conversation'}${selected.length ? ` · ${selected.length} selected`:''}`} onPress={()=>void start()} loading={creating} disabled={!selected.length}/>
      <AppButton title="Cancel" variant="ghost" onPress={()=>setCreateMode(null)}/>
    </Card> : <View style={{flexDirection:'row',gap:10}}><View style={{flex:1}}><AppButton title="New message" icon={<Ionicons name="create-outline" size={18} color="#FFFFFF"/>} onPress={()=>openCreate('direct')}/></View><View style={{flex:1}}><AppButton title="New group" variant="secondary" icon={<Ionicons name="people-outline" size={18} color={colors.primary}/>} onPress={()=>openCreate('group')}/></View></View>}
    <SectionTitle>Recent conversations</SectionTitle>
    {loading ? <ActivityIndicator color={colors.primary} style={{padding:26}}/> : items.length===0 ? <EmptyState title="Your inbox is ready" text="Start a private conversation with a verified student or make a group for your next project."/> : items.map(item=>{
      const others=(item.members??[]).filter(p=>p.membershipId!==me?.membership.membership_id); const title=item.kind==='group'?(item.title||'Campus group'):others.map(p=>p.displayName).join(', ')||'Conversation';
      return <Pressable key={item.id} onPress={()=>router.push(`/messages/${item.id}` as never)} accessibilityRole="button" style={({pressed})=>({opacity:pressed?.78:1})}><Card style={{flexDirection:'row',alignItems:'center'}}><View style={{width:48,height:48,borderRadius:17,backgroundColor:colors.primarySoft,alignItems:'center',justifyContent:'center'}}><Ionicons name={item.kind==='group'?'people-outline':'chatbubble-ellipses-outline'} size={23} color={colors.primary}/></View><View style={{flex:1,gap:4}}><Text numberOfLines={1} style={{fontSize:15,fontWeight:'800',color:colors.text}}>{title}</Text><Text numberOfLines={2} style={{fontSize:13,lineHeight:18,color:colors.muted}}>{item.my_request_status==='pending'?'Message request · review before replying':item.last_message?.body||'Say hello 👋'}</Text><Text style={{fontSize:11,color:colors.muted}}>{others.length+1} member{others.length===0?'':'s'}</Text></View>{item.unread_count>0?<View style={{minWidth:24,height:24,borderRadius:12,backgroundColor:colors.primary,alignItems:'center',justifyContent:'center',paddingHorizontal:6}}><Text style={{color:'#fff',fontSize:11,fontWeight:'900'}}>{item.unread_count>99?'99+':item.unread_count}</Text></View>:null}</Card></Pressable>;
    })}
  </Screen>;
}
