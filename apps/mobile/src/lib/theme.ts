import { useColorScheme } from 'react-native';
export const palette = {
  light: { background: '#F7F8FC', surface: '#FFFFFF', text: '#1D2130', muted: '#6D7488', border: '#E3E6EF', primary: '#6556D9', primarySoft: '#EEECFF', accent: '#EA6A9B', danger: '#C23D53', success: '#237A5A', input: '#F2F3F8' },
  dark: { background: '#11131B', surface: '#1A1E2A', text: '#F2F3FA', muted: '#A0A7BB', border: '#303647', primary: '#B1A7FF', primarySoft: '#302A4B', accent: '#FF8CB5', danger: '#FF8A9D', success: '#70D6AC', input: '#242938' }
};
export function usePalette() { return palette[useColorScheme() === 'dark' ? 'dark' : 'light']; }
