import { useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, LogIn, UserRound } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useRouter } from '../router.jsx';
import { useSession } from '../session.jsx';
import { ErrorBanner, Spinner } from '../components/ui.jsx';

const OPERATOR = 'operator';

/** Demo login: pick who to browse as. No password — see session.jsx. */
export default function LoginPage() {
  const { t, lang, setLang } = useI18n();
  const { signIn } = useSession();
  const { path, navigate } = useRouter();
  const [state, setState] = useState({ status: 'loading', personas: [], error: null });
  const [choice, setChoice] = useState('');

  useEffect(() => {
    let live = true;
    api.personas()
      .then((r) => {
        if (!live) return;
        setState({ status: 'ready', personas: r.personas, error: null });
        setChoice((c) => c || r.personas[0]?.user_id || '');
      })
      .catch((error) => live && setState({ status: 'error', personas: [], error }));
    return () => { live = false; };
  }, []);

  const selected = useMemo(() => state.personas.find((p) => p.user_id === choice) ?? null, [state.personas, choice]);
  const operator = choice === OPERATOR;

  function submit(e) {
    e.preventDefault();
    if (operator) {
      signIn({ user_id: OPERATOR, display_name: t('login.operator'), home_currency: 'INR', role: 'operator' });
      navigate('/ops', { replace: true });
    } else if (selected) {
      signIn({ user_id: selected.user_id, display_name: selected.display_name, home_currency: selected.home_currency, role: 'traveller' });
      if (path === '/ops') navigate('/', { replace: true }); // the ops page is for the operator login only
    }
  }

  return (
    <div className="login-page">
      <div className="login-top">
        <div className="brand"><span className="brand-mark" aria-hidden="true">K</span><span>Kognivera</span></div>
        <div className="lang-toggle" role="group" aria-label={t('header.language')}>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')} aria-pressed={lang === 'en'}>EN</button>
          <button className={lang === 'hi' ? 'on' : ''} onClick={() => setLang('hi')} aria-pressed={lang === 'hi'}>हिं</button>
        </div>
      </div>

      <form className="login-card" onSubmit={submit}>
        <span className="badge accent">{t('login.badge')}</span>
        <h1>{t('login.title')}</h1>
        <p className="muted">{t('login.note')}</p>

        <ErrorBanner error={state.error} onRetry={() => window.location.reload()} />
        {state.status === 'loading' && <Spinner label={t('login.loading')} />}

        {state.status === 'ready' && (
          <>
            <label className="field">
              <span>{t('login.choose')}</span>
              <select className="input lg" value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
                <optgroup label={t('login.travellers')}>
                  {state.personas.map((p) => (
                    <option key={p.user_id} value={p.user_id}>
                      {p.display_name} · {p.home_currency}{p.lead ? ` · ${t('login.lead')}` : ''}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t('login.operations')}>
                  <option value={OPERATOR}>{t('login.operator')}</option>
                </optgroup>
              </select>
            </label>

            <div className="login-who" aria-live="polite">
              <span className="who-icon">{operator ? <LayoutDashboard size={22} /> : <UserRound size={22} />}</span>
              {operator ? (
                <div>
                  <strong>{t('login.operator')}</strong>
                  <p className="muted small">{t('login.operatorNote')}</p>
                </div>
              ) : (
                selected && (
                  <div>
                    <strong>{selected.display_name}</strong>
                    <p className="muted small">
                      {t('login.home', { cur: selected.home_currency })}
                      {selected.loyalty_tier && selected.loyalty_tier !== 'none' ? ` · ${t('login.tier', { tier: selected.loyalty_tier })}` : ''}
                      {selected.lead ? ` · ${t('login.lead')}` : ''}
                    </p>
                  </div>
                )
              )}
            </div>

            <button className="btn primary lg block" type="submit" disabled={!choice}>
              <LogIn size={18} /> {t('login.signIn')}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
