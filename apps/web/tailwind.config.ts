import type { Config } from 'tailwindcss';

// Colours are CSS variables from theme.css (semantic and component tokens only, never the --ref-* palette). They resolve to plain hex, so Tailwind opacity modifiers such as
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
        'primary-deep': 'var(--primary-deep)',
        vio: 'var(--vio)',
        'vio-bg': 'var(--vio-bg)',
        ink2: 'var(--ink2)',
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
        blue: 'var(--blue)',
        border: 'var(--border)',
        'on-bad': 'var(--on-bad)',
        hero: 'var(--hero)',
        'on-hero': 'var(--on-hero)',
        'on-hero-muted': 'var(--on-hero-muted)',
        'hero-chip': 'var(--hero-chip)',
        'hero-icon': 'var(--hero-icon)',
        'hero-action': 'var(--hero-action)',
        'on-hero-action': 'var(--on-hero-action)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,27,22,0.04)',
        // hover lift for clickable cards; dark enough to read on the dark surfaces too
        lift: '0 12px 28px -14px rgba(0,0,0,0.45)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      // wrong-PIN feedback on the PIN dots (motion-safe only)
      keyframes: {
        shake: { '0%, 100%': { transform: 'translateX(0)' }, '20%, 60%': { transform: 'translateX(-6px)' }, '40%, 80%': { transform: 'translateX(6px)' } },
      },
      animation: { shake: 'shake 0.4s ease-in-out' },
      fontFamily: {
        sans: ['var(--font-sans)'],
      },
    },
  },
  plugins: [],
} satisfies Config;
