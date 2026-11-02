import "./concept.css";

// Explicitly namespaced: the existing *.css Turbopack loader bypasses CSS Modules.
export const previewStyles = {
  study: "alfred-ui-study",
  current: "alfred-ui-current",
  dashboard: "alfred-ui-dashboard",
  heading: "alfred-ui-heading",
  controls: "alfred-ui-controls",
  ranges: "alfred-ui-ranges",
  talk: "alfred-ui-talk",
  balances: "alfred-ui-balances",
  balanceLabel: "alfred-ui-balanceLabel",
  summary: "alfred-ui-summary",
  insights: "alfred-ui-insights",
  trends: "alfred-ui-trends",
  legend: "alfred-ui-legend",
  transactions: "alfred-ui-transactions",
  categories: "alfred-ui-categories",
  previewTools: "alfred-ui-previewTools",
  demoLabel: "alfred-ui-demoLabel",
  comparison: "alfred-ui-comparison",
  themeButton: "alfred-ui-themeButton",
  notice: "alfred-ui-notice",
} as const;
