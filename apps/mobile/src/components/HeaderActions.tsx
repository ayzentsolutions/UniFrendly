import React, { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { apiRequest } from '@/lib/api';
import { usePalette } from '@/lib/theme';
export function HeaderActions() {
  const colors = usePalette();
  const [unread, setUnread] = useState(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    apiRequest<{ count: number }>('/notifications/unread-count').then((result) => { if (active) setUnread(result.count); }).catch(() => undefined);
    return () => { active = false; };
  }, []));
  return <View style={{ flexDirection: 'row', gap: 10 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Open messages" hitSlop={10} onPress={() => router.push('/messages')} style={{ width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }}><Ionicons name="chatbubble-ellipses-outline" size={21} color={colors.text} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`Notifications${unread ? `, ${unread} unread` : ''}`} hitSlop={10} onPress={() => router.push('/notifications')} style={{ width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }}><Ionicons name="notifications-outline" size={21} color={colors.text} />{unread > 0 ? <View style={{ position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} /> : null}</Pressable>
  </View>;
}
