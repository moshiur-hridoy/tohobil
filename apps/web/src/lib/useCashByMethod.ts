import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** The rule `cash_tracking_by_method`: true shows and checks each cash account on its own, false treats cash and bank as one pool. */
export function useCashByMethod(): boolean {
  const q = useQuery({
    queryKey: ['rules', 'cash_tracking_by_method'],
    queryFn: () => api<{ items: Array<{ key: string; value: unknown }> }>('/rules?key=cash_tracking_by_method'),
  });
  return q.data?.items[0]?.value === true;
}
