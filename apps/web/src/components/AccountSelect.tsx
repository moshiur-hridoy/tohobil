import { useTranslation } from 'react-i18next';

export const CASH_ACCOUNTS = ['CASH', 'BANK', 'BKASH', 'NAGAD'] as const;
export type CashAccount = (typeof CASH_ACCOUNTS)[number];

/** Which cash account a money action uses (the same four the ledger knows). */
export function AccountSelect({ value, onChange }: { value: CashAccount; onChange: (v: CashAccount) => void }) {
  const { t } = useTranslation();
  return (
    <label className="field-label">
      {t('payment.method')}
      <select
        className="field mt-1 w-full"
        value={value}
        onChange={(e) => onChange(e.target.value as CashAccount)}
      >
        {CASH_ACCOUNTS.map((a) => (
          <option key={a} value={a}>{t(`cashAccount.${a}`)}</option>
        ))}
      </select>
    </label>
  );
}
