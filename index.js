require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const sendConfirmationEmail = require('./emailSender');

const app = express();
const port = process.env.PORT || 3000;

// 🔐 Caricamento chiave service account
const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

// 🔧 Inizializza Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 🔥 Firestore DB
const db = admin.firestore();

// 🌍 Middlewares
app.use(cors());
app.use(express.json());

// ✅ ROTTA POST - Registrazione garanzia + invio email
app.post('/registrazione', async (req, res) => {
  const dati = req.body;

  try {
    await db.collection('registrazioni').doc(dati.ordineShopify).set(dati); // Salva con ID = numero ordine
    await sendConfirmationEmail(dati); // Invia email
    res.status(200).json({ message: 'Garanzia registrata e email inviata' });
  } catch (error) {
    console.error('❌ Errore nella registrazione:', error);
    res.status(500).json({ error: 'Errore nella registrazione' });
  }
});

// ✅ ROTTA GET - Verifica ordine per numero
app.get('/ordini/:numeroOrdine', async (req, res) => {
  const numeroOrdine = req.params.numeroOrdine;

  try {
    const docRef = db.collection('registrazioni').doc(numeroOrdine);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Ordine non trovato' });
    }

    res.status(200).json(doc.data());
  } catch (error) {
    console.error('❌ Errore nella ricerca ordine:', error);
    res.status(500).json({ error: 'Errore del server' });
  }
});

// ▶️ Avvia server
app.listen(port, () => {
  console.log(`🚀 Server attivo su http://localhost:${port}`);
});

