const express = require('express');
const path    = require('path');
const config  = require('./config');

const ocrRoutes  = require('./routes/ocr');
const odooRoutes = require('./routes/odoo');

const app = express();

// --- Parsing JSON et form-data ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Fichiers statiques (index.html, css, js) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes API ---
app.use('/api/ocr',  ocrRoutes);
app.use('/api/odoo', odooRoutes);

// --- Écoute sur toutes les interfaces (obligatoire pour accès externe) ---
app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`✅ Serveur OCR Présence démarré sur le port ${config.PORT}`);
  console.log(`   Accès local  : http://localhost:${config.PORT}`);
  console.log(`   Accès réseau : http://<IP_DU_SERVEUR>:${config.PORT}`);
});
