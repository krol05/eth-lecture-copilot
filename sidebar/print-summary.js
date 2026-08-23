/**
 * Opens from sidebar with summary HTML in localStorage (set by sidebar.js).
 * Triggers the browser print dialog (Save as PDF). Logic in print-common.js.
 */
runPrintPage({
  key: 'eth-copilot-print-summary',
  defaultTitle: 'Lecture summary',
  bodyClass: 'export-summary-body',
  footerText: 'ETH Lecture Copilot — lecture summary export (KaTeX rendered)'
});
