import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';
import { usePalette } from '@/lib/theme';

function Navigation() {
  const { loading } = useAuth();
  const colors = usePalette();
  useEffect(() => {
    const redirect = (notification: Notifications.Notification) => {
      const url = notification.request.content.data?.url;
      if (typeof url !== 'string' || !url.startsWith('/') || url.includes('..')) return;
      if (url === '/campus/events' || url.startsWith('/events/')) router.push('/(tabs)/campus' as never);
      else if (url === '/study/resources' || url.startsWith('/study/')) router.push('/(tabs)/study' as never);
      else if (url.startsWith('/marketplace/')) router.push('/(tabs)/campus' as never);
      else router.push(url as never);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) redirect(last.notification);
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => redirect(response.notification));
    return () => subscription.remove();
  }, []);
  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}><ActivityIndicator size="large" color={colors.primary} /></View>;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'slide_from_right' }}>
    <Stack.Screen name="index" />
    <Stack.Screen name="(auth)" />
    <Stack.Screen name="(tabs)" />
    <Stack.Screen name="messages/index" options={{ headerShown: true, title: 'Messages', headerBackTitle: 'Back' }} />
    <Stack.Screen name="messages/[conversationId]" options={{ headerShown: true, title: 'Conversation', headerBackTitle: 'Back' }} />
    <Stack.Screen name="notifications" options={{ headerShown: true, title: 'Notifications', headerBackTitle: 'Back' }} />
  </Stack>;
}
export default function RootLayout() { return <AuthProvider><Navigation /></AuthProvider>; }
