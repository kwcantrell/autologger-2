import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { apiFetch } from '../../api/client';
import type { AdminDataResponse, AdminStudio, AdminUser } from '../../api/types';
import logoAsset from '../../assets/logos/logo-autologger-transparent.png';
import { showToast, Toast } from '../../shared/components/Toast';
import { useConfirm } from '../../shared/ui/ConfirmDialog';
import { Popover, PopoverItem } from '../../shared/ui/Popover';
import { assetSrc } from '../../shared/utils/assetSrc';

const TOKEN_KEY = 'autologger_admin_token';
const logoUrl = assetSrc(logoAsset);

/** apiFetch plus the admin bearer token; apiFetch supplies the default
 * Content-Type and detail-extraction/error behavior. */
async function fetchAdmin<T>(path: string, token: string, opts: RequestInit = {}): Promise<T> {
  return apiFetch<T>(path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
  });
}

export function AdminUsersPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [studios, setStudios] = useState<AdminStudio[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [newTeamId, setNewTeamId] = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const { confirm, confirmElement } = useConfirm();

  function saveToken(t: string) {
    setToken(t);
    sessionStorage.setItem(TOKEN_KEY, t);
  }

  const loadAll = useCallback(async () => {
    if (!token) {
      showToast('Enter an admin token first', true);
      return;
    }
    setLoading(true);
    try {
      const data = await fetchAdmin<AdminDataResponse>('admin/users', token);
      setStudios(data.studios_catalog);
      setUsers(data.users);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Load failed', true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  async function createTeam() {
    if (!newTeamId.trim() || !newTeamName.trim()) {
      showToast('Team ID and name are required', true);
      return;
    }
    try {
      await fetchAdmin('admin/studios', token, {
        method: 'POST',
        body: JSON.stringify({ id: newTeamId.trim(), display_name: newTeamName.trim() }),
      });
      setNewTeamId('');
      setNewTeamName('');
      showToast('Team created.');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Create failed', true);
    }
  }

  async function deleteTeam(studioId: string) {
    const ok = await confirm({
      title: 'Delete team',
      message: `Delete team "${studioId}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetchAdmin(`admin/studios/${encodeURIComponent(studioId)}`, token, {
        method: 'DELETE',
      });
      showToast('Team deleted.');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', true);
    }
  }

  async function addMembership(userId: string, studioId: string) {
    try {
      await fetchAdmin(`admin/users/${encodeURIComponent(userId)}/memberships`, token, {
        method: 'POST',
        body: JSON.stringify({ studio_id: studioId }),
      });
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed', true);
    }
  }

  async function removeMembership(userId: string, studioId: string) {
    try {
      await fetchAdmin(
        `admin/users/${encodeURIComponent(userId)}/memberships/${encodeURIComponent(studioId)}`,
        token,
        { method: 'DELETE' },
      );
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed', true);
    }
  }

  async function toggleDisabled(user: AdminUser) {
    const action = user.disabled ? 'enable' : 'disable';
    try {
      await fetchAdmin(`admin/users/${encodeURIComponent(user.id)}/${action}`, token, {
        method: 'POST',
      });
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed', true);
    }
  }

  return (
    <div className="shell">
      <header className="header header-home">
        <div className="brand brand-with-logo">
          <div className="brand-lockup">
            <img className="brand-logo" src={logoUrl} width={96} height={96} alt="AutoLogger" />
            <div className="brand-text">
              <p className="crumb">
                <a href="/">&larr; Sessions</a>
              </p>
              <h1>Admin Users</h1>
              <p className="tagline">Manage OAuth users and team memberships.</p>
            </div>
          </div>
        </div>
      </header>

      <main className="main">
        <section className="panel settings-panel">
          {/* Token input */}
          <label className="field">
            <span>Admin token</span>
            <input
              type="password"
              id="admin-token"
              className="profile-select"
              autoComplete="off"
              placeholder="AUTOLOGGER_ADMIN_TOKEN"
              value={token}
              onChange={(e) => saveToken(e.target.value)}
            />
          </label>
          <div className="settings-actions mb-6">
            <button type="button" className="btn primary" onClick={loadAll} disabled={loading}>
              {loading ? 'Loading…' : 'Load data'}
            </button>
          </div>

          {/* Create team */}
          {studios.length > 0 && (
            <div className="admin-settings-block">
              <h2 className="settings-subheading">Create team</h2>
              <label className="field">
                <span>Team ID (slug)</span>
                <input
                  type="text"
                  className="profile-select"
                  placeholder="my-team"
                  value={newTeamId}
                  maxLength={63}
                  onChange={(e) => setNewTeamId(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Display name</span>
                <input
                  type="text"
                  className="profile-select"
                  placeholder="My Team"
                  value={newTeamName}
                  maxLength={200}
                  onChange={(e) => setNewTeamName(e.target.value)}
                />
              </label>
              <button type="button" className="btn" onClick={createTeam}>
                Create team
              </button>
            </div>
          )}

          {/* Teams table */}
          {studios.length > 0 && (
            <div className="admin-settings-block">
              <h2 className="settings-subheading">Teams</h2>
              <table className="admin-table" id="teams-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Built-in</th>
                    <th />
                  </tr>
                </thead>
                <tbody id="teams-tbody">
                  {studios.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <code>{s.id}</code>
                      </td>
                      <td>{s.name}</td>
                      <td>{s.builtin ? 'Yes' : 'No'}</td>
                      <td>
                        {!s.builtin && (
                          <button
                            type="button"
                            className="btn danger"
                            onClick={() => deleteTeam(s.id)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Users table */}
          {users.length > 0 && (
            <div className="admin-settings-block">
              <h2 className="settings-subheading">Users</h2>
              <table className="admin-table" id="users-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Teams</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody id="users-tbody">
                  {users.map((u) => (
                    <tr key={u.id} className={clsx(u.disabled && 'opacity-50')}>
                      <td>{u.email}</td>
                      <td>
                        {u.given_name} {u.family_name}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {u.studios.map((m) => (
                            <span key={m.id} className="inline-flex gap-1 items-center">
                              <code>{m.name}</code>
                              <button
                                type="button"
                                className="btn btn-icon danger text-[10px] px-1 py-0"
                                aria-label={`Remove from ${m.name}`}
                                onClick={() => removeMembership(u.id, m.id)}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          <Popover
                            trigger={
                              <button
                                type="button"
                                className="btn text-[12px]"
                                aria-label={`Add team membership for ${u.email}`}
                              >
                                + Add team
                              </button>
                            }
                            align="start"
                          >
                            {studios
                              .filter((s) => !u.studios.some((m) => m.id === s.id))
                              .map((s) => (
                                <PopoverItem key={s.id} onClick={() => addMembership(u.id, s.id)}>
                                  {s.name}
                                </PopoverItem>
                              ))}
                          </Popover>
                        </div>
                      </td>
                      <td>{u.disabled ? 'Disabled' : 'Active'}</td>
                      <td>
                        <button
                          type="button"
                          className={`btn ${u.disabled ? '' : 'danger'}`}
                          onClick={() => toggleDisabled(u)}
                        >
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <div className="developer-footer">
          <p className="developer-label">Developed by</p>
          <img
            className="developer-logo"
            src={logoUrl}
            width={320}
            height={80}
            alt="Enny Automations"
          />
        </div>
      </footer>
      <Toast />
      {confirmElement}
    </div>
  );
}
