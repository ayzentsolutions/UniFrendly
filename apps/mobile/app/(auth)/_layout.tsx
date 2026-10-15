import React from 'react';
import { Stack, Redirect } from 'expo-router';
import { useAuth } from '@/providers/AuthProvider';
import { usePalette } from '@/lib/theme';
export default function AuthLayout() {
  const { me, loading } = useAuth();
  const colors = usePalette();
  if (!loading && me) return <Redirect href="/(tabs)" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'fade' }} />;
}
