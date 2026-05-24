import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

declare var Chart: any;
declare var ChartDataLabels: any;

if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
  Chart.register(ChartDataLabels);
}

// === DIAGNOSTIC: Show errors visually ===
function showError(msg: string) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#cc0000;color:#fff;padding:20px;font-size:14px;z-index:99999;white-space:pre-wrap;font-family:monospace;';
  div.textContent = '初期化エラー:\n' + msg;
  document.body.appendChild(div);
}
window.addEventListener('error', (e) => showError(e.message + '\n' + (e.filename || '') + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => showError(String(e.reason)));
// =========================================

const container = document.getElementById('root');

if (!container) {
  throw new Error('Failed to find the root element');
}

const root = createRoot(container);

const renderApp = () => {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
};

// Check for required elements before rendering
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderApp);
} else {
  renderApp();
}
