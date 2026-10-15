import React, { useCallback, useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import * as Calendar from 'expo-calendar';
import { useFocusEffect } from 'expo-router';
import { AppButton, Card, EmptyState, Field, Notice, Screen, SectionTitle } from '@/components/ui';
import { HeaderActions } from '@/components/HeaderActions';
import { apiRequest, ApiError } from '@/lib/api';
import { usePalette } from '@/lib/theme';

type CampusEvent = { id: string; title: string; description: string; club_name?: string | null; location_label?: string | null; starts_at: string; ends_at: string; capacity?: number | null; registered_count: number; registered_by_me: boolean };
type Listing = { id: string; title: string; description: string; category: string; price_minor?: number | null; currency: string; seller_name: string; seller_membership_id: string; expires_at: string; created_at: string };
type Mode = 'events' | 'marketplace' | 'canteen' | 'lost_found';
const categories = [
  { key: 'used_books', label: 'Books' }, { key: 'stationery', label: 'Stationery' }, { key: 'permitted_service', label: 'Services' },
  { key: 'canteen', label: 'Canteen' }, { key: 'lost_found', label: 'Lost & found' }
] as const;
export default function CampusScreen() {
  const colors = usePalette();
  const [mode, setMode] = useState<Mode>('events');
  const [events, setEvents] = useState<CampusEvent[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState('');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<'event' | 'listing'>('event');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [club, setClub] = useState('');
  const [startsInHours, setStartsInHours] = useState('24');
  const [durationHours, setDurationHours] = useState('2');
  const [capacity, setCapacity] = useState('');
  const [category, setCategory] = useState<(typeof categories)[number]['key']>('used_books');
  const [price, setPrice] = useState('');
  const [publishing, setPublishing] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      if (mode === 'events') {
        const result = await apiRequest<{ items: CampusEvent[] }>('/campus/events?limit=30'); setEvents(result.items);
      } else {
        const filter = mode === 'canteen' ? 'canteen' : mode === 'lost_found' ? 'lost_found' : undefined;
        const result = await apiRequest<{ items: Listing[] }>(`/campus/marketplace?limit=30${filter ? `&category=${filter}` : ''}`); setListings(result.items);
      }
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Campus items could not be loaded.'); }
    finally { setLoading(false); }
  }, [mode]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const setTab = (next: Mode) => { setMode(next); setShowCreate(false); setError(''); };
  const saveItem = async () => {
    setPublishing(true); setError('');
    try {
      if (createType === 'event') {
        if (!title.trim()) throw new Error('Add an event title first.');
        const startsOffset = Number(startsInHours); const duration = Number(durationHours);
        if (!Number.isFinite(startsOffset) || startsOffset < 1 || startsOffset > 8760 || !Number.isFinite(duration) || duration <= 0 || duration > 168) throw new Error('Start time must be 1–8760 hours from now and duration must be 0–168 hours.');
        const start = new Date(Date.now() + startsOffset * 3_600_000);
        const end = new Date(start.getTime() + duration * 3_600_000);
        const capacityValue = capacity.trim() ? Number(capacity) : undefined;
        if (capacityValue !== undefined && (!Number.isInteger(capacityValue) || capacityValue < 1 || capacityValue > 100_000)) throw new Error('Capacity must be a positive whole number.');
        await apiRequest('/campus/events', { method: 'POST', body: JSON.stringify({ title: title.trim(), description: description.trim(), clubName: club.trim() || undefined, locationLabel: location.trim() || undefined, startsAt: start.toISOString(), endsAt: end.toISOString(), capacity: capacityValue }) });
        Alert.alert('Event published', `It starts ${start.toLocaleString()}. Campus members can now discover it.`);
      } else {
        if (!title.trim()) throw new Error('Add a listing title first.');
        const priceValue = price.trim() ? Number(price) : null;
        if (priceValue !== null && (!Number.isFinite(priceValue) || priceValue < 0 || priceValue > 1_000_000)) throw new Error('Enter a valid price, or leave price blank.');
        await apiRequest('/campus/marketplace', { method: 'POST', body: JSON.stringify({ title: title.trim(), description: description.trim(), category, priceMinor: priceValue === null || category === 'lost_found' || category === 'canteen' ? null : Math.round(priceValue * 100), currency: 'INR' }) });
        Alert.alert('Listing created', 'Your listing is visible to eligible members and will expire after 30 days unless renewed.');
      }
      setTitle(''); setDescription(''); setLocation(''); setClub(''); setCapacity(''); setPrice(''); setShowCreate(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Item could not be saved.'); }
    finally { setPublishing(false); }
  };
  const register = async (event: CampusEvent) => {
    setWorkingId(event.id); setError('');
    try {
      await apiRequest(`/campus/events/${event.id}/register`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not register for event.'); }
    finally { setWorkingId(''); }
  };
  const cancelRegistration = async (event: CampusEvent) => {
    setWorkingId(event.id);
    try { await apiRequest(`/campus/events/${event.id}/register`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not cancel registration.'); }
    finally { setWorkingId(''); }
  };
  const addCalendar = async (event: CampusEvent) => {
    try {
      const permission = await Calendar.requestCalendarPermissionsAsync();
      if (permission.status !== 'granted') { Alert.alert('Calendar access needed', 'Allow calendar access in device settings to add this event.'); return; }
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      let calendar = calendars.find((item) => item.allowsModifications && item.isPrimary) ?? calendars.find((item) => item.allowsModifications);
      if (!calendar) { Alert.alert('No editable calendar', 'Create or enable a calendar on your device, then try again.'); return; }
      await Calendar.createEventAsync(calendar.id, { title: event.title, startDate: new Date(event.starts_at), endDate: new Date(event.ends_at), location: event.location_label ?? undefined, notes: event.description });
      Alert.alert('Added to calendar', 'This event is now in your device calendar.');
    } catch (e) { Alert.alert('Calendar unavailable', e instanceof Error ? e.message : 'Unable to add the event.'); }
  };
  const markListing = async (listing: Listing, status: 'sold' | 'removed') => {
    try { await apiRequest(`/campus/marketplace/${listing.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
    catch (e) { Alert.alert('Unable to update listing', e instanceof Error ? e.message : 'Only the seller can update this listing.'); }
  };
  return <Screen title="Campus life" subtitle="Events, clubs, canteen finds and student listings." right={<HeaderActions />}>
    {error ? <Notice message={error} tone="error" /> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>{([
      ['events','Events'], ['marketplace','Marketplace'], ['canteen','Canteen'], ['lost_found','Lost & found']
    ] as Array<[Mode,string]>).map(([key,label]) => <AppButton key={key} title={label} variant={mode === key ? 'primary' : 'secondary'} onPress={() => setTab(key)} />)}</View>
    <Card>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{mode === 'events' ? 'Make something happen' : mode === 'canteen' ? 'Campus canteen listings' : mode === 'lost_found' ? 'Help something find its way home' : 'Give useful things a second life'}</Text>
      <Text style={{ color: colors.muted, lineHeight: 20 }}>{mode === 'events' ? 'Create a club meetup, study group or campus activity.' : mode === 'canteen' ? 'Share useful canteen details and updates with verified campus members.' : mode === 'lost_found' ? 'Post lost or found items without revealing private contact information.' : 'List used books, stationery and permitted student services. Payments are arranged separately.'}</Text>
      <AppButton title={showCreate ? 'Close form' : mode === 'events' ? 'Create campus event' : 'Create listing'} onPress={() => { setCreateType(mode === 'events' ? 'event' : 'listing'); setShowCreate((value) => !value); }} variant="secondary" />
      {showCreate ? <View style={{ gap: 12 }}>
        {createType === 'listing' ? <View style={{ gap: 7 }}><Text style={{ color: colors.muted, fontWeight: '700' }}>Listing category</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{categories.map((item) => <AppButton key={item.key} title={item.label} variant={category === item.key ? 'primary' : 'secondary'} onPress={() => setCategory(item.key)} />)}</View></View> : null}
        <Field label={createType === 'event' ? 'Event title' : 'Listing title'} value={title} onChangeText={setTitle} maxLength={160} placeholder={createType === 'event' ? 'e.g. Friday board-game meetup' : 'e.g. Semester 2 Chemistry book'} />
        <Field label="Description" value={description} onChangeText={setDescription} maxLength={createType === 'event' ? 4000 : 2000} multiline placeholder="Helpful details for your campus…" />
        {createType === 'event' ? <>
          <Field label="Club (optional)" value={club} onChangeText={setClub} maxLength={120} placeholder="e.g. Photography Club" />
          <Field label="Location label (no live location)" value={location} onChangeText={setLocation} maxLength={160} placeholder="e.g. Student Activity Hall" />
          <View style={{ flexDirection: 'row', gap: 10 }}><View style={{ flex: 1 }}><Field label="Starts in hours" keyboardType="number-pad" value={startsInHours} onChangeText={setStartsInHours} placeholder="24" /></View><View style={{ flex: 1 }}><Field label="Duration (hours)" keyboardType="decimal-pad" value={durationHours} onChangeText={setDurationHours} placeholder="2" /></View></View>
          <Field label="Capacity (optional)" keyboardType="number-pad" value={capacity} onChangeText={setCapacity} placeholder="Leave blank for no cap" />
        </> : category !== 'lost_found' && category !== 'canteen' ? <Field label="Price in ₹ (optional)" keyboardType="decimal-pad" value={price} onChangeText={setPrice} placeholder="e.g. 250" /> : null}
        <AppButton title={createType === 'event' ? 'Publish event' : 'Publish listing'} onPress={() => void saveItem()} loading={publishing} />
      </View> : null}
    </Card>
    <SectionTitle action={<AppButton title="Refresh" variant="ghost" onPress={() => void load()} />}>{mode === 'events' ? 'Upcoming events' : mode === 'canteen' ? 'Canteen information' : mode === 'lost_found' ? 'Lost and found' : 'Student marketplace'}</SectionTitle>
    {!loading && mode === 'events' && events.length === 0 ? <EmptyState title="Nothing scheduled yet" text="Be the first to bring people together on campus." /> : null}
    {mode === 'events' ? events.map((event) => <Card key={event.id}>
      <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800' }}>{event.title}</Text>
      <Text style={{ color: colors.primary, fontWeight: '700' }}>{new Date(event.starts_at).toLocaleString()}</Text>
      {event.location_label ? <Text style={{ color: colors.muted }}>⌖ {event.location_label}</Text> : null}
      {event.club_name ? <Text style={{ color: colors.muted }}>{event.club_name}</Text> : null}
      {event.description ? <Text style={{ color: colors.text, lineHeight: 20 }}>{event.description}</Text> : null}
      <Text style={{ color: colors.muted, fontSize: 12 }}>{event.registered_count} registered{event.capacity ? ` · capacity ${event.capacity}` : ''}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
        {event.registered_by_me ? <AppButton title="Registered · Cancel" variant="secondary" onPress={() => void cancelRegistration(event)} loading={workingId === event.id} /> : <AppButton title={event.capacity && event.registered_count >= event.capacity ? 'Event full' : 'Register'} onPress={() => void register(event)} loading={workingId === event.id} disabled={Boolean(event.capacity && event.registered_count >= event.capacity)} />}
        <AppButton title="Add to calendar" variant="ghost" onPress={() => void addCalendar(event)} />
        <AppButton title="Share" variant="ghost" onPress={() => void import('react-native').then(({ Share }) => Share.share({ message: `${event.title}\n${new Date(event.starts_at).toLocaleString()}\n${event.location_label ?? ''}\nunifrendly://campus` }))} />
      </View>
    </Card>) : null}
    {!loading && mode !== 'events' && listings.length === 0 ? <EmptyState title="No listings yet" text="Check back later, or post something useful for your campus." /> : null}
    {mode !== 'events' ? listings.map((listing) => <Card key={listing.id}>
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>{listing.title}</Text>
      <Text style={{ color: colors.primary, fontWeight: '800' }}>{listing.price_minor == null ? listing.category.replace('_',' ') : new Intl.NumberFormat('en-IN', { style: 'currency', currency: listing.currency }).format(listing.price_minor / 100)}</Text>
      {listing.description ? <Text style={{ color: colors.text, lineHeight: 20 }}>{listing.description}</Text> : null}
      <Text style={{ color: colors.muted, fontSize: 12 }}>Posted by {listing.seller_name} · expires {new Date(listing.expires_at).toLocaleDateString()}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><AppButton title="Share listing" variant="ghost" onPress={() => void import('react-native').then(({ Share }) => Share.share({ message: `${listing.title}\n${listing.description}\n${listing.price_minor == null ? 'Ask seller for details' : `${listing.currency} ${(listing.price_minor / 100).toFixed(2)}`}\nunifrendly://campus` }))} /><AppButton title="Report" variant="ghost" onPress={() => Alert.alert('Report listing?', 'Campus moderators will review the listing.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Report', style: 'destructive', onPress: () => void apiRequest('/reports', { method: 'POST', body: JSON.stringify({ targetType: 'listing', targetId: listing.id, reason: 'other', details: '' }) }).catch((e) => Alert.alert('Unable to report', e.message)) }])} /><AppButton title="Mark sold / remove" variant="ghost" onPress={() => Alert.alert('Listing options', 'Only the seller can change this listing.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Mark sold', onPress: () => void markListing(listing,'sold') }, { text: 'Remove listing', style: 'destructive', onPress: () => void markListing(listing,'removed') }])} /></View>
    </Card>) : null}
    <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>Campus-wide event visibility is institution-scoped. Marketplace payments are not handled by UniFrendly.</Text>
  </Screen>;
}
