import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n.jsx';
import { RouterProvider } from './router.jsx';
import { AppProvider } from './context.jsx';
import { TripProvider } from './trip.jsx';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <RouterProvider>
        <AppProvider>
          <TripProvider>
            <App />
          </TripProvider>
        </AppProvider>
      </RouterProvider>
    </I18nProvider>
  </StrictMode>,
);
