import { Platform } from 'react-native';
export const theme = {
  bg: '#101719', surface: '#182124', raised: '#222d30', border: '#334044',
  text: '#f0f3ed', muted: '#93a3a7', dim: '#617478', accent: '#c4f58a',
  accentDark: '#273a23', warning: '#f5c98a', error: '#ffafa6',
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
};
