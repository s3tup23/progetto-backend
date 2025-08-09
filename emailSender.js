require('dotenv').config();

const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

// Mappa modello → immagine da usare
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

// Configurazione SMTP (OVH o altro provider)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendConfirmationEmail(dati) {
  const modello = dati.modello;
  const imageFile = modelloToImage[modello];

  if (!imageFile) {
    console.error("❌ Modello non riconosciuto:", modello);
    return;
  }

  const imagePath = path.join(__dirname, "email-assets", "images", imageFile);
  const hasLocal = fs.existsSync(imagePath);
  const publicUrl = `${process.env.BASE_IMAGE_URL}/${imageFile}`;

  // HTML: usa CID se il file locale esiste, altrimenti URL pubblico
  const imgTag = hasLocal
    ? `<img src="cid:carrelloImage" alt="Carrello Stewart" style="max-width:100%;border-radius:8px;margin-top:20px;">`
    : `<img src="${publicUrl}" alt="Carrello Stewart" style="max-width:100%;border-radius:8px;margin-top:20px;">`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
      <h2 style="color: #007c4f;">🎉 Garanzia registrata con successo</h2>
      <p>Gentile <strong>${dati.nome} ${dati.cognome}</strong>,</p>
      <p>Grazie per aver registrato il tuo carrello <strong>${modello}</strong>. Ecco i dettagli:</p>
      <ul style="line-height:1.6;">
        <li><strong>Modello:</strong> ${modello}</li>
        <li><strong>Serial Number:</strong> ${dati.serial}</li>
        <li><strong>Luogo di acquisto:</strong> ${dati.luogo}</li>
        <li><strong>Data di acquisto:</strong> ${dati.data_acquisto}</li>
        <li><strong>Email registrata:</strong> ${dati.email}</li>
        <li><strong>Data registrazione:</strong> ${new Date().toLocaleDateString()}</li>
      </ul>
      <p>Per qualsiasi informazione puoi scriverci a <a href="mailto:${process.env.EMAIL_USER}">${process.env.EMAIL_USER}</a>.</p>
      ${imgTag}
    </div>
  `;

  const mailOptions = {
    from: `"Stewart Golf" <${process.env.EMAIL_USER}>`,
    to: dati.email,
    subject: "Conferma registrazione garanzia Stewart Golf",
    html: htmlContent,
    attachments: hasLocal ? [{
      filename: imageFile,
      path: imagePath,
      cid: 'carrelloImage'
    }] : []
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Email inviata:", info.messageId, "(local image:", hasLocal, ")");
  } catch (error) {
    console.error("❌ Errore invio email:", error);
  }
}


module.exports = sendConfirmationEmail;
