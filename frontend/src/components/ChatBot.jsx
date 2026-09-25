import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, RotateCcw, Send, X } from 'lucide-react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { matchPath, useQuery, useRouter } from '../router.jsx';
import { useSession } from '../session.jsx';
import { useTrip } from '../trip.jsx';

/*
 * Booking assistant. Every message carries a snapshot of what the traveller is looking at (page, filters, trip cart), so
 * "book the cheapest room here" or "what's in my trip?" needs no explaining. The reply comes from the assistant service
 * (a LangChain agent using MCP tools); when it books something the answer includes a button to open the booking.
 */

const KEEP = 30; // messages kept per user, per tab

function pageOf(path, params) {
  if (path === '/') return 'explore';
  if (path === '/search') return params.type === 'flights' ? 'flight_search' : 'hotel_search';
  if (path.startsWith('/hotel/')) return 'hotel';
  if (path === '/hold') return 'trip';
  if (path.startsWith('/confirmation/')) return 'confirmation';
  if (path === '/bookings') return 'bookings';
  return path.replace(/^\//, '') || 'explore';
}

/** Tiny safe markdown: **bold**, "- " / "1. " lists, line breaks. Rendered as React nodes, never as HTML. */
function Rich({ text }) {
  const inline = (s) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
    );
  const blocks = [];
  let list = null;
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      if (!list) blocks.push((list = []));
      list.push(item[1]);
    } else {
      list = null;
      if (line.trim()) blocks.push(line);
    }
  }
  return (
    <>
      {blocks.map((b, i) =>
        Array.isArray(b) ? (
          <ul key={i}>{b.map((li, j) => <li key={j}>{inline(li)}</li>)}</ul>
        ) : (
          <p key={i}>{inline(b)}</p>
        ),
      )}
    </>
  );
}

export default function ChatBot() {
  const { t } = useI18n();
  const { meta, currency } = useApp();
  const { session } = useSession();
  const { path, navigate } = useRouter();
  const [params] = useQuery();
  const trip = useTrip();

  const storeKey = `kognivera.chat:${session?.user_id}`;
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storeKey)) ?? [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(storeKey, JSON.stringify(messages.slice(-KEEP)));
    } catch {
      /* storage can be blocked: the chat still works for this page view */
    }
  }, [messages, storeKey]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy, open]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const page = pageOf(path, params);

  // What the assistant is told about the screen. Kept small: it goes into the model prompt.
  const context = useMemo(() => {
    const hotel = matchPath('/hotel/:hotelId', path);
    const booking = matchPath('/confirmation/:bookingId', path);
    return {
      page,
      path,
      query: params,
      hotel_id: hotel?.hotelId,
      booking_id: booking?.bookingId,
      today: meta?.today,
      currency,
      trip: {
        items: trip.items.map((i) => ({ title: i.title, kind: i.kind, status: i.status, units: i.units })),
        reserved: trip.reserved,
        expires_at: trip.reserved ? trip.items.map((i) => i.expires_at).sort()[0] : undefined,
      },
    };
  }, [page, path, params, meta?.today, currency, trip.items, trip.reserved]);

  const send = useCallback(
    async (text) => {
      const message = text.trim();
      if (!message || busy) return;
      const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.text }));
      setMessages((m) => [...m, { role: 'user', text: message }]);
      setInput('');
      setBusy(true);
      try {
        const { data } = await api.chat({ message, history, context });
        setMessages((m) => [...m, { role: 'assistant', text: data.reply, steps: data.steps, actions: data.actions }]);
        // anything the assistant reserved, paid, released or cancelled shows up in the trip cart straight away
        if (data.steps?.some((s) => ['reserve_trip', 'pay_and_confirm', 'release_holds', 'cancel_booking'].includes(s.tool))) trip.syncHolds();
      } catch (e) {
        setMessages((m) => [...m, { role: 'assistant', text: e.message || t('chat.error'), error: true }]);
      } finally {
        setBusy(false);
      }
    },
    [busy, messages, context, t, trip],
  );

  const suggestions = {
    explore: ['chat.s.exploreHotels', 'chat.s.exploreFlights', 'chat.s.whatCan'],
    hotel_search: ['chat.s.cheapest', 'chat.s.breakfast', 'chat.s.whatCan'],
    flight_search: ['chat.s.cheapestFlight', 'chat.s.oneStop', 'chat.s.whatCan'],
    hotel: ['chat.s.hotelFree', 'chat.s.bookCheapestRoom', 'chat.s.whatCan'],
    trip: ['chat.s.tripSummary', 'chat.s.payTrip', 'chat.s.whatCan'],
    bookings: ['chat.s.myBookings', 'chat.s.cancelLatest', 'chat.s.whatCan'],
    confirmation: ['chat.s.thisBooking', 'chat.s.myBookings', 'chat.s.whatCan'],
  }[page] ?? ['chat.s.whatCan'];

  const actionLabel = { view_booking: t('chat.viewBooking'), my_bookings: t('chat.myBookings'), view_trip: t('chat.viewTrip') };

  if (meta && meta.assistant && meta.assistant.enabled === false) return null;

  return (
    <div className="chatbot">
      {open && (
        <section className="chat-panel" role="dialog" aria-label={t('chat.title')}>
          <header className="chat-head">
            <span className="chat-avatar" aria-hidden="true"><Bot size={18} /></span>
            <div>
              <strong>{t('chat.title')}</strong>
              <span className="chat-sub">{t('chat.onPage', { page: t(`chat.page.${page}`) })}</span>
            </div>
            <button className="chat-icon" onClick={() => setMessages([])} title={t('chat.clear')} aria-label={t('chat.clear')} disabled={!messages.length}>
              <RotateCcw size={16} />
            </button>
            <button className="chat-icon" onClick={() => setOpen(false)} aria-label={t('chat.close')}><X size={18} /></button>
          </header>

          <div className="chat-body" ref={scroller} aria-live="polite">
            {messages.length === 0 && (
              <div className="chat-hello">
                <p><strong>{t('chat.hello', { name: session?.display_name?.split(' ')[0] ?? '' })}</strong></p>
                <p className="muted small">{t('chat.intro')}</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role} ${m.error ? 'err' : ''}`}>
                <div className="chat-bubble"><Rich text={m.text} /></div>
                {m.steps?.length > 0 && (
                  <p className="chat-steps">{t('chat.used')}: {[...new Set(m.steps.map((s) => s.tool))].join(', ')}</p>
                )}
                {m.actions?.map((a, j) => (
                  <button key={j} className="btn outline sm chat-action" onClick={() => { navigate(a.to); setOpen(false); }}>
                    {actionLabel[a.label] ?? a.label}
                  </button>
                ))}
              </div>
            ))}
            {busy && (
              <div className="chat-msg assistant">
                <div className="chat-bubble typing" aria-label={t('chat.thinking')}><span /><span /><span /></div>
              </div>
            )}
          </div>

          {messages.length === 0 && (
            <div className="chat-suggest">
              {suggestions.map((k) => (
                <button key={k} className="chip-btn" onClick={() => send(t(k))}>{t(k)}</button>
              ))}
            </div>
          )}

          <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('chat.placeholder')}
              maxLength={1000}
              aria-label={t('chat.placeholder')}
              disabled={busy}
            />
            <button type="submit" className="chat-send" disabled={busy || !input.trim()} aria-label={t('chat.send')}><Send size={18} /></button>
          </form>
          <p className="chat-foot">{t('chat.foot')}</p>
        </section>
      )}
      <button className={`chat-fab ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t('chat.title')}>
        {open ? <X size={24} /> : <Bot size={26} />}
        {!open && <span className="chat-fab-label">{t('chat.fab')}</span>}
      </button>
    </div>
  );
}
