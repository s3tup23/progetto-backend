require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const sendConfirmationEmail = require('./emailSender');

const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// ✅ Abilita CORS per tutte le origini (per test)
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

app.use(express.json());

// 🚀 Rotta POST per registrazione garanzia
app.post('/registrazione', async (req, res) => {
  const dati = req.body;

  try {
    // 1. Salva in Firestore
    const docRef = await db.collection('registrazioni').add(dati);
    console.log('✅ Registrazione salvata con ID:', docRef.id);

    // 2. Prepara URL immagine dal modello
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

    // 3. Invia email di conferma
    await sendConfirmationEmail(dati);

    res.status(200).json({ message: 'Garanzia registrata con successo' });

  } catch (error) {
    console.error('❌ Errore registrazione:', error);
    res.status(500).json({ error: 'Errore durante la registrazione' });
  }
});

// ✅ Avvia server in locale
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server avviato su porta ${PORT}`);
});
