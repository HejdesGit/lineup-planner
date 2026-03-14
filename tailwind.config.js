/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pitch: {
          50: '#f3f7ef',
          100: '#dce8d3',
          200: '#b4cf9d',
          300: '#86b270',
          400: '#4d8b48',
          500: '#2f6434',
          600: '#214a27',
          700: '#18371d',
          800: '#102715',
          900: '#0b1b0f',
        },
        clay: {
          50: '#fdf6eb',
          100: '#f6dcc0',
          200: '#eebe8c',
          300: '#e49d59',
          400: '#d47d33',
          500: '#b86424',
          600: '#8f4d1f',
          700: '#69391b',
          800: '#452515',
          900: '#28140c',
        },
      },
      boxShadow: {
        board: '0 24px 80px rgba(5, 23, 10, 0.28)',
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'sans-serif'],
        body: ['"IBM Plex Sans"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}
