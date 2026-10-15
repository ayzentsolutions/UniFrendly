import React from 'react';
import { Redirect } from 'expo-router';
import { useAuth } from '@/providers/AuthProvider';
import { Screen, Notice, AppButton } from '@/components/ui';

export default function Index() {
  const { me, offline, refreshMe } = useAuth();
  if (me) return <Redirect href="/(tabs)" />;
  if (offline) return <Screen title="You're offline" subtitle="Your secure session is saved on this device."><Notice message="Reconnect to the internet to verify your campus session." /><AppButton title="Try again" onPress={() => void refreshMe().catch(() => undefined)} /></Screen>;
  return <Redirect href="/(auth)/login" />;
}
