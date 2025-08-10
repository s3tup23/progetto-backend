require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');
const crypto = require('crypto');

// opzionale: se l’hai nel repo
let sendConfirmationEmail = null;
try { sendConfirmationEmail = require('./emailSender'); } catch {}

const app = express();
const port = process.env.PORT || 3000;

// ---------- Firebase ----------
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  serviceAccount = require(path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
} else {
  serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const ts = () => admin.firestore.FieldValue.serverTimestamp();

// ---------- Middleware ----------
app.set('trust proxy', 1);
app.use(cors({
  origin: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));
app.use(express.json());

// static assets per le email (se servono)
app.use('/email-assets/images', express.static(
  path.join(__dirname, 'email-assets', 'images')
));

// preflight
app.options('/auth/unlock', cors());
app.options('/permute/ritiro', cors());
app.options('/usato/vendita', cors());
app.options('/carrelli/lookup', cors());
app.options('/registrazione', cors());
app.options('/admin/registrazioni', cors());
app.options('/admin/purge-registrazioni', cors());

// ---------- Token HMAC (stateless) ----------
function getAdminKey() {
  return process.env.ADMIN_UNLOCK_KEY || process.env.ADMIN_API_KEY || '';
}
function signHmac(s) {
  return crypto.createHmac('sha256', getAdminKey()).update(s).digest('base64url');
}
function issueToken(ttlSec = 1800) {
  const iat = Date.now();
  const exp = iat + ttlSec * 1000;
  const data = `${iat}.${exp}`;
  const sig = signHmac(data);
  return Buffer.from(`${data}.${sig}`).toString('base64url');
}
function verifyToken(tok) {
  try {
    const raw = Buffer.from(tok, 'base64url').toString('utf8');
    const [iatStr, expStr, sig] = raw.split('.');
    if (!iatStr || !expStr || !sig) return false;
    const data = `${iatStr}.${expStr}`;
    if (signHmac(data) !== sig) return false;
    if (Date.now() > Number(expStr)) return false;
    return true;
  } catch { return false; }
}
function adminAuth(req, res, next) {
  const envKey = getAdminKey();
  if (!envKey) return res.status(500).json({ error: 'ADMIN_UNLOCK_KEY non configurata' });
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const headerKey = req.header('x-admin-key') || req.query.key;
  if (bearer && verifyToken(bearer)) return next();
  if (headerKey && headerKey === envKey) return next(); // comodo per test/cURL
  return res.status(401).json({ error: 'Unauthorized' });
}

// ---------- HEALTH / VERSION ----------
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/',       (_, res) => res.json({ ok: true, service: 'stewart-backend' }));
app.get('/version', (req, res) => {
  let version = 'dev';
  try { version = require('./package.json').version || version; } catch {}
  res.json({
    version,
    node: process.version,
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    env: process.env.NODE_ENV || 'development'
  });
});

// ---------- REGISTRAZIONE (pubblica) ----------
app.post('/registrazione', async (req, res) => {
  try {
    const dati = req.body || {};
    const required = ['nome','cognome','email','modello','serial','luogo','data_acquisto'];
    for (const f of required) {
      if (!dati[f] || String(dati[f]).trim() === '') {
        return res.status(400).json({ error: `Campo mancante: ${f}` });
      }
    }
    const parseISO = (s) => {
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const [dd,mm,yyyy] = s.split('/');
        return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
      }
      return new Date(`${s}T00:00:00Z`);
    };
    const d = parseISO(String(dati.data_acquisto));
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'data_acquisto non valida' });
    }
    const scadenza = new Date(d); scadenza.setMonth(scadenza.getMonth() + 24);

    const payload = {
      ...dati,
      tipo_registrazione: 'nuovo',
      data_acquisto: d.toISOString().slice(0,10),
      scadenza_garanzia: scadenza.toISOString().slice(0,10),
      createdAt: new Date().toISOString()
    };

    const docId = dati.ordineShopify && String(dati.ordineShopify).trim();
    if (docId) await db.collection('registrazioni').doc(docId).set(payload);
    else await db.collection('registrazioni').add(payload);

    if (typeof sendConfirmationEmail === 'function') {
      try { await sendConfirmationEmail(payload); } catch (e) { console.error('Email NUOVO fallita:', e.message); }
    }
    res.json({ message: 'Garanzia registrata con successo' });
  } catch (err) {
    console.error('❌ Errore /registrazione:', err);
    res.status(500).json({ error: 'Errore durante la registrazione' });
  }
});

// ---------- ADMIN: LIST / PURGE ----------
app.get('/admin/registrazioni', adminAuth, async (req, res) => {
  try {
    const snap = await db.collection('registrazioni').limit(500).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ items, count: items.length });
  } catch (err) {
    console.error('❌ Errore lista registrazioni:', err);
    res.status(500).json({ error: 'Errore del server' });
  }
});

app.post('/admin/purge-registrazioni', adminAuth, async (req, res) => {
  try {
    const { dryRun = true, idList = [], ordinePrefix, emailDomain, createdBefore } = req.body || {};
    const snap = await db.collection('registrazioni').limit(1000).get();
    const toDelete = [];
    const cutoff = createdBefore ? new Date(createdBefore) : null;
    const isValidDate = d => d instanceof Date && !isNaN(d.getTime());

    snap.forEach(doc => {
      const data = doc.data() || {};
      const id = doc.id;
      let match = false;
      if (idList?.length && idList.includes(id)) match = true;
      if (!match && ordinePrefix && typeof data.ordineShopify === 'string') {
        if (data.ordineShopify.startsWith(ordinePrefix)) match = true;
      }
      if (!match && emailDomain && typeof data.email === 'string') {
        if (data.email.toLowerCase().endsWith(`@${emailDomain.toLowerCase()}`)) match = true;
      }
      if (!match && cutoff) {
        const base = data.createdAt || data.data_acquisto;
        if (base) {
          const d = new Date(base);
          if (isValidDate(d) && d < cutoff) match = true;
        }
      }
      if (match) toDelete.push(doc.ref);
    });

    if (dryRun) return res.json({ dryRun: true, wouldDelete: toDelete.length });

    let deleted = 0;
    while (toDelete.length) {
      const chunk = toDelete.splice(0, 400);
      const batch = db.batch();
      chunk.forEach(ref => batch.delete(ref));
      await batch.commit();
      deleted += chunk.length;
    }
    res.json({ deleted });
  } catch (err) {
    console.error('❌ Purge error:', err);
    res.status(500).json({ error: 'Errore purge' });
  }
});

// ---------- AUTH SBLOCCO (STAFF) ----------
app.post('/auth/unlock', (req, res) => {
  const key = (req.body && req.body.key) || req.header('x-admin-key') || req.query.key;
  const envKey = getAdminKey();
  if (!envKey) return res.status(500).json({ error: 'ADMIN_UNLOCK_KEY non configurata' });
  if (!key || key !== envKey) return res.status(401).json({ error: 'Chiave non valida.' });
  const token = issueToken(1800);
  res.json({ token, expiresInSec: 1800, scopes: ['nuovo','permuta','usato'] });
});

// ---------- LOOKUP CARRELLO ----------
app.get('/carrelli/lookup', adminAuth, async (req, res) => {
  try {
    const seriale = String(req.query.seriale || '').trim();
    if (!seriale) return res.status(400).json({ error: 'seriale obbligatorio' });

    const regQ = await db.collection('registrazioni').where('serial', '==', seriale).orderBy('createdAt','desc').limit(1).get();
    const reg = regQ.empty ? null : ({ id: regQ.docs[0].id, ...regQ.docs[0].data() });

    const carrRef = db.collection('carrelli').doc(seriale);
    const carrSnap = await carrRef.get();
    let carr = carrSnap.exists ? ({ id: carrSnap.id, ...carrSnap.data() }) : null;

    res.json({ registrazione: reg, carrello: carr });
  } catch (e) {
    console.error('lookup error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// ---------- PERMUTA: RITIRO ----------
app.post('/permute/ritiro', adminAuth, async (req, res) => {
  const { seriale, modello, dataRientro, note } = req.body || {};
  if (!seriale || !modello) return res.status(400).json({ error: 'seriale e modello obbligatori' });

  try {
    await db.runTransaction(async (trx) => {
      const carrRef = db.collection('carrelli').doc(seriale);
      const carrSnap = await trx.get(carrRef);

      // chiudi eventuale registrazione cliente attiva
      const regQ = await trx.get(
        db.collection('registrazioni').where('serial', '==', seriale).orderBy('createdAt','desc').limit(1)
      );
      if (!regQ.empty) {
        trx.update(regQ.docs[0].ref, { stato: 'chiusa_per_permuta', updatedAt: ts() });
      }

      if (!carrSnap.exists) {
        trx.set(carrRef, {
          seriale,
          modello,
          stato: 'permuta_ritirato',
          possesso_corrente: { tipo: 'rivenditore' },
          createdAt: ts(),
          updatedAt: ts()
        });
      } else {
        trx.update(carrRef, {
          modello,
          stato: 'permuta_ritirato',
          possesso_corrente: { tipo: 'rivenditore' },
          updatedAt: ts()
        });
      }

      trx.set(carrRef.collection('eventi').doc(), {
        tipo: 'permuta_ritiro',
        payload: {
          dataRientro: dataRientro || null,
          note: (typeof note === 'string' && note.trim()) ? note.trim() : null
        },
        createdAt: ts()
      });
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Errore /permute/ritiro:', e);
    res.status(500).json({ error: 'Errore ritiro permuta' });
  }
});

// ---------- USATO: VENDITA ----------
app.post('/usato/vendita', adminAuth, async (req, res) => {
  try {
    const { seriale, modello, cliente, vendita = {}, gr = {} } = req.body || {};
    if (!seriale || !cliente?.nome || !cliente?.email) {
      return res.status(400).json({ error: 'seriale, cliente.nome ed email obbligatori' });
    }

    const mesi = Number(gr.mesi || 0);
    if (!Number.isFinite(mesi) || mesi < 0) {
      return res.status(400).json({ error: 'gr.mesi non valido' });
    }

    const parseDate = (s) => {
      if (!s) return new Date();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const [dd,mm,yyyy] = s.split('/');
        return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
      }
      return new Date(String(s));
    };
    const vendDate = parseDate(vendita.data);
    if (isNaN(vendDate.getTime())) return res.status(400).json({ error: 'vendita.data non valida' });

    const grFine = new Date(vendDate); grFine.setMonth(grFine.getMonth() + mesi);

    const regRef = db.collection('registrazioni').doc();
    const carrRef = db.collection('carrelli').doc(seriale);

    await db.runTransaction(async (trx) => {
      // chiudi eventuale precedente registrazione
      const regQ = await trx.get(
        db.collection('registrazioni').where('serial', '==', seriale).orderBy('createdAt','desc').limit(1)
      );
      if (!regQ.empty) {
        trx.update(regQ.docs[0].ref, { stato: 'chiusa_per_permuta', updatedAt: ts() });
      }

      trx.set(regRef, {
        tipo_registrazione: 'usato',
        serial: seriale,
        modello: (typeof modello === 'string' && modello.trim()) ? modello.trim() : null,
        cliente: {
          nome: String(cliente.nome).trim(),
          email: String(cliente.email).trim(),
          telefono: (typeof cliente.telefono === 'string' && cliente.telefono.trim()) ? cliente.telefono.trim() : null
        },
        vendita: {
          data: vendDate.toISOString(),
          sorgente: 'rivenditore',
          ordineShopify: vendita.ordineShopify ? String(vendita.ordineShopify).trim() : null
        },
        gr: {
          mesi,
          inizio: vendDate.toISOString(),
          fine: grFine.toISOString(),
          condizioni: (typeof gr.condizioni === 'string' && gr.condizioni.trim()) ? gr.condizioni.trim() : null
        },
        stato: 'attiva',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const carrSnap = await trx.get(carrRef);
      if (!carrSnap.exists) {
        trx.set(carrRef, {
          seriale,
          modello: (typeof modello === 'string' && modello.trim()) ? modello.trim() : null,
          stato: 'in_uso_cliente',
          possesso_corrente: { tipo: 'cliente', riferimento_registrazione_id: regRef.id },
          createdAt: ts(),
          updatedAt: ts()
        });
      } else {
        trx.update(carrRef, {
          modello: (typeof modello === 'string' && modello.trim()) ? modello.trim() : (carrSnap.data().modello || null),
          stato: 'in_uso_cliente',
          possesso_corrente: { tipo: 'cliente', riferimento_registrazione_id: regRef.id },
          updatedAt: ts()
        });
      }

      trx.set(carrRef.collection('eventi').doc(), {
        tipo: 'vendita_usato',
        payload: {
          regId: regRef.id,
          cliente: { nome: String(cliente.nome).trim(), email: String(cliente.email).trim() },
          gr: { mesi, fine: grFine.toISOString() }
        },
        createdAt: ts()
      });
    });

    // email al cliente usato (facoltativa, se hai configurato SMTP in emailSender separato: qui non la rilanciamo)
    res.json({ ok: true, registrazioneId: regRef.id });
  } catch (err) {
    console.error('❌ Errore /usato/vendita:', err);
    res.status(500).json({ error: 'Errore vendita usato' });
  }
});

// ---------- START ----------
app.listen(port, () => {
  console.log(`🚀 Server attivo su porta ${port}`);
});
