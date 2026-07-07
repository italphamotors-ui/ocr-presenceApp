require('dotenv').config();

module.exports = {
  // --- Mistral OCR ---
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '4hRwzayTSYtUFKDymlQncJglArufOtPA',
  MISTRAL_API_URL: 'https://api.mistral.ai/v1/chat/completions',
  MISTRAL_MODEL: process.env.MISTRAL_MODEL || 'pixtral-12b-2409',

  // --- Odoo (JSON-RPC) ---
  ODOO_JSONRPC_URL: process.env.ODOO_JSONRPC_URL || 'https://app.alphamotors-cameroun.com/jsonrpc',
  ODOO_DB: process.env.ODOO_DB || 'alpha_motors',
  ODOO_USER: process.env.ODOO_USER || 'russeltiako462@gmail.com',
  ODOO_PASSWORD: process.env.ODOO_PASSWORD || '04505c6b19529a4741e2addead23233b1d3917c5',
  ODOO_MODEL: 'x_manual.attendance',

  // --- Noms techniques des champs Odoo (Studio) — inchangés ---
  FIELDS: {
    DATE: 'x_date_2',
    NAME: 'x_name',
    EMPLOYEE: 'x_employee',
  },
  ATTENDANCE_LINE: {
  MODEL: 'x_manual.attendance.line',

  SHEET: 'x_attendance_sheet_id',

  EMPLOYEE: 'x_employee_id',

  CHECK_IN: 'x_check_in',

  CHECK_OUT: 'x_check_out',
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
