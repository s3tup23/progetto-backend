require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const sendConfirmationEmail = require('./emailSender');

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin da ENV JSON (Render)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Middleware
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('/registrazione', cors());
app.use(express.json());
app.use('/email-assets/images', express.static(require('path').join(__dirname, 'email-assets', 'images')));


// Servi immagini come statiche (URL pubblico)
app.use('/email-assets/images',
  express.static(path.join(__dirname, 'email-assets', 'images'))
);

// POST /registrazione — salva + email
app.post('/registrazione', async (req, res) => {
  try {
    const dati = req.body || {};
    const docId = dati.ordineShopify && String(dati.ordineShopify).trim();

    if (docId) {
      await db.collection('registrazioni').doc(docId).set(dati);
    } else {
      await db.collection('registrazioni').add(dati);
    }

    await sendConfirmationEmail(dati);
    res.status(200).json({ message: 'Garanzia registrata con successo' });
  } catch (err) {
    console.error('❌ Errore registrazione:', err);
    res.status(500).json({ error: 'Errore durante la registrazione' });
  }
});

// GET /ordini/:numeroOrdine — recupera registrazione
app.get('/ordini/:numeroOrdine', async (req, res) => {
  try {
    const id = String(req.params.numeroOrdine || '').trim();
    if (!id) return res.status(400).json({ error: 'ID mancante' });

    const snap = await db.collection('registrazioni').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Ordine non trovato' });

    res.status(200).json(snap.data());
  } catch (err) {
    console.error('❌ Errore ricerca ordine:', err);
    res.status(500).json({ error: 'Errore del server' });
  }
});

// 🔐 Endpoint admin: lista registrazioni (protetto da API key)
app.get('/admin/registrazioni', async (req, res) => {
  try {
    const key = req.query.key || req.headers['x-api-key'];
    if (!key || key !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Leggi max 500 registrazioni (ordinabili in futuro)
    const snap = await db.collection('registrazioni').limit(500).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.status(200).json({ items, count: items.length });
  } catch (err) {
    console.error('❌ Errore lista registrazioni:', err);
    res.status(500).json({ error: 'Errore del server' });
  }
});



// Avvio server
app.listen(port, () => {
  console.log(`🚀 Server attivo su porta ${port}`);
});
