require('dotenv').config();
const nodemailer = require('nodemailer');

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
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:2px solid #007c4f;padding:24px;border-radius:12px;">
      <h2 style="color:#007c4f;">🎉 Garanzia registrata con successo</h2>
      <p>Grazie per aver registrato il tuo carrello Stewart Golf. Ecco i dettagli:</p>
      <ul style="line-height:1.6;">
        <li><strong>Modello:</strong> ${dati.modello}</li>
        <li><strong>Serial Number:</strong> ${dati.serial}</li>
        <li><strong>Luogo di acquisto:</strong> ${dati.luogo}</li>
        <li><strong>Data di acquisto:</strong> ${dati.data_acquisto}</li>
      </ul>
      <p>Per qualsiasi informazione puoi scriverci a <a href="mailto:${process.env.EMAIL_USER}">${process.env.EMAIL_USER}</a>.</p>
      <img src="${dati.imgURL}" alt="Carrello Stewart" style="max-width:100%;border-radius:8px;margin-top:20px;">
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"Stewart Golf" <${process.env.EMAIL_USER}>`,
      to: dati.email,
      subject: "Conferma registrazione garanzia Stewart",
      html: htmlContent
    });

    console.log("✅ Email inviata:", info.messageId);
  } catch (error) {
    console.error("❌ Errore invio email:", error);
  }
}

module.exports = sendConfirmationEmail;
