import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n.jsx';
import { RouterProvider } from './router.jsx';
import { SessionProvider, useSession } from './session.jsx';
import { AppProvider } from './context.jsx';
import { TripProvider } from './trip.jsx';
import App from './App.jsx';
import './styles.css';

// A fresh trip store per signed-in user: switching user remounts it, so nobody sees another user's cart.
function Trip({ children }) {
  const { session } = useSession();
  return (
    <TripProvider key={session?.user_id ?? 'anon'} userId={session?.user_id}>
      {children}
    </TripProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <RouterProvider>
        <SessionProvider>
          <AppProvider>
            <Trip>
              <App />
            </Trip>
          </AppProvider>
        </SessionProvider>
      </RouterProvider>
    </I18nProvider>
  </StrictMode>,
);
