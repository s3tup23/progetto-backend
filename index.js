require('dotenv').config();
const express = require('express');
const app = express();
const port = 3000;

app.use(express.json());

// Importa il modulo che gestisce l'invio dell’email
const emailSender = require('./emailSender');

// Rotta POST per invio mail
app.post('/invia-mail', async (req, res) => {
  try {
    const result = await emailSender(req.body);
    res.status(200).json({ message: 'Email inviata con successo', result });
  } catch (error) {
    console.error('❌ Errore invio email:', error);
    res.status(500).json({ error: 'Errore invio email' });
  }
});

console.log("🧪 Test log");

// Avvio server UNA SOLA VOLTA
app.listen(port, () => {
  console.log(`🚀 Server in ascolto su http://localhost:${port}`);
});
