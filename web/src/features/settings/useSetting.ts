import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';

/** Load/edit/save one settings section with dirty tracking. */
export function useSetting<T extends Record<string, any>>(key: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh, can } = useSession();
  const q = useQuery({ queryKey: ['settings', key], queryFn: () => api<{ value: T }>(`/settings/${key}`) });
  const [value, setValue] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (q.data) setValue(q.data.value);
  }, [q.data]);
  const dirty = !!value && JSON.stringify(value) !== JSON.stringify(q.data?.value);
  const save = async () => {
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/settings/${key}`, { method: 'PUT', body: { value } });
      await qc.invalidateQueries({ queryKey: ['settings', key] });
      await refresh();
      toast.push({ kind: 'success', title: 'Settings saved' });
    } catch (e) {
      if (e instanceof ApiError) setError(e);
    } finally {
      setSaving(false);
    }
  };
  const set = <K extends keyof T>(k: K, v: T[K]) => setValue((old) => (old ? { ...old, [k]: v } : old));
  return { value, set, setValue, save, saving, dirty, error, loading: q.isLoading, canEdit: can('settings.write') };
}
