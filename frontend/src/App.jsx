import { useApp } from './context.jsx';
import { useI18n } from './i18n.jsx';
import { useTrip } from './trip.jsx';
import { Countdown, Spinner } from './components/ui.jsx';
import SearchPage from './pages/SearchPage.jsx';
import TripPage from './pages/TripPage.jsx';
import BookingsPage from './pages/BookingsPage.jsx';
import LoadTestPage from './pages/LoadTestPage.jsx';

const NAV = [
  ['search', 'nav.search'],
  ['trip', 'nav.trip'],
  ['bookings', 'nav.bookings'],
  ['loadtest', 'nav.loadtest'],
];

function DemoMenu() {
  const { t } = useI18n();
  const { settings, setSettings } = useTrip();
  return (
    <details className="demo-menu">
      <summary title={t('demo.note')}>⚙ {t('demo.title')}</summary>
      <div className="demo-pop">
        <p className="muted small">{t('demo.note')}</p>
        <label>
          <span>{t('demo.ttl')}</span>
          <select value={settings.ttl} onChange={(e) => setSettings({ ttl: Number(e.target.value) })}>
            <option value={0}>{t('demo.ttlDefault')}</option>
            <option value={60}>60 s</option>
            <option value={15}>15 s</option>
          </select>
        </label>
        <label>
          <span>{t('demo.fail')}</span>
          <select value={settings.simulate} onChange={(e) => setSettings({ simulate: e.target.value })}>
            <option value="">{t('demo.failNone')}</option>
            <option value="flight">{t('demo.failFlight')}</option>
            <option value="hotel">{t('demo.failHotel')}</option>
            <option value="payment">{t('demo.failPayment')}</option>
          </select>
        </label>
      </div>
    </details>
  );
}

function Header() {
  const { t, lang, setLang } = useI18n();
  const { route, navigate, currency, setCurrency, currencies, meta } = useApp();
  const { active } = useTrip();
  const soonest = active.length ? active.map((i) => i.expires_at).sort()[0] : null;

  return (
    <header className="header">
      <div className="header-inner">
        <a className="brand" href="#/search" aria-label="Kognivera">
          <span className="brand-mark" aria-hidden="true">◈</span>
          <span>Kognivera</span>
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map(([id, key]) => (
            <button key={id} className={`nav-item ${route === id ? 'active' : ''}`} onClick={() => navigate(id)}>
              {t(key)}
              {id === 'trip' && active.length > 0 && (
                <span className="nav-badge">
                  {active.length}
                  <Countdown expiresAt={soonest} compact />
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="header-tools">
          <label className="select-pill" title={t('header.currency')}>
            <span className="sr-only">{t('header.currency')}</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.iso4217} value={c.iso4217}>
                  {c.iso4217} {c.symbol}
                </option>
              ))}
            </select>
          </label>
          <div className="lang-toggle" role="group" aria-label={t('header.language')}>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')} aria-pressed={lang === 'en'}>
              EN
            </button>
            <button className={lang === 'hi' ? 'on' : ''} onClick={() => setLang('hi')} aria-pressed={lang === 'hi'}>
              हिं
            </button>
          </div>
          {meta?.demo_controls && <DemoMenu />}
          {meta && <span className="user-pill" title={meta.user.user_id}>{meta.user.display_name}</span>}
        </div>
      </div>
    </header>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} onClick={() => dismissToast(x.id)}>
          {x.message}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const { route, meta, bootError } = useApp();
  const { t } = useI18n();

  return (
    <>
      <Header />
      <main className="main">
        {bootError ? (
          <div className="banner bad">
            <strong>{t('error.boot')}</strong> <span className="mono">{bootError.message}</span>
          </div>
        ) : !meta ? (
          <Spinner label={t('common.loading')} />
        ) : (
          <>
            {route === 'search' && <SearchPage />}
            {route === 'trip' && <TripPage />}
            {route === 'bookings' && <BookingsPage />}
            {route === 'loadtest' && <LoadTestPage />}
          </>
        )}
      </main>
      <footer className="footer">{t('footer.tagline')}</footer>
      <Toasts />
    </>
  );
}
