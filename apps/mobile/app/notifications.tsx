import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppButton, Card, EmptyState, Notice, Screen, SectionTitle } from '@/components/ui';
import { apiRequest, ApiError } from '@/lib/api';
import { usePalette } from '@/lib/theme';

type NotificationItem={id:string;category:string;title:string;body:string;resource_type:string|null;resource_id:string|null;read_at:string|null;created_at:string};
function destination(item:NotificationItem){if(item.resource_type==='conversation'&&item.resource_id)return `/messages/${item.resource_id}`;if(item.resource_type==='post'&&item.resource_id)return `/posts/${item.resource_id}`;return null;}
export default function NotificationsScreen(){const colors=usePalette();const [items,setItems]=useState<NotificationItem[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [saving,setSaving]=useState(false);
 const load=useCallback(async()=>{setLoading(true);try{setError('');const result=await apiRequest<{items:NotificationItem[]}>('/notifications?limit=50');setItems(result.items);}catch(e){setError(e instanceof ApiError?e.message:'Notifications could not be loaded.');}finally{setLoading(false);}},[]);
 useFocusEffect(useCallback(()=>{void load();},[load]));
 const markAll=async()=>{setSaving(true);try{await apiRequest('/notifications/read-all',{method:'PUT'});setItems(old=>old.map(n=>({...n,read_at:n.read_at??new Date().toISOString()})));}catch(e){setError(e instanceof Error?e.message:'Unable to mark notifications read.');}finally{setSaving(false);}};
 const open=async(item:NotificationItem)=>{try{if(!item.read_at)await apiRequest(`/notifications/${item.id}/read`,{method:'PUT'});setItems(old=>old.map(n=>n.id===item.id?{...n,read_at:n.read_at??new Date().toISOString()}:n));const path=destination(item);if(path)router.push(path as never);}catch(e){setError(e instanceof Error?e.message:'Notification could not be opened.');}};
 return <Screen title="Notifications" subtitle="Campus updates, without the noise." refreshing={loading}>
 {error?<Notice message={error} tone="error"/>:null}
 <SectionTitle>Recent activity <AppButton title="Mark all read" variant="ghost" onPress={()=>void markAll()} loading={saving}/></SectionTitle>
 {!loading&&items.length===0?<EmptyState title="You’re all caught up" text="When something relevant happens in your campus community, it will appear here."/>:null}
 {!loading?items.map(item=><Pressable key={item.id} accessibilityRole="button" onPress={()=>void open(item)}><Card style={{flexDirection:'row',gap:12,borderColor:item.read_at?colors.border:colors.primary}}><View style={{width:42,height:42,borderRadius:15,backgroundColor:item.read_at?colors.input:colors.primarySoft,alignItems:'center',justifyContent:'center'}}><Ionicons name={item.category==='message'?'chatbubble-ellipses-outline':item.category==='event'?'calendar-outline':item.category==='study'?'book-outline':item.category==='connection'?'people-outline':'notifications-outline'} size={21} color={colors.primary}/></View><View style={{flex:1,gap:4}}><View style={{flexDirection:'row',alignItems:'center',gap:6}}><Text style={{flex:1,fontSize:15,fontWeight:'800',color:colors.text}}>{item.title}</Text>{!item.read_at?<View style={{width:7,height:7,borderRadius:4,backgroundColor:colors.accent}}/>:null}</View><Text style={{color:colors.muted,fontSize:13,lineHeight:19}}>{item.body}</Text><Text style={{color:colors.muted,fontSize:11}}>{new Date(item.created_at).toLocaleString()}</Text></View></Card></Pressable>):null}
 </Screen>;
}
