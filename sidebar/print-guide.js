/**
 * Opens from sidebar with guide HTML in localStorage (set by sidebar.js).
 * Triggers the browser print dialog (Save as PDF). Logic in print-common.js.
 */
runPrintPage({
  key: 'eth-copilot-print-guide',
  defaultTitle: 'Lecture guide',
  footerText: 'ETH Lecture Copilot — guide export (KaTeX rendered)'
});
