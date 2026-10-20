import type { Config } from 'tailwindcss';

// Colours are CSS variables from theme.css. They are plain hex, so Tailwind opacity modifiers such as
// `bg-primary/10` cannot work with them (and silently emit nothing); use the dedicated tokens
// instead: `bg-primary-soft`, `hover:bg-hover`.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        bad: 'var(--bad)',
        muted: 'var(--muted)',
        primary: 'var(--primary)',
        'primary-foreground': 'var(--primary-foreground)',
        'primary-soft': 'var(--primary-soft)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: 'var(--card)',
        'card-foreground': 'var(--card-foreground)',
        hover: 'var(--hover)',
        soft: 'var(--soft)',
        'ok-bg': 'var(--ok-bg)',
        'warn-bg': 'var(--warn-bg)',
        'bad-bg': 'var(--bad-bg)',
        'blue-bg': 'var(--blue-bg)',
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
      },
    },
  },
  plugins: [],
} satisfies Config;
