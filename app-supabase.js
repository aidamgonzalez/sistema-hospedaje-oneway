/* Puente entre la página y Supabase: inicio de sesión, roles, base de datos en vivo y descargas. */
(function(){
  const URL_ = window.SUPABASE_URL || '', KEY = window.SUPABASE_ANON_KEY || '';
  const libOk = !!(window.supabase && window.supabase.createClient);
  const configured = libOk && !!(URL_ && KEY);
  const sb = configured ? window.supabase.createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: /access_token|type=recovery|[?&]code=/.test(location.hash + location.search), storageKey: 'hospedaje-ow-auth', lock: async (name, timeout, fn) => fn() } }) : null;
  const conTiempo = (pr, ms, paso) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('TIEMPO:' + paso)), ms))]);
  const paso = t => { const m = document.getElementById('loginMsg'); if (m) { m.style.color = 'var(--muted)'; m.textContent = t; } };
  window.__sbClient = sb;
  const S = { user: null, perfil: null };
  let resolveReady; const ready = new Promise(r => resolveReady = r);
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- caché local + tiempo real ---------- */
  const cache = new Map();            // path -> data
  const docL = new Map();             // path -> Set(fn)
  const colL = new Map();             // coleccion -> Set(fn)
  const loadedCols = new Set();
  const colOf = p => p.replace(/\/[^/]+$/, '');
  const idOf = p => p.split('/').pop();
  const snapDoc = p => ({ id: idOf(p), exists: cache.has(p), data: () => cache.has(p) ? JSON.parse(JSON.stringify(cache.get(p))) : undefined, metadata: { fromCache: false, hasPendingWrites: false } });
  const snapCol = c => { const docs = [...cache.keys()].filter(p => colOf(p) === c).sort().map(snapDoc); return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } }; };
  function emit(p) {
    (docL.get(p) || []).forEach(f => { try { f(snapDoc(p)) } catch (e) { console.error(e) } });
    const c = colOf(p); (colL.get(c) || []).forEach(f => { try { f(snapCol(c)) } catch (e) { console.error(e) } });
  }
  function put(p, data) { if (data == null) cache.delete(p); else cache.set(p, data); emit(p); }
  let channel = null;
  function startRealtime() {
    if (channel) return;
    channel = sb.channel('docs-cambios').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, ev => {
      if (ev.eventType === 'DELETE') { const p = ev.old && ev.old.path; if (p) put(p, null); }
      else if (ev.new && ev.new.path) put(ev.new.path, ev.new.data);
    }).subscribe();
  }
  const mapErr = e => ({ code: e && (e.code === '42501' || e.code === 'P0002' || /row-level security|no_existe/i.test(e.message || '')) ? 'invalid_argument' : 'unavailable', message: (e && e.message) || '' });
  async function q(promise) { const { data, error } = await promise; if (error) throw mapErr(error); return data; }

  function docRef(path) {
    return {
      id: idOf(path), path,
      get: async () => { const rows = await q(sb.from('docs').select('path,data').eq('path', path)); put(path, rows[0] ? rows[0].data : null); return snapDoc(path); },
      set: async d => { const rows = await q(sb.from('docs').upsert({ path, data: d, updated_at: new Date().toISOString() }).select('path,data')); put(path, rows[0].data); },
      update: async patch => { const data = await q(sb.rpc('doc_update', { p_path: path, p_patch: patch })); put(path, data); },
      delete: async () => { await q(sb.from('docs').delete().eq('path', path)); put(path, null); },
      onSnapshot: (next, err) => {
        if (!docL.has(path)) docL.set(path, new Set()); docL.get(path).add(next); startRealtime();
        sb.from('docs').select('path,data').eq('path', path).then(({ data, error }) => { if (error) { err && err(mapErr(error)); return; } if (data[0]) cache.set(path, data[0].data); else cache.delete(path); next(snapDoc(path)); });
        return () => docL.get(path) && docL.get(path).delete(next);
      },
      collection: c => colRef(path + '/' + c)
    };
  }
  function colRef(c) {
    const ref = {
      path: c,
      limit: () => ref, where: () => ref, orderBy: () => ref,
      doc: id => docRef(c + '/' + (id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))),
      add: async d => { const r = ref.doc(); await r.set(d); return r; },
      get: async () => { await loadCol(c); return snapCol(c); },
      onSnapshot: (next, err) => {
        if (!colL.has(c)) colL.set(c, new Set()); colL.get(c).add(next); startRealtime();
        loadCol(c).then(() => next(snapCol(c))).catch(e => err && err(e));
        return () => colL.get(c) && colL.get(c).delete(next);
      }
    };
    return ref;
  }
  async function loadCol(c) {
    const rows = [];
    for (let from = 0; ; from += 500) {
      const part = await q(sb.from('docs').select('path,data').eq('coleccion', c).range(from, from + 499));
      rows.push(...part); if (part.length < 500) break;
    }
    [...cache.keys()].filter(p => colOf(p) === c).forEach(p => cache.delete(p));
    rows.forEach(r => cache.set(r.path, r.data)); loadedCols.add(c);
  }

  const dbApi = configured ? { doc: docRef, collection: colRef } : null;
  const userApi = { can: async () => true, canEdit: () => S.perfil && S.perfil.rol === 'admin', isOwner: () => S.perfil && S.perfil.rol === 'admin', id: async () => S.user && S.user.id };
  const downloadsApi = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000);
    }
  };
  window.claude = { use: async name => { await ready; return name === 'db' ? dbApi : name === 'user' ? userApi : name === 'downloads' ? downloadsApi : null; } };

  /* ---------- inicio de sesión ---------- */
  function showLogin(msg) { $('#loginBox').hidden = false; $('#loginMsg').textContent = msg || ''; }
  function hideLogin() { $('#loginBox').hidden = true; }
  async function entrar(session) {
    const u = session && session.user; if (!u) { showLogin(); return; }
    if (S.user && S.user.id === u.id) return;
    try {
      paso('Cargando tu perfil…');
      let { data: p, error } = await conTiempo(sb.from('perfiles').select('*').eq('id', u.id).maybeSingle(), 15000, 'perfil');
      if (error) throw error;
      if (!p && u.email && u.email.toLowerCase() === String(window.ADMIN_EMAIL || '').toLowerCase()) {
        const r = await sb.from('perfiles').insert({ id: u.id, nombre: u.email.split('@')[0], email: u.email, rol: 'admin', activo: true }).select().single();
        if (r.error) throw r.error; p = r.data;
      }
      if (!p || !p.activo) { await sb.auth.signOut(); showLogin('Tu usuario no tiene acceso. Pide al administrador que te habilite.'); return; }
      S.user = u; S.perfil = p; $('#loginMsg').style.color = ''; $('#loginMsg').textContent = ''; hideLogin(); applyRole(); resolveReady();
    } catch (err) { $('#loginMsg').style.color = ''; showLogin(/TIEMPO:perfil/.test(err.message) ? 'La conexión con la base de datos tardó demasiado al cargar tu perfil (paso 2). Revisa tu internet y vuelve a intentar.' : 'No se pudo cargar tu perfil: ' + (err.message || err)); }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!configured) { showLogin(libOk ? 'Falta configurar Supabase: completa el archivo supabase-config.js.' : 'No se pudo conectar con Supabase. Revisa tu conexión a internet y recarga la página.'); $('#lForm').hidden = true; return; }
    $('#lForm').addEventListener('submit', async e => {
      e.preventDefault(); $('#lBtn').disabled = true; $('#lBtn').textContent = 'Entrando…'; $('#loginMsg').textContent = '';
      const email = $('#lEmail').value.trim().toLowerCase().replace(/\s+/g, '');
      try {
        paso('Verificando contraseña…');
        const { data, error } = await conTiempo(sb.auth.signInWithPassword({ email, password: $('#lPass').value }), 15000, 'clave');
        $('#loginMsg').style.color = '';
        if (error) {
          $('#loginMsg').textContent = /invalid login|invalid_credentials|invalid credentials/i.test(error.message) ? 'Correo o contraseña incorrectos. Revisa que no haya espacios ni mayúsculas de más.' : (/confirm/i.test(error.message) ? 'Tu correo aún no está confirmado.' : 'No se pudo iniciar sesión: ' + error.message);
        } else if (data && data.session) { await entrar(data.session); }
      } catch (err) { $('#loginMsg').style.color = ''; $('#loginMsg').textContent = /TIEMPO:clave/.test(err && err.message) ? 'El servidor no respondió al verificar la contraseña (paso 1). Revisa tu internet y vuelve a intentar.' : 'No se pudo conectar: ' + (err && err.message || err) + '. Revisa tu internet e inténtalo de nuevo.'; }
      finally { $('#lBtn').disabled = false; $('#lBtn').textContent = 'Entrar'; }
    });
    $('#lForgot').addEventListener('click', async () => {
      const em = $('#lEmail').value.trim(); if (!em) { $('#loginMsg').textContent = 'Escribe tu correo y vuelve a pulsar “Olvidé mi contraseña”.'; return; }
      const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
      $('#loginMsg').textContent = error ? 'No se pudo enviar el correo: ' + error.message : 'Te enviamos un correo para cambiar la contraseña.';
    });
    $('#lNewBtn').addEventListener('click', async () => {
      const pw = $('#lNew').value; if (pw.length < 6) { $('#loginMsg').textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) { $('#loginMsg').textContent = 'No se pudo cambiar: ' + error.message; return; }
      $('#lRecover').hidden = true; $('#lForm').hidden = false; $('#loginMsg').textContent = '';
      const { data } = await sb.auth.getSession(); entrar(data.session);
    });
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') { $('#lForm').hidden = true; $('#lRecover').hidden = false; showLogin('Escribe tu nueva contraseña.'); return; }
      if (event === 'SIGNED_OUT') { if (S.user) location.reload(); else showLogin(); return; }
      if (session && $('#lRecover').hidden) setTimeout(() => entrar(session));
      else if (!session) showLogin();
    });
  });

  /* ---------- roles y menú de usuario ---------- */
  function applyRole() {
    const admin = S.perfil.rol === 'admin';
    $('#uName').textContent = (S.perfil.nombre || S.user.email) + ' · ' + (admin ? 'Administrador' : 'Agente');
    $('#uBtn').hidden = !admin;
    if (!admin) { const t = $('#tab-creditos'); if (t) t.hidden = true; const v = $('#view-creditos'); if (v) { v.innerHTML = ''; v.hidden = true; } }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('header.top .bar');
    const box = document.createElement('div'); box.className = 'ubox';
    box.innerHTML = '<span class="uname" title="Versión del sistema">v 26/10 mes fact.</span><span id="uName" class="uname"></span><button type="button" id="uBtn" hidden>Usuarios</button><button type="button" id="uOut" class="ghost">Salir</button>';
    bar.appendChild(box);
    $('#uOut').onclick = () => sb && sb.auth.signOut();
    $('#uBtn').onclick = openUsers;
    $('#usClose').onclick = closeUsers; $('#usScrim').onclick = closeUsers;
    $('#usAdd').onclick = addUser;
    $('#usImport').addEventListener('change', importFile);
    $('#usImpOk').onclick = runImport;
    $('#usList').addEventListener('change', async e => {
      const tr = e.target.closest('tr[data-u]'); if (!tr) return;
      const patch = e.target.matches('[data-rol]') ? { rol: e.target.value } : e.target.matches('[data-act]') ? { activo: e.target.checked } : null;
      if (!patch) return;
      const { error } = await sb.from('perfiles').update(patch).eq('id', tr.dataset.u);
      note(error ? 'No se pudo actualizar: ' + error.message : 'Usuario actualizado.'); loadUsers();
    });
    $('#usList').addEventListener('click', async e => {
      if (!e.target.matches('[data-reset]')) return;
      const em = e.target.closest('tr').querySelector('.sub').textContent;
      const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
      note(error ? 'No se pudo enviar: ' + error.message : 'Correo para cambiar la clave enviado a ' + em + '.');
    });
  });

  let pendingImport = null;
  function note(t) { $('#usNote').textContent = t; }
  async function loadUsers() {
    const { data, error } = await sb.from('perfiles').select('*').order('nombre');
    if (error) { note('No se pudieron cargar los usuarios: ' + error.message); return; }
    $('#usList').innerHTML = data.map(u => `<tr data-u="${u.id}"><td><b>${esc(u.nombre || '')}</b><span class="sub">${esc(u.email || '')}</span></td>
      <td><select data-rol ${u.id === S.user.id ? 'disabled' : ''}><option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option><option value="agente" ${u.rol === 'agente' ? 'selected' : ''}>Agente</option></select></td>
      <td><label class="check"><input type="checkbox" data-act ${u.activo ? 'checked' : ''} ${u.id === S.user.id ? 'disabled' : ''}> Activo</label></td>
      <td><button type="button" data-reset>Enviar cambio de clave</button></td></tr>`).join('');
  }
  function openUsers() { $('#usScrim').hidden = false; $('#usSheet').hidden = false; loadUsers(); }
  function closeUsers() { $('#usScrim').hidden = true; $('#usSheet').hidden = true; }
  async function addUser() {
    const nombre = $('#usNom').value.trim(), email = $('#usMail').value.trim(), pass = $('#usPass').value, rol = $('#usRol').value;
    if (!nombre || !email || pass.length < 6) { note('Escribe nombre, correo y una contraseña de al menos 6 caracteres.'); return; }
    $('#usAdd').disabled = true;
    try {
      const sec = window.supabase.createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sb-secundaria' } });
      const { data, error } = await sec.auth.signUp({ email, password: pass });
      if (error) throw error;
      if (!data.user || (data.user.identities && !data.user.identities.length)) throw new Error('Ese correo ya tiene usuario.');
      const r = await sb.from('perfiles').insert({ id: data.user.id, nombre, email, rol, activo: true });
      if (r.error) throw r.error;
      ['#usNom', '#usMail', '#usPass'].forEach(x => $(x).value = '');
      note(`Usuario creado. ${nombre} entra con ${email} y la contraseña que escribiste.`); loadUsers();
    } catch (err) { note('No se pudo crear: ' + (err.message || err)); }
    finally { $('#usAdd').disabled = false; }
  }
  async function importFile(e) {
    const f = e.target.files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); if (!j.docs) throw 0; pendingImport = j.docs;
      $('#usImpTxt').textContent = `El archivo tiene ${Object.keys(j.docs).length} documentos. Al importar se reemplazan los que tengan el mismo nombre.`; $('#usImpOk').hidden = false; }
    catch (err) { $('#usImpTxt').textContent = 'Ese archivo no es una exportación del sistema.'; }
  }
  async function runImport() {
    if (!pendingImport) return; $('#usImpOk').disabled = true;
    try {
      const entries = Object.entries(pendingImport); let done = 0;
      for (let i = 0; i < entries.length; i += 20) {
        const rows = entries.slice(i, i + 20).map(([path, data]) => ({ path, data, updated_at: new Date().toISOString() }));
        const { error } = await sb.from('docs').upsert(rows); if (error) throw error;
        done += rows.length; $('#usImpTxt').textContent = `Importando… ${done} de ${entries.length}`;
      }
      $('#usImpTxt').textContent = `Listo: ${entries.length} documentos importados. Recargando…`; pendingImport = null;
      setTimeout(() => location.reload(), 1200);
    } catch (err) { $('#usImpTxt').textContent = 'No se pudo importar: ' + (err.message || err); }
    finally { $('#usImpOk').disabled = false; }
  }
})();

/* ---------- Historial de cambios ---------- */
(function(){
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fd = s => s && /^\d{4}-\d\d-\d\d/.test(s) ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : s;
  const n2 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const fdt = s => { const d = new Date(s); return d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }); };
  const LBL = { contrato: 'Contrato', pasajero: 'Pasajero', in: 'Check-in', out: 'Check-out', noches: 'Noches', status: 'Status', obs: 'Observación', usd: 'Monto', bs: 'Monto Bs', bcv: 'Tasa BCV', tarifa: 'Tarifa', factura: 'Factura', presupuesto: 'Presupuesto', grupo: 'Pago compartido', nombre: 'Nombre', estado: 'Estado', categoria: 'Categoría', moneda: 'Moneda', retencion: 'Retención', ret_pct: 'Retención', hotel: 'Hotel', tasa: 'Tasa', estatus: 'Estatus', fecha: 'Fecha', fecha_corte: 'Estatus al', eur: 'Tasa €', ret_hotel: 'Pago al hotel', ret: 'Retención Bs', base: 'Llevado en', retenciones: 'Descontar retenciones', anios: 'Años' };
  const SKIP = new Set(['editado', 'orden', '_borrado', 'lote']);
  const fv = (k, v) => v == null || v === '' ? '—' : typeof v === 'number' ? n2.format(v) : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : (k === 'grupo' ? 'sí' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : fd(String(v)));
  function cambios(a) {
    const L = a.path === 'config/tasas' ? { ...LBL, usd: 'Tasa $', eur: 'Tasa €' } : LBL;
    if (a.accion === 'eliminar') return '<span class="chip bad">Eliminado</span>';
    const o = a.antes && typeof a.antes === 'object' ? a.antes : null, n = a.despues && typeof a.despues === 'object' ? a.despues : null;
    if (!o && !n) return `${esc(fv('', a.antes))} → <b>${esc(fv('', a.despues))}</b>`;
    if (!o) return Object.keys(n).filter(k => !SKIP.has(k) && n[k] != null && n[k] !== '').slice(0, 6).map(k => `${L[k] || k}: <b>${esc(fv(k, n[k]))}</b>`).join(' · ');
    const ks = [...new Set([...Object.keys(o), ...Object.keys(n || {})])].filter(k => !SKIP.has(k) && JSON.stringify(o[k] ?? null) !== JSON.stringify((n || {})[k] ?? null));
    return ks.length ? ks.map(k => `${L[k] || k}: ${esc(fv(k, o[k]))} → <b>${esc(fv(k, (n || {})[k]))}</b>`).join('<br>') : '<span class="mut">Sin cambios visibles</span>';
  }
  function que(a, nombres) {
    const [tipo, key] = (a.clave || ':').split(/:(.*)/s);
    const d = a.despues && typeof a.despues === 'object' ? a.despues : (a.antes && typeof a.antes === 'object' ? a.antes : {});
    const hotelName = nombres[a.path] || a.path.split('/').pop().replace(/-/g, ' ').toUpperCase();
    if (/^hoteles-\d{4}$/.test(a.coleccion)) {
      if (tipo === 'rows') return `Reserva · <b>${esc(hotelName)}</b><span class="sub">${esc(d.pasajero || '')}${d.in ? ' · ' + fd(d.in) : ''}</span>`;
      return `Hotel · <b>${esc(hotelName)}</b><span class="sub">${esc(LBL[key] || key)}</span>`;
    }
    if (a.path === 'config/tasas') return `Tasa BCV<span class="sub">del ${fd(key)}</span>`;
    if (a.path === 'config/hoteles') return `Catálogo de hoteles<span class="sub">${esc(d.nombre || key)}</span>`;
    if (a.path === 'config/general') return 'Años del sistema';
    if (a.path === 'creditos/deudas') return tipo === 'items' ? `Crédito · <b>${esc(d.hotel || '')}</b>` : `Créditos<span class="sub">${esc(LBL[key] || key)}</span>`;
    if (a.path === 'creditos/pagos') return `Pago a hotel · <b>${esc(d.hotel || '')}</b><span class="sub">${fd(d.fecha || '')}</span>`;
    return esc(a.path);
  }
  const ACC = { crear: ['ok', 'Creó'], editar: ['info', 'Editó'], eliminar: ['bad', 'Eliminó'], 'eliminar documento': ['bad', 'Eliminó'] };
  let sb = null, nombres = {}, data = [];
  async function getSb() { if (sb) return sb; const db = await window.claude.use('db'); sb = window.__sbClient; return sb; }
  async function loadHotelNames() {
    const { data: rows } = await sb.from('docs').select('path,data->>nombre').like('coleccion', 'hoteles-%');
    (rows || []).forEach(r => nombres[r.path] = r.nombre);
  }
  async function cargar() {
    await getSb(); if (!sb) return;
    $('#hiBody').innerHTML = '<tr><td colspan="5" class="empty">Cargando…</td></tr>';
    if (!Object.keys(nombres).length) await loadHotelNames();
    let qy = sb.from('actividad').select('*').order('fecha', { ascending: false }).limit(500);
    const a = $('#hiDesde').value, b = $('#hiHasta').value, t = $('#hiTipo').value;
    if (a) qy = qy.gte('fecha', a + 'T00:00:00');
    if (b) qy = qy.lte('fecha', b + 'T23:59:59');
    if (t === 'reservas') qy = qy.like('coleccion', 'hoteles-%').like('clave', 'rows:%');
    if (t === 'tasas') qy = qy.eq('path', 'config/tasas');
    if (t === 'creditos') qy = qy.eq('coleccion', 'creditos');
    const { data: rows, error } = await qy;
    if (error) { $('#hiBody').innerHTML = `<tr><td colspan="5" class="empty">No se pudo cargar el historial: ${esc(error.message)}. ¿Ejecutaste el archivo supabase-historial.sql en Supabase?</td></tr>`; return; }
    data = t === 'hoteles' ? rows.filter(r => r.path === 'config/hoteles' || (/^hoteles-/.test(r.coleccion || '') && /^campo:/.test(r.clave || ''))) : rows; const us = [...new Set(rows.map(r => r.nombre).filter(Boolean))].sort();
    const cur = $('#hiUser').value; $('#hiUser').innerHTML = '<option value="">Todos</option>' + us.map(u => `<option ${u === cur ? 'selected' : ''}>${esc(u)}</option>`).join('');
    pintar();
  }
  function pintar() {
    const u = $('#hiUser').value, q = $('#hiQ').value.trim().toUpperCase();
    const rows = data.filter(r => (!u || r.nombre === u) && (!q || JSON.stringify([r.despues, r.antes, nombres[r.path], r.path]).toUpperCase().includes(q)));
    $('#hiCount').textContent = `${rows.length} ${rows.length === 1 ? 'cambio' : 'cambios'}${data.length === 500 ? ' (los 500 más recientes; usa las fechas para ver más atrás)' : ''}`;
    $('#hiBody').innerHTML = rows.length ? rows.map(r => { const [c, l] = ACC[r.accion] || ['', r.accion];
      return `<tr><td>${fdt(r.fecha)}</td><td><b>${esc(r.nombre || '—')}</b></td><td><span class="chip ${c}">${l}</span></td><td class="pax">${que(r, nombres)}</td><td class="hichg">${cambios(r)}</td></tr>`; }).join('')
      : '<tr><td colspan="5" class="empty">No hay cambios con estos filtros.</td></tr>';
  }
  function mostrar(on) {
    ['#view-reservas', '#view-hoteles', '#view-reportes', '#view-creditos', '#filters', '#summary'].forEach(s => { const e = $(s); if (e && on) e.hidden = true; });
    $('#view-historial').hidden = !on;
    if (on) { document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.id === 'tab-historial'))); cargar(); }
  }
  // historial dentro de la reserva
  let lastRow = null;
  document.addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('td.sel')) lastRow = tr.dataset.id; }, true);
  async function historialReserva() {
    const box = $('#hiRes'); if (!box) return;
    const sheet = $('#sheet'); if (sheet.hidden || $('#sheetTitle').textContent !== 'Editar reserva' || !lastRow) { box.hidden = true; return; }
    await getSb(); if (!sb) return;
    const [slug, id] = lastRow.split('|'); const path = 'hoteles-' + $('#fYear').value + '/' + slug;
    box.hidden = false; box.innerHTML = '<div class="sec">Historial de esta reserva</div><p class="hint">Cargando…</p>';
    const { data: rows, error } = await sb.from('actividad').select('*').eq('path', path).eq('clave', 'rows:' + id).order('fecha', { ascending: false }).limit(30);
    if (error) { box.innerHTML = '<div class="sec">Historial de esta reserva</div><p class="hint">El historial no está activado todavía.</p>'; return; }
    box.innerHTML = '<div class="sec">Historial de esta reserva</div>' + (rows.length ? '<ul class="hilist">' + rows.map(r => { const [c, l] = ACC[r.accion] || ['', r.accion];
      return `<li><span class="chip ${c}">${l}</span> <b>${esc(r.nombre || '—')}</b> <span class="mut">${fdt(r.fecha)}</span><div>${cambios(r)}</div></li>`; }).join('') + '</ul>'
      : '<p class="hint">Sin cambios registrados desde que se activó el historial.</p>');
  }
  document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.querySelector('.tabs');
    const tb = document.createElement('button'); tb.setAttribute('role', 'tab'); tb.id = 'tab-historial'; tb.setAttribute('aria-selected', 'false'); tb.textContent = 'Historial';
    tabs.appendChild(tb);
    tb.addEventListener('click', () => mostrar(true));
    document.querySelectorAll('.tabs button:not(#tab-historial)').forEach(b => b.addEventListener('click', () => { $('#view-historial').hidden = true; }));
    const sec = document.createElement('section'); sec.id = 'view-historial'; sec.hidden = true;
    sec.innerHTML = `<div class="cfg">
        <div class="f"><label for="hiUser">Usuario</label><select id="hiUser"><option value="">Todos</option></select></div>
        <div class="f"><label for="hiTipo">Qué</label><select id="hiTipo"><option value="">Todo</option><option value="reservas">Reservas</option><option value="hoteles">Hoteles</option><option value="tasas">Tasas BCV</option><option value="creditos">Créditos</option></select></div>
        <div class="f"><label for="hiDesde">Desde</label><input type="date" id="hiDesde"></div>
        <div class="f"><label for="hiHasta">Hasta</label><input type="date" id="hiHasta"></div>
        <div class="f" style="flex:1 1 200px"><label for="hiQ">Buscar</label><input type="search" id="hiQ" placeholder="Pasajero, hotel…" style="width:100%"></div>
        <button type="button" id="hiReload">Actualizar</button></div>
      <p class="hint" id="hiCount"></p>
      <div class="tablebox"><table><thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Acción</th><th>Qué</th><th>Cambios</th></tr></thead><tbody id="hiBody"></tbody></table></div>`;
    document.querySelector('main').appendChild(sec);
    ['#hiDesde', '#hiHasta', '#hiTipo'].forEach(s => $(s).addEventListener('change', cargar));
    ['#hiUser', '#hiQ'].forEach(s => $(s).addEventListener('input', pintar));
    $('#hiReload').onclick = cargar;
    const st = document.createElement('style');
    st.textContent = '.hichg{white-space:normal;min-width:260px;font-size:13px;line-height:1.5}#view-historial td{vertical-align:top}.hilist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}.hilist li{background:var(--surface-2);border-radius:8px;padding:8px 10px;font-size:13px}.hilist li div{margin-top:4px}';
    document.head.appendChild(st);
    const form = $('#form'); const box = document.createElement('div'); box.id = 'hiRes'; box.className = 'full'; box.hidden = true; box.style.gridColumn = '1/-1'; form.appendChild(box);
    new MutationObserver(historialReserva).observe($('#sheet'), { attributes: true, attributeFilter: ['hidden'] });
  });
})();

/* ---------- Instalar como aplicación ---------- */
(function(){
  if ('serviceWorker' in navigator) {
    if (/[?&]reiniciar/.test(location.search)) {
      navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))).then(() => caches.keys()).then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => location.replace(location.pathname));
    } else {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {}));
      let reloaded = false; navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && document.getElementById('loginBox') && !document.getElementById('loginBox').hidden) { reloaded = true; location.reload(); } });
    }
  }
  let evt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); evt = e; const b = document.getElementById('instBtn'); if (b) b.hidden = false; });
  window.addEventListener('appinstalled', () => { const b = document.getElementById('instBtn'); if (b) b.hidden = true; });
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.querySelector('.ubox'); if (!box) return;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'instBtn'; b.textContent = '⬇ Instalar app'; b.hidden = !evt;
    b.onclick = async () => { if (!evt) return; evt.prompt(); await evt.userChoice; evt = null; b.hidden = true; };
    box.insertBefore(b, box.firstChild);
  });
})();
