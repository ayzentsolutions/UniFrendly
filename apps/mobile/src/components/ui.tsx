import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ImageStyle, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePalette } from '@/lib/theme';

export function Screen({ children, title, subtitle, right, refreshing = false }: { children: React.ReactNode; title?: string; subtitle?: string; right?: React.ReactNode; refreshing?: boolean }) {
  const colors = usePalette();
  return <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {(title || right) ? <View style={styles.titleRow}><View style={{ flex: 1 }}>
        {title ? <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text> : null}
        {subtitle ? <Text style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text> : null}
      </View>{right}</View> : null}
      {refreshing ? <ActivityIndicator accessibilityLabel="Loading" color={colors.primary} style={{ margin: 28 }} /> : children}
    </ScrollView>
  </SafeAreaView>;
}
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const colors = usePalette();
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>{children}</View>;
}
export function AppButton({ title, onPress, variant = 'primary', disabled = false, loading = false, icon, style }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; disabled?: boolean; loading?: boolean; icon?: React.ReactNode; style?: ViewStyle }) {
  const colors = usePalette();
  const backgroundColor = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : variant === 'secondary' ? colors.primarySoft : 'transparent';
  const foreground = variant === 'primary' || variant === 'danger' ? '#FFFFFF' : colors.primary;
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor, borderColor: colors.border, opacity: disabled || loading ? 0.55 : pressed ? 0.82 : 1 }, style]}>
    {loading ? <ActivityIndicator color={foreground} size="small" /> : icon}
    <Text style={[styles.buttonText, { color: foreground }]}>{loading ? 'Please wait…' : title}</Text>
  </Pressable>;
}
export function Field({ label, style, multiline, ...props }: TextInputProps & { label: string }) {
  const colors = usePalette();
  return <View style={styles.fieldWrap}>
    <Text style={[styles.fieldLabel, { color: colors.muted }]}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} selectionColor={colors.primary} {...props} multiline={multiline} style={[styles.field, { color: colors.text, backgroundColor: colors.input, borderColor: colors.border }, multiline && styles.multiline, style]} />
  </View>;
}
export function Notice({ message, tone = 'info' }: { message: string; tone?: 'info' | 'error' | 'success' }) {
  const colors = usePalette();
  return <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: tone === 'error' ? `${colors.danger}16` : tone === 'success' ? `${colors.success}16` : colors.primarySoft, borderColor: tone === 'error' ? `${colors.danger}60` : colors.border }]}><Text style={{ color: tone === 'error' ? colors.danger : colors.text, lineHeight: 20 }}>{message}</Text></View>;
}
export function SectionTitle({ children, action }: { children: string; action?: React.ReactNode }) {
  const colors = usePalette();
  return <View style={styles.sectionTitleRow}><Text style={[styles.sectionTitle, { color: colors.text }]}>{children}</Text>{action}</View>;
}
export function EmptyState({ title, text }: { title: string; text: string }) {
  const colors = usePalette();
  return <View style={styles.empty}><Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text><Text style={{ color: colors.muted, textAlign: 'center', lineHeight: 21 }}>{text}</Text></View>;
}
const styles = StyleSheet.create({
  safe: { flex: 1 }, content: { padding: 16, paddingBottom: 36, gap: 14 }, titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 }, title: { fontSize: 29, lineHeight: 35, fontWeight: '800', letterSpacing: -0.5 }, subtitle: { fontSize: 14, lineHeight: 20, marginTop: 4 }, card: { borderWidth: 1, borderRadius: 20, padding: 15, gap: 10 }, button: { minHeight: 46, paddingHorizontal: 16, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1 }, buttonText: { fontWeight: '700', fontSize: 14 }, fieldWrap: { gap: 7 }, fieldLabel: { fontWeight: '600', fontSize: 13 }, field: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderRadius: 14, fontSize: 15 }, multiline: { minHeight: 100, textAlignVertical: 'top' }, notice: { borderWidth: 1, padding: 12, borderRadius: 14 }, sectionTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }, sectionTitle: { fontSize: 18, fontWeight: '800' }, empty: { minHeight: 145, borderWidth: 1, borderStyle: 'dashed', borderColor: '#9DA2B0', borderRadius: 20, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 }, emptyTitle: { fontSize: 18, fontWeight: '800' }
}) as unknown as Record<string, ViewStyle & TextStyle & ImageStyle>;
