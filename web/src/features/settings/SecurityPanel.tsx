import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { Button, Field, fmtDateTime, inputCls, Modal, SkeletonRows } from '../../components/ui';
import { MoneyInput, SaveBar, Toggle } from './panels';
import { useSetting } from './useSetting';

interface UserRow {
  id: number;
  name: string;
  username: string;
  role: string;
  active: boolean;
  has_pin: boolean;
  last_login_at: string | null;
  locked_until: string | null;
}

export function SecurityPanel() {
  const { can } = useSession();
  const s = useSetting<any>('security');
  const owner = can('*');
  if (!s.value) return <SkeletonRows rows={5} />;
  const v = s.value;
  const num = (k: string, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => s.set(k, Math.max(min, Math.min(max, Number(e.target.value.replace(/\D/g, '') || min))));
  return (
    <div className="space-y-8">
      <fieldset disabled={!owner} className="grid gap-4 sm:grid-cols-2">
        {!owner && <p className="text-sm text-slate-500 sm:col-span-2">Only the owner can change security settings.</p>}
        <Field label="Session timeout (minutes)" htmlFor="s-to">
          <input id="s-to" className={inputCls} inputMode="numeric" value={v.session_timeout_min} onChange={num('session_timeout_min', 5, 1440)} />
        </Field>
        <Field label="Activity lock after idle (minutes, 0 = off)" htmlFor="s-lock">
          <input id="s-lock" className={inputCls} inputMode="numeric" value={v.activity_lock_min} onChange={num('activity_lock_min', 0, 120)} />
        </Field>
        <Field label="Manager approval above" htmlFor="s-thr" hint="Applies to issue, reload, redeem and transfer amounts.">
          <MoneyInput id="s-thr" cents={v.approval_threshold_cents} onChange={(c) => s.set('approval_threshold_cents', c)} />
        </Field>
        <Field label="Offline redemption limit" htmlFor="s-off" hint="Max amount a terminal may queue while offline.">
          <MoneyInput id="s-off" cents={v.offline_max_redeem_cents} onChange={(c) => s.set('offline_max_redeem_cents', c)} />
        </Field>
        <Field label="Wrong PINs before lockout" htmlFor="s-pa">
          <input id="s-pa" className={inputCls} inputMode="numeric" value={v.pin_max_attempts} onChange={num('pin_max_attempts', 3, 20)} />
        </Field>
        <Field label="PIN lockout (minutes)" htmlFor="s-pl">
          <input id="s-pl" className={inputCls} inputMode="numeric" value={v.pin_lockout_min} onChange={num('pin_lockout_min', 1, 1440)} />
        </Field>
        <Field label="Undo window for redemptions (seconds)" htmlFor="s-undo">
          <input id="s-undo" className={inputCls} inputMode="numeric" value={v.undo_window_sec} onChange={num('undo_window_sec', 0, 120)} />
        </Field>
        <div className="sm:col-span-2">
          <Toggle label="Dual control for refunds" hint="A second manager must approve every refund to card." checked={v.dual_control_refunds} onChange={(x) => s.set('dual_control_refunds', x)} />
          <Toggle label="Dual control for voids" hint="A second manager must approve every void." checked={v.dual_control_voids} onChange={(x) => s.set('dual_control_voids', x)} />
        </div>
        <div className="sm:col-span-2">
          <SaveBar s={{ ...s, canEdit: owner }} />
        </div>
      </fieldset>
      <UsersSection />
      <RolesSection />
    </div>
  );
}

function UsersSection() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<{ data: UserRow[] }>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ roles: string[] }>('/roles') });
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  const manage = can('users.manage');
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-bold">Staff & PINs</h2>
        {manage && (
          <Button size="sm" onClick={() => setEdit('new')}>
            <UserPlus className="h-4 w-4" /> Add staff
          </Button>
        )}
      </div>
      <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-700">
        {q.data?.data.map((u) => (
          <li key={u.id} className="flex min-h-[56px] flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span>
              <strong className={u.active ? '' : 'line-through opacity-60'}>{u.name}</strong> <span className="text-sm text-slate-500">@{u.username}</span>
              <span className="block text-xs text-slate-500">
                {u.role} · last login {fmtDateTime(u.last_login_at)} {u.locked_until && new Date(u.locked_until) > new Date() && <span className="font-bold text-red-600">· locked</span>}
              </span>
            </span>
            {manage && (
              <Button size="sm" variant="secondary" onClick={() => setEdit(u)}>
                Edit
              </Button>
            )}
          </li>
        ))}
      </ul>
      {edit && <UserModal user={edit === 'new' ? null : edit} roles={roles.data?.roles ?? ['STAFF', 'MANAGER', 'OWNER']} onClose={() => (setEdit(null), qc.invalidateQueries({ queryKey: ['users'] }))} />}
    </section>
  );
}

function UserModal({ user, roles, onClose }: { user: UserRow | null; roles: string[]; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ name: user?.name ?? '', username: user?.username ?? '', role: user?.role ?? 'STAFF', pin: '', password: '', active: user?.active ?? true });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { name: v.name, username: v.username, role: v.role };
      if (v.pin) body.pin = v.pin;
      if (v.password) body.password = v.password;
      if (user) body.active = v.active;
      await api(user ? `/users/${user.id}` : '/users', { method: user ? 'PATCH' : 'POST', body });
      toast.push({ kind: 'success', title: user ? 'Staff updated' : 'Staff added' });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Add staff member'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      {err && (
        <p role="alert" className="mb-3 font-semibold text-red-600">
          {err}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name" htmlFor="u-n">
          <input id="u-n" className={inputCls} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Username" htmlFor="u-u">
          <input id="u-u" className={inputCls} value={v.username} onChange={(e) => setV({ ...v, username: e.target.value.toLowerCase() })} />
        </Field>
        <Field label="Role" htmlFor="u-r">
          <select id="u-r" className={inputCls} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
            {roles.filter((r) => r !== 'KIOSK').map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label={user ? 'New PIN (blank = keep)' : 'PIN (4–8 digits)'} htmlFor="u-p">
          <input id="u-p" className={inputCls} inputMode="numeric" maxLength={8} value={v.pin} onChange={(e) => setV({ ...v, pin: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label={user ? 'New password (optional)' : 'Password (optional, 8+)'} htmlFor="u-pw">
          <input id="u-pw" type="password" className={inputCls} autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />
        </Field>
        {user && <Toggle label="Active" checked={v.active} onChange={(x) => setV({ ...v, active: x })} />}
      </div>
    </Modal>
  );
}

function RolesSection() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api<{ roles: string[]; permissions: string[]; matrix: Record<string, string[]> }>('/roles') });
  const owner = can('*');
  if (!q.data) return null;
  const roles = q.data.roles.filter((r) => r !== 'OWNER');
  const toggle = async (role: string, perm: string, on: boolean) => {
    const cur = q.data!.matrix[role] ?? [];
    const next = on ? [...cur, perm] : cur.filter((p) => p !== perm);
    try {
      await api(`/roles/${role}`, { method: 'PUT', body: { permissions: next } });
      qc.invalidateQueries({ queryKey: ['roles'] });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Could not change permission', message: e instanceof Error ? e.message : '' });
    }
  };
  return (
    <section>
      <h2 className="mb-1 text-lg font-bold">Roles & permissions</h2>
      <p className="mb-2 text-sm text-slate-500">OWNER always has every permission. {owner ? 'Tap to toggle.' : 'Only the owner can edit.'}</p>
      <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200 dark:ring-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800">
            <tr>
              <th className="px-3 py-2 text-left">Permission</th>
              {roles.map((r) => (
                <th key={r} className="px-3 py-2">
                  {r}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.data.permissions.map((p) => (
              <tr key={p} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-1 font-mono">{p}</td>
                {roles.map((r) => {
                  const on = q.data!.matrix[r]?.includes(p) ?? false;
                  return (
                    <td key={r} className="text-center">
                      <input type="checkbox" className="h-5 w-5" checked={on} disabled={!owner} onChange={(e) => toggle(r, p, e.target.checked)} aria-label={`${r}: ${p}`} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
