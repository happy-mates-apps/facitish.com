/* FC 233 - Move/3500 VIKING simulator engine (data-driven).
   The menu comes from a published (or draft) snapshot managed in the Admin Portal.
   Behaviours (flows) are code: the admin picks one per function. */
(function () {
  'use strict';

  const AMT = (title, field) => ({ t: 'amount', title, field });
  const CONF = (lines, show) => ({ t: 'confirm', lines: lines || ['Correct amount?'], show: show === undefined ? true : show });
  const CARD = { t: 'card' };
  // Standard for status / processing screens: short, so the simulator never keeps the agent waiting.
  // MSG_MS for "Setting … power", "Building status…" and similar; message screens that must be read stay at most MSG_MAX.
  const MSG_MS = 1200, MSG_MAX = 1600;
  const PROC = (lines, ms) => ({ t: 'proc', lines, ms: Math.min(ms || MSG_MS, MSG_MAX) });
  const RES = (lines, note, icon) => ({ t: 'result', lines, note: note || '', icon: icon || 'check' });
  // Approved transaction: green screen (Martin, 9 Nov 2026). Rejected screens are red (customer cancel, transaction errors).
  const OK = (lines, note) => Object.assign(RES(lines, note), { ok: true });
  const DIG = (lines, field, opt, mask, max, note) => ({ t: 'digits', lines, field, opt, mask, max, note });
  const PAYNOTE = '';

  // Simulated behaviours an admin can attach to a function.
  const FLOWS = {
    purchase: { name: 'Purchase (amount → confirm → card)', end: 'idle', pay: true, tt: 'tt.purchase', steps: [AMT('Enter amount', 'amount'), CONF(), CARD, PROC(['Authorising…'], 1600), OK(['Approved'], PAYNOTE)] },
    tipnote: { name: 'Print tip-note', end: 'idle', pay: true, steps: [AMT('Enter amount', 'amount'), CONF(), CARD, PROC(['Processing…']), RES(['Tip-note printed'], '')] },
    purchasecb: { name: 'Purchase + cash back (amount, confirm, cash back)', end: 'idle', pay: true, steps: [AMT('Enter amount', 'amount'), CONF(), AMT('Cash back', 'cash'), CARD, PROC(['Authorising…'], 1600), OK(['Approved'], PAYNOTE)] },
    purchasecb2: { name: 'Purchase + cash back (purchase, cash, confirm)', end: 'idle', pay: true, steps: [AMT('Purchase', 'amount'), AMT('Enter cash amount', 'cash'), CONF(), CARD, PROC(['Authorising…'], 1600), OK(['Approved'], PAYNOTE)] },
    balance: { name: 'Balance (present card)', end: 'idle', pay: true, steps: [CARD, PROC(['Reading card…']), RES(['Balance', '250,00 DKK'], '', 'info')] },
    deposit: { name: 'Deposit (amount → card → 2 receipts)', end: 'idle', pay: true, steps: [AMT('Amount', 'amount'), CARD, PROC(['Processing…']), OK(['Deposit approved', 'Printing 2 receipts'], 'Cashier signs the cardholder’s receipt')] },
    reversal: { name: 'Reversal (cancel transaction?)', end: 'idle', pay: true, steps: [CONF(['Cancel transaction?'], false), PROC(['Cancelling…']), RES(['Transaction cancelled'], '')] },
    refund: { name: 'Return of goods (refund amount)', end: 'idle', pay: true, steps: [AMT('Refund amount', 'amount'), CONF(), CARD, PROC(['Processing…']), OK(['Refund approved'], '')] },
    forceoffline: { name: 'Force offline (auth code → amount)', end: 'idle', pay: true, steps: [DIG(['Call acquirer', 'Enter Auth-code'], 'auth', true, false, 8, ''), AMT('Enter amount', 'amount'), CONF(), CARD, PROC(['Processing…']), OK(['Approved'], '')] },
    // As filmed on a Move/3500 (DK, 6 Nov 2026): Vent → AFSTEMNING 1 / VENTER 1 → UDSKRIFT (receipt) → back to the menu. No spinner, no "done" screen.
    recon: { name: 'Reconciliation', end: 'menu', steps: [Object.assign(PROC(['Wait'], 800), { plain: true }), Object.assign(PROC(['RECONCILIATION 1', 'WAITING 1'], 1500), { plain: true }), Object.assign(PROC(['PRINTING'], 1500), { plain: true })] },
    // Printouts: PRINTING (UDSKRIFT) while the receipt prints, then straight back to the menu (Martin, 6 Nov 2026).
    print: { name: 'Print', end: 'menu', steps: [Object.assign(PROC(['PRINTING'], 1500), { plain: true })] },
    copy: { name: 'Print copy', end: 'menu', steps: [Object.assign(PROC(['PRINTING'], 1500), { plain: true })] },
    // Sending works like a reconciliation: Wait, then SENDING, then back to the menu (screen text not filmed yet).
    send: { name: 'Send to host', end: 'menu', steps: [Object.assign(PROC(['Wait'], 800), { plain: true }), Object.assign(PROC(['SENDING'], 1500), { plain: true })] },
    translist: { name: 'Transaction list (Print / Delete submenu)', end: 'menu', steps: [], special: true },
    eotdelete: { name: 'Delete offline transactions (confirm)', end: 'menu', steps: [CONF(['Delete offline', 'transactions?'], false), Object.assign(PROC(['Wait'], 800), { plain: true }), Object.assign(PROC(['DELETED'], 1200), { plain: true })] },
    battery: { name: 'Battery and signal', end: 'menu', steps: [RES(['Battery 82 %', 'Signal 3 of 4'], '', 'info')] },
    printparams: { name: 'Print parameter list', end: 'menu', steps: [Object.assign(PROC(['PRINTING'], 1500), { plain: true })] },
    obstruction: { name: 'Remove obstruction', end: 'menu', steps: [PROC(['Removing obstruction…'], 1500), RES(['Obstruction removed'], '')] },
    ping: { name: 'Ping host', end: 'menu', steps: [PROC(['Ping host…'], 1800), RES(['Ping OK'], '')] },
    buffer: { name: 'Empty print buffer', end: 'menu', steps: [RES(['Buffer cleared'], '')] },
    resetmc: { name: 'Reset merchant card (merchant code)', end: 'menu', steps: [DIG(['Enter merchant code'], 'code', false, true, 6, ''), RES(['Merchant card reset'], '')] },
    wifiscan: { name: 'Wi-Fi: available networks (simulated list and password)', end: 'menu', steps: [], special: true },
    wifion: { name: 'Wi-Fi: switch on', end: 'menu', steps: [], special: true },
    wifioff: { name: 'Wi-Fi: switch off', end: 'menu', steps: [], special: true },
    bton: { name: 'Bluetooth: switch on', end: 'menu', steps: [], special: true },
    btoff: { name: 'Bluetooth: switch off', end: 'menu', steps: [], special: true },
    reboot: { name: 'Reboot', end: 'reboot', steps: [PROC(['The terminal is restarting,', 'this may take a moment.'], 2400)] },
    switchoff: { name: 'Switch off', end: 'off', steps: [] }
  };

  const BEHAVIORS = {
    menu: 'Submenu',
    settings: 'Settings screen (▲ ▼ browse, OK edit)',
    function: 'Simulated function',
    profile: 'Profile choice (confirm)',
    placeholder: 'Placeholder (screen not documented)'
  };

  // Keep the screen looking like a real terminal: hide demo markers, mask placeholder addresses.
  const clean = v => { if (v == null) return v; let t = String(v).replace(/\s*\((demo|demo value|example)\)/ig, ''); if (/^0\.0\.0\.0$/.test(t)) t = '•••.•••.•••.•••'; else if (/hidden in training/i.test(t)) t = '••••••••'; return t; };
  const cleanNote = v => { const t = clean(v); return (!t || /simulat|demo|training/i.test(t)) ? '' : t; };
  Sim.clean = clean;

  /* ---------------- Menu model from a snapshot ---------------- */
  function condOk(c, settings) {
    if (!c || !c.setting) return true;
    const v = settings[c.setting];
    return c.op === 'neq' ? v !== c.value : v === c.value;
  }
  function showIfOk(f, settings) {
    return !f.showIf || !f.showIf.length || f.showIf.every(c => (c.in || []).indexOf(settings[c.key]) >= 0);
  }

  function buildMenu(snapshot, opts) {
    const market = opts && opts.market;
    const all = (snapshot && snapshot.nodes) || [];
    const raw = {};
    // Labels as the Move/3500 shows them, also for releases published before the menu tree was corrected.
    const FIX = { 'Set Netowrk Type': 'Set Network Type', 'Phone parring': 'Phone pairing', 'Sim Code': 'SIM Code', 'Select Networks': 'Select Network', 'Lagacy software': 'Legacy software', 'Keyboard normal level': 'Kbd normal level', 'Keyboard low level': 'Kbd low level', 'Software info': 'Software setup', 'Power saving': 'Power Saving', 'Last reconciliation': 'Last reconc.' };
    // Functions simulated in code before their menu item is republished.
    const FLOW_FIX = { 'm35-026': { behavior: 'function', flow: 'eotdelete' }, 'm35-005': { flow: 'translist' } };
    // Settings as seen on a Move/3500 (DK video, 6 Nov 2026): Reboot Time can be changed, VAT rate only shows with VAT, the ShortCut menu isn't protected by default.
    const FIELD_FIX = { rebootTime: { readOnly: false, input: 'time', display: undefined }, vatRate: { showIf: [{ key: 'vat', in: ['Fixed rate', 'Change rate'] }] }, protShortcut: { default: 'No' } };
    all.forEach(n => { if (n.deleted) return; let x = FIX[n.label] ? Object.assign({}, n, { label: FIX[n.label] }) : n; if (FLOW_FIX[n.id] && (x.behavior === 'placeholder' || FLOW_FIX[n.id].flow === 'translist')) x = Object.assign({}, x, FLOW_FIX[n.id]); if ((x.fields || []).some(f => FIELD_FIX[f.key])) x = Object.assign({}, x, { fields: x.fields.map(f => FIELD_FIX[f.key] ? Object.assign({}, f, FIELD_FIX[f.key]) : f) }); raw[n.id] = x; });
    const hw = (opts && opts.hw) || null;
    if (hw && (hw.hideFields || hw.dropValues)) Object.keys(raw).forEach(id => {
      const n = raw[id]; if (!(n.fields || []).length) return;
      const fields = n.fields.filter(f => !(hw.hideFields || []).includes(f.key)).map(f => {
        const drop = (hw.dropValues || {})[f.key]; if (!drop || !f.values) return f;
        const values = f.values.filter(v => drop.indexOf(v) < 0);
        return Object.assign({}, f, { values, default: values.indexOf(f.default) >= 0 ? f.default : values[0], showIf: f.showIf });
      }).map(f => (f.showIf || []).length ? Object.assign({}, f, { showIf: f.showIf.map(c => { const d = (hw.dropValues || {})[c.key]; return d && c.in ? Object.assign({}, c, { in: c.in.filter(v => d.indexOf(v) < 0) }) : c; }) }) : f);
      raw[id] = Object.assign({}, n, { fields });
    });
    const kidsRaw = {};
    Object.values(raw).forEach(n => { if (n.parentId) (kidsRaw[n.parentId] = kidsRaw[n.parentId] || []).push(n); });
    const root = Object.values(raw).find(n => !n.parentId && n.behavior === 'root' && n.tree !== 'cp');
    const cpRoot = hw && hw.noControlPanel ? null : (Object.values(raw).find(n => !n.parentId && n.behavior === 'root' && n.tree === 'cp') || null);
    const byId = {}, parentOf = {}, kids = {}, defaults = {};
    const inMarket = n => !market || !n.markets || !n.markets.length || n.markets.indexOf(market) >= 0;
    // Kept in the Admin Hub but not shown on the terminal (Martin, Nov 2026: not on the Move/3500 main menu in DK or NO). A node can also set hideOnTerminal itself.
    const onTerminal = n => !Sim.hiddenOnTerminal(n);
    const walk = (n, pid) => {
      byId[n.id] = n; parentOf[n.id] = pid;
      (n.fields || []).forEach(f => { if (f.key && defaults[f.key] === undefined) defaults[f.key] = f.default !== undefined ? f.default : (f.values && f.values[0]); });
      const list = (kidsRaw[n.id] || []).filter(c => inMarket(c) && onTerminal(c) && !(hw && (hw.hideNodes || []).includes(c.id))).sort((a, b) => (a.order - b.order) || (a.num - b.num));
      kids[n.id] = list;
      list.forEach(c => walk(c, n.id));
    };
    if (root) walk(root, null);
    if (cpRoot) { walk(cpRoot, null); if (defaults.wifiOn === undefined) defaults.wifiOn = 'On'; if (defaults.btOn === undefined) defaults.btOn = 'Off'; }
    if (hw && hw.defaults) Object.keys(hw.defaults).forEach(k => { if (k in defaults) defaults[k] = hw.defaults[k]; });
    return { root, cpRoot, byId, parentOf, kids, defaults, hw, version: snapshot && snapshot.version };
  }


  /* ---------------- Terminal language ----------------
     One menu structure for every language. Translations live in the i18n store (one document per
     model and language), keyed by stable ids - never by the English text:
       n:<nodeId>  menu item     f:<fieldKey>  setting name     v:<fieldKey>:<value>  setting value
       u:<id>      fixed screen text (UI below)
     Values stay English inside the simulator, so behaviour never depends on the language.
     The terminal language follows Parameters › Function › Language. The Control panel (Telium)
     is not translated. The TAS chat language is separate. */
  const UI = {
    'menu.main': 'Main menu', 'amt.enter': 'Enter amount', 'amt.amount': 'Amount', 'amt.purchase': 'Purchase', 'amt.cashback': 'Cash back', 'amt.cash': 'Enter cash amount', 'amt.refund': 'Refund amount',
    'conf.amount': 'Correct amount?', 'conf.cancel': 'Cancel transaction?', 'conf.keys': 'OK = Yes    STOP = No',
    'card.present': 'Present card', 'card.ifr': 'Press YELLOW for card application selection', 'tt.purchase': 'PURCHASE', 'cust.cancel': 'Cancelled by customer', 'p.sending': 'SENDING', 'del.q1': 'Delete offline', 'del.q2': 'transactions?', 'del.done': 'DELETED', 'mc.swipe': 'Swipe merchant card', 'mc.term': 'Term =', 'mc.code': 'Merchant code?', 'mc.wrong': 'Wrong merchant code',
    'svc.swipe1': 'Swipe', 'svc.swipe2': 'Service card', 'svc.code': 'Enter serv code', 'svc.fail1': 'Update failed', 'svc.fail2': 'wrong code',
    'fo.call': 'Call acquirer', 'fo.auth': 'Enter Auth-code',
    'p.authorising': 'Authorising…', 'p.processing': 'Processing…', 'p.reading': 'Reading card…', 'p.cancelling': 'Cancelling…', 'p.printing': 'PRINTING',
    'p.wait': 'Wait', 'p.recon1': 'RECONCILIATION 1', 'p.recon2': 'WAITING 1', 'p.obstr': 'Removing obstruction…', 'p.ping': 'Ping host…',
    'r.approved': 'Approved', 'r.tipnote': 'Tip-note printed', 'r.balance': 'Balance', 'r.deposit': 'Deposit approved', 'r.deposit2': 'Printing 2 receipts', 'r.deposit3': 'Cashier signs the cardholder’s receipt',
    'r.cancelled': 'Transaction cancelled', 'r.refund': 'Refund approved',
    'r.obstr': 'Obstruction removed', 'r.ping': 'Ping OK', 'r.buffer': 'Buffer cleared', 'mc.enter': 'Enter merchant code', 'r.mcreset': 'Merchant card reset',
    'rb.msg1': 'The terminal is restarting,', 'rb.msg2': 'this may take a moment.',
    'op.cancel': 'CANCELLED BY OPERATOR', 'cp.norecon': 'NO RECONCILIATION TO COPY', 'rb.box': 'Reboot In progress', 'rb.welcome': 'Welcome', 'idle.wait': 'Waiting for Amount', 'print.pending': 'Print Pending',
    'tl.print': 'Print', 'tl.delete': 'Delete', 'tl.period': 'Select period', 'tl.per': 'Period', 'tl.all': 'All', 'tl.del1': 'DELETE', 'tl.del2': 'TRANS. LIST?', 'tl.empty1': 'TRANS. LIST', 'tl.empty2': 'IS EMPTY', 'r.batt': 'Battery {1} %', 'r.signal': 'Signal {1} of {2}', 'pf.q1': 'Change profile', 'pf.q2': 'to {1}?', 'pf.done1': 'Profile {1}', 'pf.done2': 'selected', 'sc.title': 'ShortCut Menu', 'ti.tid': 'Terminal ID:', 'ti.prog': 'Program:', 'ti.sno': 'S.No:', 'sc.tinfo': 'Terminal Info', 'sc.bt': 'Bluetooth', 'sc.wifi': 'Wifi setting'
  };
  const UI_BY_EN = {}; Object.keys(UI).forEach(k => { if (!UI_BY_EN[UI[k]]) UI_BY_EN[UI[k]] = k; });
  // Texts with a number or name in them ("Battery 82 %", "to .no?"): {1}, {2} mark the parts that are kept as they are.
  const UI_TPL = Object.keys(UI).filter(k => /\{\d\}/.test(UI[k])).map(k => ({ k, re: new RegExp('^' + UI[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d)\\\}/g, '(.+?)') + '$') }));
  const LANG_CODE = { Danish: 'da', Dutch: 'nl', English: 'en', Estonian: 'et', Finnish: 'fi', French: 'fr', German: 'de', Hungarian: 'hu', Icelandic: 'is', Italian: 'it', Latvian: 'lv', Lithuanian: 'lt', Norwegian: 'no', Polish: 'pl', Portuguese: 'pt', Spanish: 'es', Swedish: 'sv' };
  const I18N = { docs: {} };
  const CUR_OF = { Danish: 'DKK', Norwegian: 'NOK', Swedish: 'SEK', Finnish: 'EUR' };
  const saveCur = c => { try { localStorage.setItem('vt-term-cur', c); } catch (e) {} };

  /* ---------------- Simulator ---------------- */
  function Sim(onChange) {
    this.onChange = onChange || function () {};
    this.M = buildMenu(null);
    this.tok = 0;
    this.wt = null;
    this.state = this.fresh();
  }
  Sim.FLOWS = FLOWS;
  Sim.BEHAVIORS = BEHAVIORS;
  Sim.buildMenu = buildMenu;
  Sim.condOk = condOk;
  // Kept in the Admin Hub but not shown on the terminal. Default for Purchase+C/B and Misc - Func. (Martin, Nov 2026: not on the Move/3500 main menu); the node's own hideOnTerminal switch wins when set.
  const HIDE_ON_TERMINAL = { 'm35-purchasecb': 1, 'm35-misc': 1 };
  Sim.hiddenOnTerminal = n => !!n && (n.hideOnTerminal === undefined || n.hideOnTerminal === null ? !!HIDE_ON_TERMINAL[n.id] : !!n.hideOnTerminal);
  Sim.showIfOk = showIfOk;
  Sim.UI = UI;
  Sim.LANG_CODE = LANG_CODE;
  Sim.I18N = I18N;
  Sim.setTranslations = function (docs) { I18N.docs = docs || {}; };

  // Simulated Wi-Fi networks for the Control panel (made-up names, nothing touches real networks).
  // Made-up network names, a different mix each session (the real list shows whatever is nearby).
  const WIFI_POOL = ['Shop-WiFi', 'Cafe_Guest', 'Office_5G', 'Netgear_4F21', 'TP-Link_7A3C', 'Zyxel_B2C4', 'Bakery-Net', 'Kiosk_2G', 'Salon_Guest', 'Warehouse-AP', 'Backroom_5G', 'Home-8F3A'];
  const WIFI_NETS = (() => { const p = WIFI_POOL.slice(); for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p.slice(0, 6); })();
  // Password keyboard: 12 keys (1-9, '.', 0, '*') and the bar (#$%, ABC, cancel, delete, OK). Moved through with ▲ ▼ F1 F4, green picks.
  const PW_CELLS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '*', 'sym', 'abc', 'cancel', 'del', 'ok'];
  Sim.PW_CELLS = PW_CELLS;
  Sim.WIFI_NETS = WIFI_NETS;
  const PW_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*-_.';
  // Made-up identity for this session: a random Terminal ID (also the TID setting under Function) and serial number.
  const rnd = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
  const SESSION_TID = (1 + Math.floor(Math.random() * 9)) + rnd(7);
  const SESSION_PERIOD = 200 + Math.floor(Math.random() * 90);
  const SESSION_SN = '2' + rnd(20);
  // Mobile network status: as seen on a Move/3500, with a made-up SIM ICC ID and cell ID for this session.
  const SESSION_ICC = '8947' + rnd(16);
  const SESSION_CELL = '0x000004' + '0123456789ABCDEF'[Math.floor(Math.random() * 16)] + '0123456789ABCDEF'[Math.floor(Math.random() * 16)];
  // Second number on the Welcome screen while starting: meaning unknown, so a number like the real one (400126010200) with its digits moved around.
  const SESSION_ID12 = '400' + '126010200'.split('').sort(() => Math.random() - 0.5).join('');
  Sim.SESSION_TID = SESSION_TID;
  /* ShortCut menu: ▼ on the start screen. Items and numbers as on the terminal (there is no item 3). */
  // Wifi setting: merchant card, then the Control panel (Terminal settings › Comm means › Wi-Fi) - Nets user guide 7.5.1.2.
  // As on a Move/3500 (DK, 6 Nov 2026): 1, 2 and 4 - there is no 3 or 5. 2 Bluetooth opens the Control panel's Bluetooth menu.
  const SHORTCUTS = [{ num: 1, label: 'Terminal Info', act: 'tinfo' }, { num: 2, label: 'Bluetooth', act: 'bt' }, { num: 4, label: 'Wifi setting', act: 'cp' }];
  Sim.SHORTCUTS = SHORTCUTS;
  Sim.prototype.shortcuts = function () { const h = (this.hwp().hideShortcuts || []); return SHORTCUTS.filter(x => h.indexOf(x.act) < 0); };
  // The physical terminal this simulator is (Move/3500 unless the menu was built for another model).
  Sim.prototype.hwp = function () { return (this.M && this.M.hw) || {}; };
  Sim.prototype.fresh = function () {
    const st = Object.assign({}, this.M.defaults, 'tid' in this.M.defaults ? { tid: SESSION_TID } : {});
    if (this.prefLang && 'language' in st) st.language = this.prefLang;
    return { cur: this.prefCur || CUR_OF[st.language || this.prefLang] || 'DKK', termLang: st.language || this.prefLang || 'English', power: 'on', stack: [], screen: null, merchantAuth: false, settings: st, serial: SESSION_SN, status: '', busy: false, pressed: null, swipe: false, tap: false, wifi: { connected: WIFI_NETS[0] } };
  };
  Sim.prototype.setMenu = function (M) {
    const old = this.state.settings;
    this.M = M;
    const s = Object.assign({}, M.defaults);
    if ('tid' in s) s.tid = SESSION_TID;
    Object.keys(old).forEach(k => { if (k in s) s[k] = old[k]; });
    this.goIdle();
    if (this.prefLang && !('language' in old) && 'language' in s) s.language = this.prefLang;
    this.state.settings = s;
    if (!this.state.termLang) this.state.termLang = s.language || 'English';
    this.wt = null;
    this.emit();
  };
  // Training merchant code for this virtual terminal (TAS Settings). Never a real merchant's code.
  Sim.prototype.merchantCode = '1234';
  // Changing the TID asks for the terminal's service code, on the same kind of screen as the merchant code.
  Sim.prototype.serviceCode = '5678';
  // Terminal language picked outside the menu (language button or TAS chat). Kept for the session.
  Sim.prototype.prefLang = null;
  const SVC_FIELDS = ['tid'];
  const PROGRAM_VER = '206';
  // Telium Manager code: Control panel › Comm means › Ethernet and PCL ask for it (confirmed on a Move/3500).
  const TELIUM_CODE = '4302';
  // Shown wherever the simulator has no information about a screen yet (after the password, if there is one).
  const NOINFO = 'No information about this screen yet';
  // Software mgmt › Evolution › Remote upgrade, as seen on a Move/3500 (video 29 Oct 2026). "none" = not opened in the recording.
  const SW_REMOTE = [
    { l: 'Start remote upgrade', a: 'pass' },
    { l: 'Download package', a: 'input', prompt: 'Enter package name' },
    { l: 'Configuration', a: 'tms' },
    { l: 'Automatic upgrades', kids: [
      { l: 'Cyclic calls', kids: [
        { l: 'Reference call', a: 'input', prompt: 'Enter Contract number' },
        { l: 'Cyclic calls', a: 'info', text: 'No cyclic call definition' },
        { l: 'Manual parameters', kids: [{ l: 'Consult parameters', a: 'dp', show: 'cfg' }, { l: 'Deactivate', a: 'resetprog' }, { l: 'Reset configuration', a: 'none' }] }] },
      { l: 'Maintenance', a: 'none' },
      { l: 'Consult call log', a: 'dp', show: 'calllog' }] }];
  const SW_TMS = ['Network type\nETHERNET', 'Contract number', 'TMS address\n0.0.0.0', 'TCP port\n6000', 'SSL profile', 'Helpdesk port\n0', 'Data Usage Limit (in MB)\n0', 'Print Parameters'];
  // View configuration › Customer packages › Legacy software: package names as seen; IDs and versions are simulated.
  const swId = () => 'Id ' + String(Math.floor(Math.random() * 1e6)).padStart(10, '0'), swVer = () => 'ver ' + String(Math.floor(Math.random() * 60)).padStart(2, '0') + '.' + String(Math.floor(Math.random() * 40)).padStart(2, '0') + '.00';
  const SW_PKGS = {};
  // Control panel › Terminal info › Hardware info: shortened and general (the real lists are longer and specific to each terminal).
  const HW_INFO = {
    General: () => ['Prod. name: Move3500', 'Prod. code: M75', 'Const. code: INGENICO', 'SN: ' + SESSION_SN],
    Wireless: () => ['GPRS: YES', 'Bluetooth: YES', 'Wi-Fi: YES', '4G: YES'],
    Hardware: () => ['Modem: NO', 'Printer: YES', 'Buzzer: YES', 'USB host: YES'],
    Readers: () => ['ISO1: YES', 'ISO2: YES', 'ISO3: YES', 'CAM1: YES', 'SAM1: YES']
  };
  [['application', ['EMUL', 'EMVDC_EMUL', 'EMV_ENGINE', 'Interac', 'SPMCIWR', 'VIKING']], ['dll', ['COLOR', 'CRYPTO', 'DLLPSC', 'ENTRY', 'EXTENS', 'IAM', 'LIBDPAS', 'LibEmul', 'libexpresspay', 'LIBGR', 'libinterac']], ['parameters', ['ISO1', 'M2OS', 'MESSAGE', 'T3PARAM', 'T3PARAM', 'T3PARAM', 'VIKING']]].forEach(([k, names]) => { SW_PKGS[k] = names.map((n, i) => i + '-' + n + '\n' + swId() + '   ' + swVer()); });
  Sim.prototype.reset = function () { this.tok++; this.wt = null; this.errText = ''; this.state = this.fresh(); this.emit(); };
  // An error message shown on the idle screen (set by TAS while troubleshooting). Menus still work on top of it.
  Sim.prototype.showError = function (t, red) { this.errText = t || ''; this.errRed = !!(t && red); this.emit(); };
  Sim.prototype.emit = function (quiet) { if (!quiet && !this._replaying) this.wtCheck(); if (!this._replaying) this.onChange(); };

  const S = Sim.prototype;
  S.node = function (id) { return this.M.byId[id]; };
  S.vis = function (node) { const st = this.state.settings; return (this.M.kids[node.id] || []).filter(c => condOk(c.condition, st)); };
  S.isHidden = function (n) { return !condOk(n.condition, this.state.settings); };
  // Readable condition text; the Control panel switches read as "Bluetooth is switched on".
  const SWITCH_NAMES = { btOn: 'Bluetooth', wifiOn: 'Wi-Fi' };
  S.condText = function (c) {
    if (!c) return '';
    if (SWITCH_NAMES[c.setting]) { const on = (c.op === 'neq') !== (String(c.value).toLowerCase() === 'on'); return SWITCH_NAMES[c.setting] + ' is switched ' + (on ? 'on' : 'off'); }
    let label = c.setting; Object.values(this.M.byId || {}).some(n => (n.fields || []).some(f => { if (f.key === c.setting) { label = f.label; return true; } return false; }));
    return label + (c.op === 'neq' ? ' is not ' : ' is ') + c.value;
  };
  S.fieldsFor = function (node) { const st = this.state.settings; return (node.fields || []).filter(f => showIfOk(f, st)); };
  // Rows per screen: the VIKING menus show 5 items under the title (as filmed on a Move/3500), the Control panel 6.
  S.rowsPerScreen = function () { return this.inCP() ? 6 : 5; };
  S.fit = function (e, n) { const V = this.rowsPerScreen(); if (e.sel < e.top) e.top = e.sel; if (e.sel > e.top + V - 1) e.top = e.sel - V + 1; e.top = Math.max(0, Math.min(e.top, Math.max(0, n - V))); };
  S.say = function (t) { this.state.status = t; };
  // The terminal shows its language after a restart: changing Function › Language only takes effect at the reboot.
  S.lang = function () { return LANG_CODE[this.state.termLang] || 'en'; };
  S.langName = function () { return this.state.termLang || 'English'; };
  // Quick switch (language button / TAS chat): back to the start screen in the new language.
  S.setLanguage = function (name) {
    if (CUR_OF[name]) { this.prefCur = CUR_OF[name]; this.state.cur = CUR_OF[name]; saveCur(this.prefCur); }
    if (!LANG_CODE[name]) return false;
    const s = this.state; this.prefLang = name; s.termLang = name; if (s.settings && 'language' in s.settings) s.settings.language = name;
    if (s.power === 'on') this.goIdle(); this.wt = null; this.emit(); return true;
  };
  S.tr = function (key, en) {
    const L = this.lang(); if (L === 'en') return en;
    const hwt = ((this.hwp().tr || {})[L] || {})[key]; if (hwt) return hwt; // text that differs on this terminal model
    const d = I18N.docs[L], e = d && d.entries && d.entries[key];
    if (e && e.blank && e.s === 'verified') return '';
    if (!e || !e.t || e.s === 'missing') return en;
    if (e.s !== 'verified' && d.useUnverified === false) return en;
    return e.t;
  };
  S.trNode = function (n) { return n ? (this.isCpNode(n.id) ? n.label : this.tr('n:' + n.id, n.label)) : ''; };
  S.trField = function (f) { return this.tr('f:' + f.key, f.label); };
  S.trVal = function (f, v) { return v == null ? v : this.tr('v:' + f.key + ':' + v, String(v)); };
  S.trUi = function (t) {
    if (typeof t !== 'string') return t; const k = UI_BY_EN[t]; if (k) return this.tr('u:' + k, t);
    for (const p of UI_TPL) { const m = p.re.exec(t); if (m) { const tt = this.tr('u:' + p.k, UI[p.k]); return tt.replace(/\{(\d)\}/g, (x, n) => m[+n] || ''); } }
    return t;
  };
  S.wl = function (n) { const t = this.trNode(n); return t && t !== n.label ? t + ' (' + n.label + ')' : n.label; };
  S.trId = function (k) { return this.tr('u:' + k, UI[k]); };
  S.goIdle = function () { const s = this.state; s.stack = []; s.screen = null; s.merchantAuth = false; s.menuAuth = false; s.busy = false; this.tok++; };
  /* ---------- Control panel screens (application selector, Wi-Fi networks, Wi-Fi password) ---------- */
  S.APPS = ['Control panel', 'VIKING PA'];
  S.cpKey = function (k) {
    const s = this.state, sc = s.screen, digit = (k.charAt(0) === 'k' && k !== 'kdot') ? k.slice(1) : null;
    if (sc.type === 'apps') {
      if (k === 'f2' || k === 'f3') { sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + 2) % 2; return; }
      if (k === 'green') return this.pickApp(sc.sel);
      if (k === 'yellow') { this.goIdle(); }
      return;
    }
    if (sc.type === 'wifinets') {
      const n = WIFI_NETS.length + 1;
      if (k === 'f2' || k === 'f3') { sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + n) % n; this.fitNets(sc); return; }
      if (digit !== null && +digit < n) { sc.sel = +digit; return this.pickNet(sc.sel); }
      if (k === 'green') return this.pickNet(sc.sel);
      if (k === 'yellow') s.screen = null;
      return;
    }
    if (sc.type === 'wifipw') {
      // As on the Move/3500: ▲ ▼ and F1 / F4 move the highlight over the on-screen keys, green picks the highlighted key
      // (a character shows as *). To finish, move to the green key on the screen and press green.
      const f = sc.f == null ? 16 : sc.f;
      if (k === 'f1' || k === 'f4') { sc.f = f < 12 ? Math.floor(f / 3) * 3 + (f % 3 + (k === 'f4' ? 1 : 2)) % 3 : 12 + (f - 12 + (k === 'f4' ? 1 : 4)) % 5; return; }
      if (k === 'f2' || k === 'f3') {
        const down = k === 'f3';
        if (f < 12) { const r = Math.floor(f / 3), c = f % 3; sc.f = down ? (r === 3 ? 12 + [0, 2, 4][c] : f + 3) : (r === 0 ? 12 + [0, 2, 4][c] : f - 3); }
        else { const c = [0, 0, 1, 2, 2][f - 12]; sc.f = down ? c : 9 + c; }
        return;
      }
      if (k === 'green') return this.pwTap(PW_CELLS[f]);
      if (k === 'yellow') return this.pwTap('del');
    }
  };
  // Diagnosis › Local › All / Counters / Messages › Display (seen on a Move/3500; no counters or messages were shown).
  // The reset history is the kind shown on the real terminal, with dates from the last two days.
  S.swOpen = function (sc, it) {
    const s = this.state, path = (sc.path || [sc.title]);
    if (it.kids) { s.screen = { type: 'cptree', node: sc.node, title: it.l, items: it.kids, sel: 0, back: sc, path: path.concat([it.l]) }; return; }
    if (it.a === 'pass') { s.screen = { type: 'cppass', node: sc.node, header: it.l, pw: '', showLast: true, back: sc }; return; }
    if (it.a === 'input') { s.screen = { type: 'cppass', node: sc.node, header: it.l, pw: '', prompt: it.prompt, plain: true, back: sc }; return; }
    if (it.a === 'tms') { s.screen = { type: 'cplist', node: sc.node, title: '< TMS configuration', rows: SW_TMS, sel: 0, top: 0, plain: true, multi: true, view: 5, back: sc, info: true }; return; }
    if (it.a === 'info') { s.screen = { type: 'cpinfo', node: sc.node, header: it.l, lines: [it.text], icon: 'infob', back: sc }; return; }
    if (it.a === 'dp') { s.screen = { type: 'wifistat', node: sc.node, sel: 0, sw: it.show, back: sc }; return; }
    if (it.a === 'resetprog') { s.screen = { type: 'swreset', node: sc.node }; const tok = this.tok; setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'swreset') return; s.screen = sc; this.emit(); }, MSG_MAX); return; }
    // Maintenance / Reset configuration: nothing happens (as on the Move/3500).
  };
  // Configuration parameters and Call log (Remote upgrade › Automatic upgrades): text as seen on a Move/3500, with recent dates.
  S.swLines = function (what) {
    const H = t => ({ t, b: true }), pad = n => String(n).padStart(2, '0'), d = n => { const x = new Date(Date.now() - n * 864e5); return pad(x.getDate()) + '/' + pad(x.getMonth() + 1) + '/' + x.getFullYear(); };
    if (what === 'cfg') { const x = new Date(); return [H('Configuration parameters'), { t: '' }, { t: d(0) + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes()) + ':' + pad(x.getSeconds()) }, { t: 'Version: T3 ALPHA 0.1' }, { t: 'No config' }, { t: 'manual nettype = fe' }, { t: 'manual tms id =' }]; }
    const log = [[7, '14:11:49', 'Reset manual param file'], [7, '14:11:49', 'No configuration'], [7, '14:12:42', 'No configuration'], [3, '11:16:11', 'No configuration'], [3, '11:56:29', 'No configuration'], [3, '11:59:51', 'No configuration'], [3, '12:06:53', 'No configuration'], [3, '17:00:44', 'No configuration'], [3, '17:07:56', 'No configuration'], [3, '17:09:19', 'No configuration'], [2, '08:39:20', 'No configuration'], [2, '13:04:44', 'No configuration'], [2, '13:29:07', 'No configuration'], [2, '13:31:29', 'No configuration'], [2, '15:46:53', 'No configuration'], [2, '15:58:20', 'No configuration'], [2, '16:01:01', 'No configuration'], [2, '16:03:13', 'No configuration'], [1, '09:58:36', 'No configuration'], [0, '09:50:25', 'No configuration']];
    return [H('Call log')].concat([].concat.apply([], log.map(([n, t, m]) => [{ t: d(n) + ' ' + t + ' [I]' + m.split(' ')[0] }, { t: m.split(' ').slice(1).join(' ') }])));
  };
  S.diagLines = function (what) {
    const H = t => ({ t, b: true }), d = n => { const x = new Date(Date.now() - n * 864e5); return String(x.getDate()).padStart(2, '0') + '/' + String(x.getMonth() + 1).padStart(2, '0') + '/' + x.getFullYear(); };
    if (what === 'Counters') return [H('Diagnosis'), { t: '' }, { t: '' }, { t: '' }, H('Diagnosis Counters')];
    if (what === 'Messages') return [H('Diagnosis'), { t: '' }, { t: '' }, { t: '' }, H('Diagnosis Messages')];
    const r = [['RebootRequestByLinux', 0, '15:07:29'], ['RebootRequestByLinux', 0, '15:05:17'], ['RebootRequestByLinux', 0, '15:02:36'], ['Shutdown-restart', 0, '12:35:43'], ['RebootRequestByLinux', 0, '12:33:22'], ['RebootRequestByLinux', 0, '12:08:50'], ['RebootRequestByLinux', 1, '15:15:40'], ['RebootRequestByLinux', 1, '15:13:20'], ['Shutdown-restart', 1, '15:04:52'], ['RebootRequestByLinux', 1, '14:35:06']];
    const out = [H('Diagnosis'), H('Diagnosis Counters'), { t: '' }, H('Diagnosis Messages'), { t: '' }, H('Last Resets'), { t: '' }];
    r.forEach(([n, a, t]) => { out.push({ t: n }, { t: d(a + 1) + ' ' + t }, { t: '' }); });
    return out;
  };
  S.mobStatusRows = function () {
    return ['FW: EG912YEM\nEG912YEMAAR01A13M1\n6_30.001.30.001-V0\n2', 'SIM Status: OK', 'Attachment: ATTACHED', 'Radio Access: 4G', 'Radio level : 4', 'Ready for data', 'Start Report READY', 'Automaton Status:\nGPRS PDP CONNECTED', 'Enabled Function:\nGPRS/3G', 'Network Connection:\nREADY TO CONNECT', 'Network Name:\nTDC MOBIL (0x23801)', 'GPRS/3G Registration:\nROAMING REGISTERED', 'GSM Registration:\nROAMING REGISTERED', 'Active SIM slot: Slot 1', 'SIM ICC ID:\n' + SESSION_ICC, 'SIM provider:\nTelenor', 'APN:\ninternet'];
  };
  S.fitNets = function (sc) { const V = 5; sc.top = sc.top || 0; if (sc.sel < sc.top) sc.top = sc.sel; if (sc.sel > sc.top + V - 1) sc.top = sc.sel - V + 1; };
  // VIKING PA opens the Main menu, the same as the white Menu key.
  S.pickApp = function (i) { if (i === 0) this.goCP(); else this.goMain(); };
  S.pickNet = function (i) {
    const s = this.state, ssid = WIFI_NETS[i];
    if (!ssid) { this.say('Adding another network isn’t simulated yet.'); return; }
    if (s.wifi.connected === ssid) { this.say('Already connected to ' + ssid + '.'); return; }
    s.screen = { type: 'wifipw', ssid, pw: '', back: i, f: 16 };
  };
  S.pwTap = function (v) {
    const s = this.state, sc = s.screen; if (!sc || sc.type !== 'wifipw') return;
    if (PW_CELLS.indexOf(v) >= 0) sc.f = PW_CELLS.indexOf(v);
    if (v === 'del') { if (sc.pw) sc.pw = sc.pw.slice(0, -1); else s.screen = { type: 'wifinets', sel: sc.back }; return; }
    if (v === 'cancel') { s.screen = { type: 'wifinets', sel: sc.back }; return; }
    if (v === 'ok') {
      // Simulated rule (not documented terminal behaviour): a password of 8 or more characters connects, a shorter one fails.
      if (!sc.pw) return;
      const ok = sc.pw.length >= 8, tok = this.tok, prev = sc;
      s.screen = { type: 'wifimsg', ssid: sc.ssid, step: 'busy' };
      setTimeout(() => {
        if (tok !== this.tok || !s.screen || s.screen.type !== 'wifimsg') return;
        s.screen.step = ok ? 'ok' : 'fail'; this.emit();
        setTimeout(() => {
          if (tok !== this.tok || !s.screen || s.screen.type !== 'wifimsg') return;
          if (ok) { s.wifi.connected = prev.ssid; s.screen = { type: 'wifinets', sel: prev.back }; this.fitNets(s.screen); }
          else s.screen = { type: 'wifipw', ssid: prev.ssid, pw: '', back: prev.back, f: 16 };
          this.emit();
        }, MSG_MAX);
      }, MSG_MS);
      return;
    }
    if (v === 'abc' || v === 'sym') { this.say((v === 'abc' ? 'Letters' : 'Symbols') + ' on the password keyboard aren’t simulated yet.'); return; }
    if (sc.pw.length < 32) sc.pw += v;
  };
  S.pwPress = function (v) { this.say(''); this.pwTap(v); this.emit(); };
  S.isCpNode = function (id) { const p = this.pathNodes(id); return !!(this.M.cpRoot && p.length && p[0].id === this.M.cpRoot.id); };
  S.goCP = function () { this.goIdle(); this.state.stack = [{ id: this.M.cpRoot.id, sel: 0, top: 0 }]; };
  S.inCP = function () { const s = this.state; return !!(this.M.cpRoot && s.stack.length && s.stack[0].id === this.M.cpRoot.id); };
  S.goMain = function () { this.goIdle(); if (this.M.root) this.state.stack = [{ id: this.M.root.id, sel: 0, top: 0 }]; };
  S.press = function (k) {
    const s = this.state; s.pressed = k;
    clearTimeout(this._pt);
    this._pt = setTimeout(() => { s.pressed = null; this.onChange(); }, 150);
  };

  S.key = function (k) { const r = this.key0(k); this.afterKey(); return r; };
  S.key0 = function (k) {
    const s = this.state;
    if (!this.M.root) return;
    this.press(k); this.say(''); this.navRest = null;
    if (s.power === 'off') { if (k === 'green') this.boot(); else this.say('Terminal is off - press OK (green) to switch it on'); return this.emit(); }
    if (s.power === 'boot' || s.power === 'reboot' || s.power === 'shut' || s.busy) return this.emit();
    // Switch off: hold the . key and yellow together for 2-3 seconds (here: press . then yellow).
    if (k === 'kdot') this._dotAt = Date.now();
    if (k === 'yellow' && this._dotAt && Date.now() - this._dotAt < 1500 && !this.hwp().noPowerKeys) { this._dotAt = 0; this.shutdown(); return; }
    // Start screen: yellow flips between the Nets logo and "Waiting for Amount"; it keeps alternating at the same pace.
    if (k === 'yellow' && !s.screen && !s.stack.length) { this.idleFlip = (this.idleFlip || 0) + 1; return this.emit(); }
    // At the merchant card prompt, red opens the merchant code screen instead (merchant code = alternative to the card).
    if (k === 'red' && s.screen && (s.screen.type === 'auth' || (s.screen.type === 'flow' && s.screen.steps[s.screen.i].t === 'merchant'))) { s.screen = { type: 'mcode', code: '', back: s.screen }; return this.emit(); }
    if (s.screen && s.screen.type === 'mcerr') return this.emit();
    // Editing a setting: red leaves the edit without saving and stays on the setting.
    if (k === 'red' && s.screen && s.screen.type === 'settings' && s.screen.editing) { s.screen.editing = false; s.screen.draft = null; return this.emit(); }
    // Red on a setting after something was changed under Parameters: back to the Parameters menu (Function, Comms ...),
    // so more can be changed. Red there leaves Parameters and the terminal reboots. Without changes, red goes to the start screen.
    if (k === 'red' && s.screen && s.screen.type === 'settings' && s.paramDirty && this.underParams(s.screen.node)) { s.screen = null; return this.emit(); }
    if (s.screen && s.screen.type === 'mcode' && !s.screen.svc && k === 'red' && this.hwp().opCancel) { const tok = ++this.tok; s.screen = { type: 'opcancel' }; setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'opcancel') return; this.goIdle(); this.emit(); }, 2500); return this.emit(); }
    if (s.screen && (s.screen.type === 'opcancel' || s.screen.type === 'norecon')) return this.emit();
    if (s.screen && s.screen.type === 'mcode' && s.screen.svc && k === 'red') { s.screen = s.screen.back; s.screen.editing = false; return this.emit(); }
    if (s.screen && s.screen.type === 'svcswipe') { if (k === 'red') s.screen = { type: 'mcode', svc: true, code: '', back: s.screen.back, value: s.screen.value }; return this.emit(); }
    if (s.screen && s.screen.type === 'svcfail') return this.emit();
    if (s.screen && s.screen.type === 'mcode' && k !== 'red') { this.mcKey(k); return this.emit(); }
    // Password screens in the Control panel (Transaction, Ethernet, PCL, Default IP config, SIM/PUK Code): red goes back
    // to the menu it came from; yellow does nothing there (seen on a Move/3500).
    if (k === 'red' && s.screen && s.screen.type === 'cppass') { s.screen = s.screen.back || null; return this.emit(); }
    if (s.screen && s.screen.type === 'custcancel') return this.emit();
    if (s.screen && /^(tlist|tlper|tldel|tlempty|tlprint|cpmini|cpdt)$/.test(s.screen.type)) { if (k === 'red' && !/^cp/.test(s.screen.type)) { this.goIdle(); return this.emit(); } if (k === 'red') { s.screen = null; return this.emit(); } this.miniKey(k); return this.emit(); }
    // Red while the terminal asks for the card: red screen "Afbrudt af kunde" for 2-3 seconds, then the start screen (photo, 6 Nov 2026).
    if (k === 'red' && s.screen && s.screen.type === 'flow' && s.screen.pay && s.screen.steps[s.screen.i].t === 'card') { const tok = ++this.tok; s.screen = { type: 'custcancel' }; setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'custcancel') return; this.goIdle(); this.emit(); }, 2400); return this.emit(); }
    if (k === 'red' && s.screen && s.screen.type === 'appsel') { const tok = ++this.tok; s.screen = { type: 'custcancel' }; setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'custcancel') return; this.goIdle(); this.emit(); }, 2400); return this.emit(); }
    if (s.screen && s.screen.type === 'appsel') { this.appKey(k); return this.emit(); }
    if (k === 'red') { const sc = s.screen; if (sc && sc.type === 'flow' && sc.pay && sc.steps[sc.i].t !== 'result') this.say('Transaction cancelled'); this.goIdle(); return this.emit(); }
    if (k === 'menu' && this.hwp().menuAuth && !s.menuAuth) { this.goIdle(); s.screen = { type: 'auth', main: true, pending: null, label: '' }; return this.emit(); }
    if (k === 'menu') { const ma = s.menuAuth; this.goMain(); if (this.hwp().menuAuth) s.menuAuth = ma; return this.emit(); }
    if (k === 'paper') { this.say('Paper feed'); return this.emit(); }
    // The line keys under the screen do nothing on the start screen.
    // F1 opens the Control panel (from the start screen or any menu); the right line key does nothing on the start screen.
    // F1 asks for the merchant card (or code) before the application list (confirmed on a Move/3500, 28 Oct 2026).
    if (k === 'f1' && this.M.cpRoot && (!s.screen || s.screen.type === 'apps')) { if (s.screen && s.screen.type === 'apps') return this.emit(); this.goIdle(); s.screen = { type: 'auth', pending: null, apps: true, label: 'Application list' }; return this.emit(); }
    if (k === 'f4' && !s.screen && !s.stack.length) return this.emit();
    // On the Wi-Fi password screen the side keys move along the password (Nets user guide 7.5.1.1).
    if ((k === 'f1' || k === 'f4') && s.screen && s.screen.type === 'wifipw') { this.cpKey(k); return this.emit(); }
    if (s.screen && (s.screen.type === 'wifipower' || s.screen.type === 'btpower' || s.screen.type === 'mobbuild' || s.screen.type === 'mobwait')) return this.emit();
    if (k === 'f1') k = 'yellow';
    if (k === 'f4') k = 'green';
    const sc = s.screen;
    if (sc && sc.type === 'auth') { if (k === 'yellow') s.screen = null; return this.emit(); }
    if (sc && (sc.type === 'wifimsg' || sc.type === 'wifiscan')) return this.emit();
    if (sc && sc.type === 'cpinfo') { if (k === 'yellow' || k === 'green') s.screen = sc.back || null; return this.emit(); }
    if (sc && sc.type === 'swreset') return this.emit();
    if (sc && sc.type === 'noinfo') { if (k === 'yellow' || k === 'green') s.screen = sc.back || null; return this.emit(); }
    if (sc && sc.type === 'cptree') {
      if (k === 'f2' || k === 'f3') sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + sc.items.length) % sc.items.length;
      else if (k === 'green') this.swOpen(sc, sc.items[sc.sel]);
      else if (k === 'yellow') s.screen = sc.back || null;
      return this.emit();
    }
    if (sc && sc.type === 'wifistat') {
      if (k === 'f2' || k === 'f3') sc.sel = 1 - sc.sel;
      else if (k === 'green' && sc.sw) { if (sc.sel === 0) { const lines = this.swLines(sc.sw); s.screen = { type: 'diagtext', node: sc.node, lines, top: sc.sw === 'calllog' ? Math.max(0, lines.length - 12) : 0, back: sc }; } else s.screen = sc.back; }
      else if (k === 'green' && sc.diag) { if (sc.sel === 0) s.screen = { type: 'diagtext', node: sc.node, lines: this.diagLines(sc.diag), top: 0, back: sc }; else s.screen = sc.back; }
      else if (k === 'yellow' && sc.back) s.screen = sc.back;
      else if (k === 'green' && sc.mob) {
        if (sc.sel === 0) { s.screen = { type: 'mobbuild', node: sc.node, back: sc }; const tok = this.tok; setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'mobbuild') return; s.screen = { type: 'cplist', node: sc.node, title: '', rows: this.mobStatusRows(), sel: 0, top: 0, plain: true, multi: true, view: 5, back: sc, info: true }; this.emit(); }, MSG_MS); }
        else this.say('Printing the mobile network status isn’t simulated.');
      }
      else if (k === 'green') { if (sc.sel === 0) s.screen = { type: 'wifistate', node: sc.node, back: sc }; else this.say('Printing the Wi-Fi status isn’t simulated.'); }
      else if (k === 'yellow') s.screen = null;
      return this.emit();
    }
    if (sc && sc.type === 'cpsub') {
      if (k === 'f2' || k === 'f3') sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + sc.rows.length) % sc.rows.length;
      else if (k === 'green') { const r = sc.rows[sc.sel]; if (r === 'Reset') s.screen = { type: 'cppass', node: sc.node, header: 'Reset', pw: '', showLast: true, back: sc }; else s.screen = { type: 'wifistat', node: sc.node, sel: 0, diag: r, back: sc }; }
      else if (k === 'yellow') s.screen = null;
      return this.emit();
    }
    if (sc && sc.type === 'diagtext') {
      if (k === 'f2' || k === 'f3') sc.top = Math.max(0, Math.min(sc.lines.length - 12, (sc.top || 0) + (k === 'f3' ? 3 : -3)));
      else if (k === 'yellow' || k === 'green') s.screen = sc.back;
      return this.emit();
    }
    if (sc && sc.type === 'diagask') { if (k === 'yellow') s.screen = null; /* green does nothing here (as on the Move/3500) */ return this.emit(); }
    if (sc && sc.type === 'diagerr') { if (k === 'yellow' || k === 'green') s.screen = null; return this.emit(); }
    if (sc && sc.type === 'mobsig') { if (k === 'yellow' || k === 'green') s.screen = null; return this.emit(); }
    if (sc && sc.type === 'wifistate') { if (k === 'yellow' || k === 'green') s.screen = sc.back; return this.emit(); }
    if (sc && sc.type === 'cplist') {
      const digit = (k.charAt(0) === 'k' && k !== 'kdot') ? +k.slice(1) : null;
      if (k === 'f2' || k === 'f3') { sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + sc.rows.length) % sc.rows.length; if (sc.view) { sc.top = sc.top || 0; if (sc.sel < sc.top) sc.top = sc.sel; if (sc.sel > sc.top + sc.view - 1) sc.top = sc.sel - sc.view + 1; } }
      else if (digit !== null && !sc.plain && digit < sc.rows.length) sc.sel = digit;
      else if (k === 'green') { if (!sc.info) this.say((sc.title || 'This') + ' can’t be changed in the virtual terminal.'); }
      else if (k === 'yellow') s.screen = sc.back || null;
      return this.emit();
    }
    if (sc && sc.type === 'cppass') {
      if (k.charAt(0) === 'k' && k !== 'kdot') { if (sc.pw.length < 16) sc.pw += k.slice(1); }
      else if (k === 'yellow' || k === 'f1') { /* does nothing on the terminal */ }
      else if (k === 'green' || k === 'f4') {
        if (sc.pw && sc.next && sc.pw === TELIUM_CODE) {
          if (sc.next === 'diag') { s.screen = null; s.stack.push({ id: sc.node, sel: 0, top: 0 }); }
          else if (sc.next === 'eth') s.screen = { type: 'cpinfo', node: sc.node, header: 'Ethernet configuration', lines: ['Not on Ethernet cradle'], icon: 'infob' };
          else s.screen = { type: 'cplist', node: sc.node, title: 'PCL (not connected)', rows: ['Off', 'USB (COM5)', 'USB (COMU)', 'Serial (COM0)', 'Serial (COM1)', 'Ethernet / Wi-Fi', 'Bluetooth'], sel: 0, top: 0, plain: true, radio: true, cur: 0, view: 6 };
        } else if (sc.pw && sc.next) { sc.pw = ''; this.say('Wrong password'); }
        // Everything else behind a password or input (Transaction, Calls planning, Removal, upgrades, SIM / PUK Code ...): no information yet.
        else if (sc.pw) s.screen = { type: 'noinfo', node: sc.node, header: sc.header, back: sc.back || null };
      }
      return this.emit();
    }
    if (sc && (sc.type === 'apps' || sc.type === 'wifinets' || sc.type === 'wifipw')) { this.cpKey(k); return this.emit(); }
    if (sc && (sc.type === 'shortcut' || sc.type === 'tinfo' || sc.type === 'scph')) { this.scKey(k); return this.emit(); }
    if (sc && sc.type === 'flow') { this.flowKey(k); return this.emit(); }
    if (sc && sc.type === 'settings') { this.setKey(k); return this.emit(); }
    if (s.stack.length) { this.menuKey(k); return this.emit(); }
    // ▼ on the start screen opens the ShortCut menu.
    if (k === 'f3' && !this.hwp().noShortcut) { s.screen = { type: 'shortcut', sel: 0 }; return this.emit(); }
    // Idle screen: only the white Menu key opens the menu. Typing an amount (or OK) starts a
    // purchase straight away, the same as Menu > 1 Purchase.
    const digit = k.charAt(0) === 'k' && k !== 'kdot' ? k.slice(1) : null;
    if (digit !== null || k === 'green') {
      const p = (this.M.kids[this.M.root.id] || []).find(n => n.behavior === 'function' && n.flow === 'purchase' && !this.isHidden(n));
      if (p) { this.startFlow(p, 'purchase'); if (digit !== null && digit !== '0') this.flowKey(k); }
    }
    return this.emit();
  };

  S.scKey = function (k) {
    const s = this.state, sc = s.screen, n = this.shortcuts().length;
    // Terminal Info: yellow (or red) goes back to the start screen; green prints the page ("Print Pending"), then back to the start screen.
    if (sc.type === 'tinfo') {
      if (k === 'yellow') { this.goIdle(); return; }
      if (k === 'green') {
        const lines = ['Terminal ID: ' + (s.settings.tid || SESSION_TID), 'Program: ' + PROGRAM_VER, 'S.No:', s.serial || SESSION_SN];
        s.screen = { type: 'printing' }; s.busy = true; const tok = this.tok;
        setTimeout(() => { if (tok !== this.tok) return; this.goIdle(); s.receipt = { lines, n: (s.receipt ? s.receipt.n : 0) + 1 }; this.emit(); }, 1600);
      }
      return;
    }
    if (sc.type !== 'shortcut') { if (k === 'yellow' || k === 'green') s.screen = { type: 'shortcut', sel: sc.back || 0 }; return; }
    if (k === 'f2' || k === 'f3') { sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + n) % n; return; }
    if (k === 'yellow') { s.screen = null; return; }
    if (k === 'green') return this.scOpen(sc.sel);
    if (k.charAt(0) === 'k' && k !== 'kdot') { const i = this.shortcuts().findIndex(x => x.num === +k.slice(1)); if (i < 0) { this.say('No item ' + k.slice(1) + ' in this menu'); return; } sc.sel = i; this.scOpen(i); }
  };
  S.scOpen = function (i) {
    const it = this.shortcuts()[i]; if (!it) return;
    if (it.act === 'bt') { const bt = Object.values(this.M.byId).find(n => /^bluetooth$/i.test(n.label) && this.isCpNode(n.id)); if (bt) { const p = this.pathNodes(bt.id); this.goIdle(); this.state.stack = p.map(n => ({ id: n.id, sel: 0, top: 0 })); for (let j = 0; j < this.state.stack.length - 1; j++) { const e = this.state.stack[j], nx = this.state.stack[j + 1]; e.sel = Math.max(0, this.vis(this.node(e.id)).findIndex(c => c.id === nx.id)); this.fit(e, this.vis(this.node(e.id)).length); } return; } }
    this.state.screen = it.act === 'tinfo' ? { type: 'tinfo', back: i } : it.act === 'cp' && this.M.cpRoot ? { type: 'auth', pending: null, cp: true, label: it.label } : { type: 'scph', label: it.label, back: i };
  };
  S.back = function () {
    const s = this.state;
    if (s.screen) { s.screen = null; return; }
    const e = s.stack.pop();
    if (e && this.node(e.id) && this.node(e.id).merchantCard) s.merchantAuth = false;
  };

  S.menuKey = function (k) {
    const s = this.state, e = s.stack[s.stack.length - 1], node = this.node(e.id), items = this.vis(node), n = items.length;
    if (!n) { if (k === 'yellow') this.back(); else this.say('This menu has no items'); return; }
    if (e.sel >= n) e.sel = n - 1;
    if (k === 'f2' || k === 'f3') { e.sel = (e.sel + (k === 'f3' ? 1 : -1) + n) % n; this.fit(e, n); return; }
    if (k === 'green') { this.open(items[e.sel]); return; }
    if (k === 'yellow') { this.back(); return; }
    if (k.charAt(0) === 'k' && k !== 'kdot') {
      const d = +k.slice(1), i = items.findIndex(c => +c.num === d);
      if (i < 0) {
        const hid = (this.M.kids[node.id] || []).find(c => +c.num === d);
        this.say(hid ? hid.label + ' is only shown when ' + this.condText(hid.condition) : 'No item ' + d + ' in this menu');
        return;
      }
      e.sel = i; this.fit(e, n); this.open(items[i]);
    }
  };

  // Control panel items that show a screen, recognised by where they are in the menu (the menu itself is unchanged).
  S.cpFlow = function (node) {
    if (!node || !this.M.cpRoot || !this.isCpNode(node.id)) return null;
    const par = this.node(this.M.parentOf[node.id]), pl = String(par && par.label || '').toLowerCase(), l = String(node.label || '').toLowerCase();
    if ((pl === 'wi-fi' || pl === 'wifi') && l === 'status') return 'wifistatus';
    if (/^apps? reports?$/.test(pl) && (/^transactions?$/.test(l) || /^calls? planning$/.test(l) || /^batch data capture$/.test(l))) return 'cppass';
    // Apps reports › Diagnosis (seen on a Move/3500): the Telium Manager code first, then Local, Clear, Diag to USB, Diag to MMC.
    if (/^apps? reports?$/.test(pl) && l === 'diagnosis') return 'diagpass';
    // Software mgmt (seen on a Move/3500, video 29 Oct 2026).
    if (pl === 'evolution' && (l === 'local upgrade' || l === 'external upgrade')) return 'cppass';
    if (pl === 'platform packages') return 'cpnoop';
    if (pl === 'evolution' && l === 'remote upgrade') return 'swremote';
    if (/^software m(gm)?t|^software management$/.test(pl) && l === 'removal') return 'cppass';
    if (/^l[ae]gacy software$/.test(pl) && /^(application|dll|parameters)$/.test(l)) return 'swlist';
    if ((/^l[ae]gacy software$/.test(pl) && l === 'kernel') || pl === 'specific software') return 'swnone';
    if (pl === 'diagnosis') { if (l === 'local') return 'diaglocal'; if (l === 'clear') return 'diagclear'; if (l === 'diag to usb') return 'diagusb'; if (l === 'diag to mmc') return 'diagmmc'; }
    if (pl === 'bluetooth' && /^phone pa(i|r)r?ing/.test(l)) return 'btpair';
    if (l === 'date and time') return 'datetime';
    if (l === 'hardware info') return 'hwinfo';
    if (/^comm(unication)? means$/.test(pl) && l === 'ethernet') return 'ethpass';
    // Mobile Networks (seen on a Move/3500).
    if (pl === 'mobile networks') {
      if (l === 'parameters') return 'mobparams';
      if (l === 'sim code' || l === 'puk code') return 'mobpin';
      if (l === 'status') return 'mobstatus';
      if (l === 'signal strength') return 'mobsignal';
      if (/^select networks?$/.test(l)) return 'mobselect';
      if (l === 'change sim slot') return 'mobslot';
      if (/^set net(wo|ow)rk type$/.test(l)) return 'mobtype';
    }
    if (/^comm(unication)? means$/.test(pl) && (l === 'pcl' || l === 'plc')) return 'pclpass';
    // Wi-Fi › Advanced options (seen on a Move/3500). Shown as on the terminal; nothing is changed here.
    const gp = this.node(this.M.parentOf[par && par.id]), gpl = String(gp && gp.label || '').toLowerCase();
    if (pl === 'advanced options' && (gpl === 'wi-fi' || gpl === 'wifi')) {
      if (l === 'my networks') return 'wifimynets';
      if (l === 'default ip config') return 'cppass';
      if (l === 'active roaming') return 'wifiroam';
      if (l === 'frequency bands') return 'wifibands';
      if (l === 'country information') return 'wificountry';
    }
    return null;
  };
  S.open = function (node) {
    const s = this.state;
    if (this.isHidden(node)) { this.say(node.label + ' is only shown when ' + this.condText(node.condition)); return; }
    const b = node.behavior;
    // Control panel Wi-Fi functions (simulated data only)
    if (b === 'function' && node.flow === 'wifiscan') {
      // "Scanning…" first, then the list of networks found (simulated names).
      s.screen = { type: 'wifiscan', node: node.id }; s.busy = true; const tok = this.tok;
      setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'wifiscan') return; s.busy = false; s.screen = { type: 'wifinets', sel: Math.max(0, WIFI_NETS.indexOf(s.wifi && s.wifi.connected)), top: 0, node: node.id }; this.fitNets(s.screen); this.emit(); }, 1300);
      return;
    }
    // Wi-Fi › Status shows whether the terminal is connected (Nets user guide 7.5.1.1: "the status shows Connected").
    // Bluetooth › Phone pairing shows the code to enter on the phone (Nets user guide 7.5.3, Ingenico TETRA guide).
    const cpf = this.cpFlow(node);
    // Apps reports › Transaction asks for a password first (seen on a Move/3500). The password itself isn't known, so it isn't accepted here.
    if (cpf === 'cppass') { s.screen = { type: 'cppass', node: node.id, header: node.label, pw: '' }; return; }
    // Wi-Fi › Status: Display and Print (seen on a Move/3500). Display shows the state; nothing can be changed there.
    if (cpf === 'wifistatus') { s.screen = { type: 'wifistat', node: node.id, sel: 0 }; return; }
    if (cpf === 'cpnoop') return; // Platform packages items: nothing opens (as on the Move/3500)
    if (cpf === 'swremote') { s.screen = { type: 'cptree', node: node.id, title: 'Remote upgrade', items: SW_REMOTE, sel: 0 }; return; }
    if (cpf === 'swlist') { const rows = SW_PKGS[node.label.toLowerCase()] || []; s.screen = { type: 'cplist', node: node.id, title: node.label, rows, sel: 0, top: 0, plain: true, multi: true, view: 5, info: true }; return; }
    if (cpf === 'swnone') { s.screen = { type: 'cpinfo', node: node.id, header: 'Information', lines: ['No software package of this type found in the terminal.'] }; return; }
    if (cpf === 'diagpass') { s.screen = { type: 'cppass', node: node.id, header: node.label, pw: '', next: 'diag', showLast: true }; return; }
    if (cpf === 'diaglocal') { s.screen = { type: 'cpsub', node: node.id, parent: 'Local', rows: ['All', 'Counters', 'Messages', 'Reset'], sel: 0 }; return; }
    if (cpf === 'diagclear') { s.screen = { type: 'diagask', node: node.id }; return; }
    if (cpf === 'diagusb' || cpf === 'diagmmc') {
      s.screen = { type: 'diagerr', node: node.id, what: cpf === 'diagusb' ? 'USB' : 'MMC' }; const tok = this.tok, sc0 = s.screen;
      setTimeout(() => { if (tok !== this.tok || s.screen !== sc0) return; s.screen = null; this.emit(); }, MSG_MAX);
      return;
    }
    if (cpf === 'ethpass' || cpf === 'pclpass') { s.screen = { type: 'cppass', node: node.id, header: node.label, pw: '', next: cpf === 'ethpass' ? 'eth' : 'pcl' }; return; }
    if (cpf === 'datetime') { s.screen = { type: 'cpmini', kind: 'dt', node: node.id, title: node.label, rows: ['Date', 'Time', 'Date format', 'Time format'], sel: 0 }; return; }
    if (cpf === 'hwinfo') { s.screen = { type: 'cpmini', kind: 'hw', node: node.id, title: node.label, rows: ['General', 'Wireless', 'Hardware', 'Readers'], sel: 0 }; return; }
    if (cpf === 'mobparams') { s.screen = { type: 'cplist', node: node.id, title: 'Parameters', rows: ['Startup Mode', 'Slot 1', 'Slot 2'], sel: 0, plain: true }; return; }
    if (cpf === 'mobpin') { s.screen = { type: 'cppass', node: node.id, header: /^sim/i.test(node.label) ? 'SIM Code' : 'PUK Code', pw: '', showLast: true }; return; }
    if (cpf === 'mobstatus') { s.screen = { type: 'wifistat', node: node.id, sel: 0, mob: true }; return; }
    if (cpf === 'mobselect') { s.screen = { type: 'cplist', node: node.id, title: 'Select Network', rows: ['0-Auto', '1-Manual'], sel: 0, radio: true }; return; }
    if (cpf === 'mobslot') { s.screen = { type: 'cplist', node: node.id, title: 'Select SIM slot', rows: ['0-Slot 1', '1-Slot 2'], sel: 0, radio: true }; return; }
    if (cpf === 'mobtype') { s.screen = { type: 'cplist', node: node.id, title: 'Set Network Type', rows: ['0-2G only', '1-4G only', '2-4G/2G (auto)'], sel: 2, radio: true }; return; }
    if (cpf === 'mobsignal') {
      s.screen = { type: 'mobwait', node: node.id }; const tok = this.tok;
      setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'mobwait') return; s.screen = { type: 'mobsig', node: node.id }; this.emit(); }, 600);
      return;
    }
    if (cpf === 'wifimynets') { s.screen = { type: 'cplist', node: node.id, title: 'My networks', rows: ['Delete all'], sel: 0, plain: true }; return; }
    if (cpf === 'wifiroam') { s.screen = { type: 'cplist', node: node.id, title: 'Active roaming', rows: ['0-Off', '1-On'], sel: 0 }; return; }
    if (cpf === 'wifibands') { s.screen = { type: 'cplist', node: node.id, title: 'Frequency bands', rows: ['0-Auto', '1-2.4 GHz', '2-5.0 GHz'], sel: 0 }; return; }
    if (cpf === 'wificountry') { s.screen = { type: 'cpinfo', node: node.id, header: 'Country Information', lines: ['ETSI(1)'], icon: 'infob' }; return; }
    if (cpf === 'btpair') { s.screen = { type: 'cpinfo', node: node.id, header: 'Phone pairing', lines: ['Pair code', String(100000 + Math.floor(Math.random() * 900000))], note: 'Enter this code on the phone' }; return; }
    if (b === 'function' && (node.flow === 'btoff' || node.flow === 'bton')) {
      s.settings.btOn = node.flow === 'bton' ? 'On' : 'Off'; const e = s.stack[s.stack.length - 1]; if (e) { e.sel = 0; e.top = 0; }
      // "Setting Bluetooth power on / off" for a while (switching on takes longer), then the Bluetooth menu.
      s.screen = { type: 'btpower', on: node.flow === 'bton' }; const tok = this.tok;
      setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'btpower') return; s.screen = null; this.emit(); }, MSG_MS);
      return;
    }
    if (b === 'function' && (node.flow === 'wifioff' || node.flow === 'wifion')) {
      s.settings.wifiOn = node.flow === 'wifion' ? 'On' : 'Off';
      if (node.flow === 'wifioff') s.wifi.connected = null; else if (!s.wifi.connected) s.wifi.connected = WIFI_NETS[0];
      const e = s.stack[s.stack.length - 1]; if (e) { e.sel = 0; e.top = 0; }
      // "Setting WiFi power on / off" for a moment, then the Wi-Fi menu (only Switch On when it's off).
      s.screen = { type: 'wifipower', on: node.flow === 'wifion' }; const tok = this.tok;
      setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'wifipower') return; s.screen = null; this.emit(); }, MSG_MS);
      return;
    }
    if (b === 'menu') {
      if (node.merchantCard && !s.merchantAuth) { s.screen = { type: 'auth', pending: node.id }; return; }
      s.stack.push({ id: node.id, sel: 0, top: 0 }); return;
    }
    if (b === 'settings') { s.screen = { type: 'settings', node: node.id, idx: 0, editing: false, draft: null, flash: false }; return; }
    if (b === 'profile') { this.startFlow(node, 'profile'); return; }
    if (b === 'function' && FLOWS[node.flow]) { this.startFlow(node, node.flow); return; }
    this.startFlow(node, 'ph');
  };

  S.startFlow = function (node, name) {
    let def = FLOWS[name], steps;
    if (name === 'profile') { def = { end: 'menu' }; const v = node.profileValue || node.label; steps = [{ t: 'confirm', lines: ['Change profile', 'to ' + v + '?'], show: false }, { t: 'result', lines: ['Profile ' + v, 'selected'], note: '', icon: 'check' }]; }
    else if (name === 'ph') { def = { end: 'menu' }; steps = [{ t: 'ph' }]; }
    else if (name === 'switchoff') { this.shutdown(node.id); return; }
    else if (name === 'copy' && node.id === 'm35-003' && this.hwp().noReconCopy && !this.state.hadRecon) { const s = this.state, tok = ++this.tok; s.screen = { type: 'norecon', node: node.id }; setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'norecon') return; s.screen = null; this.emit(); }, 2500); return; }
    else if (name === 'translist') { this.state.screen = { type: 'tlist', node: node.id, sel: 0 }; return; }
    else steps = def.steps.slice();
    if (name === 'recon') this.state.hadRecon = true;
    if (node.merchantCard && !this.state.merchantAuth) steps = [{ t: 'merchant' }].concat(steps);
    this.state.screen = { type: 'flow', node: node.id, name, steps, i: 0, end: def.end, pay: !!def.pay, data: { amount: '', cash: '', auth: '', code: '' } };
    this.enterStep();
  };
  // ECR-integrated terminal: the cash register sends the amount. The purchase starts with the amount already set
  // and goes straight to the card screen (not confirmed yet whether the terminal asks "Correct amount?" first).
  S.ecrAmount = function (ore) {
    const s = this.state;
    if (s.power !== 'on' || s.busy) return 'The terminal is busy.';
    if (s.screen || s.stack.length) return 'The terminal isn’t on the start screen - press red (STP) first.';
    const p = (this.M.kids[this.M.root.id] || []).find(n => n.behavior === 'function' && n.flow === 'purchase' && !this.isHidden(n));
    if (!p) return 'There is no purchase in this menu.';
    this.startFlow(p, 'purchase');
    const f = s.screen; if (!f || f.type !== 'flow') return 'The purchase didn’t start.';
    f.data.amount = String(ore); f.data.ore = ore; f.ecr = true; // the cash register sends kroner and øre
    const ci = f.steps.findIndex(x => x.t === 'card'); if (ci > 0) { f.i = ci; this.enterStep(); }
    this.emit(); return '';
  };
  S.enterStep = function () {
    const s = this.state, f = s.screen;
    if (!f || f.type !== 'flow') return;
    const st = f.steps[f.i];
    if (st.t === 'merchant' && s.merchantAuth) { this.advance(); return; }
    if (st.t === 'proc') {
      s.busy = true;
      const tok = ++this.tok;
      setTimeout(() => { if (tok !== this.tok) return; s.busy = false; this.advance(); this.emit(); }, st.ms);
    }
    // Confirmation screens ("Reconciliation done", "Done" …) fade back to the main screen on their own.
    if (st.t === 'result') {
      const tok = ++this.tok;
      setTimeout(() => {
        if (tok !== this.tok || this.state.screen !== f || f.steps[f.i] !== st) return;
        f.fading = true; this.emit(true);
        setTimeout(() => { if (tok !== this.tok || this.state.screen !== f) return; this.goIdle(); this.emit(); }, 450);
      }, st.icon === 'info' ? 5000 : 3000);
    }
  };
  S.advance = function () {
    const f = this.state.screen;
    if (!f || f.type !== 'flow') return;
    f.i++;
    if (f.i >= f.steps.length) { this.finish(f); return; }
    this.enterStep();
  };
  S.finish = function (f) {
    const s = this.state;
    if (f.name === 'profile') { const n = this.node(f.node); if (n) s.settings.profile = n.profileValue || n.label; }
    if (f.end === 'idle') this.goIdle();
    else if (f.end === 'menu') s.screen = null;
    else if (f.end === 'off') { this.goIdle(); s.power = 'off'; this.say('Switched off - press OK (green) to switch on'); }
    else if (f.end === 'reboot') { this.goIdle(); this.boot(); }
  };
  /* ---------- Reboot after changing Parameters (as on a real Move/3500 with VIKING) ----------
     A saved change under Merchant menu › Parameters marks the parameters as changed; leaving Parameters then
     reboots the terminal: "Reboot In progress", a black screen, the Ingenico start screen and the Welcome screen
     with the four loading dots - shortened to about 7 seconds. Settings are kept. Browsing never reboots. */
  S.paramsNode = function () {
    if (this._pm && this._pm.M === this.M) return this._pm.id;
    const mm = this.M.root && (this.M.kids[this.M.root.id] || []).find(n => /merchant/i.test(n.label)), p = mm && (this.M.kids[mm.id] || []).find(n => /^parameters$/i.test(n.label));
    this._pm = { M: this.M, id: p ? p.id : null }; return this._pm.id;
  };
  S.underParams = function (id) { const p = this.paramsNode(); return !!(p && id && this.pathNodes(id).some(n => n.id === p)); };
  S.inParams = function () { const s = this.state; return s.stack.some(e => this.underParams(e.id)) || !!(s.screen && s.screen.node && this.underParams(s.screen.node)); };
  S.afterKey = function () {
    const s = this.state;
    if (s.paramDirty && s.power === 'on' && !this.inParams()) this.reboot();
  };
  S.reboot = function () {
    const s = this.state, tok = ++this.tok, me = this;
    s.paramDirty = false; s.power = 'reboot'; s.rb = 'msg'; s.busy = false; s.screen = null; s.stack = []; s.merchantAuth = false;
    const at = (ms, fn) => setTimeout(() => { if (tok !== me.tok || s.power !== 'reboot') return; fn(); me.emit(true); }, ms);
    at(1800, () => { s.rb = 'black'; });
    at(2500, () => { s.rb = 'logo'; if (s.settings.language && LANG_CODE[s.settings.language]) { s.termLang = s.settings.language; me.prefLang = s.termLang; if (CUR_OF[s.termLang]) { s.cur = CUR_OF[s.termLang]; me.prefCur = s.cur; saveCur(s.cur); } } });
    at(4200, () => { s.rb = 'welcome'; });
    at(7000, () => { s.rb = 'selftest'; });
    at(8600, () => { s.power = 'on'; s.rb = null; me.goIdle(); me.rbEnd = Date.now(); });
    this.emit(true);
  };
  // Switching on (green after a shutdown): the start-up of a restart - black, Ingenico, Welcome, Selftest - then the start screen.
  S.boot = function () {
    const s = this.state, tok = ++this.tok, me = this;
    s.busy = false; s.screen = null; s.stack = []; s.merchantAuth = false; s.power = 'reboot'; s.rb = 'black';
    const at = (ms, fn) => setTimeout(() => { if (tok !== me.tok || s.power !== 'reboot') return; fn(); me.emit(true); }, ms);
    at(700, () => { s.rb = 'logo'; });
    at(2400, () => { s.rb = 'welcome'; });
    at(5200, () => { s.rb = 'selftest'; });
    at(6800, () => { s.power = 'on'; s.rb = null; me.goIdle(); me.rbEnd = Date.now(); });
    this.emit(true);
  };
  // Switching off (Menu › 9 Switch off, or . + yellow held): "Shutdown In progress" for a few seconds, then a black screen.
  S.shutdown = function (nodeId) {
    const s = this.state, tok = ++this.tok, me = this;
    s.busy = false; s.screen = null; s.stack = []; s.merchantAuth = false; s.power = 'shut'; s.shutNode = nodeId || null;
    setTimeout(() => { if (tok !== me.tok || s.power !== 'shut') return; s.power = 'off'; me.say('Switched off - hold OK (green) to switch on'); me.emit(); }, 2500);
    this.emit();
  };
  S.backStep = function () {
    const f = this.state.screen;
    for (let j = f.i - 1; j >= 0; j--) if (['amount', 'digits', 'confirm'].indexOf(f.steps[j].t) >= 0) { f.i = j; return; }
    this.state.screen = null;
  };
  S.flowKey = function (k) {
    const s = this.state, f = s.screen, st = f.steps[f.i], d = f.data;
    const digit = (k.charAt(0) === 'k' && k !== 'kdot') ? k.slice(1) : null;
    if (st.t === 'amount' || st.t === 'digits') {
      const fld = st.field, max = st.t === 'amount' ? 7 : (st.max || 8);
      if (digit !== null) { if (d[fld].length >= max) return; if (st.t === 'amount' && !d[fld] && digit === '0') return; d[fld] += digit; return; }
      if (k === 'yellow') { if (d[fld]) d[fld] = d[fld].slice(0, -1); else this.backStep(); return; }
      if (k === 'green') {
        if (st.t === 'amount' && this.toOre(d[fld]) <= 0) { this.say('Enter an amount first'); return; }
        if (st.t === 'digits' && !st.opt && !d[fld]) { this.say('Enter the code first'); return; }
        this.advance();
      }
      return;
    }
    if (st.t === 'confirm') { if (k === 'green') this.advance(); else if (k === 'yellow') this.backStep(); return; }
    if (st.t === 'card') { if (k === 'yellow') { if (this.ifrOn()) s.screen = { type: 'appsel', sel: 0, back: f }; else this.backStep(); } return; }
    if (st.t === 'merchant') { if (k === 'yellow') s.screen = null; return; }
    if (st.t === 'result' || st.t === 'ph') { if (k === 'green' || k === 'yellow') this.advance(); }
  };
  // IFR: with an IFR priority set (DK), the card screen says the cardholder can pick the card application with yellow.
  S.ifrOn = function () { const v = this.state.settings.ifr; return !!v && v !== 'None'; };
  S.APPS_IFR = ['International', 'National'];
  S.appKey = function (k) {
    const s = this.state, sc = s.screen, n = this.APPS_IFR.length;
    if (k === 'f2' || k === 'f3') { sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + n) % n; return; }
    const d = k.charAt(0) === 'k' ? parseInt(k.slice(1), 10) : NaN;
    if (d >= 1 && d <= n) sc.sel = d - 1;
    if ((d >= 1 && d <= n) || k === 'green') { sc.back.data.app = this.APPS_IFR[sc.sel]; s.screen = sc.back; return; }
    if (k === 'yellow') s.screen = sc.back;
  };
  // Operator Menu › Reports › Trans. list (DK, 6 Nov 2026): 1 Print → choose a period → PRINTING; 2 Delete → DELETE TRANS. LIST? → TRANS. LIST IS EMPTY.
  // Control panel › Date and Time and Terminal info › Hardware info: small menus shown as on the terminal (nothing is changed).
  S.miniKey = function (k) {
    const s = this.state, sc = s.screen, d = k.charAt(0) === 'k' && k !== 'kdot' ? +k.slice(1) : NaN;
    const show = (scr, ms, then) => { s.screen = scr; const tok = ++this.tok; setTimeout(() => { if (tok !== this.tok || s.screen !== scr) return; s.screen = then; this.emit(); }, ms); };
    if (sc.type === 'tlempty' || sc.type === 'tlprint') return;
    if (sc.type === 'tldel') { if (k === 'green') { s.tlEmpty = true; show({ type: 'tlempty', node: sc.node }, 1600, sc.back); } else if (k === 'yellow') s.screen = sc.back; return; }
    const rows = sc.type === 'tlist' ? 2 : sc.type === 'tlper' ? this.tlPeriods().length : sc.type === 'cpmini' ? sc.rows.length : 0;
    if (sc.type === 'cpdt') { if (k === 'yellow') s.screen = sc.back; else if (k === 'green') this.say('The date and time can’t be changed in the virtual terminal.'); return; }
    if (k === 'f2' || k === 'f3') { sc.sel = (sc.sel + (k === 'f3' ? 1 : -1) + rows) % rows; return; }
    if (k === 'yellow') { s.screen = sc.type === 'tlper' ? sc.back : null; return; }
    let pick = -1; if (k === 'green') pick = sc.sel; else if (d >= 1 && d <= rows && sc.type === 'tlist') pick = d - 1;
    if (pick < 0) return; sc.sel = pick;
    if (sc.type === 'tlist') {
      if (pick === 0) { if (s.tlEmpty) show({ type: 'tlempty', node: sc.node }, 1600, sc); else s.screen = { type: 'tlper', node: sc.node, sel: 0, back: sc }; }
      else s.screen = { type: 'tldel', node: sc.node, back: sc };
      return;
    }
    if (sc.type === 'tlper') { show({ type: 'tlprint', node: sc.node }, 1500, sc.back); return; }
    if (sc.type === 'cpmini') {
      const r = sc.rows[pick];
      if (sc.kind === 'dt') {
        const now = new Date(), p = n => (n < 10 ? '0' : '') + n;
        if (r === 'Date') s.screen = { type: 'cpdt', node: sc.node, title: 'Date', label: 'Set date - dd/mm/yyyy', value: p(now.getDate()) + '/' + p(now.getMonth() + 1) + '/' + now.getFullYear(), back: sc };
        else if (r === 'Time') s.screen = { type: 'cpdt', node: sc.node, title: 'Time', label: 'Set time', value: p(now.getHours()) + ':' + p(now.getMinutes()), back: sc };
        else if (r === 'Date format') s.screen = { type: 'cplist', node: sc.node, title: 'Date format', rows: ['DD MM YYYY', 'MM DD YYYY', 'YYYY MM DD'], sel: 0, radio: true, back: sc };
        else s.screen = { type: 'cplist', node: sc.node, title: 'Time format', rows: ['24 hours (23:45)', '12 hours (11:45 PM)'], sel: 0, radio: true, back: sc };
      } else s.screen = { type: 'cplist', node: sc.node, title: r, rows: HW_INFO[r] ? HW_INFO[r]() : [], sel: 0, top: 0, plain: true, info: true, view: 6, back: sc };
    }
  };
  // Periods for Trans. list › Print: synthetic numbers for the virtual terminal.
  S.tlPeriods = function () { const a = [{ n: SESSION_PERIOD, c: 8 }, { n: SESSION_PERIOD - 3, c: 2 }]; return a.concat([{ all: true, c: a.reduce((x, y) => x + y.c, 0) }]); };
  S.setKey = function (k) {
    const s = this.state, sc = s.screen, node = this.node(sc.node), fields = this.fieldsFor(node);
    if (!fields.length) { if (k === 'yellow' || k === 'green') s.screen = null; return; }
    if (sc.idx >= fields.length) sc.idx = 0;
    const f = fields[sc.idx];
    const digit = (k.charAt(0) === 'k' && k !== 'kdot') ? k.slice(1) : null;
    const editable = !f.readOnly && ((f.values && f.values.length) || f.input === 'digits' || f.input === 'time');
    if (!sc.editing) {
      if (k === 'f2' || k === 'f3') { sc.idx = (sc.idx + (k === 'f3' ? 1 : -1) + fields.length) % fields.length; return; }
      // Green or yellow starts the edit (the setting gets a *).
      if (k === 'green' || k === 'yellow') { if (!editable) { this.say(f.label + ' can’t be changed from the keypad'); return; } sc.editing = true; sc.fresh = false; sc.draft = String(s.settings[f.key] == null ? '' : s.settings[f.key]); if (f.input === 'time') { const m = /^(\d\d):(\d\d)$/.exec(sc.draft) || [0, '04', '00']; sc.tm = { h: m[1], m: m[2], seg: 0, hf: true, mf: true }; } return; }
      return;
    }
    if (f.input === 'time') {
      // Reboot Time (filmed on a Move/3500): the hours are marked; yellow clears them, two digits jump to the minutes,
      // two more jump back to the hours. Yellow on the minutes goes back and deletes the last hour digit. Green saves.
      const t = sc.tm;
      if (digit !== null) {
        if (t.seg === 0) { if (t.hf) { t.h = ''; t.hf = false; } t.h += digit; if (t.h.length >= 2) { t.seg = 1; t.mf = true; } }
        else { if (t.mf) { t.m = ''; t.mf = false; } t.m += digit; if (t.m.length >= 2) { t.seg = 0; t.hf = true; } }
        return;
      }
      if (k === 'yellow') {
        if (t.seg === 0) { if (t.hf) { t.h = ''; t.hf = false; } else t.h = t.h.slice(0, -1); }
        else if (t.mf || !t.m) { t.seg = 0; t.hf = false; t.h = t.h.slice(0, -1); }
        else t.m = t.m.slice(0, -1);
        return;
      }
      if (k === 'green') {
        const h = +t.h, mi = +t.m;
        if (t.h.length < 2 || t.m.length < 2 || h > 23 || mi > 59) { this.say('Enter the time as two digits for the hour and two for the minutes'); return; }
        const v = t.h + ':' + t.m;
        if (String(s.settings[f.key]) !== v && this.underParams(sc.node)) s.paramDirty = true; s.settings[f.key] = v; sc.editing = false; sc.tm = null; this.flash();
      }
      return;
    }
    if (f.input === 'digits') {
      // As on the Move/3500: digits are added to the value, yellow clears it, green confirms.
      if (digit !== null) { if (sc.draft.length < (f.maxLength || 8)) sc.draft += digit; return; }
      if (k === 'yellow') { sc.draft = ''; return; }
      if (k === 'green') {
        if (!sc.draft) return;
        // Changing the TID: the terminal asks for the service card of the new TID (red: its service code instead).
        if (SVC_FIELDS.indexOf(f.key) >= 0) { s.screen = { type: 'svcswipe', back: sc, value: sc.draft }; return; }
        if (String(s.settings[f.key]) !== String(sc.draft) && this.underParams(sc.node)) s.paramDirty = true; s.settings[f.key] = sc.draft; sc.editing = false; this.flash();
      }
      return;
    }
    if (k === 'f2' || k === 'f3') { const v = f.values, i = v.indexOf(sc.draft); sc.draft = v[(i + (k === 'f3' ? 1 : -1) + v.length) % v.length]; return; }
    if (k === 'green') {
      if (String(s.settings[f.key]) !== String(sc.draft) && this.underParams(sc.node)) s.paramDirty = true;
      s.settings[f.key] = sc.draft; sc.editing = false; this.flash();
      if (this.affectsMenu(f.key)) this.say(f.label + ' changed - menus updated');
      const nf = this.fieldsFor(node); if (sc.idx >= nf.length) sc.idx = 0;
      return;
    }
    // Yellow does nothing while choosing a value; red (handled above) cancels.
  };
  S.affectsMenu = function (key) { return Object.values(this.M.byId).some(n => n.condition && n.condition.setting === key); };
  S.flash = function () {
    const sc = this.state.screen; if (!sc) return;
    sc.flash = true;
    setTimeout(() => { sc.flash = false; this.onChange(); }, 1000);
  };
  S.wantMerchant = function () { const sc = this.state.screen; return !!(sc && (sc.type === 'auth' || (sc.type === 'flow' && sc.steps[sc.i].t === 'merchant'))); };
  S.wantCard = function () { const sc = this.state.screen; return !!(sc && sc.type === 'flow' && sc.steps[sc.i].t === 'card'); };
  // "Swipe Service card" (changing the TID): the service card confirms the change, like the right service code.
  S.wantService = function () { const sc = this.state.screen; return !!(sc && sc.type === 'svcswipe'); };
  S.svcSave = function (b, value) {
    const s = this.state, f = this.fieldsFor(this.node(b.node))[b.idx];
    s.screen = b; if (String(s.settings[f.key]) !== String(value) && this.underParams(b.node)) s.paramDirty = true;
    s.settings[f.key] = value; b.editing = false; b.draft = null; this.flash();
  };
  S.swipe = function () {
    const s = this.state;
    if (this.wantCard()) return this.present('swipe');
    if (!s.swipe && s.power === 'on' && this.wantService()) { const sc = s.screen; s.swipe = true; this.onChange(); setTimeout(() => { s.swipe = false; if (s.screen === sc) this.svcSave(sc.back, sc.value); this.emit(); }, 1100); return true; }
    if (s.swipe || !this.wantMerchant()) return;
    s.swipe = true; this.onChange();
    setTimeout(() => { s.swipe = false; this.swipeDone(); this.emit(); }, 1100);
    return true;
  };
  S.mcKey = function (k) {
    const s = this.state, sc = s.screen;
    if (k.charAt(0) === 'k' && k !== 'kdot') { if (sc.code.length < 4) sc.code += k.slice(1); return; }
    if (k === 'yellow' || k === 'f1') { if (sc.code) sc.code = sc.code.slice(0, -1); else s.screen = null; return; }
    if (k === 'green' || k === 'f4') {
      // A shorter service code is simply wrong (filmed: 3 digits → "Ændring fejlet"). The merchant code still needs 4 digits.
      if (!sc.code.length || (!sc.svc && sc.code.length < 4)) { this.say('The ' + (sc.svc ? 'service' : 'merchant') + ' code has 4 digits'); return; }
      // Service code accepted: back to the setting, ready to type the new value.
      // Service code accepted: the new TID is saved and shown for a moment ("Terminal ID = …").
      if (sc.svc && sc.code === String(this.serviceCode)) { this.svcSave(sc.back, sc.value); return; }
      // Wrong service code: "Update failed / wrong code", then back to the setting, unchanged.
      if (sc.svc) { const b = sc.back, tok = this.tok; s.screen = { type: 'svcfail', back: b }; setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'svcfail') return; b.editing = false; b.draft = null; s.screen = b; this.emit(); }, MSG_MAX); return; }
      if (!sc.svc && sc.code === String(this.merchantCode)) { this.authOK(sc.back); return; }
      // Wrong code: a short message, then the code screen again (the expected code is never shown).
      const back = sc.back, tok = this.tok; s.screen = { type: 'mcerr', back };
      setTimeout(() => { if (tok !== this.tok || !s.screen || s.screen.type !== 'mcerr') return; s.screen = { type: 'mcode', code: '', back }; this.emit(); }, 1800);
    }
  };
  // Merchant authorised (card swiped or code accepted): carry on with what was asked for.
  S.authOK = function (sc) {
    const s = this.state;
    if (sc && sc.type === 'auth' && sc.apps) { s.screen = { type: 'apps', sel: 0 }; s.merchantAuth = true; return; }
    if (sc && sc.type === 'auth' && sc.cp) { this.goCP(); s.merchantAuth = true; return; }
    if (sc && sc.type === 'auth' && sc.main) { this.goMain(); s.menuAuth = true; return; }
    if (sc && sc.type === 'auth') { s.merchantAuth = true; const n = this.node(sc.pending); s.screen = null; if (n) this.open(n); const r = this.navRest; this.navRest = null; if (r && n && r.via === n.id) this.navTo(r.id, r.fieldKey, true); return; }
    if (sc && sc.type === 'flow') { s.merchantAuth = true; s.screen = sc; this.advance(); }
  };
  S.swipeDone = function () {
    const s = this.state, sc = s.screen;
    if (s.power !== 'on') return;
    if (sc && (sc.type === 'auth' || (sc.type === 'flow' && sc.steps[sc.i].t === 'merchant'))) this.authOK(sc);
  };
  // The customer's card: tapped on top (contactless), inserted at the bottom (chip) or swiped through the right side.
  S.present = function (how) {
    const s = this.state;
    if (s.tap || !this.wantCard()) return false;
    s.tap = true; s.cardHow = how || 'tap'; this.onChange();
    setTimeout(() => { s.tap = false; if (this.wantCard()) this.advance(); this.emit(); }, 1250);
    return true;
  };
  S.tap = function () { return this.present('tap'); };
  S.insert = function () { return this.present('insert'); };
  S.toOre = function (d) { if (!d) return 0; const n = parseInt(d, 10) || 0; return this.state.settings.amountMode === 'Kroner' ? n * 100 : n; };
  S.fmt = function (ore) { const kr = Math.floor(ore / 100), o = ore % 100; return String(kr).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + (o < 10 ? '0' : '') + o + ' ' + this.currency(); };
  // Currency follows the last local language picked (DK → DKK, NO → NOK, SE → SEK, FI → EUR). English keeps the one before it.
  S.currency = function () { return this.state.cur || this.prefCur || 'DKK'; };

  /* ---------------- Paths, location, jump ---------------- */
  S.pathNodes = function (id) { const a = []; let c = id; while (c && this.M.byId[c]) { a.unshift(this.M.byId[c]); c = this.M.parentOf[c]; } return a; };
  S.pathLabels = function (id) { return this.pathNodes(id).map(n => (n.parentId && n.num != null && n.num !== '' ? n.num + ' ' : '') + n.label); };
  S.location = function () {
    const s = this.state, sc = s.screen;
    if (s.power === 'shut' && s.shutNode) return { nodeId: s.shutNode, label: 'Shutdown In progress' };
    if (s.power !== 'on') return { nodeId: null, label: s.power === 'off' ? 'Switched off' : s.power === 'reboot' ? 'Rebooting after a parameter change (' + ({ msg: 'Reboot In progress', black: 'screen off', logo: 'Ingenico start screen', welcome: 'Welcome screen' }[s.rb] || '') + ')' : 'Starting' };
    if (sc && (sc.svc || sc.type === 'svcswipe' || sc.type === 'svcfail')) { const b = sc.back || {}, f = this.fieldsFor(this.node(b.node))[b.idx] || {}; return { nodeId: b.node, fieldKey: f.key || null, label: (sc.type === 'svcswipe' ? 'Swipe Service card - to confirm the new ' : sc.type === 'svcfail' ? 'Update failed (wrong service code) - ' : 'Service code prompt for the new ') + (f.label || 'value') + (sc.value ? ' ' + sc.value : ''), step: 'servicecode' }; }
    if (sc && (sc.type === 'mcode' || sc.type === 'mcerr')) { const b = sc.back || {}, id = b.type === 'flow' ? b.node : b.pending || null; return { nodeId: id, label: (sc.type === 'mcerr' ? 'Wrong merchant code entered' : 'Merchant code prompt') + (id ? ' for ' + this.node(id).label : b.label ? ' for ' + b.label : '') + ' (Term = ' + s.settings.tid + ')', step: 'merchantcode' }; }
    if (sc && sc.type === 'auth' && sc.main) return { nodeId: null, label: 'Merchant card prompt before the main menu' };
    if (sc && sc.type === 'norecon') return { nodeId: sc.node, label: 'No reconciliation to copy (Lane/3600, Copy menu › Last reconciliation)' };
    if (sc && sc.type === 'opcancel') return { nodeId: null, label: 'Cancelled by operator (Lane/3600: red at the merchant code)' };
    if (sc && sc.type === 'auth') return { nodeId: sc.pending, label: 'Merchant card prompt for ' + (sc.label || this.node(sc.pending).label) };
    if (sc && sc.type === 'apps') return { nodeId: null, label: 'Application selector (Control panel / VIKING PA)' };
    if (sc && sc.type === 'wifinets') return { nodeId: sc.node || null, label: 'Wi-Fi › Available networks' };
    if (sc && sc.type === 'wifipw') return { nodeId: null, label: 'Wi-Fi password for ' + sc.ssid };
    if (sc && sc.type === 'wifiscan') return { nodeId: sc.node || null, label: 'Wi-Fi › Scanning for networks' };
    if (sc && sc.type === 'cppass') return { nodeId: sc.node || null, label: this.pathLabels(sc.node).join(' › ') + ' (asks for a password)' };
    if (sc && (sc.type === 'btpower' || sc.type === 'mobbuild' || sc.type === 'mobwait' || sc.type === 'mobsig')) return { nodeId: sc.node || null, label: sc.type === 'btpower' ? 'Setting Bluetooth power ' + (sc.on ? 'on' : 'off') : sc.type === 'mobsig' ? 'Mobile Networks › Signal Strength (Cell ID, -71dBm, 65%)' : 'Mobile Networks › ' + (sc.type === 'mobbuild' ? 'Status › Building status' : 'Signal Strength') };
    if (sc && sc.type === 'noinfo') return { nodeId: sc.node || null, label: (sc.header || 'Screen') + ' (no information in the simulator yet)' };
    if (sc && (sc.type === 'cptree' || sc.type === 'swreset' || (sc.type === 'wifistat' && sc.sw))) return { nodeId: sc.node || null, label: 'Control panel › Software mgmt › Evolution › ' + (sc.type === 'cptree' ? (sc.path || ['Remote upgrade']).join(' › ') + ' (' + sc.items.map(i => i.l).join(', ') + ')' : sc.type === 'swreset' ? 'Remote upgrade › … › Manual parameters › Deactivate (Reset in progress)' : 'Remote upgrade › … › ' + (sc.sw === 'calllog' ? 'Consult call log' : 'Consult parameters') + ' (Display, Printer)') };
    if (sc && (sc.type === 'cpsub' || sc.type === 'diagtext' || sc.type === 'diagask' || sc.type === 'diagerr' || (sc.type === 'wifistat' && sc.diag))) return { nodeId: sc.node || null, label: 'Control panel › Apps reports › Diagnosis' + (sc.type === 'cpsub' ? ' › Local (All, Counters, Messages, Reset)' : sc.type === 'wifistat' ? ' › Local › ' + sc.diag + ' (Display, Print)' : sc.type === 'diagtext' ? ' › Local › Display' : sc.type === 'diagask' ? ' › Clear ("Delete all diagnosis?")' : ' › Diag to ' + sc.what + ' (error)') };
    if (sc && /^(tlist|tlper|tldel|tlempty|tlprint)$/.test(sc.type)) return { nodeId: sc.node, label: 'Operator Menu › Reports › Trans. list' + ({ tlper: ' › Print (select period)', tldel: ' › Delete (asks to confirm)', tlempty: ' (transaction list is empty)', tlprint: ' (printing)' }[sc.type] || ' (1 Print, 2 Delete)') };
    if (sc && (sc.type === 'cpmini' || sc.type === 'cpdt')) return { nodeId: sc.node, label: this.pathLabels(sc.node).join(' › ') + (sc.type === 'cpdt' ? ' › ' + sc.title : ' (' + sc.rows.join(', ') + ')') };
    if (sc && sc.type === 'cplist') return { nodeId: sc.node || null, label: this.pathLabels(sc.node).join(' › ') + ' (' + sc.rows.join(', ') + ')' };
    if (sc && (sc.type === 'wifistat' || sc.type === 'wifistate')) return { nodeId: sc.node || null, label: 'Wi-Fi › Status' + (sc.type === 'wifistate' ? ' › Display (State: ' + (s.wifi && s.wifi.connected ? 'Connected' : 'Disconnected') + ')' : ' (Display, Print)') };
    if (sc && sc.type === 'cpinfo') return { nodeId: sc.node || null, label: this.pathLabels(sc.node).join(' › ') + ' (' + sc.lines.join(', ') + ')' };
    if (sc && sc.type === 'wifimsg') return { nodeId: null, label: 'Connecting to ' + sc.ssid };
    if (sc && sc.type === 'shortcut') return { nodeId: null, label: 'ShortCut Menu (opened with ▼ on the start screen)', selected: this.shortcuts()[sc.sel].num + ' ' + this.shortcuts()[sc.sel].label };
    if (sc && sc.type === 'tinfo') return { nodeId: null, label: 'ShortCut Menu › Terminal Info (Terminal ID ' + s.settings.tid + ', Program 206, serial number)' };
    if (sc && sc.type === 'scph') return { nodeId: null, label: 'ShortCut Menu › ' + sc.label + ' (not simulated yet)' };
    if (sc && sc.type === 'printing') return { nodeId: null, label: 'Print Pending (printing Terminal Info)' };
    if (sc && sc.type === 'flow') return { nodeId: sc.node, label: this.node(sc.node).label, step: sc.steps[sc.i].t };
    if (sc && sc.type === 'settings') { const f = this.fieldsFor(this.node(sc.node))[sc.idx]; return { nodeId: sc.node, fieldKey: f && f.key, label: this.node(sc.node).label + (f ? ' › ' + f.label : ''), editing: sc.editing }; }
    if (s.stack.length) { const e = s.stack[s.stack.length - 1], n = this.node(e.id), it = this.vis(n)[e.sel]; return { nodeId: e.id, label: n.label, selected: it && ((it.num != null && it.num !== '' ? it.num + ' ' : '') + it.label), selectedId: it ? it.id : null }; }
    return { nodeId: null, label: 'Idle screen (technology by nets, alternating with "Waiting for Amount")' };
  };
  S.jump = function (id, fieldKey) {
    const s = this.state;
    if (s.power !== 'on' || !this.node(id)) return;
    const path = this.pathNodes(id);
    for (const n of path) if (this.isHidden(n)) { this.say(n.label + ' is only shown when ' + this.condText(n.condition)); return this.emit(); }
    this.goMain();
    for (let i = 1; i < path.length; i++) {
      const n = path[i], e = s.stack[s.stack.length - 1], items = this.vis(this.node(e.id));
      e.sel = Math.max(0, items.indexOf(n)); this.fit(e, items.length);
      if (n.behavior === 'menu') { if (n.merchantCard) s.merchantAuth = true; s.stack.push({ id: n.id, sel: 0, top: 0 }); }
      else this.open(n);
    }
    if (fieldKey && s.screen && s.screen.type === 'settings') { const ix = this.fieldsFor(this.node(id)).findIndex(f => f.key === fieldKey); if (ix >= 0) s.screen.idx = ix; }
    this.emit();
  };

  /* Touchscreen: tapping a menu row opens it, like pressing its number. */
  S.tapRow = function (id) {
    if (this.hwp().rowTap === false) return;
    const s = this.state;
    const sc = s.screen;
    if (s.power === 'on' && sc && sc.type === 'apps' && /^app:/.test(id)) { this.say(''); sc.sel = +id.slice(4); this.pickApp(sc.sel); return this.emit(); }
    if (s.power === 'on' && sc && /^(tlist|tlper|cpmini)$/.test(sc.type) && /^(tl|tp|cm):/.test(id)) { this.say(''); sc.sel = +id.split(':')[1]; this.key('green'); return; }
    if (s.power === 'on' && sc && sc.type === 'appsel' && /^ifr:/.test(id)) { this.say(''); sc.sel = +id.slice(4); this.key('green'); return; }
    if (s.power === 'on' && sc && sc.type === 'wifinets' && /^net:/.test(id)) { this.say(''); sc.sel = +id.slice(4); this.pickNet(sc.sel); return this.emit(); }
    if (s.power === 'on' && sc && sc.type === 'cptree' && /^ct:/.test(id)) { this.say(''); sc.sel = +id.slice(3); this.key('green'); return; }
    if (s.power === 'on' && sc && sc.type === 'cpsub' && /^cs:/.test(id)) { this.say(''); sc.sel = +id.slice(3); this.key('green'); return; }
    if (s.power === 'on' && sc && sc.type === 'wifistat' && /^ws:/.test(id)) { this.say(''); sc.sel = +id.slice(3); this.key('green'); return; }
    if (s.power === 'on' && sc && sc.type === 'shortcut' && /^sc:/.test(id)) { this.say(''); sc.sel = +id.slice(3); this.scOpen(sc.sel); return this.emit(); }
    if (s.power !== 'on' || s.busy || s.screen || !s.stack.length) return;
    const e = s.stack[s.stack.length - 1], items = this.vis(this.node(e.id)), i = items.findIndex(c => c.id === id);
    if (i < 0) return;
    this.say(''); this.navRest = null;
    e.sel = i; this.fit(e, items.length); this.open(items[i]);
    this.emit();
  };

  /* Open a menu, screen or function the way the terminal would (used by the Menu Explorer).
     Merchant-card menus stop at the swipe prompt; after the swipe the navigation continues. */
  S.navTo = function (id, fieldKey, quiet) {
    const s = this.state;
    if (!this.node(id) || !this.M.root) return;
    if (s.power !== 'on') { this.say(s.power === 'off' ? 'Terminal is off - press OK (green) to switch it on' : ''); if (!quiet) this.emit(); return; }
    const path = this.pathNodes(id);
    for (const n of path) if (this.isHidden(n)) { this.say(n.label + ' is only shown when ' + this.condText(n.condition)); if (!quiet) this.emit(); return; }
    const keepAuth = s.merchantAuth && s.stack.some(e => { const n = this.node(e.id); return n && n.merchantCard && path.indexOf(n) >= 0; });
    this.tok++; this.navRest = null; this.say('');
    s.screen = null; s.busy = false; s.stack = [{ id: path[0].id, sel: 0, top: 0 }]; s.merchantAuth = keepAuth;
    for (let i = 1; i < path.length; i++) {
      const n = path[i], e = s.stack[s.stack.length - 1], items = this.vis(this.node(e.id));
      e.sel = Math.max(0, items.indexOf(n)); this.fit(e, items.length);
      if (n.behavior === 'menu') {
        if (n.merchantCard) s.merchantAuth = true; // jumping from the Menu Explorer skips the card swipe
        s.stack.push({ id: n.id, sel: 0, top: 0 });
      } else { this.open(n); break; }
    }
    if (fieldKey && s.screen && s.screen.type === 'settings') { const ix = this.fieldsFor(this.node(s.screen.node)).findIndex(f => f.key === fieldKey); if (ix >= 0) s.screen.idx = ix; else this.say('This setting is only shown when other settings allow it'); }
    this.emit();
  };

  /* ---------------- Walkthroughs generated from the menu path ---------------- */
  S.buildWalk = function (targetId, fieldKey, opts) {
    const path = this.pathNodes(targetId);
    if (path.length < 2) return null;
    for (const n of path) if (this.isHidden(n)) return { error: n.label + ' is only shown when ' + this.condText(n.condition) };
    const me = this, top = s => (s.stack.length ? s.stack[s.stack.length - 1].id : null);
    const atMenu = id => s => s.power === 'on' && !s.screen && top(s) === id;
    const cp = !!(this.M.cpRoot && path[0].id === this.M.cpRoot.id);
    const apps = s => !!(s.screen && s.screen.type === 'apps');
    const steps = cp ? [
      { key: 'f1', tip: 'Press F1', text: 'Press F1.', sub: 'The left key just below the screen. The terminal asks for the merchant card.', done: s => !!(s.screen && s.screen.type === 'auth' && s.screen.apps) || !!(s.screen && s.screen.type === 'mcode') || apps(s) || atMenu(path[0].id)(s) },
    ].concat(opts && opts.mcode ? this.mcSteps(s => apps(s) || atMenu(path[0].id)(s)) : [{ key: 'card', tip: 'Swipe card', text: 'Swipe the merchant card.', sub: 'Use Swipe Card under the terminal - or press red and enter the merchant code.', done: s => apps(s) || atMenu(path[0].id)(s) }]).concat([
      { key: 'f2', skip: true, tip: 'Press ▲', text: 'Press ▲ to select Control panel.', sub: 'Or tap “Control panel” on the screen.', done: s => (apps(s) && s.screen.sel === 0) || atMenu(path[0].id)(s), on: apps },
      { key: 'green', tip: 'Press OK', text: 'Press OK to open Control panel.', sub: 'The green key.', done: atMenu(path[0].id) }])
      : this.hwp().menuAuth
        ? [{ key: 'menu', tip: 'Press F', text: 'Press the F key.', sub: 'Bottom left of the number keys. The terminal asks for the merchant card.', done: s => !!(s.screen && s.screen.type === 'auth' && s.screen.main) || atMenu(path[0].id)(s) || s.stack.length > 1 },
           { key: 'card', tip: 'Swipe card', text: 'Swipe the merchant card.', sub: 'Use Swipe Card under the terminal - or press red and enter the merchant code.', done: s => atMenu(path[0].id)(s) || s.stack.length > 1 || !!(s.screen && s.screen.type === 'mcode') }]
        : [{ key: 'menu', tip: 'Press Menu', text: 'Press the white Menu key.', sub: 'Top right of the keypad, marked with a circle.', done: atMenu(path[0].id) }];
    const times = c => c === 1 ? 'once' : c === 2 ? 'twice' : c + ' times';
    for (let i = 1; i < path.length; i++) {
      const n = path[i];
      // Items without a menu number: select with ▲ ▼ (shortest way, counted live), then OK.
      if (n.num == null || n.num === '') {
        const parent = path[i - 1], cur = s => { const e = s.stack[s.stack.length - 1]; return e && e.id === parent.id && !s.screen ? e.sel : -1; }, ix = () => me.vis(parent).indexOf(n);
        steps.push({ node: n.id, skip: true, sub: 'Use the ▲ ▼ keys just below the screen, or tap “' + me.trNode(n) + '” on the screen.', key: 'f3', tip: '', text: '',
          dyn: s => { const c = Math.max(0, cur(s)), cnt = me.vis(parent).length || 1, fi = ix(), dn = (fi - c + cnt) % cnt, up = (c - fi + cnt) % cnt, d = up < dn ? { key: 'f2', a: '▲', n: up } : { key: 'f3', a: '▼', n: dn }; return { key: d.key, tip: 'Press ' + d.a + (d.n > 1 ? ' ×' + d.n : ''), text: 'Press ' + d.a + ' ' + times(d.n) + ' to select ' + me.wl(n) + '.' }; },
          done: s => cur(s) === ix(), on: s => cur(s) >= 0 });
        // Platform packages items open nothing on the Move/3500: selecting them is as far as it goes.
        if (me.cpFlow(n) === 'cpnoop') continue;
        // Diagnosis asks for the Telium Manager code before the menu opens.
        if (me.cpFlow(n) === 'diagpass') {
          const code = TELIUM_CODE, pwOn = s => !!(s.screen && s.screen.type === 'cppass' && s.screen.next === 'diag');
          steps.push({ node: n.id, key: 'green', tip: 'Press OK', text: 'Press OK to open ' + me.wl(n) + '.', sub: 'The terminal asks for a password.', done: s => pwOn(s) || atMenu(n.id)(s) });
          steps.push({ key: 'k' + code[0], tip: 'Type the code', text: 'Type the Telium Manager code.', sub: 'The yellow key doesn’t delete here - red goes back.', dyn: s => { const c = pwOn(s) ? s.screen.pw : ''; const ok = code.indexOf(c) === 0; return { key: ok && c.length < 4 ? 'k' + code[c.length] : 'red', tip: ok ? 'Press ' + (code[c.length] || '') : 'Press red and start again' }; }, done: s => (pwOn(s) && s.screen.pw === code) || atMenu(n.id)(s), on: pwOn });
          steps.push({ key: 'green', tip: 'Press OK', text: 'Press OK (green).', sub: 'The Diagnosis menu opens.', done: atMenu(n.id) });
          continue;
        }
        steps.push({ node: n.id, key: 'green', tip: 'Press OK', text: 'Press OK to open ' + me.wl(n) + '.', sub: 'The green key.',
          done: n.behavior === 'menu' ? atMenu(n.id) : n.flow === 'wifioff' ? s => s.settings.wifiOn === 'Off' : n.flow === 'wifion' ? s => s.settings.wifiOn === 'On' : n.flow === 'btoff' ? s => s.settings.btOn === 'Off' : n.flow === 'bton' ? s => s.settings.btOn === 'On' : s => !!(s.screen && (s.screen.type === 'flow' || s.screen.type === 'cpmini' || s.screen.type === 'tlist' || s.screen.type === 'settings' || s.screen.type === 'wifinets' || s.screen.type === 'wifiscan' || s.screen.type === 'cpinfo' || s.screen.type === 'cppass' || s.screen.type === 'wifistat' || s.screen.type === 'cplist' || s.screen.type === 'mobwait' || s.screen.type === 'mobsig' || s.screen.type === 'cpsub' || s.screen.type === 'diagask' || s.screen.type === 'diagerr' || s.screen.type === 'cptree') && s.screen.node === n.id) });
        continue;
      }
      const label = n.num + ' ' + n.label;
      if (n.behavior === 'menu') {
        if (n.merchantCard) {
          steps.push({ node: n.id, sub: 'Or tap “' + me.trNode(n) + '” on the screen.', key: 'k' + n.num, tip: 'Press ' + n.num, text: 'Press ' + n.num + ' for ' + me.wl(n) + '.', done: s => !!(s.screen && s.screen.type === 'auth' && s.screen.pending === n.id) || atMenu(n.id)(s) });
          if (opts && opts.mcode) steps.push.apply(steps, this.mcSteps(atMenu(n.id)));
          else steps.push({ key: 'card', tip: 'Swipe card', text: 'Swipe the merchant card.', sub: 'Protected menu: use Swipe Card.', done: atMenu(n.id) });
        } else steps.push({ node: n.id, sub: 'Or tap “' + me.trNode(n) + '” on the screen.', key: 'k' + n.num, tip: 'Press ' + n.num, text: 'Press ' + n.num + ' for ' + me.wl(n) + '.', done: atMenu(n.id) });
      } else if (n.behavior === 'settings') {
        steps.push({ node: n.id, sub: 'Or tap “' + me.trNode(n) + '” on the screen.', key: 'k' + n.num, tip: 'Press ' + n.num, text: 'Press ' + n.num + ' for ' + me.wl(n) + '.', done: s => !!(s.screen && s.screen.type === 'settings' && s.screen.node === n.id) });
        if (fieldKey) {
          const fl = this.fieldsFor(n), fi = fl.findIndex(f => f.key === fieldKey), lab = fl[fi] ? fl[fi].label : '';
          // Shortest way to the setting (▲ or ▼), with the number of presses left worked out live.
          const left = s => { const sc = s.screen, cnt = fl.length, idx = sc && sc.type === 'settings' ? sc.idx : 0, dn = (fi - idx + cnt) % cnt, up = (idx - fi + cnt) % cnt; return up < dn ? { key: 'f2', arrow: '▲', n: up } : { key: 'f3', arrow: '▼', n: dn }; };
          const times = c => c === 1 ? 'once' : c === 2 ? 'twice' : c + ' times';
          if (fi > 0) steps.push({ sub: 'Use the ▲ ▼ keys just below the screen.', dyn: s => { const d = left(s); return { key: d.key, tip: 'Press ' + d.arrow + (d.n > 1 ? ' ×' + d.n : ''), text: 'Press ' + d.arrow + ' ' + times(d.n) + ' to find ' + lab + '.' }; }, key: 'f3', tip: '', text: '', done: s => !!(s.screen && s.screen.type === 'settings' && s.screen.node === n.id && s.screen.idx === fi), on: s => !!(s.screen && s.screen.type === 'settings' && s.screen.node === n.id && !s.screen.editing) });
          // Finish on the change itself: OK to edit, pick (or type) the new value, OK to save.
          const f = fl[fi];
          if (f && !(opts && opts.viewOnly) && !f.readOnly && ((f.values && f.values.length) || f.input === 'digits')) {
            const here = s => !!(s.screen && s.screen.type === 'settings' && s.screen.node === n.id && s.screen.idx === fi);
            const editing = s => here(s) && !!s.screen.editing;
            const changed = s => editing(s) && String(s.screen.draft) !== String(s.settings[f.key] == null ? '' : s.settings[f.key]);
            steps.push({ key: 'green', tip: 'Press OK', text: 'Press OK to change ' + lab + '.', sub: 'The green key. The setting gets a * so you can change the value.', done: editing, on: here });
            if (f.input === 'digits') {
              steps.push({ key: 'yellow', tip: 'Press yellow', text: 'Press yellow to clear the current value.', sub: 'The value disappears so you can type the new one.', done: s => (editing(s) && !s.screen.draft) || changed(s), on: editing });
              steps.push({ key: null, manual: true, tip: 'Type', text: 'Type the new value.', sub: 'Use the number keys.', done: s => changed(s) && !!s.screen.draft, on: editing });
            }
            else if (opts && opts.value && f.values.indexOf(opts.value) >= 0) {
              // A specific value was asked for: count the presses to it live, and only move on when it is shown.
              const want = opts.value;
              steps.push({ key: 'f3', tip: '', text: '', sub: 'The value changes each time you press. Options: ' + f.values.join(', ') + '.', dyn: s => { const v = f.values, n = v.length, c = Math.max(0, v.indexOf(s.screen && s.screen.draft)), t = v.indexOf(want), dn = (t - c + n) % n, up = (c - t + n) % n, d = up < dn ? { key: 'f2', a: '▲', n: up } : { key: 'f3', a: '▼', n: dn }; return { key: d.key, tip: 'Press ' + d.a + (d.n > 1 ? ' ×' + d.n : ''), text: 'Press ' + d.a + ' ' + times(d.n) + ' until ' + want + ' is shown.' }; }, done: s => editing(s) && String(s.screen.draft) === String(want), on: editing });
            }
            else steps.push({ key: 'f3', tip: 'Press ▲ ▼', text: 'Press ▲ or ▼ to choose the value you need.', sub: 'Options: ' + f.values.join(', ') + '.', done: changed, on: editing });
            if (SVC_FIELDS.indexOf(f.key) >= 0) {
              // The TID: the service card of the new TID, or red and its service code.
              const code = String(this.serviceCode), swipeOn = s => !!(s.screen && s.screen.type === 'svcswipe'), svcOn = s => !!(s.screen && s.screen.type === 'mcode' && s.screen.svc), saved = s => here(s) && !s.screen.editing && !!s.screen.flash;
              steps.push({ key: 'green', tip: 'Press OK', text: 'Press OK (green).', sub: 'The terminal asks for the Service card of the new TID.', done: s => swipeOn(s) || svcOn(s) || saved(s), on: editing });
              steps.push({ key: 'card', tip: 'Swipe card', text: 'Swipe the Service card for the new TID.', sub: 'Use Swipe Service Card under the terminal - or, without the card, press red and enter the service code.', done: s => svcOn(s) || saved(s), on: swipeOn });
              steps.push({ key: 'k' + code[0], tip: 'Type the code', text: 'Type the 4-digit service code for the new TID.', sub: 'Merchants don’t have it - it comes from Nets Customer Support. In this virtual terminal the training service code is ' + code + '.', dyn: s => { const c = svcOn(s) ? s.screen.code : ''; const ok = code.indexOf(c) === 0; return { key: ok && c.length < 4 ? 'k' + code[c.length] : 'yellow', tip: ok ? 'Press ' + (code[c.length] || '') : 'Press yellow' }; }, done: s => (svcOn(s) && s.screen.code === code) || saved(s), on: svcOn });
              steps.push({ key: 'green', tip: 'Press OK', text: 'Press OK (green).', sub: 'The terminal shows “' + lab + ' = …” and the new TID is saved. A wrong code shows “Update failed - wrong code”.', done: saved });
            } else
            steps.push({ key: 'green', tip: 'Press OK', text: 'Press OK again to confirm.', sub: 'The terminal briefly shows the new setting, for example “' + lab + ' = …”. Red cancels without saving.', done: s => here(s) && !s.screen.editing && !!s.screen.flash && (!(opts && opts.value) || String(s.settings[f.key]) === String(opts.value)), on: editing });
          }
        }
      } else {
        steps.push({ node: n.id, sub: 'Or tap “' + me.trNode(n) + '” on the screen.', key: 'k' + n.num, tip: 'Press ' + n.num, text: 'Press ' + n.num + ' for ' + label.replace(/^\d+ /, '') + '.', done: s => !!(s.screen && (s.screen.type === 'flow' || s.screen.type === 'tlist' || s.screen.type === 'norecon') && s.screen.node === n.id) || (s.power === 'shut' && s.shutNode === n.id) });
        const passed = s => !!(s.screen && s.screen.type === 'flow' && s.screen.node === n.id && s.screen.steps[s.screen.i].t !== 'merchant');
        if (n.merchantCard && opts && opts.mcode) steps.push.apply(steps, this.mcSteps(passed));
        else if (n.merchantCard) steps.push({ key: 'card', tip: 'Swipe card', text: 'Swipe the merchant card.', sub: 'Protected menu: use Swipe Card.', done: passed });
      }
    }
    const last = path[path.length - 1];
    return { title: last.label, field: fieldKey ? ((last.fields || []).find(f => f.key === fieldKey) || {}).label : null, value: (opts && opts.value) || null, steps, pay: last.behavior === 'function' && FLOWS[last.flow] && FLOWS[last.flow].pay };
  };
  // The merchant code instead of the card: red at the card prompt, the 4 digits, then OK.
  S.mcSteps = function (passed) {
    const code = String(this.merchantCode), on = s => !!(s.screen && s.screen.type === 'mcode');
    return [
      { key: 'red', tip: 'Press red', text: 'When the terminal asks for the merchant card, press the red key (Cancel).', sub: 'The terminal then asks for the merchant code.', done: s => on(s) || passed(s) },
      { key: 'k' + code[0], tip: 'Type the code', text: 'Type the 4-digit merchant code for this Terminal ID.', sub: 'In this virtual terminal the training code is ' + code + '. The yellow key deletes a digit.', dyn: s => { const c = on(s) ? s.screen.code : ''; const ok = code.indexOf(c) === 0; return { key: ok && c.length < 4 ? 'k' + code[c.length] : 'yellow', tip: ok ? 'Press ' + (code[c.length] || '') : 'Press yellow' }; }, done: s => (on(s) && s.screen.code === code) || passed(s), on: s => on(s) },
      { key: 'green', tip: 'Press OK', text: 'Press OK (green).', sub: 'The terminal opens the menu, the same as after swiping the card.', done: passed }
    ];
  };
  S.sig = function () {
    const s = this.state, sc = s.screen;
    return JSON.stringify([s.power, s.stack.map(e => e.id), sc ? [sc.type, sc.pending, sc.node, sc.i, sc.idx, sc.editing, sc.code] : null]);
  };
  // Where a guide can pick up from the terminal's current screen: after the last step that is already done.
  S.wtStartIndex = function (def) {
    if (!def || this.state.power !== 'on') return 0;
    for (let i = def.steps.length - 1; i >= 0; i--) { try { if (def.steps[i].done(this.state)) return i + 1; } catch (e) {} }
    return 0;
  };
  S.wtStart = function (targetId, fieldKey, opts) {
    const def = this.buildWalk(targetId, fieldKey, opts);
    if (!def || def.error) { this.say(def ? def.error : 'No walkthrough for this item'); this.emit(); return false; }
    // fromHere: carry on from the current screen when it is already part of the way (never past the last step).
    const from = opts && opts.fromHere ? Math.min(this.wtStartIndex(def), def.steps.length - 1) : 0;
    if (!from) { this.goIdle(); this.state.power = 'on'; this.state.paramDirty = false; }
    this.say('');
    this.wt = { def, i: from, done: false, off: false, sig: '', cp: null, from };
    this.wt.sig = this.sig(); this.wt.cp = this.snapshot(); this.wt.cps = []; this.wt.cps[from] = this.wt.cp;
    this.onChange();
    return true;
  };
  S.wtCheck = function () {
    const w = this.wt;
    if (!w || w.done || w.off) return;
    const st = w.def.steps[w.i];
    if (st.done(this.state)) {
      do { w.i++; } while (w.i < w.def.steps.length && w.def.steps[w.i].skip && w.def.steps[w.i].done(this.state));
      if (w.i >= w.def.steps.length) w.done = true; w.sig = this.sig(); w.cp = this.snapshot(); w.cps[w.i] = w.cp; return;
    }
    const ok = st.on ? st.on(this.state) : this.sig() === w.sig;
    if (!ok) w.off = true; else if (st.on) { w.sig = this.sig(); w.cp = this.snapshot(); }
  };
  S.wtTarget = function () { const w = this.wt; if (!w || w.done || w.off) return null; const st = w.def.steps[w.i]; return st.dyn ? Object.assign({}, st, st.dyn(this.state)) : st; };
  // Put the terminal back where the current step started, keeping progress.
  S.wtResume = function () { const w = this.wt; if (!w || !w.cp) return; w.off = false; this.tok++; this.state = JSON.parse(JSON.stringify(w.cp)); w.sig = this.sig(); this.onChange(); };
  S.snapshot = function () { const c = JSON.parse(JSON.stringify(this.state)); c.pressed = null; c.swipe = false; c.tap = false; c.status = ''; c.busy = false; if (c.screen) c.screen.flash = false; return c; };
  S.wtNext = function () { const st = this.wtTarget(); if (!st || !st.key) return; if (st.key === 'card') this.swipe(); else this.key(st.key); };
  S.wtRestart = function () { if (!this.wt) return; const d = this.wt.def; this.goIdle(); this.state.power = 'on'; this.wt = { def: d, i: 0, done: false, off: false, sig: '' }; this.wt.sig = this.sig(); this.wt.cp = this.snapshot(); this.wt.cps = [this.wt.cp]; this.onChange(); };
  // Step back: put the terminal where the previous step started.
  S.wtBack = function () { const w = this.wt; if (!w || !w.i || !w.cps[w.i - 1]) return; w.i--; w.done = false; w.off = false; w.cp = w.cps[w.i]; this.tok++; this.state = JSON.parse(JSON.stringify(w.cp)); w.sig = this.sig(); this.onChange(); };
  S.wtExit = function () { this.wt = null; this.onChange(); };

  /* ---------------- LCD view model ---------------- */
  S.lcd0 = function () {
    const s = this.state, sc = s.screen;
    const base = { hw: this.hwp().id || 'move3500', bar: !!this.hwp().idleBar, laneIdle: !!this.hwp().laneIdle, flip: this.idleFlip || 0, fadeIn: !!this.rbEnd && Date.now() - this.rbEnd < 700 && !sc && !s.stack.length, kind: 'idle', title: '', rows: [], scroll: false, thumbTop: 0, thumbH: 0, counter: '', label: '', value: '', editing: false, note: '', flash: false, hint: '', header: '', lines: [], amount: '', input: '', tag: '', icon: '' };
    const C = o => Object.assign(base, { kind: 'center' }, o);
    if (!this.M.root) return C({ lines: ['No menu published'], note: 'Publish a menu in the Admin Portal', icon: 'demo' });
    if (s.power === 'off') return Object.assign(base, { kind: 'off' });
    if (s.power === 'shut') return Object.assign(base, { kind: 'reboot', phase: 'msg', shut: true });
    if (s.power === 'boot') return C({ lines: ['Starting…'], icon: 'spin' });
    if (s.power === 'reboot') return Object.assign(base, { kind: 'reboot', phase: s.rb, lines: [String(s.settings.tid || SESSION_TID), SESSION_ID12], ver: PROGRAM_VER });
    if (sc && sc.type === 'auth') return C({ header: sc.apps || sc.main ? '' : sc.label || this.trNode(this.node(sc.pending)), lines: ['Swipe merchant card'], icon: 'swipe' });
    if (sc && sc.type === 'cppass') return Object.assign(base, { kind: 'cppass', title: sc.header, prompt: sc.prompt || 'Enter password', value: sc.plain ? (sc.pw || '') : sc.showLast && sc.pw ? sc.pw.slice(0, -1).replace(/./g, '*') + sc.pw.slice(-1) : (sc.pw || '').replace(/./g, '*') });
    if (sc && sc.type === 'svcswipe') return C({ lines: ['Swipe', 'Service card'] });
    if (sc && sc.type === 'svcfail') return C({ lines: ['Update failed', 'wrong code'] });
    if (sc && sc.type === 'mcode') return C({ lines: sc.svc ? [this.trId('mc.term') + ' ' + sc.value, 'Enter serv code'] : [this.trId('mc.term') + ' ' + (s.settings.tid || SESSION_TID), 'Merchant code?'], input: sc.code.replace(/./g, '*') || '\u00a0', mcode: true });
    if (sc && sc.type === 'tlist') return Object.assign(base, { kind: 'menu', title: this.trNode(this.node(sc.node)), rows: [this.trId('tl.print'), this.trId('tl.delete')].map((l, i) => ({ id: 'tl:' + i, num: i + 1, label: l, sel: sc.sel === i })) });
    if (sc && sc.type === 'tlper') return Object.assign(base, { kind: 'menu', title: this.trId('tl.period'), rows: this.tlPeriods().map((p, i) => ({ id: 'tp:' + i, num: '', label: (p.all ? this.trId('tl.all') + ' :  ' : this.trId('tl.per') + ' ' + p.n + ':   ') + p.c, sel: sc.sel === i })) });
    if (sc && sc.type === 'tldel') return C({ lines: [this.trId('tl.del1'), this.trId('tl.del2')], hint: 'OK = Yes    STOP = No' });
    if (sc && sc.type === 'tlempty') return C({ lines: [this.trId('tl.empty1'), this.trId('tl.empty2')] });
    if (sc && sc.type === 'tlprint') return C({ lines: ['PRINTING'] });
    if (sc && sc.type === 'cpmini') return Object.assign(base, { kind: 'cpmenu', rows: sc.rows.map((l, i) => ({ id: 'cm:' + i, label: l, parent: sc.title, sel: sc.sel === i })) });
    if (sc && sc.type === 'cpdt') return Object.assign(base, { kind: 'cpdt', cp: true, title: sc.title, label: sc.label, value: sc.value });
    if (sc && sc.type === 'custcancel') return C({ lines: ['Cancelled by customer'], red: true });
    if (sc && sc.type === 'opcancel') return C({ lines: ['CANCELLED BY OPERATOR'] });
    if (sc && sc.type === 'norecon') return C({ lines: ['NO RECONCILIATION TO COPY'] });
    if (sc && sc.type === 'appsel') return Object.assign(base, { kind: 'menu', title: '', rows: this.APPS_IFR.map((a, i) => ({ id: 'ifr:' + i, num: i + 1, label: this.trVal({ key: 'ifr' }, a), sel: sc.sel === i })), scroll: false });
    if (sc && sc.type === 'mcerr') return C({ lines: ['Wrong merchant code'] }); // text only, then back to the code prompt (filmed 6 Nov 2026)
    // Control panel look: application selector, icon menus, Wi-Fi networks and password keyboard
    if (sc && sc.type === 'apps') return Object.assign(base, { kind: 'cpmenu', rows: this.APPS.map((l, i) => ({ id: 'app:' + i, label: l, icon: i ? 'viking' : 'cp', sel: sc.sel === i })) });
    if (sc && sc.type === 'wifinets') return Object.assign(base, { kind: 'cpnets', title: 'Available networks', rows: WIFI_NETS.map((n, i) => ({ id: 'net:' + i, label: i + '-' + n, note: s.wifi && s.wifi.connected === n ? 'Connected' : '', sel: sc.sel === i })).concat([{ id: 'net:' + WIFI_NETS.length, label: WIFI_NETS.length + '-Other', note: '', sel: sc.sel === WIFI_NETS.length }]).slice(sc.top || 0, (sc.top || 0) + 5), scroll: true, thumbTop: Math.round(250 * (sc.top || 0) / (WIFI_NETS.length + 1)), thumbH: Math.round(250 * 5 / (WIFI_NETS.length + 1)) });
    if (sc && sc.type === 'wifimsg') return sc.step === 'busy' ? C({ header: sc.ssid, lines: ['Connecting…'], icon: 'spin' }) : sc.step === 'ok' ? C({ header: sc.ssid, lines: ['Connected'], icon: 'check' }) : C({ header: sc.ssid, lines: ['Connection failed', 'Wrong password'], note: 'Please try again', icon: 'err' });
    if (sc && sc.type === 'wifiscan') return C({ header: 'Available networks', lines: ['Scanning ...'], cp: true });
    if (sc && sc.type === 'noinfo') return C({ header: sc.header || '', lines: [NOINFO], note: 'Yellow = back', icon: 'infob', cp: true });
    if (sc && sc.type === 'cptree') return Object.assign(base, { kind: 'cpmenu', rows: sc.items.map((it, i) => ({ id: 'ct:' + i, label: it.l, parent: sc.title, sel: sc.sel === i })) });
    if (sc && sc.type === 'swreset') return C({ lines: ['Reset in progress'], cp: true });
    if (sc && sc.type === 'cpsub') return Object.assign(base, { kind: 'cpmenu', rows: sc.rows.map((l, i) => ({ id: 'cs:' + i, label: l, parent: sc.parent, sel: sc.sel === i })) });
    if (sc && sc.type === 'diagtext') return Object.assign(base, { kind: 'diagtext', cp: true, lines: sc.lines.slice(sc.top || 0, (sc.top || 0) + 12), scroll: sc.lines.length > 9, thumbTop: Math.round(250 * (sc.top || 0) / sc.lines.length), thumbH: Math.max(30, Math.round(250 * 9 / sc.lines.length)) });
    if (sc && sc.type === 'diagask') return C({ header: 'Diagnosis', lines: ['Delete all diagnosis?'], icon: 'ask', cp: true });
    if (sc && sc.type === 'diagerr') return C({ header: 'Diagnosis', lines: ['Diag to ' + sc.what + ' Error'], icon: 'stop', cp: true });
    if (sc && sc.type === 'btpower') return C({ lines: ['Setting Bluetooth power ' + (sc.on ? 'on' : 'off')], cp: true });
    if (sc && sc.type === 'mobbuild') return C({ lines: ['Building status...'], cp: true });
    if (sc && sc.type === 'mobwait') return C({ lines: [''], cp: true });
    if (sc && sc.type === 'mobsig') return Object.assign(base, { kind: 'mobsig', cp: true, lines: ['Cell ID: ' + SESSION_CELL, '-71dBm'], pct: 65 });
    if (sc && sc.type === 'wifipower') return C({ lines: ['Setting WiFi power ' + (sc.on ? 'on' : 'off')], cp: true });
    if (sc && sc.type === 'wifistat') return Object.assign(base, { kind: 'cpmenu', rows: (sc.sw ? ['Display', 'Printer'] : ['Display', 'Print']).map((l, i) => ({ id: 'ws:' + i, label: l, parent: 'Status', sel: sc.sel === i })) });
    if (sc && sc.type === 'wifistate') return Object.assign(base, { kind: 'cpnets', title: 'Wi-Fi Status', rows: [{ id: 'wst', label: 'State: ' + (s.wifi && s.wifi.connected ? 'Connected' : 'Disconnected'), note: '', sel: true }], scroll: false });
    if (sc && sc.type === 'cpinfo') return C({ header: sc.header, lines: sc.lines, note: sc.note || '', cp: true, icon: sc.icon || undefined });
    if (sc && sc.type === 'cplist') { const V = sc.view || sc.rows.length, t = sc.top || 0; return Object.assign(base, { kind: 'cpnets', title: sc.title, rows: sc.rows.map((r, i) => ({ id: 'cl:' + i, label: r, note: '', sel: sc.sel === i, radio: !!sc.radio, multi: !!sc.multi })).slice(t, t + V), scroll: V < sc.rows.length, thumbTop: Math.round(250 * t / sc.rows.length), thumbH: Math.round(250 * V / sc.rows.length) }); }
    if (sc && sc.type === 'wifipw') return Object.assign(base, { kind: 'cppw', title: 'Wi-Fi password', label: 'Enter password:', value: (sc.pw || '').replace(/./g, '*'), focus: PW_CELLS[sc.f == null ? 16 : sc.f] });
    if (sc && sc.type === 'shortcut') return Object.assign(base, { kind: 'menu', title: this.trUi('ShortCut Menu'), rows: this.shortcuts().map((x, i) => ({ id: 'sc:' + i, num: x.num, label: this.trUi(x.label), sel: sc.sel === i })) });
    if (sc && sc.type === 'tinfo') return Object.assign(base, { kind: 'tinfo', lines: [this.trId('ti.tid') + ' ' + (s.settings.tid || SESSION_TID), this.trId('ti.prog') + ' ' + PROGRAM_VER, this.trId('ti.sno'), s.serial || SESSION_SN] });
    if (sc && sc.type === 'scph') return C({ header: sc.label, lines: ['Not available'], icon: 'info' });
    if (sc && sc.type === 'printing') return C({ lines: ['Print Pending'] });
    if (sc && sc.type === 'settings') {
      const node = this.node(sc.node), fs = this.fieldsFor(node);
      if (!fs.length) return C({ header: node.label, lines: ['No settings'], note: 'No configurable values are defined for this screen yet.', icon: 'demo' });
      if (sc.idx >= fs.length) sc.idx = 0;
      const f = fs[sc.idx], cur = clean(s.settings[f.key]);
      let value;
      if (f.input === 'digits') value = sc.editing ? (sc.draft || '') : String(cur == null ? '' : cur);
      else if (f.input === 'time') value = sc.editing && sc.tm ? (sc.tm.h || '') + ':' + (sc.tm.m || '') : String(cur == null ? '' : cur);
      else if (f.readOnly || !(f.values && f.values.length)) value = clean(f.display) || String(cur == null ? '' : cur);
      else value = sc.editing ? '<' + this.trVal(f, sc.draft) + '>' : String(cur == null ? '' : this.trVal(f, cur));
      // As on the Move/3500: the name and the value only. Editing adds a * to the name; OK shows "Name = value" for a moment.
      return Object.assign(base, { kind: 'settings', arrows: !!this.hwp().touchArrows, title: this.trNode(node), counter: (sc.idx + 1) + '/' + fs.length, label: this.trField(f) + (sc.editing ? '*' : ''), value, tseg: f.input === 'time' && sc.editing && sc.tm ? { h: sc.tm.h, m: sc.tm.m, seg: sc.tm.seg } : null, editing: sc.editing, flash: sc.flash ? this.trField(f) + ' = ' + (cur == null ? '' : (f.values && f.values.length ? this.trVal(f, cur) : String(cur))) : '' });
    }
    if (sc && sc.type === 'flow') {
      const st = sc.steps[sc.i], d = sc.data, n = this.node(sc.node);
      const total = (d.ore != null ? d.ore : this.toOre(d.amount)) + this.toOre(d.cash), tag = '';
      if (st.t === 'amount') return C({ title: st.title, amount: this.fmt(this.toOre(d[st.field])), tag });
      if (st.t === 'digits') { const v = d[st.field]; return C({ lines: st.lines, input: v ? (st.mask ? v.replace(/./g, '*') : v) : '_', note: st.note || '', tag }); }
      if (st.t === 'confirm') return C({ lines: st.lines, amount: st.show ? this.fmt(total) : '', hint: 'OK = Yes    STOP = No', tag });
      if (st.t === 'card') { const tt = FLOWS[sc.name] && FLOWS[sc.name].tt; return Object.assign(base, { kind: 'present', header: total > 0 && tt ? this.trId(tt) : '', amount: total > 0 ? this.fmt(total) : '', title: this.trId('card.present'), note: this.ifrOn() ? 'Press YELLOW for card application selection' : '', app: d.app ? this.trVal({ key: 'ifr' }, d.app) : '' }); }
      if (st.t === 'merchant') return C({ lines: ['Swipe merchant card'], icon: 'swipe' });
      if (st.t === 'proc') return C({ lines: st.lines, icon: st.plain ? '' : 'spin', tag });
      if (st.t === 'result') return C({ lines: st.lines, note: st.note, icon: st.ok ? '' : st.icon, tag, fade: !!sc.fading, green: !!st.ok });
      if (st.t === 'ph') return C({ header: n ? this.trNode(n) : '', lines: [NOINFO], note: 'Yellow = back', icon: 'infob', cp: !!(n && this.isCpNode(n.id)) });
    }
    if (s.stack.length) {
      const e = s.stack[s.stack.length - 1], node = this.node(e.id);
      if (!node) { this.goIdle(); return base; }
      const items = this.vis(node), n = items.length;
      if (e.sel >= n) e.sel = Math.max(0, n - 1);
      this.fit(e, n);
      const V = this.rowsPerScreen();
      const rows = items.slice(e.top, e.top + V).map((c, i) => ({ id: c.id, num: c.num == null ? '' : c.num, label: this.trNode(c), sel: e.top + i === e.sel }));
      if (this.M.cpRoot && s.stack[0].id === this.M.cpRoot.id) return Object.assign(base, { kind: 'cpmenu', title: node.label, rows: items.slice(e.top, e.top + 6).map((c, i) => ({ id: c.id, label: c.label, parent: node.label, sel: e.top + i === e.sel })), scroll: n > 6, thumbTop: n ? Math.round(277 * e.top / n) : 0, thumbH: n ? Math.round(277 * 6 / n) : 0 });
      return Object.assign(base, { kind: 'menu', title: node === this.M.root ? this.trId('menu.main') : this.trNode(node), rows, scroll: n > V, thumbTop: n ? Math.round(277 * e.top / n) : 0, thumbH: n ? Math.round(277 * V / n) : 0 });
    }
    if (this.errText) return this.errRed ? C({ lines: [this.errText], red: true }) : C({ lines: [this.errText], icon: 'err' });
    return base;
  };

  // Fixed screen texts in the terminal language (VIKING screens only - the Control panel stays as it is).
  S.lcd = function () {
    const v = this.lcd0();
    v.ui = { welcome: this.trId('rb.welcome'), wait: this.trId('idle.wait'), rbbox: this.trId('rb.box') };
    if (this.lang() === 'en' || v.cp || /^cp|diagtext|mobsig|tinfo/.test(v.kind)) return v;
    if (v.lines) v.lines = v.lines.map(l => this.trUi(l)).filter(l => l !== '');
    if (v.lines && this.currency() !== 'DKK') v.lines = v.lines.map(l => typeof l === 'string' ? l.replace(/ DKK$/, ' ' + this.currency()) : l);
    ['hint', 'note'].forEach(k => { if (v[k]) v[k] = this.trUi(v[k]); });
    if (v.kind === 'center' && v.title) v.title = this.trUi(v.title);
    return v;
  };

  window.FCSim = Sim;
})();
