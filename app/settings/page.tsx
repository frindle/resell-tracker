'use client';

import { useEffect, useState } from 'react';

type ConnState = 'idle' | 'testing' | 'ok' | 'fail';
type User = { id: number; name: string; _count: { orders: number } };
type PortalRate = { id: number; merchant: string; category: string | null; portal: string; rate: string };

export default function SettingsPage() {
  // BFMR
  const [bfmrKey, setBfmrKey] = useState('');
  const [bfmrSecret, setBfmrSecret] = useState('');
  const [bfmrEmail, setBfmrEmail] = useState('');
  const [bfmrPassword, setBfmrPassword] = useState('');
  const [bfmrConn, setBfmrConn] = useState<ConnState>('idle');
  const [bfmrConnMsg, setBfmrConnMsg] = useState('');
  const [bfmrSaved, setBfmrSaved] = useState(false);
  const [bfmrSyncStart, setBfmrSyncStart] = useState('');
  const [bfmrWebConn, setBfmrWebConn] = useState<ConnState>('idle');
  const [bfmrWebConnMsg, setBfmrWebConnMsg] = useState('');

  // Gmail
  const [gmailAddress, setGmailAddress] = useState('');
  const [gmailPassword, setGmailPassword] = useState('');
  const [gmailSaved, setGmailSaved] = useState(false);
  const [gmailConn, setGmailConn] = useState<ConnState>('idle');
  const [gmailConnMsg, setGmailConnMsg] = useState('');

  // BuyingGroup
  const [bgEmail, setBgEmail] = useState('');
  const [bgPassword, setBgPassword] = useState('');
  const [bgSaved, setBgSaved] = useState(false);
  const [bgConn, setBgConn] = useState<ConnState>('idle');
  const [bgConnMsg, setBgConnMsg] = useState('');
  const [bgSyncStart, setBgSyncStart] = useState('');

  // BigSky
  const [bigskyCookie, setBigskyCookie] = useState('');
  const [bigskySaved, setBigskySaved] = useState(false);

  // CardCenter
  const [ccEmail, setCcEmail] = useState('');
  const [ccPassword, setCcPassword] = useState('');
  const [ccSaved, setCcSaved] = useState(false);
  const [ccConn, setCcConn] = useState<ConnState>('idle');
  const [ccConnMsg, setCcConnMsg] = useState('');

  // Ignored portals
  const [ignoredPortals, setIgnoredPortals] = useState<string[]>([]);

  async function toggleIgnoredPortal(portal: string) {
    const next = ignoredPortals.includes(portal)
      ? ignoredPortals.filter(p => p !== portal)
      : [...ignoredPortals, portal];
    setIgnoredPortals(next);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored_portals: JSON.stringify(next) }),
    });
  }

  // Portal Rates
  const [portalRates, setPortalRates] = useState<PortalRate[]>([]);
  const [prMerchant, setPrMerchant] = useState('');
  const [prCategory, setPrCategory] = useState('');
  const [prPortal, setPrPortal] = useState('');
  const [prRate, setPrRate] = useState('');
  const [prAdding, setPrAdding] = useState(false);
  const [prError, setPrError] = useState('');

  // Pushover
  const [pushoverUserKey, setPushoverUserKey] = useState('');
  const [pushoverAppToken, setPushoverAppToken] = useState('');
  const [pushoverSaved, setPushoverSaved] = useState(false);
  const [pushoverConn, setPushoverConn] = useState<ConnState>('idle');
  const [pushoverConnMsg, setPushoverConnMsg] = useState('');

  // Users
  const [users, setUsers] = useState<User[]>([]);
  const [newUserName, setNewUserName] = useState('');
  const [userError, setUserError] = useState('');

  // Extension commands
  const [extCmdMsg, setExtCmdMsg] = useState<Record<string, string>>({});
  const [extCmds, setExtCmds] = useState<{ id: number; type: string; status: string; result: string | null; createdAt: string }[]>([]);

  // Danger zone
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  function loadPortalRates() {
    fetch('/api/portal-rates').then(r => r.json()).then(setPortalRates).catch(() => {});
  }

  function loadUsers() {
    fetch('/api/users').then(r => r.json()).then(setUsers);
  }

  function loadExtCmds() {
    fetch('/api/extension/commands?all=1').then(r => r.json()).then(setExtCmds).catch(() => {});
  }

  useEffect(() => {
    loadPortalRates();
    loadUsers();
    loadExtCmds();
    fetch('/api/settings')
      .then(r => r.json())
      .then((s: Record<string, string>) => {
        if (s.bfmr_api_key) setBfmrKey(s.bfmr_api_key);
        if (s.bfmr_api_secret) setBfmrSecret(s.bfmr_api_secret);
        if (s.bfmr_email) setBfmrEmail(s.bfmr_email);
        if (s.bfmr_password) setBfmrPassword(s.bfmr_password);
        if (s.bfmr_sync_start_date) setBfmrSyncStart(s.bfmr_sync_start_date);
        if (s.gmail_address) setGmailAddress(s.gmail_address);
        if (s.gmail_app_password) setGmailPassword(s.gmail_app_password);
        if (s.bg_email) setBgEmail(s.bg_email);
        if (s.bg_password) setBgPassword(s.bg_password);
        if (s.bg_sync_start_date) setBgSyncStart(s.bg_sync_start_date);
        if (s.bigsky_cookie) setBigskyCookie(s.bigsky_cookie);
        if (s.cc_email) setCcEmail(s.cc_email);
        if (s.cc_password) setCcPassword(s.cc_password);
        if (s.pushover_user_key) setPushoverUserKey(s.pushover_user_key);
        if (s.pushover_app_token) setPushoverAppToken(s.pushover_app_token);
        if (s.ignored_portals) {
          try { setIgnoredPortals(JSON.parse(s.ignored_portals)); } catch {}
        }
      });
  }, []);

  async function saveBfmr() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bfmr_sync_start_date: bfmrSyncStart }),
    });
    setBfmrSaved(true);
    setTimeout(() => setBfmrSaved(false), 2000);
    setBfmrConn('idle');
  }

  async function connectBfmrWeb() {
    if (!bfmrEmail || !bfmrPassword) return;
    setBfmrWebConn('testing');
    setBfmrWebConnMsg('');
    try {
      const res = await fetch('/api/bfmr/web-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bfmrEmail, password: bfmrPassword }),
      });
      if (res.ok) {
        const d = await res.json() as { apiKey: string; apiSecret: string };
        setBfmrKey(d.apiKey);
        setBfmrSecret(d.apiSecret);
        setBfmrWebConn('ok');
        setBfmrSaved(true);
        setTimeout(() => setBfmrSaved(false), 2000);
      } else {
        setBfmrWebConn('fail');
        setBfmrWebConnMsg(await res.text());
      }
    } catch (e) {
      setBfmrWebConn('fail');
      setBfmrWebConnMsg(String(e));
    }
  }

  async function testBfmr() {
    if (!bfmrKey || !bfmrSecret) return;
    setBfmrConn('testing');
    setBfmrConnMsg('');
    try {
      const res = await fetch('/api/bfmr/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: bfmrKey, apiSecret: bfmrSecret }),
      });
      if (res.ok) { setBfmrConn('ok'); } else { setBfmrConn('fail'); setBfmrConnMsg(await res.text()); }
    } catch (e) {
      setBfmrConn('fail'); setBfmrConnMsg(String(e));
    }
  }

  async function saveGmail() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gmail_address: gmailAddress, gmail_app_password: gmailPassword }),
    });
    setGmailSaved(true);
    setTimeout(() => setGmailSaved(false), 2000);
    setGmailConn('idle');
  }

  async function testGmail() {
    if (!gmailAddress || !gmailPassword) return;
    setGmailConn('testing');
    setGmailConnMsg('');
    try {
      const res = await fetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: gmailAddress, appPassword: gmailPassword }),
      });
      if (res.ok) { setGmailConn('ok'); } else { setGmailConn('fail'); setGmailConnMsg(await res.text()); }
    } catch (e) {
      setGmailConn('fail'); setGmailConnMsg(String(e));
    }
  }

  async function saveBg() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bg_email: bgEmail, bg_password: bgPassword, bg_sync_start_date: bgSyncStart }),
    });
    setBgSaved(true);
    setTimeout(() => setBgSaved(false), 2000);
    setBgConn('idle');
  }

  async function testBg() {
    if (!bgEmail || !bgPassword) return;
    setBgConn('testing');
    setBgConnMsg('');
    try {
      const res = await fetch('/api/buyinggroup/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bgEmail, password: bgPassword }),
      });
      if (res.ok) {
        setBgConn('ok');
      } else {
        setBgConn('fail');
        setBgConnMsg(await res.text());
      }
    } catch (e) {
      setBgConn('fail');
      setBgConnMsg(String(e));
    }
  }

  async function saveBigsky() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bigsky_cookie: bigskyCookie }),
    });
    setBigskySaved(true);
    setTimeout(() => setBigskySaved(false), 2000);
  }

  async function saveCc() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cc_email: ccEmail, cc_password: ccPassword }),
    });
    setCcSaved(true);
    setTimeout(() => setCcSaved(false), 2000);
    setCcConn('idle');
  }

  async function testCc() {
    if (!ccEmail || !ccPassword) return;
    setCcConn('testing');
    setCcConnMsg('');
    try {
      const res = await fetch('/api/cardcenter/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ccEmail, password: ccPassword }),
      });
      if (res.ok) { setCcConn('ok'); } else { setCcConn('fail'); setCcConnMsg(await res.text()); }
    } catch (e) {
      setCcConn('fail'); setCcConnMsg(String(e));
    }
  }

  async function savePushover() {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushover_user_key: pushoverUserKey, pushover_app_token: pushoverAppToken }),
    });
    setPushoverSaved(true);
    setTimeout(() => setPushoverSaved(false), 2000);
    setPushoverConn('idle');
  }

  async function testPushover() {
    if (!pushoverUserKey || !pushoverAppToken) return;
    setPushoverConn('testing');
    setPushoverConnMsg('');
    try {
      const res = await fetch('/api/pushover/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userKey: pushoverUserKey, appToken: pushoverAppToken }),
      });
      if (res.ok) { setPushoverConn('ok'); } else { setPushoverConn('fail'); setPushoverConnMsg(await res.text()); }
    } catch (e) {
      setPushoverConn('fail'); setPushoverConnMsg(String(e));
    }
  }

  async function addPortalRate() {
    if (!prMerchant.trim() || !prPortal.trim() || !prRate.trim()) return;
    setPrAdding(true);
    setPrError('');
    try {
      const res = await fetch('/api/portal-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchant: prMerchant, category: prCategory || undefined, portal: prPortal, rate: prRate }),
      });
      if (!res.ok) { setPrError(await res.text()); return; }
      setPrMerchant(''); setPrCategory(''); setPrPortal(''); setPrRate('');
      loadPortalRates();
    } catch (e) {
      setPrError(String(e));
    } finally {
      setPrAdding(false);
    }
  }

  async function deletePortalRate(id: number) {
    await fetch(`/api/portal-rates/${id}`, { method: 'DELETE' });
    setPortalRates(prev => prev.filter(r => r.id !== id));
  }

  async function addUser() {
    setUserError('');
    if (!newUserName.trim()) return;
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName.trim() }),
    });
    if (res.ok) {
      setNewUserName('');
      loadUsers();
    } else {
      const d = await res.json();
      setUserError(d.error ?? 'Failed');
    }
  }

  async function deleteAllOrders() {
    setDeleting(true);
    await fetch('/api/orders', { method: 'DELETE' });
    setDeleting(false);
    setDeleteConfirm(false);
    loadUsers();
  }

  async function queueExtCmd(type: string) {
    setExtCmdMsg(prev => ({ ...prev, [type]: 'Queuing…' }));
    try {
      const res = await fetch('/api/extension/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      if (res.ok) {
        setExtCmdMsg(prev => ({ ...prev, [type]: 'Queued ✓' }));
        setTimeout(() => setExtCmdMsg(prev => ({ ...prev, [type]: '' })), 3000);
        loadExtCmds();
      } else {
        setExtCmdMsg(prev => ({ ...prev, [type]: 'Failed' }));
      }
    } catch (e) {
      setExtCmdMsg(prev => ({ ...prev, [type]: String(e) }));
    }
  }

  async function removeUser(id: number) {
    if (!confirm('Delete this user? Their orders will be unassigned.')) return;
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    loadUsers();
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-gray-400 text-sm mt-1">Configure integrations and preferences.</p>
      </div>

      {/* BFMR */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">BFMR Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Connect to BuyForMeRetail to view your tracker, active deals, and shipment insurance.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input type="email" className="input" placeholder="Email"
            value={bfmrEmail} onChange={e => { setBfmrEmail(e.target.value); setBfmrWebConn('idle'); }} />
          <input type="password" className="input" placeholder="Password"
            value={bfmrPassword} onChange={e => { setBfmrPassword(e.target.value); setBfmrWebConn('idle'); }} />
        </div>

        <div>
          <label className="label">Import orders on or after</label>
          <input type="date" className="input" value={bfmrSyncStart} onChange={e => setBfmrSyncStart(e.target.value)} />
          <p className="text-xs text-gray-500 mt-1">Only orders reserved on or after this date will be imported. Leave blank to import all.</p>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={connectBfmrWeb} disabled={!bfmrEmail || !bfmrPassword || bfmrWebConn === 'testing'}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40">
            {bfmrWebConn === 'testing' ? 'Connecting…' : bfmrSaved ? 'Saved!' : 'Save'}
          </button>
          {bfmrWebConn === 'ok' && <span className="text-green-400 text-sm">Connected</span>}
          {bfmrWebConn === 'fail' && <span className="text-red-400 text-sm">Failed{bfmrWebConnMsg ? `: ${bfmrWebConnMsg}` : ''}</span>}
        </div>

        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>View My Tracker — order numbers, tracking, payment status and amounts</li>
            <li>Browse active deals available to reserve</li>
            <li>File and manage shipment insurance</li>
            <li>Auto-submit tracking numbers when scraped orders arrive (requires website login)</li>
          </ul>
        </div>
      </section>

      {/* Gmail — hidden until email parsing is reworked */}

      {/* BuyingGroup */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">BuyingGroup Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Connect to BuyingGroup.com to view your receipts and browse active deals.
            Uses your BuyingGroup.com login credentials.
          </p>
        </div>

        <div>
          <label className="label">Email</label>
          <input type="email" className="input" placeholder="you@example.com"
            value={bgEmail} onChange={e => { setBgEmail(e.target.value); setBgConn('idle'); }} />
        </div>
        <div>
          <label className="label">Password</label>
          <input type="password" className="input" placeholder="Your BuyingGroup.com password"
            value={bgPassword} onChange={e => { setBgPassword(e.target.value); setBgConn('idle'); }} />
        </div>

        <div>
          <label className="label">Import receipts on or after</label>
          <input type="date" className="input" value={bgSyncStart} onChange={e => setBgSyncStart(e.target.value)} />
          <p className="text-xs text-gray-500 mt-1">Only receipts submitted on or after this date will be synced. Leave blank to sync all.</p>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={saveBg} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors">
            {bgSaved ? 'Saved!' : 'Save'}
          </button>
          <button onClick={testBg} disabled={!bgEmail || !bgPassword || bgConn === 'testing'}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40">
            {bgConn === 'testing' ? 'Connecting…' : 'Test Connection'}
          </button>
          {bgConn === 'ok' && <span className="text-green-400 text-sm">Connected</span>}
          {bgConn === 'fail' && <span className="text-red-400 text-sm">Failed{bgConnMsg ? `: ${bgConnMsg}` : ' — check email and password'}</span>}
        </div>

        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>View receipts — order numbers, tracking, payout amounts and dates</li>
            <li>Browse active deals with cashback spread calculator</li>
          </ul>
        </div>
      </section>

      {/* BigSky */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">BigSkyBuyers Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Paste your BigSkyBuyers session cookie to enable tracking submission.
            In Chrome DevTools → Application → Cookies → bigskybuyers.com, copy the full cookie string.
          </p>
        </div>
        <div>
          <label className="label">Session Cookie</label>
          <input type="password" className="input font-mono text-xs" placeholder="Paste cookie string here"
            value={bigskyCookie} onChange={e => setBigskyCookie(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <button onClick={saveBigsky} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors">
            {bigskySaved ? 'Saved!' : 'Save'}
          </button>
        </div>
        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>Submit tracking numbers to BigSkyBuyers from the Orders page</li>
          </ul>
        </div>
      </section>

      {/* CardCenter */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">CardCenter Integration</h2>
          <p className="text-gray-400 text-sm mt-1">
            Submit gift cards to CardCenter (cardcenter.cc) directly from the order detail page.
            Uses your CardCenter login credentials.
          </p>
        </div>
        <div>
          <label className="label">Email</label>
          <input type="email" className="input" placeholder="you@example.com"
            value={ccEmail} onChange={e => { setCcEmail(e.target.value); setCcConn('idle'); }} />
        </div>
        <div>
          <label className="label">Password</label>
          <input type="password" className="input" placeholder="Your CardCenter password"
            value={ccPassword} onChange={e => { setCcPassword(e.target.value); setCcConn('idle'); }} />
        </div>
        <div className="flex items-center gap-3">
          <button onClick={saveCc} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors">
            {ccSaved ? 'Saved!' : 'Save'}
          </button>
          <button onClick={testCc} disabled={!ccEmail || !ccPassword || ccConn === 'testing'}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40">
            {ccConn === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          {ccConn === 'ok' && <span className="text-green-400 text-sm">Connected</span>}
          {ccConn === 'fail' && <span className="text-red-400 text-sm">Failed{ccConnMsg ? `: ${ccConnMsg}` : ' — check email and password'}</span>}
        </div>
        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>Submit gift cards to CardCenter from the order detail page with one click</li>
            <li>Tracks which cards have already been submitted to avoid duplicates</li>
          </ul>
        </div>
      </section>

      {/* Pushover */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Pushover Notifications</h2>
          <p className="text-gray-400 text-sm mt-1">
            Receive push notifications when the deal watcher reserves a slot. Get your User Key and App Token from{' '}
            <span className="text-gray-300">pushover.net</span>.
          </p>
        </div>
        <div>
          <label className="label">User Key</label>
          <input type="password" className="input font-mono text-xs" placeholder="Your Pushover user key"
            value={pushoverUserKey} onChange={e => { setPushoverUserKey(e.target.value); setPushoverConn('idle'); }} />
        </div>
        <div>
          <label className="label">App Token</label>
          <input type="password" className="input font-mono text-xs" placeholder="Your Pushover app/API token"
            value={pushoverAppToken} onChange={e => { setPushoverAppToken(e.target.value); setPushoverConn('idle'); }} />
        </div>
        <div className="flex items-center gap-3">
          <button onClick={savePushover} className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-md transition-colors">
            {pushoverSaved ? 'Saved!' : 'Save'}
          </button>
          <button onClick={testPushover} disabled={!pushoverUserKey || !pushoverAppToken || pushoverConn === 'testing'}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40">
            {pushoverConn === 'testing' ? 'Sending…' : 'Send Test'}
          </button>
          {pushoverConn === 'ok' && <span className="text-green-400 text-sm">Notification sent</span>}
          {pushoverConn === 'fail' && <span className="text-red-400 text-sm">Failed{pushoverConnMsg ? `: ${pushoverConnMsg}` : ''}</span>}
        </div>
        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">What this enables</p>
          <ul className="text-sm text-gray-400 space-y-1 list-disc list-inside">
            <li>Push notifications when the BFMR deal watcher successfully reserves a slot</li>
            <li>Alerts if the watcher encounters an error</li>
          </ul>
        </div>
      </section>

      {/* Portal Rates — hidden per #61. The data + APIs are still in
          place, but the settings UI got too long. Re-enable by flipping
          SHOW_PORTAL_RATES if/when we use this again. */}
      {false && (
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Portal Cashback Rates</h2>
          <p className="text-gray-400 text-sm mt-1">
            Configure cashback rates and exclusions per merchant. Shown inline on the BFMR Deals page.
            Use <span className="text-gray-300">Excluded</span> as the rate for brands or categories that don't earn.
          </p>
        </div>

        {portalRates.length > 0 && (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Merchant</th>
                  <th className="px-3 py-2 text-left">Category / Note</th>
                  <th className="px-3 py-2 text-left">Portal</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {portalRates.map(r => (
                  <tr key={r.id} className="hover:bg-gray-900/40">
                    <td className="px-3 py-2 text-gray-200">{r.merchant}</td>
                    <td className="px-3 py-2 text-gray-500">{r.category ?? <span className="text-gray-700">—</span>}</td>
                    <td className="px-3 py-2 text-gray-300">{r.portal}</td>
                    <td className={`px-3 py-2 text-right font-mono text-xs font-medium ${r.rate.toLowerCase() === 'excluded' ? 'text-red-400' : 'text-green-400'}`}>
                      {r.rate}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => deletePortalRate(r.id)} className="text-gray-600 hover:text-red-400 transition-colors text-xs">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <input type="text" className="input" placeholder="Merchant (e.g. Walmart)"
            value={prMerchant} onChange={e => setPrMerchant(e.target.value)} />
          <input type="text" className="input" placeholder="Category (optional)"
            value={prCategory} onChange={e => setPrCategory(e.target.value)} />
          <input type="text" className="input" placeholder="Portal (e.g. TopCashback)"
            value={prPortal} onChange={e => setPrPortal(e.target.value)} />
          <input type="text" className="input" placeholder="Rate (e.g. 3% or Excluded)"
            value={prRate} onChange={e => setPrRate(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addPortalRate()} />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={addPortalRate}
            disabled={prAdding || !prMerchant.trim() || !prPortal.trim() || !prRate.trim()}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-md transition-colors"
          >
            {prAdding ? 'Adding…' : 'Add Rate'}
          </button>
          {prError && <span className="text-red-400 text-xs">{prError}</span>}
        </div>

        {/* Ignored portals */}
        {(() => {
          const knownPortals = [...new Set(portalRates.map(r => r.portal))].sort();
          if (!knownPortals.length) return null;
          return (
            <div className="border-t border-gray-800 pt-4 space-y-2">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Hide portals from popup</p>
              <p className="text-xs text-gray-600">Ignored portals are hidden from the rate popup on the Deals page. United CC variants are always hidden.</p>
              <div className="flex flex-wrap gap-2">
                {knownPortals.map(portal => {
                  const ignored = ignoredPortals.includes(portal);
                  return (
                    <button
                      key={portal}
                      onClick={() => toggleIgnoredPortal(portal)}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                        ignored
                          ? 'border-red-800 bg-red-900/30 text-red-400 line-through'
                          : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-600'
                      }`}
                    >
                      {portal}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </section>
      )}

      {/* Extension Control */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Browser Extension</h2>
          <p className="text-gray-400 text-sm mt-1">
            Queue commands for the browser extension. The extension polls every 60s and picks up pending commands automatically.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {(['SYNC_AMAZON', 'SYNC_WALMART', 'SYNC_COSTCO', 'SYNC_BIGSKY', 'SCRAPE_CBM'] as const).map(type => {
            const labels: Record<string, string> = {
              SYNC_AMAZON: 'Sync Amazon',
              SYNC_WALMART: 'Sync Walmart',
              SYNC_COSTCO: 'Sync Costco',
              SYNC_BIGSKY: 'Sync BigSky',
              SCRAPE_CBM: 'Refresh CBM Rates',
            };
            const msg = extCmdMsg[type];
            return (
              <button key={type} onClick={() => queueExtCmd(type)}
                className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm px-4 py-2 rounded-md transition-colors text-left">
                <span className="block">{labels[type]}</span>
                {msg && <span className="text-xs text-blue-400">{msg}</span>}
              </button>
            );
          })}
        </div>
        {extCmds.length > 0 && (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-gray-900">
              <span className="text-xs text-gray-500 uppercase tracking-wide">Recent commands</span>
              <button onClick={loadExtCmds} className="text-xs text-gray-600 hover:text-gray-400 transition-colors">↺ Refresh</button>
            </div>
            <table className="w-full text-xs">
              <tbody className="divide-y divide-gray-800">
                {extCmds.map(cmd => {
                  const statusCls = cmd.status === 'done' ? 'text-green-400' : cmd.status === 'failed' ? 'text-red-400' : cmd.status === 'running' ? 'text-blue-400' : 'text-yellow-400';
                  const label = cmd.type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
                  const ago = Math.round((Date.now() - new Date(cmd.createdAt).getTime()) / 1000);
                  const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`;
                  return (
                    <tr key={cmd.id} className="hover:bg-gray-900/40">
                      <td className="px-4 py-2 text-gray-300 font-medium">{label}</td>
                      <td className={`px-4 py-2 ${statusCls}`}>{cmd.status}</td>
                      <td className="px-4 py-2 text-gray-500 max-w-xs truncate">{cmd.result ?? ''}</td>
                      <td className="px-4 py-2 text-gray-600 text-right whitespace-nowrap">{agoStr}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-600">
          Extension must be installed and configured with this tracker&apos;s URL.
        </p>
      </section>

      {/* Users */}
      <section className="rounded-lg border border-gray-800 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Users</h2>
          <p className="text-gray-400 text-sm mt-1">
            Each user has their own orders, settings, and API credentials. Buyers are shared.
          </p>
        </div>

        {users.length > 0 && (
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-right">Orders</th>
                  <th className="px-4 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-gray-900/40">
                    <td className="px-4 py-2 text-gray-200">{u.name}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{u._count.orders}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => removeUser(u.id)}
                        className="text-gray-600 hover:text-red-400 transition-colors text-xs"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="label">Add user</label>
            <input
              type="text"
              value={newUserName}
              onChange={e => setNewUserName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addUser()}
              className="input w-full"
              placeholder="Name"
            />
          </div>
          <button
            onClick={addUser}
            disabled={!newUserName.trim()}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-md transition-colors"
          >
            Add
          </button>
        </div>
        {userError && <p className="text-red-400 text-sm">{userError}</p>}
      </section>

      {/* Danger zone */}
      <section className="rounded-lg border border-red-900/50 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
          <p className="text-gray-400 text-sm mt-1">These actions are permanent and cannot be undone.</p>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-200">Delete all orders</p>
            <p className="text-xs text-gray-500 mt-0.5">Permanently removes all your orders from the database.</p>
          </div>
          {!deleteConfirm ? (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="bg-gray-800 hover:bg-red-900/60 border border-red-900/50 text-red-400 text-sm px-4 py-2 rounded-md transition-colors"
            >
              Delete All Orders
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-400">Are you sure?</span>
              <button
                onClick={deleteAllOrders}
                disabled={deleting}
                className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-md transition-colors"
              >
                {deleting ? 'Deleting…' : 'Yes, delete all'}
              </button>
              <button
                onClick={() => setDeleteConfirm(false)}
                className="text-gray-400 hover:text-white text-sm px-3 py-2 rounded-md transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
