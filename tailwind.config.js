/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './assets/js/app.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        cohab: {
          terracotta: '#B84231', terracottaDark: '#963324', terracottaLight: '#FDF3F1',
          graphite: '#4A4A4A', graphiteDark: '#333333', medium: '#7A7A7A', bg: '#F5F5F5', border: '#E2E2E2'
        }
      },
      boxShadow: { '2xs': '0 1px 1px 0 rgb(0 0 0 / 0.04)', xs: '0 1px 2px 0 rgb(0 0 0 / 0.06)' },
      backdropBlur: { xs: '2px' },
      minWidth: { 5: '1.25rem', 6: '1.5rem' }
    }
  },
  plugins: []
};
