/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

module.exports = {
  content: ['./index.html', './assets/js/app.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        // Superfícies e textos mudam com o tema (veja :root e .dark em src/input.css)
        surface: v('surface'),
        cohab: {
          terracotta: '#B84231',
          terracottaDark: '#963324',
          terracottaLight: v('terracotta-light'),
          graphite: v('graphite'),
          graphiteDark: v('graphite-dark'),
          medium: v('medium'),
          bg: v('bg'),
          border: v('border'),
          ink: v('ink'),
          inkDark: v('ink-dark'),
          subtle: v('subtle'),
          past: v('past'),
          pastCard: v('past-card'),
          muted: v('muted'),
          weekend: v('weekend')
        }
      },
      boxShadow: { '2xs': '0 1px 1px 0 rgb(0 0 0 / 0.04)', xs: '0 1px 2px 0 rgb(0 0 0 / 0.06)' },
      backdropBlur: { xs: '2px' },
      minWidth: { 5: '1.25rem', 6: '1.5rem' }
    }
  },
  plugins: []
};
