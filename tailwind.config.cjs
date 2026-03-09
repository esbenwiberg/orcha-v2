/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('tool-design-system/preset')],
  content: [
    './src/web/views/**/*.html',
    './src/web/public/js/**/*.js',
    './src/web/routes/**/*.ts',
    './src/web/middleware/**/*.ts',
  ],
  safelist: [
    // Badge classes used via dynamic mapping (ETA interpolation, JS className assignment).
    // The status-badge partial and deploy-log script build class strings at runtime,
    // so Tailwind's static scanner may not see them in all code paths.
    'badge',
    'badge-neutral',
    'badge-accent',
    'badge-success',
    'badge-warning',
    'badge-error',
    'badge-info',
    'badge-sm',
    'badge-dot',
    'badge-pulse',
    // Activity indicator states (built dynamically from activityState in kanban-card.html)
    'kanban-card__activity--working',
    'kanban-card__activity--queued',
    'kanban-card__activity--review',
  ],
  theme: {
    extend: {},
  },
};
