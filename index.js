// index.js — Stewart backend (nuovo + permuta + usato + lookup)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

// opzionale: email conferma "nuovo"
let sendConfirmationEmail = null;
try { sendConfirmationEmail = require('./emailSender'); } catch { /* opzionale */ }

const app = express();
const port = process.env.PORT || 3000;

// ---------- Firebase Admin ----------
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  serviceAccount = require(path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
} else {
  // fallback locale (sviluppo)
  serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const ts = () => admin.firestore.FieldValue.serverTimestamp();

// ---------- Config email (usato) opzionale ----------
const BASE_ASSETS_URL = (process.env.PUBLIC_ASSETS_URL || '').replace(/\/$/, '');
const MODEL_IMAGE_MAP = {
  'Q Follow Black': 'qfollow-black.jpg',
  'Q Follow Carbon': 'qfollow-carbon.jpg',
  'Q Range Red': 'qrange-red.jpg',
  'Q Range Blue': 'qrange-blue.jpg',
  'Q Range Black': 'qrange-black.jpg',
  'VERTX': 'vertx.jpg',
  'X10 Follow Bianco': 'x10-bianco.jpg',
  'X10 Follow Argento': 'x10-argento.jpg',
  'X9 Follow Bianco': 'x10-bianco.jpg',
  'X9 Follow Argento': 'x10-argento.jpg',
  'X9 Follow Black': 'x9-follow-black.jpg',
  'X9 Remote Bianco': 'x10-bianco.jpg',
  'X9 Remote Argento': 'x10-argento.jpg',
  'X9 Remote Black': 'x9-remote-black.jpg'
};
function getModelImageUrl(modello) {
  if (!BASE_ASSETS_URL) return null;
  if (!modello) return null;
  const key = Object.keys(MODEL_IMAGE_MAP).find(k => (modello+'').toLowerCase().includes(k.toLowerCase()));
  return key ? `${BASE_ASSETS_URL}/email-assets/images/${MODEL_IMAGE_MAP[key]}` : null;
}

// ---------- Middleware ----------
app.set('trust proxy', 1);
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'x-api-key']
}));
app.use(express.json({ limit: '1mb' }));

// assets statici per email
app.use('/email-assets/images', express.static(path.join(__dirname, 'email-assets', 'images')));

// ---------- Auth & Token ----------
const ADMIN_UNLOCK_KEY = process.env.ADMIN_UNLOCK_KEY || process.env.ADMIN_API_KEY || '';
function makeToken() {
  const payload = { exp: Date.now() + 30 * 60 * 1000, jti: crypto.randomUUID() };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_UNLOCK_KEY).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(hdr) {
  if (!hdr || !/^Bearer\s+/.test(hdr)) return false;
  const token = hdr.replace(/^Bearer\s+/i, '');
  const [data, sig] = token.split('.');
  if (!data || !sig) return false;
  const expected = crypto.createHmac('sha256', ADMIN_UNLOCK_KEY).update(data).digest('base64url');
  if (sig !== expected) return false;
  let payload = null;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return false; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return false;
  return true;
}
function adminGuard(req, res, next) {
  if (!ADMIN_UNLOCK_KEY) return res.status(500).json({ error: 'ADMIN_UNLOCK_KEY non configurata' });
  const hdr = req.headers['authorization'];
  const xk = req.headers['x-admin-key'] || req.headers['x-api-key'];
  if ((hdr && verifyToken(hdr)) || (xk && xk === ADMIN_UNLOCK_KEY)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ---------- Health & meta ----------
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime_sec: Math.round(process.uptime()) }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'stewart-backend' }));
app.get('/version', (_req, res) => {
  let version = 'dev';
  try { version = require('./package.json').version || version; } catch {}
  res.json({
    version,
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    node: process.version,
    env: process.env.NODE_ENV || 'development'
  });
});

// ---------- /auth/unlock ----------
app.options('/auth/unlock', cors());
app.post('/auth/unlock', (req, res) => {
  try {
    const key = (req.header('x-admin-key')) || (req.body && req.body.key) || (req.query && req.query.key) || '';
    if (!ADMIN_UNLOCK_KEY) return res.status(500).json({ error: 'ADMIN_UNLOCK_KEY non configurata' });
    if (!key || key !== ADMIN_UNLOCK_KEY) return res.status(401).json({ error: 'Chiave non valida.' });
    const token = makeToken();
    return res.json({ token, expiresInSec: 1800, scopes: ['nuovo','permuta','usato'] });
  } catch (e) {
    return res.status(500).json({ error: 'Errore unlock' });
  }
});

// ---------- Registrazione NUOVO ----------
app.options('/registrazione', cors());
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
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'data_acquisto non valida' });
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

    res.status(200).json({ message: 'Garanzia registrata con successo' });
  } catch (err) {
    console.error('❌ Errore registrazione:', err);
    res.status(500).json({ error: 'Errore durante la registrazione' });
  }
});

// ---------- Admin: elenco registrazioni (come prima) ----------
app.get('/admin/registrazioni', async (req, res) => {
  try {
    const key = req.query.key || req.headers['x-api-key'] || req.headers['x-admin-key'];
    if (!key || key !== ADMIN_UNLOCK_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const snap = await db.collection('registrazioni').limit(500).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.status(200).json({ items, count: items.length });
  } catch (err) {
    console.error('❌ Errore lista registrazioni:', err);
    res.status(500).json({ error: 'Errore del server' });
  }
});

// ---------- LOOKUP carrello ----------
app.get('/carrelli/lookup', adminGuard, async (req, res) => {
  try {
    const seriale = String(req.query.seriale || '').trim();
    if (!seriale) return res.status(400).json({ error: 'seriale obbligatorio' });

    const regSnap = await db.collection('registrazioni').where('serial', '==', seriale).get();
    const regs = regSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // prendo un "nuovo" se presente; se no qualunque registrazione con scadenza
    let modello = null, data_acquisto = null, scadenza = null;
    const nuovo = regs.find(r => r.tipo_registrazione === 'nuovo');
    const any = nuovo || regs.find(r => r.scadenza_garanzia);
    if (any) {
      modello = any.modello || null;
      data_acquisto = any.data_acquisto || null;
      scadenza = any.scadenza_garanzia || null;
    }

    const carrRef = db.collection('carrelli').doc(seriale);
    const carrSnap = await carrRef.get();
    const carrello = carrSnap.exists ? { id: carrSnap.id, ...carrSnap.data() } : null;

    let residuo_garanzia_giorni = null;
    if (scadenza) {
      const end = new Date(scadenza + 'T00:00:00Z').getTime();
      const now = Date.now();
      residuo_garanzia_giorni = Math.ceil((end - now) / (1000*60*60*24));
    }

    res.json({
      seriale,
      modello,
      data_acquisto,
      scadenza_garanzia: scadenza,
      residuo_garanzia_giorni,
      carrello,
      registrazioni_count: regs.length
    });
  } catch (e) {
    console.error('lookup error:', e);
    res.status(500).json({ error: 'Errore lookup' });
  }
});

// ---------- PERMUTA: ritiro ----------
app.options('/permute/ritiro', cors());
app.post('/permute/ritiro', adminGuard, async (req, res) => {
  try {
    const { seriale, modello, dataRientro, note } = req.body || {};
    if (!seriale || !modello) return res.status(400).json({ error: 'seriale e modello obbligatori' });

    await db.runTransaction(async (trx) => {
      const carrRef = db.collection('carrelli').doc(String(seriale));
      const carrSnap = await trx.get(carrRef);

      // chiudo eventuale registrazione attiva
      const regQ = await trx.get(db.collection('registrazioni').where('serial', '==', String(seriale)).limit(1));
      if (!regQ.empty) trx.update(regQ.docs[0].ref, { stato: 'chiusa_per_permuta', updatedAt: ts() });

      if (!carrSnap.exists) {
        trx.set(carrRef, {
          seriale: String(seriale),
          modello: String(modello),
          stato: 'permuta_ritirato',
          possesso_corrente: { tipo: 'rivenditore' },
          createdAt: ts(),
          updatedAt: ts(),
          note: note ? String(note) : null
        });
      } else {
        trx.update(carrRef, {
          modello: String(modello),
          stato: 'permuta_ritirato',
          possesso_corrente: { tipo: 'rivenditore' },
          updatedAt: ts(),
          note: note ? String(note) : admin.firestore.FieldValue.delete()
        });
      }

      trx.set(carrRef.collection('eventi').doc(), {
        tipo: 'permuta_ritiro',
        payload: {
          dataRientro: dataRientro || null,
          note: note || null
        },
        createdAt: ts(),
        by: 'backend'
      });
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('permuta error:', e);
    res.status(500).json({ error: 'Errore permuta' });
  }
});

// ---------- USATO: vendita ----------
app.options('/usato/vendita', cors());
app.post('/usato/vendita', adminGuard, async (req, res) => {
  try {
    const { seriale, modello, cliente, vendita = {}, gr = {} } = req.body || {};
    if (!seriale) return res.status(400).json({ error: 'seriale obbligatorio' });
    if (!cliente || !cliente.nome || !cliente.email) return res.status(400).json({ error: 'cliente.nome e cliente.email obbligatori' });

    const mesi = Number(gr.mesi || 0);
    if (!Number.isFinite(mesi) || mesi < 0) return res.status(400).json({ error: 'gr.mesi non valido' });

    const parseDate = (s) => {
      if (!s) return new Date();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [dd, mm, yyyy] = s.split('/'); return new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`); }
      return new Date(String(s));
    };
    const vendDate = parseDate(vendita.data);
    if (isNaN(vendDate.getTime())) return res.status(400).json({ error: 'vendita.data non valida' });

    const grFine = new Date(vendDate); grFine.setMonth(grFine.getMonth() + mesi);

    const regRef = db.collection('registrazioni').doc();
    const carrRef = db.collection('carrelli').doc(String(seriale));

    await db.runTransaction(async (trx) => {
      const carrSnap = await trx.get(carrRef);

      // chiudo eventuale registrazione precedente
      const regQ = await trx.get(db.collection('registrazioni').where('serial', '==', String(seriale)).limit(1));
      if (!regQ.empty) trx.update(regQ.docs[0].ref, { stato: 'chiusa_per_permuta', updatedAt: ts() });

      // stato carrello -> in uso cliente
      if (!carrSnap.exists) {
        trx.set(carrRef, {
          seriale: String(seriale),
          modello: modello ? String(modello) : null,
          stato: 'in_uso_cliente',
          possesso_corrente: { tipo: 'cliente', riferimento_registrazione_id: regRef.id },
          createdAt: ts(),
          updatedAt: ts()
        });
      } else {
        trx.update(carrRef, {
          modello: modello ? String(modello) : admin.firestore.FieldValue.delete(),
          stato: 'in_uso_cliente',
          possesso_corrente: { tipo: 'cliente', riferimento_registrazione_id: regRef.id },
          updatedAt: ts()
        });
      }

      // nuova registrazione usato
      trx.set(regRef, {
        tipo_registrazione: 'usato',
        serial: String(seriale),
        modello: modello ? String(modello) : null,
        cliente: {
          nome: String(cliente.nome).trim(),
          email: String(cliente.email).trim(),
          telefono: cliente.telefono ? String(cliente.telefono).trim() : null
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
          condizioni: gr.condizioni ? String(gr.condizioni).trim() : null
        },
        stato: 'attiva',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // evento
      trx.set(carrRef.collection('eventi').doc(), {
        tipo: 'vendita_usato',
        payload: {
          regId: regRef.id,
          modello: modello ? String(modello) : null,
          cliente: {
            nome: String(cliente.nome).trim(),
            email: String(cliente.email).trim(),
            telefono: cliente.telefono ? String(cliente.telefono).trim() : null
          },
          gr: { mesi, fine: grFine.toISOString(), condizioni: gr.condizioni ? String(gr.condizioni).trim() : null }
        },
        createdAt: ts(),
        by: 'backend'
      });
    });

    // email al cliente (se configurata)
    try { await sendEmailRegistrazioneUsato({ seriale, cliente, gr: { mesi, fine: grFine.toISOString() }, modello }); } catch (e) { console.error('Email USATO fallita:', e.message); }

    res.json({ ok: true, registrazioneId: regRef.id });
  } catch (e) {
    console.error('usato error:', e);
    res.status(500).json({ error: 'Errore vendita usato' });
  }
});

// ---------- Email "usato" opzionale ----------
async function sendEmailRegistrazioneUsato({ seriale, cliente, gr, modello }) {
  const nodemailer = require('nodemailer');
  const SMTP_HOST = process.env.SMTP_HOST || process.env.EMAIL_HOST || 'ssl0.ovh.net';
  const SMTP_PORT = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 465);
  const SMTP_SECURE_RAW = (process.env.SMTP_SECURE ?? process.env.EMAIL_SECURE ?? 'true') + '';
  const SMTP_SECURE = !/^false$/i.test(SMTP_SECURE_RAW);
  const SMTP_USER = process.env.SMTP_USER || process.env.EMAIL_USER;
  const SMTP_PASS = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const SMTP_FROM = process.env.SMTP_FROM || process.env.EMAIL_FROM || SMTP_USER || 'garanzia@stewartgolf.it';
  if (!SMTP_USER || !SMTP_PASS) { console.warn('✉️  Email USATO disattivata: mancano credenziali.'); return; }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const scad = gr?.fine ? new Date(gr.fine) : null;
  const scadStr = (scad && !isNaN(scad.getTime())) ? scad.toLocaleDateString('it-IT') : '';
  const logoUrl = BASE_ASSETS_URL ? `${BASE_ASSETS_URL}/email-assets/images/logo-verticalgolf.jpg` : null;
  const modelUrl = getModelImageUrl(modello);
  const safe = (s) => (typeof s === 'string' ? s.replace(/[<>]/g, '') : '');

  const html = `
  <div style="background:#f6f7f9;padding:24px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" width="100%" style="max-width:680px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
      <tr>
        <td style="padding:16px 24px; background:#111; text-align:center;">
          ${logoUrl ? `<img src="${logoUrl}" alt="Stewart Golf" style="max-width:220px;height:auto;display:inline-block;">` : `<h2 style="color:#fff;margin:0;">Stewart Golf</h2>`}
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <h1 style="font-size:20px; margin:0 0 12px;">Conferma garanzia usato</h1>
          <p style="margin:0 0 8px;">Ciao ${safe(cliente?.nome)},</p>
          <p style="margin:0 0 12px;">abbiamo registrato la tua <b>garanzia usato</b> per il carrello <b>${safe(seriale)}</b>${modello ? `, modello <b>${safe(modello)}</b>` : ''}.</p>
          ${modelUrl ? `<img src="${modelUrl}" alt="${safe(modello || 'Carrello')}" style="width:100%;max-width:640px;height:auto;display:block;border-radius:8px;margin:12px 0;">` : ''}
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:12px 0 16px;">
            <tr><td style="padding:8px 0;"><b>Garanzia Rivenditore:</b> ${Number(gr?.mesi || 0)} mesi ${scadStr ? `— scadenza ${scadStr}` : ''}</td></tr>
            <tr><td style="padding:8px 0;">Per eventuali interventi coperti da garanzia del produttore, ci occupiamo noi della pratica.</td></tr>
          </table>
          <p style="margin:16px 0 0;">Grazie,<br><b>Stewart Golf Italia</b></p>
        </td>
      </tr>
    </table>
  </div>`;
  await transporter.sendMail({ from: SMTP_FROM, to: cliente.email, subject: `Registrazione garanzia usato – ${seriale}`, html });
}

// ---------- Purge rimane com’era ----------
app.post('/admin/purge-registrazioni', async (req, res) => {
  try {
    const key = req.headers['x-api-key'] || req.headers['x-admin-key'];
    if (!key || key !== ADMIN_UNLOCK_KEY) return res.status(401).json({ error: 'Unauthorized' });

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

    if (dryRun) return res.status(200).json({ dryRun: true, wouldDelete: toDelete.length });

    let deleted = 0;
    while (toDelete.length) {
      const chunk = toDelete.splice(0, 400);
      const batch = db.batch();
      chunk.forEach(ref => batch.delete(ref));
      await batch.commit();
      deleted += chunk.length;
    }
    return res.status(200).json({ deleted });
  } catch (err) {
    console.error('❌ Purge error:', err);
    return res.status(500).json({ error: 'Errore purge' });
  }
});

// ---------- Start ----------
app.listen(port, () => {
  console.log(`🚀 Server attivo su porta ${port}`);
});
