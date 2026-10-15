import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { AppButton, Card, Field, Notice, Screen } from '@/components/ui';
import { useAuth } from '@/providers/AuthProvider';
import { ApiError } from '@/lib/api';
import { usePalette } from '@/lib/theme';

export default function LoginScreen() {
  const { signIn, working } = useAuth();
  const colors = usePalette();
  const [institutionSlug, setInstitutionSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try { await signIn({ institutionSlug: institutionSlug.trim().toLowerCase(), email: email.trim(), password }); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Unable to sign in. Please try again.'); }
  };
  return <Screen title="UniFrendly" subtitle="Your campus, your people, your space.">
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Card>
        <Text style={{ fontSize: 23, fontWeight: '800', color: colors.text }}>Welcome back 👋</Text>
        <Text style={{ color: colors.muted, lineHeight: 20 }}>Sign in with the institution and account you were verified for.</Text>
        {error ? <Notice message={error} tone="error" /> : null}
        <Field label="Campus code" value={institutionSlug} onChangeText={setInstitutionSlug} autoCapitalize="none" autoCorrect={false} placeholder="e.g. north-campus" returnKeyType="next" />
        <Field label="Institution email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} placeholder="you@college.edu" returnKeyType="next" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" placeholder="Your password" onSubmitEditing={() => void submit()} />
        <AppButton title="Sign in" onPress={() => void submit()} loading={working} disabled={!institutionSlug.trim() || !email.trim() || !password} />
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 5, flexWrap: 'wrap' }}>
          <Text style={{ color: colors.muted }}>Have an invite?</Text><Link href="/(auth)/join" style={{ color: colors.primary, fontWeight: '800' }}>Join your campus</Link>
        </View>
      </Card>
    </KeyboardAvoidingView>
    <Text style={{ color: colors.muted, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>Private by design. Campus access depends on an institution-issued invitation or approved verification.</Text>
  </Screen>;
}
