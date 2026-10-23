/* Puente entre la página y Firebase: inicio de sesión, roles, base de datos y descargas. */
(function(){
  const cfg = window.FIREBASE_CONFIG || {};
  const fbOk = !!(window.firebase && firebase.initializeApp);
  const configured = fbOk && !!(cfg.apiKey && cfg.projectId);
  let app, auth, fs;
  if (configured) { app = firebase.initializeApp(cfg); auth = firebase.auth(); fs = firebase.firestore(); fs.settings({ ignoreUndefinedProperties: true, merge: true }); }

  const S = { user: null, perfil: null };
  let resolveReady; const ready = new Promise(r => resolveReady = r);
  const FP = fbOk && firebase.firestore ? firebase.firestore.FieldPath : null;

  const mapErr = e => ({ code: (e && (e.code === 'permission-denied' || e.code === 'not-found' || e.code === 'invalid-argument')) ? 'invalid_argument' : (e && e.code === 'resource-exhausted' ? 'quota_exceeded' : 'unavailable'), message: e && e.message || '' });
  const wrapSnap = s => ({ id: s.id, exists: s.exists, data: () => s.data(), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } });
  function flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix.concat(k);
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) flatten(v, p, out);
      else out.push([p, v === undefined ? null : v]);
    }
    return out;
  }
  function docRef(ref) {
    return {
      id: ref.id, path: ref.path,
      get: () => ref.get().then(wrapSnap),
      set: d => ref.set(d).catch(e => { throw mapErr(e) }),
      update: d => { const pairs = flatten(d, [], []); if (!pairs.length) return Promise.resolve(); const args = []; pairs.forEach(([p, v]) => args.push(new FP(...p), v)); return ref.update(...args).catch(e => { throw mapErr(e) }); },
      delete: () => ref.delete().catch(e => { throw mapErr(e) }),
      onSnapshot: (next, err) => ref.onSnapshot(s => next(wrapSnap(s)), e => err && err(mapErr(e))),
      collection: p => colRef(ref.collection(p))
    };
  }
  function queryRef(q) {
    return {
      where: (f, op, v) => queryRef(q.where(f, op, v)),
      orderBy: (f, d) => queryRef(q.orderBy(f, d)),
      limit: n => queryRef(q.limit(n)),
      get: () => q.get().then(s => ({ docs: s.docs.map(wrapSnap), size: s.size, empty: s.empty, metadata: s.metadata })),
      onSnapshot: (next, err) => q.onSnapshot(s => next({ docs: s.docs.map(wrapSnap), size: s.size, empty: s.empty, metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } }), e => err && err(mapErr(e)))
    };
  }
  function colRef(c) { const q = queryRef(c); q.doc = id => docRef(id ? c.doc(id) : c.doc()); q.add = d => c.add(d).then(r => docRef(r)); q.path = c.path; return q; }
  const dbApi = configured ? { doc: p => docRef(fs.doc(p)), collection: p => colRef(fs.collection(p)) } : null;
  const userApi = { can: async () => true, canEdit: () => S.perfil && S.perfil.rol === 'admin', isOwner: () => S.perfil && S.perfil.rol === 'admin', id: async () => S.user && S.user.uid };
  const downloadsApi = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  };
  window.claude = { use: async name => { await ready; return name === 'db' ? dbApi : name === 'user' ? userApi : name === 'downloads' ? downloadsApi : null; } };

  /* ---------- pantalla de inicio de sesión ---------- */
  const $ = s => document.querySelector(s);
  function showLogin(msg) { $('#loginBox').hidden = false; $('#loginMsg').textContent = msg || ''; }
  function hideLogin() { $('#loginBox').hidden = true; }

  document.addEventListener('DOMContentLoaded', () => {
    if (!configured) { showLogin(fbOk ? 'Falta configurar Firebase: completa el archivo firebase-config.js.' : 'No se pudo conectar con Firebase. Revisa tu conexión a internet y recarga la página.'); $('#lForm').hidden = true; return; }
    $('#lForm').addEventListener('submit', async e => {
      e.preventDefault(); $('#lBtn').disabled = true; $('#loginMsg').textContent = '';
      try { await auth.signInWithEmailAndPassword($('#lEmail').value.trim(), $('#lPass').value); }
      catch (err) { $('#loginMsg').textContent = /wrong-password|invalid-credential|user-not-found|invalid-login/.test(err.code) ? 'Correo o contraseña incorrectos.' : (err.code === 'auth/too-many-requests' ? 'Demasiados intentos. Espera unos minutos.' : 'No se pudo iniciar sesión: ' + err.message); }
      finally { $('#lBtn').disabled = false; }
    });
    $('#lForgot').addEventListener('click', async () => {
      const em = $('#lEmail').value.trim(); if (!em) { $('#loginMsg').textContent = 'Escribe tu correo y vuelve a pulsar “Olvidé mi contraseña”.'; return; }
      try { await auth.sendPasswordResetEmail(em); $('#loginMsg').textContent = 'Te enviamos un correo para cambiar la contraseña.'; } catch (err) { $('#loginMsg').textContent = 'No se pudo enviar el correo: ' + err.message; }
    });
    auth.onAuthStateChanged(async u => {
      if (!u) { if (S.user) location.reload(); showLogin(); return; }
      try {
        const ref = fs.collection('usuarios').doc(u.uid); let snap = await ref.get();
        if (!snap.exists && u.email && u.email.toLowerCase() === String(window.ADMIN_EMAIL || '').toLowerCase()) {
          await ref.set({ nombre: u.email.split('@')[0], email: u.email, rol: 'admin', activo: true, creado: new Date().toISOString() });
          snap = await ref.get();
        }
        if (!snap.exists || !snap.data().activo) { showLogin('Tu usuario no tiene acceso. Pide al administrador que te habilite.'); await auth.signOut(); return; }
        S.user = u; S.perfil = snap.data(); hideLogin(); applyRole(); resolveReady();
      } catch (err) { showLogin('No se pudo cargar tu perfil: ' + err.message); }
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
    $('#uOut').onclick = () => auth && auth.signOut();
    $('#uBtn').onclick = openUsers;
    $('#usClose').onclick = closeUsers;
    $('#usAdd').onclick = addUser;
    $('#usImport').addEventListener('change', importFile);
    $('#usImpOk').onclick = runImport;
  });

  let unsubUsers = null, pendingImport = null;
  function openUsers() {
    $('#usScrim').hidden = false; $('#usSheet').hidden = false;
    if (unsubUsers) return;
    unsubUsers = fs.collection('usuarios').onSnapshot(s => {
      const rows = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      $('#usList').innerHTML = rows.map(u => `<tr data-u="${u.id}"><td><b>${esc(u.nombre || '')}</b><span class="sub">${esc(u.email || '')}</span></td>
        <td><select data-rol ${u.id === S.user.uid ? 'disabled' : ''}><option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option><option value="agente" ${u.rol === 'agente' ? 'selected' : ''}>Agente</option></select></td>
        <td><label class="check"><input type="checkbox" data-act ${u.activo ? 'checked' : ''} ${u.id === S.user.uid ? 'disabled' : ''}> Activo</label></td>
        <td><button type="button" data-reset>Enviar cambio de clave</button></td></tr>`).join('');
    });
    $('#usList').onchange = async e => {
      const tr = e.target.closest('tr[data-u]'); if (!tr) return;
      const patch = e.target.matches('[data-rol]') ? { rol: e.target.value } : e.target.matches('[data-act]') ? { activo: e.target.checked } : null;
      if (patch) try { await fs.collection('usuarios').doc(tr.dataset.u).update(patch); note('Usuario actualizado.'); } catch (err) { note('No se pudo actualizar: ' + err.message); }
    };
    $('#usList').onclick = async e => {
      if (!e.target.matches('[data-reset]')) return; const tr = e.target.closest('tr');
      const em = tr.querySelector('.sub').textContent;
      try { await auth.sendPasswordResetEmail(em); note('Correo para cambiar la clave enviado a ' + em + '.'); } catch (err) { note('No se pudo enviar: ' + err.message); }
    };
  }
  function closeUsers() { $('#usScrim').hidden = true; $('#usSheet').hidden = true; }
  function note(t) { $('#usNote').textContent = t; }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function addUser() {
    const nombre = $('#usNom').value.trim(), email = $('#usMail').value.trim(), pass = $('#usPass').value, rol = $('#usRol').value;
    if (!nombre || !email || pass.length < 6) { note('Escribe nombre, correo y una contraseña de al menos 6 caracteres.'); return; }
    $('#usAdd').disabled = true;
    try {
      const sec = firebase.apps.find(a => a.name === 'secundaria') || firebase.initializeApp(cfg, 'secundaria');
      const cred = await sec.auth().createUserWithEmailAndPassword(email, pass);
      await fs.collection('usuarios').doc(cred.user.uid).set({ nombre, email, rol, activo: true, creado: new Date().toISOString() });
      await sec.auth().signOut();
      ['#usNom', '#usMail', '#usPass'].forEach(x => $(x).value = '');
      note(`Usuario creado. ${nombre} entra con ${email} y la contraseña que escribiste.`);
    } catch (err) { note(err.code === 'auth/email-already-in-use' ? 'Ese correo ya tiene usuario.' : 'No se pudo crear: ' + err.message); }
    finally { $('#usAdd').disabled = false; }
  }
  async function importFile(e) {
    const f = e.target.files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); if (!j.docs) throw new Error('formato'); pendingImport = j.docs;
      $('#usImpTxt').textContent = `El archivo tiene ${Object.keys(j.docs).length} documentos. Al importar se reemplazan los datos que tengan el mismo nombre.`; $('#usImpOk').hidden = false; }
    catch (err) { $('#usImpTxt').textContent = 'Ese archivo no es una exportación del sistema.'; }
  }
  async function runImport() {
    if (!pendingImport) return; $('#usImpOk').disabled = true;
    try {
      const entries = Object.entries(pendingImport); let done = 0;
      for (let i = 0; i < entries.length; i += 300) {
        const b = fs.batch(); entries.slice(i, i + 300).forEach(([p, d]) => b.set(fs.doc(p), d)); await b.commit(); done += Math.min(300, entries.length - i);
        $('#usImpTxt').textContent = `Importando… ${done} de ${entries.length}`;
      }
      $('#usImpTxt').textContent = `Listo: ${entries.length} documentos importados.`; $('#usImpOk').hidden = true; pendingImport = null;
    } catch (err) { $('#usImpTxt').textContent = 'No se pudo importar: ' + err.message; }
    finally { $('#usImpOk').disabled = false; }
  }
})();
