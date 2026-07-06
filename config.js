require('dotenv').config();

module.exports = {
  // --- Mistral OCR ---
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '4hRwzayTSYtUFKDymlQncJglArufOtPA',
  MISTRAL_API_URL: 'https://api.mistral.ai/v1/chat/completions',
  MISTRAL_MODEL: process.env.MISTRAL_MODEL || 'pixtral-12b-2409',

  // --- Odoo (JSON-RPC) ---
  ODOO_JSONRPC_URL: process.env.ODOO_JSONRPC_URL || 'https://odooee.alphamotors-cameroun.com/jsonrpc',
  ODOO_DB: process.env.ODOO_DB || 'alpha_motors',
  ODOO_USER: process.env.ODOO_USER || 'service.it@alphamotors-cameroun.com',
  ODOO_PASSWORD: process.env.ODOO_PASSWORD || 'a113efbe86d8c67db19dbefb7b295693fde05d06',
  ODOO_MODEL: 'x_fiche_de_presenceocr',

  // --- Noms techniques des champs Odoo (Studio) — inchangés ---
  FIELDS: {
    DATE:               'x_studio_date',
    NAME:               'x_name',
    EMPLOYEE_NAME:      'x_studio_employee',
    HEURE_ARRIVEE:      'x_studio_heure_darrivee',
    HEURE_DEBUT_PAUSE:  'x_studio_heure_debut_pause',
    HEURE_RETOUR_PAUSE: 'x_studio_heure_retour_pausep',
    HEURE_DEPART:       'x_studio_heure_de_depart',
    OBSERVATION:        'x_studio_observation',
    DE_GARDE_HIER:      'x_studio_de_garde_hier',
  },

  // --- Règles métier RH (utilisées uniquement dans le rapport journalier) ---
  RH: {
    HEURE_ARRIVEE_STANDARD: '08:30',  // heure attendue employé normal
    HEURE_ARRIVEE_GARDE:    '10:30',  // heure attendue si de garde la veille
    EMAIL_RH: process.env.EMAIL_RH || 'rh@alphamotors-cameroun.com',
  },

  // --- Session ---
  SESSION_SECRET: process.env.SESSION_SECRET || 'change-moi-en-prod',

  // --- Upload ---
  MAX_UPLOAD_SIZE: 10 * 1024 * 1024,
  ALLOWED_EXTENSIONS: ['jpg', 'jpeg', 'png', 'pdf'],

  PORT: process.env.PORT || 3000,
};
