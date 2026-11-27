/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        brand: {
          // one calm accent (teal) for active nav, links and focus
          50: '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
          950: '#042f2e',
        },
      },
      keyframes: {
        pulseRing: { '0%': { boxShadow: '0 0 0 0 rgba(34,197,94,.6)' }, '100%': { boxShadow: '0 0 0 8px rgba(34,197,94,0)' } },
        flash: { '0%': { backgroundColor: 'rgba(20,184,166,.18)' }, '100%': { backgroundColor: 'transparent' } },
        slideIn: { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        pop: { from: { transform: 'scale(.96)', opacity: 0 }, to: { transform: 'scale(1)', opacity: 1 } },
      },
      animation: {
        pulseRing: 'pulseRing 1.6s ease-out infinite',
        flash: 'flash 1.2s ease-out',
        slideIn: 'slideIn .2s ease-out',
        pop: 'pop .15s ease-out',
      },
    },
  },
  plugins: [],
};
