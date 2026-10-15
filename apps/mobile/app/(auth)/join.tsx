import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text } from 'react-native';
import { Link } from 'expo-router';
import { AppButton, Card, Field, Notice, Screen } from '@/components/ui';
import { useAuth } from '@/providers/AuthProvider';
import { ApiError } from '@/lib/api';
import { usePalette } from '@/lib/theme';
export default function JoinScreen() {
  const { acceptInvitation, working } = useAuth();
  const colors = usePalette();
  const [institutionSlug, setInstitutionSlug] = useState('');
  const [email, setEmail] = useState('');
  const [invitationToken, setInvitationToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try { await acceptInvitation({ institutionSlug: institutionSlug.trim().toLowerCase(), email: email.trim(), invitationToken: invitationToken.trim(), displayName: displayName.trim(), password }); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Invitation could not be accepted. Please try again.'); }
  };
  return <Screen title="Join your campus" subtitle="You need an invitation from your institution.">
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Card>
        {error ? <Notice message={error} tone="error" /> : null}
        <Field label="Campus code" value={institutionSlug} onChangeText={setInstitutionSlug} autoCapitalize="none" placeholder="e.g. north-campus" />
        <Field label="Institution email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="you@college.edu" />
        <Field label="Invitation token" value={invitationToken} onChangeText={setInvitationToken} autoCapitalize="none" autoCorrect={false} placeholder="Paste your one-time invitation token" />
        <Field label="Your name" value={displayName} onChangeText={setDisplayName} placeholder="How classmates will see you" />
        <Field label="Create password" value={password} onChangeText={setPassword} secureTextEntry placeholder="At least 12 characters" />
        <AppButton title="Accept invitation" onPress={() => void submit()} loading={working} disabled={!institutionSlug.trim() || !email.trim() || invitationToken.trim().length < 24 || !displayName.trim() || password.length < 12} />
        <Text style={{ textAlign: 'center', color: colors.muted }}>Already verified? <Link href="/(auth)/login" style={{ color: colors.primary, fontWeight: '800' }}>Sign in</Link></Text>
      </Card>
    </KeyboardAvoidingView>
  </Screen>;
}
