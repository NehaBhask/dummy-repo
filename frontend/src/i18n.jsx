import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './locales/en.json';
import hi from './locales/hi.json';
import { setApiLang } from './api.js';

// Static UI text lives in reviewed JSON files (en/hi), not in a runtime translation call: instant,
// works offline, and cannot mistranslate a button on stage. Numbers, dates and money are formatted
// with Intl, never translated.
const dictionaries = { en, hi };
const LOCALES = { en: 'en-IN', hi: 'hi-IN' };
const I18nCtx = createContext(null);

const initialLang = () => {
  try {
    return localStorage.getItem('kognivera.lang') === 'hi' ? 'hi' : 'en';
  } catch {
    return 'en';
  }
};

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    setApiLang(lang);
    try {
      localStorage.setItem('kognivera.lang', lang);
    } catch {
      /* private mode: the toggle still works for this session */
    }
  }, [lang]);
  setApiLang(lang); // also synchronously, so requests made during the same render use it

  const t = useCallback(
    (key, vars) => {
      let s = dictionaries[lang][key] ?? dictionaries.en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
    [lang],
  );

  const value = useMemo(() => {
    const locale = LOCALES[lang];
    return {
      lang,
      t,
      setLang: setLangState,
      // Display only: Number() is fine for rendering, never for arithmetic.
      money: (amount, currency) => {
        try {
          return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(amount));
        } catch {
          return `${amount} ${currency}`;
        }
      },
      date: (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
        new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)),
      dateTime: (iso) =>
        new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)),
      // Flight times are stored as UTC instants with no airport time zone, so they are shown as UTC clock times.
      time: (iso) => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(iso)),
      num: (n) => new Intl.NumberFormat(locale).format(n),
    };
  }, [lang, t]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
