/* Puente entre la página y Supabase: inicio de sesión, roles, base de datos en vivo y descargas. */
(function(){
  const URL_ = window.SUPABASE_URL || '', KEY = window.SUPABASE_ANON_KEY || '';
  const libOk = !!(window.supabase && window.supabase.createClient);
  const configured = libOk && !!(URL_ && KEY);
  const sb = configured ? window.supabase.createClient(URL_, KEY) : null;
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
      let { data: p, error } = await sb.from('perfiles').select('*').eq('id', u.id).maybeSingle();
      if (error) throw error;
      if (!p && u.email && u.email.toLowerCase() === String(window.ADMIN_EMAIL || '').toLowerCase()) {
        const r = await sb.from('perfiles').insert({ id: u.id, nombre: u.email.split('@')[0], email: u.email, rol: 'admin', activo: true }).select().single();
        if (r.error) throw r.error; p = r.data;
      }
      if (!p || !p.activo) { await sb.auth.signOut(); showLogin('Tu usuario no tiene acceso. Pide al administrador que te habilite.'); return; }
      S.user = u; S.perfil = p; hideLogin(); applyRole(); resolveReady();
    } catch (err) { showLogin('No se pudo cargar tu perfil: ' + (err.message || err)); }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!configured) { showLogin(libOk ? 'Falta configurar Supabase: completa el archivo supabase-config.js.' : 'No se pudo conectar con Supabase. Revisa tu conexión a internet y recarga la página.'); $('#lForm').hidden = true; return; }
    $('#lForm').addEventListener('submit', async e => {
      e.preventDefault(); $('#lBtn').disabled = true; $('#loginMsg').textContent = '';
      const { error } = await sb.auth.signInWithPassword({ email: $('#lEmail').value.trim(), password: $('#lPass').value });
      if (error) $('#loginMsg').textContent = /invalid/i.test(error.message) ? 'Correo o contraseña incorrectos.' : (/confirm/i.test(error.message) ? 'Tu correo aún no está confirmado.' : 'No se pudo iniciar sesión: ' + error.message);
      $('#lBtn').disabled = false;
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
    if (!admin) { const t = $('#tab-creditos'); if (t) t.hidden = true; const v = $('#view-creditos'); if (v) v.remove(); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('header.top .bar');
    const box = document.createElement('div'); box.className = 'ubox';
    box.innerHTML = '<span id="uName" class="uname"></span><button type="button" id="uBtn" hidden>Usuarios</button><button type="button" id="uOut" class="ghost">Salir</button>';
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
