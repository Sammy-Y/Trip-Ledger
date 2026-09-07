/** API 回應的形狀。UI 只能依賴這裡宣告的欄位。 */
export type Kind = 'shared' | 'personal';
export type PaymentMethod = 'cash' | 'card';
export type SplitMode = 'equal' | 'shares' | 'exact';

export interface Trip {
  id: string; name: string; base_currency: string;
  start_date: string | null; end_date: string | null;
}
export interface Member { id: string; name: string; }

export interface Expense {
  id: string; kind: Kind; description: string; category: string | null;
  currency: string; amount_minor: number;
  payment_method: PaymentMethod;
  fx_rate: number | null; fx_rate_date: string | null; fx_rate_source: string | null;
  fx_rate_override: number | null; fx_markup_pct: number;
  spent_at: string; note: string | null; created_at: string;
  payers: Array<{ member_id: string; amount_minor: number }>;
  shares: Array<{ member_id: string; amount_minor: number }>;
}

export interface Net { memberId: string; netMinor: number; }
export interface Transfer { from: string; to: string; amountMinor: number; }

export interface Balance {
  base_currency: string;
  by_currency: Record<string, { nets: Net[]; transfers: Transfer[] }>;
  per_member: Record<string, {
    sharedOwedBase: number; personalBase: number; totalBase: number; unconverted: number;
  }>;
  disclaimer: string;
  rate_attribution: string;
}

export interface Reservation {
  id: string; name: string; url: string | null;
  opens_at_utc: string | null; remind_before_min: number;
  reminded_at: string | null; status: 'pending' | 'booked' | 'cancelled';
  note: string | null;
}
