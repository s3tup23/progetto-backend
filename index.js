// definitivo
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const sendConfirmationEmail = require('./emailSender');

const app = express();
const port = process.env.PORT || 3000;

// 🔐 Firebase Admin da ENV JSON (Render)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

// 🔧 Middleware
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('/registrazione', cors());
app.use(express.json());
const path = require('path'); // se non c’è già in alto
app.use('/email-assets/images', express.static(
  path.join(__dirname, 'email-assets', 'images')
));


// ✅ POST /registrazione — salva + email
app.post('/registrazione', async (req, res) => {
  const dati = req.body;

  try {
    const modelloToImage = {
      "X10 Argento": "x10-argento.jpg",
      "X10 Bianco": "x10-bianco.jpg",
      "Q Follow Black edition": "qfollow-black.jpg",
      "Q Follow Carbon": "qfollow-carbon.jpg",
      "Q Range Follow Red": "qrange-red.jpg",
      "Q Range Follow Blue": "qrange-blue.jpg",
      "Q Range Follow Black": "qrange-black.jpg",
      "VERTX": "vertx.jpg"
    };

    const imgName = modelloToImage[dati.modello] || "default.jpg";
    dati.imgURL = `${process.env.BASE_IMAGE_URL}/${imgName}`;

    // ID documento = numero ordine (se assente, crea ID auto)
    const docId = dati.ordineShopify && String(dati.ordineShopify).trim() ? String(dati.ordineShopify).trim() : undefined;
    if (docId) {
      await db.collection('registrazioni').doc(docId).set(dati);
    } else {
      await db.collection('registrazioni').add(dati);
    }

    await sendConfirmationEmail(dati);

    res.status(200).json({ message: 'Garanzia registrata e email inviata' });
  } catch (error) {
    console.error('❌ Errore nella registrazione:', error);
    res.status(500).json({ error: 'Errore nella registrazione' });
  }
});

// ✅ GET /ordini/:numeroOrdine — recupera registrazione
app.get('/ordini/:numeroOrdine', async (req, res) => {
  const numeroOrdine = String(req.params.numeroOrdine || '').trim();

  try {
    const snap = await db.collection('registrazioni').doc(numeroOrdine).get();
    if (!snap.exists) return res.status(404).json({ error: 'Ordine non trovato' });
    res.status(200).json(snap.data());
  } catch (error) {
    console.error('❌ Errore nella ricerca ordine:', error);
