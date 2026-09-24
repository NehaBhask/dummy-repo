import { useEffect, useState } from 'react';
import { Activity, CalendarDays, Compass, Gauge, LogOut, Luggage, Menu, Radar, Settings2, X } from 'lucide-react';
import { useApp } from './context.jsx';
import { useI18n } from './i18n.jsx';
import { useSession } from './session.jsx';
import { useTrip } from './trip.jsx';
import { Link, matchPath, useRouter } from './router.jsx';
import { Countdown, Empty, Spinner } from './components/ui.jsx';
import LoginPage from './pages/LoginPage.jsx';
import HomePage from './pages/HomePage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import HotelPage from './pages/HotelPage.jsx';
import HoldPage from './pages/HoldPage.jsx';
import ConfirmationPage from './pages/ConfirmationPage.jsx';
import BookingsPage from './pages/BookingsPage.jsx';
import VisualizerPage from './pages/VisualizerPage.jsx';
import LoadTestPage from './pages/LoadTestPage.jsx';
import OpsPage from './pages/OpsPage.jsx';

const TRAVELLER_NAV = [
  { to: '/', key: 'nav.explore', icon: Compass, on: (p) => p === '/' || p.startsWith('/search') || p.startsWith('/hotel') },
  { to: '/hold', key: 'nav.trip', icon: Luggage, on: (p) => p === '/hold' || p.startsWith('/confirmation'), trip: true },
  { to: '/bookings', key: 'nav.bookings', icon: CalendarDays, on: (p) => p === '/bookings' },
  { to: '/visualizer', key: 'nav.visualizer', icon: Radar, on: (p) => p === '/visualizer' },
  { to: '/loadtest', key: 'nav.loadtest', icon: Gauge, on: (p) => p === '/loadtest' },
];
const OPERATOR_NAV = [
  { to: '/ops', key: 'nav.ops', icon: Activity, on: (p) => p === '/ops' },
  { to: '/visualizer', key: 'nav.visualizer', icon: Radar, on: (p) => p === '/visualizer' },
  { to: '/loadtest', key: 'nav.loadtest', icon: Gauge, on: (p) => p === '/loadtest' },
];
const OPS_PATHS = ['/visualizer', '/loadtest', '/ops'];
const OPERATOR_PATHS = ['/ops', '/visualizer', '/loadtest'];

function DemoMenu() {
  const { t } = useI18n();
  const { settings, setSettings } = useTrip();
  return (
    <details className="demo-menu">
      <summary title={t('demo.note')}>
        <Settings2 size={15} aria-hidden="true" /> <span>{t('demo.title')}</span>
      </summary>
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

// Who is signed in, and the way to switch (each tab keeps its own session).
function UserMenu() {
  const { t } = useI18n();
  const { session, signOut } = useSession();
  const { navigate } = useRouter();
  if (!session) return null;
  const operator = session.role === 'operator';
  return (
    <details className="user-menu">
      <summary title={session.display_name}>
        <span className="avatar" aria-hidden="true">{session.display_name.slice(0, 1).toUpperCase()}</span>
        <span className="uname">{session.display_name}</span>
      </summary>
      <div className="user-pop">
        <p className="muted tiny">{t('user.signedInAs')}</p>
        <strong>{session.display_name}</strong>
        <p className="muted small">{operator ? t('user.role.operator') : `${t('user.role.traveller')} · ${session.home_currency}`}</p>
        <button className="btn outline sm block" onClick={() => { signOut(); navigate('/', { replace: true }); }}>
          <LogOut size={14} /> {t('user.switch')}
        </button>
      </div>
    </details>
  );
}

function Header() {
  const { t, lang, setLang } = useI18n();
  const { path } = useRouter();
  const { role } = useSession();
  const { currency, setCurrency, currencies, meta } = useApp();
  const { items, reserved } = useTrip();
  const [open, setOpen] = useState(false);
  const soonest = reserved ? items.map((i) => i.expires_at).sort()[0] : null;
  const nav = role === 'operator' ? OPERATOR_NAV : TRAVELLER_NAV;

  const links = nav.map(({ to, key, icon: Icon, on, trip }) => (
    <Link key={to} to={to} className={`nav-link ${on(path) ? 'active' : ''}`} onClick={() => setOpen(false)}>
      <Icon size={16} aria-hidden="true" />
      {t(key)}
      {trip && items.length > 0 && (
        <span className="nav-count">
          {items.length}
          {reserved && <Countdown expiresAt={soonest} compact />}
        </span>
      )}
    </Link>
  ));

  return (
    <header className="site-header">
      <div className={`site-header-inner ${OPS_PATHS.includes(path) ? 'wide' : ''}`}>
        <Link to={role === 'operator' ? '/ops' : '/'} className="brand" aria-label="Kognivera">
          <span className="brand-mark" aria-hidden="true">K</span>
          <span>Kognivera</span>
        </Link>
        <nav className="site-nav" aria-label="Main">{links}</nav>
        <div className="header-tools">
          {role !== 'operator' && (
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
          )}
          <div className="lang-toggle" role="group" aria-label={t('header.language')}>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')} aria-pressed={lang === 'en'}>EN</button>
            <button className={lang === 'hi' ? 'on' : ''} onClick={() => setLang('hi')} aria-pressed={lang === 'hi'}>हिं</button>
          </div>
          {role !== 'operator' && meta?.demo_controls && <DemoMenu />}
          <UserMenu />
          <button className="menu-btn" aria-label={t('nav.menu')} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>
      {open && <nav className="mobile-nav" aria-label="Mobile">{links}</nav>}
    </header>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} onClick={() => dismissToast(x.id)}>{x.message}</div>
      ))}
    </div>
  );
}

function Routes() {
  const { path, navigate } = useRouter();
  const { role } = useSession();
  const { t } = useI18n();
  const operatorOnTravellerPage = role === 'operator' && !OPERATOR_PATHS.includes(path);
  // The operator has no traveller identity: send them to their dashboard instead of a page that would be refused.
  useEffect(() => {
    if (operatorOnTravellerPage) navigate('/ops', { replace: true });
  }, [operatorOnTravellerPage, navigate]);
  if (operatorOnTravellerPage) return null;

  let m;
  if (path === '/ops') {
    return role === 'operator' ? <OpsPage /> : (
      <div className="container narrow page">
        <Empty icon={Activity} title={t('ops.operatorsOnly')}>{t('ops.operatorsOnlyBody')}</Empty>
      </div>
    );
  }
  if (path === '/') return <HomePage />;
  if (path === '/search') return <SearchPage />;
  if ((m = matchPath('/hotel/:hotelId', path))) return <HotelPage hotelId={m.hotelId} />;
  if (path === '/hold') return <HoldPage />;
  if ((m = matchPath('/confirmation/:bookingId', path))) return <ConfirmationPage bookingId={m.bookingId} />;
  if (path === '/bookings') return <BookingsPage />;
  if (path === '/visualizer') return <VisualizerPage />;
  if (path === '/loadtest') return <LoadTestPage />;
  return (
    <div className="container narrow page">
      <Empty title={t('notfound.title')}>
        <Link className="btn primary" to="/">{t('notfound.cta')}</Link>
      </Empty>
    </div>
  );
}

export default function App() {
  const { meta, bootError } = useApp();
  const { session } = useSession();
  const { path } = useRouter();
  const { t } = useI18n();
  if (!session) return <LoginPage />;
  const ops = OPS_PATHS.includes(path);

  return (
    <div className={`app ${ops ? 'ops' : ''}`}>
      <Header />
      <main className="main">
        {bootError ? (
          <div className="container page">
            <div className="banner bad">
              <strong>{t('error.boot')}</strong> <span className="mono">{bootError.message}</span>
            </div>
          </div>
        ) : !meta ? (
          <div className="container page"><Spinner label={t('common.loading')} /></div>
        ) : (
          <Routes />
        )}
      </main>
      <footer className="footer">{t('footer.tagline')}</footer>
      <Toasts />
    </div>
  );
}
