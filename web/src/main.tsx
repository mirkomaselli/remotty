import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { BASE_PATH, appAsset } from './lib/base-path';
import { redirectToSavedServer } from './lib/native-pairing';

// SW solo in contesto sicuro (https / localhost): su HTTP LAN non è disponibile.
if (window.isSecureContext && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(appAsset('sw.js'), { scope: appAsset('') })
      .catch(() => {});
  });
}

const clearBadge = (): void => {
  if (document.visibilityState !== 'visible') return;
  const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  void nav.clearAppBadge?.().catch(() => {});
};
document.addEventListener('visibilitychange', clearBadge);
clearBadge();

void redirectToSavedServer()
  .catch(() => false)
  .then((redirecting) => {
    if (redirecting) return;
    createRoot(document.getElementById('root')!).render(
      <BrowserRouter basename={BASE_PATH || undefined}>
        <App />
      </BrowserRouter>,
    );
  });
