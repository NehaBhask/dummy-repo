import { useI18n } from '../i18n.jsx';
import { StatusChip } from './ui.jsx';

// Line items of a booking, including the ones the saga rolled back (struck through, with when).
export default function BookingTable({ booking }) {
  const { t, date, dateTime, money } = useI18n();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('bookings.item')}</th>
            <th>{t('bookings.date')}</th>
            <th className="num">{t('bookings.units')}</th>
            <th className="num">{t('bookings.amount')}</th>
            <th>{t('bookings.status')}</th>
          </tr>
        </thead>
        <tbody>
          {booking.items.map((i) => (
            <tr key={i.booking_item_id} className={i.status === 'compensated' ? 'struck' : ''}>
              <td>{i.title}</td>
              <td>{i.for_date ? date(i.for_date) : '—'}</td>
              <td className="num">{i.units}</td>
              <td className="num">{money(i.line_total, i.currency)}</td>
              <td>
                <StatusChip status={i.status} />
                {i.compensated_at && <div className="muted tiny">{t('bookings.rolledAt', { at: dateTime(i.compensated_at) })}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
