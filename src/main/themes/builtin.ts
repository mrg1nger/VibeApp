import type { ThemeDefinition } from '@shared/types'

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'The original calm dark theme.',
    source: 'built-in',
    vars: {
      font: "-apple-system, 'Segoe UI', system-ui, sans-serif",
      radius: '8px',
      bg: '#111318',
      'bg-image': 'none',
      surface: '#1a1d24',
      'surface-raised': '#333844',
      'surface-sunken': '#0d0f14',
      border: '#2a2e38',
      text: '#e8e8ec',
      'text-muted': '#9aa0ab',
      accent: '#3b5bdb',
      'accent-text': '#ffffff',
      'accent-glow': 'none',
      title: 'linear-gradient(#e8e8ec, #e8e8ec)',
      'user-bubble': '#3b5bdb',
      'success-bg': '#1f4d2e',
      'success-text': '#7be3a0',
      'warning-bg': '#4d2f1f',
      'warning-text': '#e3a97b',
      danger: '#e37b7b',
      'danger-bg': '#4d1f1f',
      'danger-text': '#ffb4b4',
      'delegation-bg': '#22314d',
      'delegation-text': '#a7c3e3',
      overlay: 'rgba(0, 0, 0, 0.55)'
    }
  },
  {
    id: 'sakura-neon',
    name: 'Sakura Neon',
    description: 'Late-night anime coding session: indigo sky, sakura pink, cyan neon, CRT scanlines.',
    source: 'built-in',
    thinkingLabel: 'Claude is coding… (ง •̀_•́)ง',
    vars: {
      font: "'Segoe UI Rounded', 'Yu Gothic UI', 'Segoe UI', system-ui, sans-serif",
      radius: '14px',
      bg: '#0f0a1f',
      'bg-image':
        'radial-gradient(circle at 12% 18%, rgba(255, 94, 170, 0.28), transparent 38%), ' +
        'radial-gradient(circle at 88% 82%, rgba(64, 224, 255, 0.22), transparent 40%), ' +
        'radial-gradient(circle at 70% 10%, rgba(167, 112, 255, 0.2), transparent 30%), ' +
        'radial-gradient(circle at 30% 70%, rgba(255, 182, 219, 0.08) 0 2px, transparent 3px), ' +
        'repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 3px)',
      surface: 'rgba(28, 18, 52, 0.82)',
      'surface-raised': '#3a2466',
      'surface-sunken': '#0a0616',
      border: '#5b3a8f',
      text: '#fdf2ff',
      'text-muted': '#c4a8e6',
      accent: '#ff5eaa',
      'accent-text': '#1a0b2e',
      'accent-glow': '0 0 14px rgba(255, 94, 170, 0.55)',
      title: 'linear-gradient(90deg, #ff5eaa, #ffd1ec 45%, #5ee7ff)',
      'user-bubble': 'linear-gradient(135deg, #ff5eaa, #a770ff)',
      'success-bg': '#123d3a',
      'success-text': '#6effd8',
      'warning-bg': '#4a2a12',
      'warning-text': '#ffc46b',
      danger: '#ff6b8b',
      'danger-bg': '#4d1030',
      'danger-text': '#ffc2d4',
      'delegation-bg': '#13345a',
      'delegation-text': '#8fe9ff',
      overlay: 'rgba(10, 4, 24, 0.72)'
    }
  }
]
