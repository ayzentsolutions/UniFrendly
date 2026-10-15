import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { mediaDownloadUrl } from '@/lib/api';
import { usePalette } from '@/lib/theme';
export function MediaPhoto({ mediaId }: { mediaId: string }) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const colors = usePalette();
  useEffect(() => {
    let active = true;
    mediaDownloadUrl(mediaId).then((url) => { if (active) setUri(url); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [mediaId]);
  return <View style={{ minHeight: 60, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.input, alignItems: 'center', justifyContent: 'center' }}>
    {uri ? <Image source={{ uri }} resizeMode="cover" style={{ width: '100%', height: 240 }} accessibilityLabel="Post attachment" /> : failed ? null : <ActivityIndicator color={colors.primary} style={{ height: 100 }} />}
  </View>;
}
