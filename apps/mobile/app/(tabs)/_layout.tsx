import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { usePalette } from '@/lib/theme';
const icons: Record<string, keyof typeof Ionicons.glyphMap> = { index: 'home', discover: 'compass', study: 'book', campus: 'people', profile: 'person-circle' };
export default function TabsLayout() {
  const colors = usePalette();
  return <Tabs screenOptions={({ route }) => ({
    headerShown: false,
    tabBarActiveTintColor: colors.primary,
    tabBarInactiveTintColor: colors.muted,
    tabBarStyle: { height: 68, paddingTop: 7, paddingBottom: 8, borderTopColor: colors.border, backgroundColor: colors.surface },
    tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
    tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? icons[route.name] : `${icons[route.name]}-outline` as keyof typeof Ionicons.glyphMap} color={color} size={size} />
  })}>
    <Tabs.Screen name="index" options={{ title: 'Home', tabBarAccessibilityLabel: 'Home feed' }} />
    <Tabs.Screen name="discover" options={{ title: 'Discover' }} />
    <Tabs.Screen name="study" options={{ title: 'Study' }} />
    <Tabs.Screen name="campus" options={{ title: 'Campus' }} />
    <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
  </Tabs>;
}
