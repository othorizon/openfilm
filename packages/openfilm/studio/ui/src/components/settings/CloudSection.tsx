import React from 'react';
import { api, type CloudAccount } from '@/api';
import { CloudLibrary } from '../CloudLibrary';
import { useT } from '@/i18n';
import { SettingsButton, SettingsField, SettingsGroup, SettingsItem, SettingsPage, settingsError } from './ui';

/** Accounts live in Studio's home; opening Settings never makes local editing depend on the cloud. */
export function CloudSection() {
  const t = useT();
  const [account, setAccount] = React.useState<CloudAccount | null>(null);
  const [url, setUrl] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [mode, setMode] = React.useState<'login' | 'register'>('login');
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState('');
  const apply = (next: CloudAccount) => { setAccount(next); setUrl(next.serviceUrl ?? ''); };

  React.useEffect(() => {
    let mounted = true;
    void api.cloud().then(next => { if (mounted) apply(next); })
      .catch(e => { if (mounted) setError(String(e.message)); })
      .finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; };
  }, []);

  async function run(action: () => Promise<CloudAccount>) {
    setBusy(true); setError(''); setPassword(''); setNewPassword('');
    // Remove the previous identity while an account or service change is pending.
    setAccount(null);
    try { apply(await action()); }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try { apply(await api.cloud()); } catch { /* the local service is unavailable too */ }
    } finally { setBusy(false); }
  }
  const changedUrl = url.trim().replace(/\/+$/, '') !== (account?.serviceUrl ?? '');
  const size = (bytes: number) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(bytes / 1_000_000_000)} GB`;

  return (
    <SettingsPage note={t('settings.cloud.intro')}>
      <SettingsGroup title={t('settings.cloud.service')} footnote={t('settings.cloud.serviceHint')}>
        <form onSubmit={e => { e.preventDefault(); void run(() => api.configureCloud(url.trim())); }}>
          <SettingsItem title={<label htmlFor="cloud-service">{t('settings.cloud.serviceUrl')}</label>}>
            <div className="flex gap-2">
              <SettingsField id="cloud-service" type="url" value={url} disabled={busy} onChange={e => setUrl(e.target.value)} placeholder="https://cloud.example.com" />
              <SettingsButton type="submit" disabled={busy || !changedUrl}>{t('settings.cloud.save')}</SettingsButton>
            </div>
          </SettingsItem>
        </form>
      </SettingsGroup>
      {error ? <p role="alert" className={`mb-4 ${settingsError}`}>{error}</p> : null}
      {account?.notice ? <p role="status" className="mb-4 text-[14px] text-[var(--text-muted)]">{account.notice}</p> : null}
      {busy ? <p role="status" className="text-[14px] text-[var(--text-muted)]">{t('settings.cloud.working')}</p> : null}
      {account?.hasSession ? (
        <SettingsGroup title={t('settings.cloud.space')}>
          <SettingsItem
            title={account.user?.username ?? t('settings.cloud.offline')}
            description={account.space ? `${size(account.space.usedBytes)} / ${size(account.space.quotaBytes)}` : t('settings.cloud.offlineHint')}
            control={<>
              <SettingsButton disabled={busy} onClick={() => void run(api.cloud)}>{t('settings.cloud.refresh')}</SettingsButton>
              <SettingsButton disabled={busy} onClick={() => void run(api.cloudSignOut)}>{t('settings.cloud.logout')}</SettingsButton>
            </>}
          />
          {account.user ? <>
            <form className="my-4 flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void run(() => api.cloudPassword(password, newPassword)); }}>
              <label htmlFor="cloud-old-password">{t('cloudLibrary.oldPassword')}</label>
              <SettingsField id="cloud-old-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required maxLength={128}/>
              <label htmlFor="cloud-new-password">{t('cloudLibrary.newPassword')}</label>
              <SettingsField id="cloud-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} required minLength={10} maxLength={128}/>
              <p className="text-sm text-[var(--text-muted)]">{t('cloudLibrary.passwordHint')}</p>
              <SettingsButton type="submit" disabled={busy}>{t('cloudLibrary.changePassword')}</SettingsButton>
            </form>
            <CloudLibrary key={`${account.serviceUrl}:${account.user.id}`} />
          </> : null}
        </SettingsGroup>
      ) : account?.serviceUrl ? (
        <SettingsGroup title={t(`settings.cloud.${mode}`)}>
          <form onSubmit={e => { e.preventDefault(); void run(() => api.cloudSignIn(mode, username, password)); }} className="flex flex-col gap-3 pt-3">
            <label htmlFor="cloud-username" className="text-[14px] text-[var(--text)]">{t('settings.cloud.username')}</label>
            <SettingsField id="cloud-username" autoComplete="username" required minLength={3} maxLength={32} value={username} disabled={busy || changedUrl} onChange={e => setUsername(e.target.value)} />
            <label htmlFor="cloud-password" className="text-[14px] text-[var(--text)]">{t('settings.cloud.password')}</label>
            <SettingsField id="cloud-password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={10} maxLength={128} value={password} disabled={busy || changedUrl} onChange={e => setPassword(e.target.value)} />
            <p className="text-[13.5px] text-[var(--text-muted)]">{t('settings.cloud.credentialsHint')}</p>
            <div className="flex gap-2">
              <SettingsButton type="submit" variant="primary" disabled={busy || changedUrl}>{t(`settings.cloud.${mode}`)}</SettingsButton>
              <SettingsButton disabled={busy} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setPassword(''); setError(''); }}>
                {t(mode === 'login' ? 'settings.cloud.createAccount' : 'settings.cloud.existingAccount')}
              </SettingsButton>
            </div>
          </form>
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
