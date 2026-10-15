import React, { useEffect, useState } from 'react';
import { Alert, Linking, Platform, Share, Switch, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { AppButton, Card, Field, Notice, Screen, SectionTitle } from '@/components/ui';
import { HeaderActions } from '@/components/HeaderActions';
import { ApiError, apiRequest, mediaDownloadUrl } from '@/lib/api';
import { useAuth } from '@/providers/AuthProvider';
import { usePalette } from '@/lib/theme';

type ModerationReport = { id: string; target_type: string; target_id: string; reason: string; details: string | null; status: string; created_at: string; reporter_name: string };
type PendingResource = { id: string; media_id: string; title: string; description: string; subject: string; semester: string | null; programme: string | null; created_at: string; contributor_name: string; byte_size: number };
type CampusSettings = { imageMaxBytes: number; imagesPerPost: number; pdfMaxBytes: number; studentQuotaBytes: number; storyTtlHours: number; listingTtlDays: number; notificationRetentionDays: number; temporaryUploadTtlHours: number };
type CampusSettingsForm = Record<keyof CampusSettings, string>;
const defaultCampusSettings: CampusSettings = { imageMaxBytes: 1048576, imagesPerPost: 4, pdfMaxBytes: 10485760, studentQuotaBytes: 52428800, storyTtlHours: 24, listingTtlDays: 30, notificationRetentionDays: 90, temporaryUploadTtlHours: 24 };
const toSettingsForm = (value: CampusSettings): CampusSettingsForm => Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, String(amount)])) as CampusSettingsForm;

export default function ProfileScreen() {
  const { me, refreshMe, signOut, working } = useAuth();
  const colors = usePalette();
  const membership = me?.membership;
  const isInstitutionAdmin = membership?.role === 'institution_admin';
  const canModerate = isInstitutionAdmin || membership?.role === 'moderator';
  const [bio, setBio] = useState(membership?.bio ?? '');
  const [discoverable, setDiscoverable] = useState(membership?.discoverable ?? false);
  const [visibility, setVisibility] = useState<'private'|'connections'|'campus'>(membership?.visibility ?? 'campus');
  const [allowMessages, setAllowMessages] = useState<'nobody'|'connections'|'campus'>(membership?.allow_messages ?? 'connections');
  const [settings, setSettings] = useState({ pushEnabled: membership?.push_enabled ?? true, notifyMessages: membership?.notify_messages ?? true, notifyConnections: membership?.notify_connections ?? true, notifyEvents: membership?.notify_events ?? true, notifyStudy: membership?.notify_study ?? false, notifyMarketplace: membership?.notify_marketplace ?? false, privateMessagePreviews: membership?.private_message_previews ?? false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'student' | 'alumni'>('student');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [pendingResources, setPendingResources] = useState<PendingResource[]>([]);
  const [moderationLoading, setModerationLoading] = useState(false);
  const [moderationError, setModerationError] = useState('');
  const [moderationBusyId, setModerationBusyId] = useState('');
  const [campusSettings, setCampusSettings] = useState<CampusSettingsForm>(toSettingsForm(defaultCampusSettings));
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [quotaMembershipId, setQuotaMembershipId] = useState('');
  const [quotaMb, setQuotaMb] = useState('50');
  const [quotaBusy, setQuotaBusy] = useState(false);

  useEffect(() => {
    if (!membership) return;
    setBio(membership.bio ?? ''); setDiscoverable(membership.discoverable ?? false); setVisibility(membership.visibility ?? 'campus'); setAllowMessages(membership.allow_messages ?? 'connections');
    setSettings({ pushEnabled: membership.push_enabled ?? true, notifyMessages: membership.notify_messages ?? true, notifyConnections: membership.notify_connections ?? true, notifyEvents: membership.notify_events ?? true, notifyStudy: membership.notify_study ?? false, notifyMarketplace: membership.notify_marketplace ?? false, privateMessagePreviews: membership.private_message_previews ?? false });
  }, [membership]);
  const loadModeration = React.useCallback(async () => {
    if (!canModerate) return;
    setModerationLoading(true); setModerationError('');
    try {
      const reportPromise = apiRequest<{ items: ModerationReport[] }>('/admin/moderation/reports?limit=25&status=open');
      const resourcePromise = apiRequest<{ items: PendingResource[] }>('/admin/moderation/study-resources?limit=25');
      const settingsPromise = isInstitutionAdmin ? apiRequest<{ settings: CampusSettings }>('/admin/settings') : Promise.resolve(null);
      const [reportResult, resourceResult, settingsResult] = await Promise.all([reportPromise, resourcePromise, settingsPromise]);
      setReports(reportResult.items ?? []);
      setPendingResources(resourceResult.items ?? []);
      if (settingsResult?.settings) setCampusSettings(toSettingsForm({ ...defaultCampusSettings, ...settingsResult.settings }));
    } catch (e) { setModerationError(e instanceof Error ? e.message : 'Moderation queue could not be loaded.'); }
    finally { setModerationLoading(false); }
  }, [canModerate, isInstitutionAdmin, membership?.role]);

  useFocusEffect(React.useCallback(() => {
    void refreshMe().catch(() => undefined);
    if (canModerate) void loadModeration();
  }, [refreshMe, canModerate, loadModeration]));

  const updateSettings = async (key: keyof typeof settings, value: boolean) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    try { await apiRequest('/me/settings', { method: 'PATCH', body: JSON.stringify({ [key]: value }) }); }
    catch (e) { setSettings(settings); Alert.alert('Setting not saved', e instanceof Error ? e.message : 'Please retry.'); }
  };
  const saveProfile = async () => {
    setSaving(true); setError('');
    try { await apiRequest('/me/profile', { method: 'PATCH', body: JSON.stringify({ bio, discoverable, visibility, allowMessages }) }); await refreshMe(); Alert.alert('Profile updated', 'Your changes are saved.'); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Profile could not be updated.'); }
    finally { setSaving(false); }
  };
  const enablePush = async () => {
    try {
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'UniFrendly notifications', importance: Notifications.AndroidImportance.DEFAULT, vibrationPattern: [0, 180, 120, 180] });
      const current = await Notifications.getPermissionsAsync();
      const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
      if (!permission.granted) { Alert.alert('Notifications not enabled', 'You can enable notifications in device settings any time.'); return; }
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      if (!projectId) { Alert.alert('Push setup is not finished', 'In the project, run `eas init` to connect UniFrendly to an Expo project, configure the APNs/FCM credentials, and rebuild the native app. In-app notifications still work.'); return; }
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      await apiRequest('/devices/push-token', { method: 'POST', body: JSON.stringify({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android' }) });
      await updateSettings('pushEnabled', true);
      Alert.alert('Notifications enabled', 'UniFrendly can now send push alerts for the categories you enable.');
    } catch (e) { Alert.alert('Push registration failed', e instanceof Error ? e.message : 'Check the native build and push credentials.'); }
  };
  const exportData = async () => {
    setSaving(true);
    try {
      const data = await apiRequest<unknown>('/me/export');
      const base = FileSystem.documentDirectory;
      if (!base) throw new Error('This device does not provide a private document directory.');
      const path = `${base}unifrendly-data-export-${new Date().toISOString().slice(0,10)}.json`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(data, null, 2), { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'application/json', dialogTitle: 'Export UniFrendly data' });
      else await Share.share({ message: JSON.stringify(data).slice(0, 5000) });
    } catch (e) { Alert.alert('Export failed', e instanceof Error ? e.message : 'Please retry when online.'); }
    finally { setSaving(false); }
  };
  const deleteAccount = async () => {
    if (deleteConfirm !== 'DELETE MY ACCOUNT') { Alert.alert('Confirmation required', 'Type DELETE MY ACCOUNT exactly to continue.'); return; }
    setDeleting(true);
    try {
      await apiRequest('/me/account', { method: 'DELETE', body: JSON.stringify({ confirmation: deleteConfirm, password }) });
      setDeleting(false); await signOut();
      Alert.alert('Account anonymized', 'Your campus access is revoked and profile information has been anonymized. Retained records and media follow the documented cleanup policy.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Account deletion failed.'); setDeleting(false); }
  };
  const createInvitation = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { Alert.alert('Check email', 'Enter a valid institutional invitee email address.'); return; }
    setInviteBusy(true);
    try {
      const result = await apiRequest<{ invitation: { email: string; role: string; expires_at: string }; token: string }>('/admin/invitations', {
        method: 'POST', body: JSON.stringify({ email, role: inviteRole, expiresInDays: 7 })
      });
      const shareMessage = `UniFrendly campus invitation\nInstitution: ${membership?.institution_name} (${membership?.institution_slug})\nEmail: ${result.invitation.email}\nRole: ${result.invitation.role}\nInvitation token (single use): ${result.token}\nExpires: ${new Date(result.invitation.expires_at).toLocaleString()}\nInstall/open UniFrendly, choose “Join your campus”, and enter the institution slug, email, display name, password and token.`;
      setInviteEmail('');
      await Share.share({ message: shareMessage });
      Alert.alert('Invitation created', 'The single-use token was shown only in the system share sheet. Share it privately with the approved invitee.');
    } catch (e) { Alert.alert('Invitation failed', e instanceof Error ? e.message : 'The invitation could not be created.'); }
    finally { setInviteBusy(false); }
  };

  const saveCampusSettings = async () => {
    const values = Object.fromEntries(Object.entries(campusSettings).map(([key, value]) => [key, Number(value)])) as Record<keyof CampusSettings, number>;
    if (Object.values(values).some((value) => !Number.isSafeInteger(value))) { Alert.alert('Check campus limits', 'Every limit must be a whole number.'); return; }
    setSettingsBusy(true);
    try {
      const result = await apiRequest<{ settings: CampusSettings }>('/admin/settings', { method: 'PATCH', body: JSON.stringify(values) });
      setCampusSettings(toSettingsForm({ ...defaultCampusSettings, ...result.settings }));
      Alert.alert('Campus limits saved', 'The server will enforce the updated limits. Existing students keep their current individual storage quotas.');
    } catch (e) { Alert.alert('Could not save limits', e instanceof Error ? e.message : 'Please retry.'); }
    finally { setSettingsBusy(false); }
  };

  const updateMemberQuota = async () => {
    const id = quotaMembershipId.trim();
    const mb = Number(quotaMb);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !Number.isInteger(mb) || mb < 0 || mb > 1024) {
      Alert.alert('Check storage quota', 'Enter the member membership ID and a whole-number quota from 0 to 1024 MB.'); return;
    }
    setQuotaBusy(true);
    try {
      await apiRequest(`/admin/memberships/${id}/storage-quota`, { method: 'PATCH', body: JSON.stringify({ quotaBytes: mb * 1024 * 1024 }) });
      Alert.alert('Member quota updated', `The server now enforces a ${mb} MB quota for this member.`);
      setQuotaMembershipId('');
    } catch (e) { Alert.alert('Could not update quota', e instanceof Error ? e.message : 'The member ID may be incorrect or storage use may exceed the requested quota.'); }
    finally { setQuotaBusy(false); }
  };

  const resolveReport = async (report: ModerationReport, action: 'dismiss' | 'remove') => {
    if (action === 'remove' && !['post', 'comment', 'study_resource', 'event', 'listing'].includes(report.target_type)) {
      Alert.alert('Removal unavailable', 'This report type requires a dedicated review workflow. You can dismiss the report after review.'); return;
    }
    Alert.alert(action === 'remove' ? 'Remove reported content?' : 'Dismiss report?', action === 'remove' ? 'This will hide/remove the supported content in this campus.' : 'This records that the report was reviewed without removing the target.', [
      { text: 'Cancel', style: 'cancel' },
      { text: action === 'remove' ? 'Remove content' : 'Dismiss report', style: action === 'remove' ? 'destructive' : 'default', onPress: () => {
        setModerationBusyId(report.id);
        void apiRequest(`/admin/moderation/reports/${report.id}/resolve`, { method: 'POST', body: JSON.stringify({ action, note: '' }) })
          .then(() => loadModeration()).catch((e) => setModerationError(e instanceof Error ? e.message : 'Report could not be resolved.'))
          .finally(() => setModerationBusyId(''));
      } }
    ]);
  };

  const reviewResource = async (resource: PendingResource, decision: 'approve' | 'reject') => {
    Alert.alert(decision === 'approve' ? 'Approve study material?' : 'Reject study material?', `${resource.title} · ${resource.subject}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: decision === 'approve' ? 'Approve' : 'Reject', style: decision === 'reject' ? 'destructive' : 'default', onPress: () => {
        setModerationBusyId(resource.id);
        void apiRequest(`/study/resources/${resource.id}/review`, { method: 'POST', body: JSON.stringify({ decision, note: '' }) })
          .then(() => loadModeration()).catch((e) => setModerationError(e instanceof Error ? e.message : 'Study material review failed.'))
          .finally(() => setModerationBusyId(''));
      } }
    ]);
  };

  const openPendingResource = async (resource: PendingResource) => {
    try { const url = await mediaDownloadUrl(resource.media_id); await Linking.openURL(url); }
    catch (e) { Alert.alert('Could not open PDF', e instanceof Error ? e.message : 'Please retry.'); }
  };

  const boolSetting = (title: string, description: string, key: keyof typeof settings) => <View key={key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingVertical: 8 }}>
    <View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.text, fontWeight: '700' }}>{title}</Text><Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>{description}</Text></View>
    <Switch accessibilityLabel={title} value={settings[key]} onValueChange={(value) => void updateSettings(key, value)} thumbColor={settings[key] ? colors.primary : undefined} trackColor={{ false: colors.border, true: colors.primarySoft }} />
  </View>;
  const choiceRow = <T extends string>(label: string, value: T, options: Array<{ value: T; label: string }>, onChange: (value: T) => void) => <View style={{ gap: 8 }}><Text style={{ color: colors.muted, fontWeight: '700', fontSize: 13 }}>{label}</Text><View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap' }}>{options.map((option) => <AppButton key={option.value} title={option.label} variant={option.value === value ? 'primary' : 'secondary'} onPress={() => onChange(option.value)} />)}</View></View>;

  return <Screen title="Your space" subtitle="Your profile, your privacy, your preferences." right={<HeaderActions />}>
    {error ? <Notice message={error} tone="error" /> : null}
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}><View style={{ width: 62, height: 62, borderRadius: 22, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.primary, fontSize: 26, fontWeight: '900' }}>{me?.user.displayName.slice(0,1).toUpperCase()}</Text></View><View style={{ flex: 1, gap: 3 }}><Text style={{ color: colors.text, fontSize: 20, fontWeight: '900' }}>{me?.user.displayName}</Text><Text style={{ color: colors.muted }}>{me?.membership.institution_name}</Text><Text style={{ color: colors.success, fontWeight: '800', fontSize: 12 }}>✓ Verified campus membership</Text></View></View>
      <Text style={{ color: colors.muted, fontSize: 13 }}>{me?.user.email}</Text>
      <Text style={{ color: colors.muted, fontSize: 12 }}>Role: {me?.membership.role.replace('_',' ')}</Text>
    </Card>
    <SectionTitle>Edit profile</SectionTitle>
    <Card>
      <Field label="Short bio" value={bio} onChangeText={setBio} multiline maxLength={500} placeholder="What would you like classmates to know?" />
      {choiceRow('Who can discover your profile?', visibility, [{ value: 'private', label: 'Private' }, { value: 'connections', label: 'Connections' }, { value: 'campus', label: 'Campus' }], setVisibility)}
      {choiceRow('Who can send you messages?', allowMessages, [{ value: 'nobody', label: 'Nobody' }, { value: 'connections', label: 'Connections' }, { value: 'campus', label: 'Campus' }], setAllowMessages)}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.text, fontWeight: '700' }}>Appear in discovery</Text><Text style={{ color: colors.muted, fontSize: 12 }}>Turn off to hide your profile from student search.</Text></View><Switch value={discoverable} onValueChange={setDiscoverable} accessibilityLabel="Appear in student discovery" thumbColor={discoverable ? colors.primary : undefined} /></View>
      <AppButton title="Save profile and privacy" onPress={() => void saveProfile()} loading={saving} />
    </Card>
    {isInstitutionAdmin ? <>
      <SectionTitle>Campus invitations</SectionTitle>
      <Card>
        <Text style={{ color: colors.muted, lineHeight: 20 }}>Create a single-use, seven-day invitation for a student or approved alumnus. Only share the token privately with the person approved by your institution.</Text>
        <Field label="Invitee email" value={inviteEmail} onChangeText={setInviteEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} placeholder="student@college.edu" maxLength={254} />
        {choiceRow('Membership type', inviteRole, [{ value: 'student', label: 'Student' }, { value: 'alumni', label: 'Alumni' }], setInviteRole)}
        <AppButton title="Create and share invitation" onPress={() => void createInvitation()} loading={inviteBusy} disabled={!inviteEmail.trim()} />
      </Card>
    </> : null}
    {isInstitutionAdmin ? <>
      <SectionTitle>Campus limits</SectionTitle>
      <Card>
        <Text style={{ color: colors.muted, lineHeight: 20 }}>These values are validated by the API and can be changed without publishing a new mobile build. Image sizes and PDFs are in bytes; per-member storage is in bytes.</Text>
        <Field label="Maximum compressed image bytes" value={campusSettings.imageMaxBytes} onChangeText={(v) => setCampusSettings((s) => ({ ...s, imageMaxBytes: v }))} keyboardType="number-pad" />
        <Field label="Images per post (maximum 4)" value={campusSettings.imagesPerPost} onChangeText={(v) => setCampusSettings((s) => ({ ...s, imagesPerPost: v }))} keyboardType="number-pad" />
        <Field label="Maximum PDF bytes" value={campusSettings.pdfMaxBytes} onChangeText={(v) => setCampusSettings((s) => ({ ...s, pdfMaxBytes: v }))} keyboardType="number-pad" />
        <Field label="Default student storage quota bytes" value={campusSettings.studentQuotaBytes} onChangeText={(v) => setCampusSettings((s) => ({ ...s, studentQuotaBytes: v }))} keyboardType="number-pad" />
        <Field label="Story lifetime hours (maximum 168)" value={campusSettings.storyTtlHours} onChangeText={(v) => setCampusSettings((s) => ({ ...s, storyTtlHours: v }))} keyboardType="number-pad" />
        <Field label="Marketplace listing lifetime days" value={campusSettings.listingTtlDays} onChangeText={(v) => setCampusSettings((s) => ({ ...s, listingTtlDays: v }))} keyboardType="number-pad" />
        <Field label="Notification retention days" value={campusSettings.notificationRetentionDays} onChangeText={(v) => setCampusSettings((s) => ({ ...s, notificationRetentionDays: v }))} keyboardType="number-pad" />
        <Field label="Temporary upload lifetime hours (maximum 24)" value={campusSettings.temporaryUploadTtlHours} onChangeText={(v) => setCampusSettings((s) => ({ ...s, temporaryUploadTtlHours: v }))} keyboardType="number-pad" />
        <AppButton title="Save campus limits" onPress={() => void saveCampusSettings()} loading={settingsBusy} />
      </Card>
      <Card>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>Individual storage quota</Text>
        <Text style={{ color: colors.muted, lineHeight: 20 }}>Use a member’s membership ID from institution support tools. A quota cannot be lower than data already used or reserved.</Text>
        <Field label="Membership ID" value={quotaMembershipId} onChangeText={setQuotaMembershipId} autoCapitalize="none" autoCorrect={false} placeholder="UUID" />
        <Field label="New quota in MB (0–1024)" value={quotaMb} onChangeText={setQuotaMb} keyboardType="number-pad" />
        <AppButton title="Update member quota" variant="secondary" onPress={() => void updateMemberQuota()} loading={quotaBusy} disabled={!quotaMembershipId.trim() || !quotaMb.trim()} />
      </Card>
    </> : null}
    {canModerate ? <>
      <SectionTitle>Campus moderation</SectionTitle>
      {moderationError ? <Notice message={moderationError} tone="error" /> : null}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>Reported content ({reports.length})</Text><AppButton title="Refresh" variant="secondary" onPress={() => void loadModeration()} loading={moderationLoading} /></View>
        {reports.length === 0 ? <Text style={{ color: colors.muted }}>{moderationLoading ? 'Loading reports…' : 'No open reports right now.'}</Text> : reports.map((report) => <View key={report.id} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, gap: 7 }}>
          <Text style={{ color: colors.text, fontWeight: '800' }}>{report.target_type.replace('_', ' ')} · {report.reason}</Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>Reported by {report.reporter_name} · {new Date(report.created_at).toLocaleDateString()}</Text>
          {report.details ? <Text style={{ color: colors.text, lineHeight: 20 }}>{report.details}</Text> : null}
          <Text style={{ color: colors.muted, fontSize: 11 }}>Target: {report.target_id}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><AppButton title="Dismiss" variant="secondary" onPress={() => void resolveReport(report, 'dismiss')} loading={moderationBusyId === report.id} /><AppButton title="Remove content" variant="danger" onPress={() => void resolveReport(report, 'remove')} disabled={!['post', 'comment', 'study_resource', 'event', 'listing'].includes(report.target_type)} loading={moderationBusyId === report.id} /></View>
        </View>)}
      </Card>
      <Card>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>Study materials awaiting review ({pendingResources.length})</Text>
        {pendingResources.length === 0 ? <Text style={{ color: colors.muted }}>{moderationLoading ? 'Loading study materials…' : 'No study materials awaiting review.'}</Text> : pendingResources.map((resource) => <View key={resource.id} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, gap: 7 }}>
          <Text style={{ color: colors.text, fontWeight: '800' }}>{resource.title}</Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{resource.subject}{resource.semester ? ` · ${resource.semester}` : ''} · {(Number(resource.byte_size) / 1024 / 1024).toFixed(2)} MB · by {resource.contributor_name}</Text>
          {resource.description ? <Text style={{ color: colors.text, lineHeight: 20 }}>{resource.description}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><AppButton title="Review PDF" variant="secondary" onPress={() => void openPendingResource(resource)} /><AppButton title="Approve" onPress={() => void reviewResource(resource, 'approve')} loading={moderationBusyId === resource.id} /><AppButton title="Reject" variant="danger" onPress={() => void reviewResource(resource, 'reject')} loading={moderationBusyId === resource.id} /></View>
        </View>)}
      </Card>
    </> : null}

    <SectionTitle>Notifications</SectionTitle>
    <Card>
      {boolSetting('Push notifications', 'Enable device-level alerts.', 'pushEnabled')}
      <AppButton title="Set up native push" variant="secondary" onPress={() => void enablePush()} />
      {boolSetting('Messages', 'A notification can say you have a new message, not reveal private content.', 'notifyMessages')}
      {boolSetting('Connections', 'Connection requests and responses.', 'notifyConnections')}
      {boolSetting('Campus events', 'New and changed events you may care about.', 'notifyEvents')}
      {boolSetting('Study resources', 'Moderation and study updates.', 'notifyStudy')}
      {boolSetting('Marketplace', 'Updates related to campus listings.', 'notifyMarketplace')}
      {boolSetting('Private message previews', 'Reserved for future local preview behavior; push messages stay generic.', 'privateMessagePreviews')}
    </Card>
    <SectionTitle>Account and data</SectionTitle>
    <Card>
      <AppButton title="Export my data" variant="secondary" onPress={() => void exportData()} loading={saving} />
      <AppButton title="Sign out" variant="ghost" onPress={() => void signOut()} loading={working} />
    </Card>
    <Card>
      <Text style={{ color: colors.danger, fontWeight: '900', fontSize: 17 }}>Delete account</Text>
      <Text style={{ color: colors.muted, lineHeight: 20 }}>This revokes access, anonymizes your profile, hides your posts, removes reactions/connections and begins media cleanup. Some records may be retained for safety, moderation or legal obligations.</Text>
      <Field label="Confirm current password" value={password} onChangeText={setPassword} secureTextEntry placeholder="Password" />
      <Field label="Type DELETE MY ACCOUNT" value={deleteConfirm} onChangeText={setDeleteConfirm} autoCapitalize="characters" placeholder="DELETE MY ACCOUNT" />
      <AppButton title="Permanently delete account" variant="danger" disabled={deleteConfirm !== 'DELETE MY ACCOUNT' || !password} loading={deleting} onPress={() => Alert.alert('Delete UniFrendly account?', 'This action cannot be undone after the recovery window.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete account', style: 'destructive', onPress: () => void deleteAccount() }])} />
    </Card>
    <Text style={{ color: colors.muted, fontSize: 12, textAlign: 'center' }}>UniFrendly · private campus community · no student location tracking</Text>
  </Screen>;
}
