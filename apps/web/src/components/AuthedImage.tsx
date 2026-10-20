import { useQuery } from '@tanstack/react-query';
import { apiBlob } from '../lib/api';

/**
 * A stored image (payment proof thumbnail). `<img src>` cannot send the bearer token, so the bytes are
 * fetched with it and shown from an object URL. Viewing a proof is audited by the server.
 */
export function AuthedImage({ fileId, thumb = true, alt, className = '' }: { fileId: string; thumb?: boolean; alt: string; className?: string }) {
  const q = useQuery({
    queryKey: ['file', fileId, thumb],
    queryFn: async () => URL.createObjectURL(await apiBlob(`/files/${fileId}${thumb ? '?thumb=true' : ''}`)),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
  if (!q.data) return <div aria-hidden="true" className={`animate-pulse rounded-md bg-hover ${className}`} />;
  return <img src={q.data} alt={alt} className={`rounded-md object-cover ${className}`} />;
}
