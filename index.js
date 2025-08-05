require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const app = express();

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

app.use(cors());
app.use(express.json());

app.get("/ordini/:numeroOrdine", async (req, res) => {
  const numeroOrdine = req.params.numeroOrdine;
  try {
    const snapshot = await db.collection("registrazioni")
      .where("ordineShopify", "==", numeroOrdine)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ success: false, message: "Ordine non trovato" });
    }

    const doc = snapshot.docs[0];
    return res.json({ success: true, data: doc.data(), id: doc.id });
  } catch (error) {
    console.error("Errore:", error);
    res.status(500).json({ success: false, error: "Errore interno" });
  }
});

app.listen(3000, () => {
  console.log("✅ Server in ascolto su http://localhost:3000");
});
