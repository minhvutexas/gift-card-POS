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
          50: '#fdf2f8',
          100: '#fce7f3',
          200: '#fbcfe8',
          400: '#f472b6',
          500: '#ec4899',
          600: '#db2777',
          700: '#be185d',
          800: '#9d174d',
          900: '#831843',
        },
      },
      keyframes: {
        pulseRing: { '0%': { boxShadow: '0 0 0 0 rgba(34,197,94,.6)' }, '100%': { boxShadow: '0 0 0 8px rgba(34,197,94,0)' } },
        flash: { '0%': { backgroundColor: 'rgba(236,72,153,.25)' }, '100%': { backgroundColor: 'transparent' } },
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
