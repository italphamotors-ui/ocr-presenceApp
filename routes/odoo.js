const express = require('express');
const axios   = require('axios');
const config  = require('../config');

const router = express.Router();

// -------------------------------------------------------
// UTILITAIRE JSON-RPC ODOO
// -------------------------------------------------------
async function jsonRpc(service, method, args) {
  const response = await axios.post(
    config.ODOO_JSONRPC_URL,
    {
      jsonrpc: '2.0',
      method:  'call',
      params:  { service, method, args },
      id:      Date.now(),
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    }
  );
  if (response.data.error) {
    throw new Error(JSON.stringify(response.data.error));
  }
  return response.data.result;
}

// -------------------------------------------------------
// UTILITAIRE : formate date + heure en datetime Odoo
// date = "2026-03-18", heure = "08:30" → "2026-03-18 08:30:00"
// Accepte les formats : "08:30", "08h30", "8:30"
// -------------------------------------------------------
function toDatetime(date, heure) {
  if (!heure || typeof heure !== 'string') return false;
  const match = heure.trim().match(/^(\d{1,2})[hH:](\d{2})$/);
  if (!match) return false;
  const h = match[1].padStart(2, '0');
  const m = match[2];
  return `${date} ${h}:${m}:00`;
}

// -------------------------------------------------------
// UTILITAIRE : matching approximatif nom OCR ↔ nom Odoo
// Règle : si tous les mots du nom OCR sont dans le nom Odoo
//         OU tous les mots du nom Odoo sont dans le nom OCR
//         → même employé, on retourne l'ID Odoo existant.
// Exemple : "FEZZE William" ↔ "FEZZE TCHEKOULONG William" → match ✅
// -------------------------------------------------------
function fuzzyFindEmployee(nomOcr, employeeMap) {
  const wordsOcr = nomOcr.trim().toUpperCase().split(/\s+/).filter(w => w.length > 1);

  // 1. Lookup exact d'abord
  if (employeeMap[nomOcr.trim().toUpperCase()]) {
    return employeeMap[nomOcr.trim().toUpperCase()];
  }

  // 2. Matching partiel
  for (const [nomOdoo, id] of Object.entries(employeeMap)) {
    const wordsOdoo = nomOdoo.split(/\s+/).filter(w => w.length > 1);
    const ocrInOdoo = wordsOcr.every(w => wordsOdoo.includes(w));
    const odooInOcr = wordsOdoo.every(w => wordsOcr.includes(w));
    if (ocrInOdoo || odooInOcr) {
      return id;
    }
  }

  return false; // aucun match → auto-création nécessaire
}

// -------------------------------------------------------
// UTILITAIRE : charge tous les employés actifs → map nom→id
// -------------------------------------------------------
async function loadEmployeeMap(uid) {
  const allEmployees = await jsonRpc('object', 'execute_kw', [
    config.ODOO_DB,
    uid,
    config.ODOO_PASSWORD,
    'hr.employee',
    'search_read',
    [[['active', '=', true]]],
    { fields: ['id', 'name'], limit: 500 },
  ]);
  const map = {};
  for (const emp of allEmployees) {
    map[emp.name.trim().toUpperCase()] = emp.id;
  }
  return map;
}

// -------------------------------------------------------
// UTILITAIRE : résout ou crée un employé
// Retourne l'ID (existant ou nouvellement créé), ou false
// -------------------------------------------------------
async function resolveOrCreateEmployee(uid, nomOcr, employeeMap, errors) {
  // 1. Matching exact ou approximatif
  let employeeId = fuzzyFindEmployee(nomOcr, employeeMap);
  if (employeeId) return employeeId;

  // 2. Aucun match → création automatique
  try {
    employeeId = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB,
      uid,
      config.ODOO_PASSWORD,
      'hr.employee',
      'create',
      [{ name: nomOcr.trim() }],
      {},
    ]);
    // Mise à jour de la map pour éviter une double création dans la même fiche
    employeeMap[nomOcr.trim().toUpperCase()] = employeeId;
    return employeeId;
  } catch (e) {
    errors.push(`${nomOcr} (échec création employé : ${e.message})`);
    return false;
  }
}

// -------------------------------------------------------
// GET /api/odoo/employees
// Retourne la liste {id, name} de tous les employés actifs
// -------------------------------------------------------
router.get('/employees', async (req, res) => {
  try {
    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB,
      config.ODOO_USER,
      config.ODOO_PASSWORD,
    ]);

    if (!uid) return res.json({ success: false, message: 'Authentification Odoo refusée.' });

    const employees = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB,
      uid,
      config.ODOO_PASSWORD,
      'hr.employee',
      'search_read',
      [[['active', '=', true]]],
      { fields: ['id', 'name'], limit: 500, order: 'name asc' },
    ]);

    return res.json({ success: true, employees });

  } catch (err) {
    return res.json({ success: false, message: 'Impossible de récupérer les employés Odoo : ' + err.message });
  }
});

// -------------------------------------------------------
// GET /api/odoo/fields  (diagnostic)
// -------------------------------------------------------
router.get('/fields', async (req, res) => {
  try {
    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB, config.ODOO_USER, config.ODOO_PASSWORD,
    ]);

    const fields = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB, uid, config.ODOO_PASSWORD,
      config.ODOO_MODEL, 'fields_get', [],
      { attributes: ['string', 'type', 'relation'] },
    ]);

    return res.json(fields);
  } catch (err) {
    return res.json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------
// POST /api/odoo/save
// 1er scan : crée les fiches de présence.
// - Matching approximatif nom OCR ↔ nom Odoo
// - Auto-création de l'employé si introuvable
// - Anti-doublon date + employé
// - Heures en datetime Odoo "YYYY-MM-DD HH:MM:SS"
// -------------------------------------------------------
router.post('/save', async (req, res) => {
  const { date, rows, force } = req.body;

  if (!date || !Array.isArray(rows) || rows.length === 0) {
    return res.json({ success: false, message: 'Données manquantes.' });
  }

  const validRows = rows.filter(r => r.employee_name && r.employee_name.trim() !== '');
  if (validRows.length === 0) {
    return res.json({ success: false, message: "Aucune ligne avec un nom d'employé." });
  }

  const F = config.FIELDS;

  try {
    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB, config.ODOO_USER, config.ODOO_PASSWORD,
    ]);
    if (!uid) return res.json({ success: false, message: 'Authentification Odoo refusée.' });

    const employeeMap  = await loadEmployeeMap(uid);
    let created        = 0;
    let skipped        = 0;
    const errors       = [];
    const skippedNames = [];

    for (const row of validRows) {

      // ── 1. Résolution / création de l'employé ──────────
      const employeeId = await resolveOrCreateEmployee(
        uid, row.employee_name, employeeMap, errors
      );
      if (!employeeId) continue;

      // ── 2. Anti-doublon : même date + même employé ─────
      let alreadyExists = false;
      try {
        const count = await jsonRpc('object', 'execute_kw', [
          config.ODOO_DB, uid, config.ODOO_PASSWORD,
          config.ODOO_MODEL, 'search_count',
          [[[F.DATE, '=', date], [F.EMPLOYEE_NAME, '=', employeeId]]],
          {},
        ]);
        alreadyExists = count > 0;
      } catch (e) { /* non bloquant */ }

      if (alreadyExists && !force) {
        skipped++;
        skippedNames.push(row.employee_name);
        continue;
      }

      // ── 3. Création de la fiche ────────────────────────
      const values = {
        [F.NAME]:              `${row.employee_name} - ${date}`,
        [F.DATE]:              date,
        [F.EMPLOYEE_NAME]:     employeeId,
        [F.HEURE_ARRIVEE]:     toDatetime(date, row.heure_arrivee)      || false,
        [F.HEURE_DEBUT_PAUSE]: toDatetime(date, row.heure_debut_pause)  || false,
        [F.HEURE_RETOUR_PAUSE]:toDatetime(date, row.heure_retour_pause) || false,
        [F.HEURE_DEPART]:      toDatetime(date, row.heure_depart)       || false,
        [F.OBSERVATION]:       row.observation                          || false,
        [F.DE_GARDE_HIER]:     Boolean(row.de_garde_hier),
      };

      try {
        await jsonRpc('object', 'execute_kw', [
          config.ODOO_DB, uid, config.ODOO_PASSWORD,
          config.ODOO_MODEL, 'create', [values], {},
        ]);
        created++;
      } catch (err) {
        errors.push(`${row.employee_name} (${err.message})`);
      }
    }

    return res.json({ success: true, created, skipped, skippedNames, errors });

  } catch (err) {
    return res.json({ success: false, message: 'Impossible de contacter Odoo (vérifie identifiants/réseau).' });
  }
});

// -------------------------------------------------------
// POST /api/odoo/update
// 2e scan : met à jour les fiches existantes.
// - Matching approximatif nom OCR ↔ nom Odoo
// - Auto-création de l'employé si introuvable
// - Si pas de fiche pour cette date → crée la fiche
// - Compare champ par champ, n'écrit que les différences
// - Retourne le détail des champs modifiés par employé
// -------------------------------------------------------
router.post('/update', async (req, res) => {
  const { date, rows } = req.body;

  if (!date || !Array.isArray(rows) || rows.length === 0) {
    return res.json({ success: false, message: 'Données manquantes.' });
  }

  const validRows = rows.filter(r => r.employee_name && r.employee_name.trim() !== '');
  if (validRows.length === 0) {
    return res.json({ success: false, message: "Aucune ligne avec un nom d'employé." });
  }

  const F = config.FIELDS;

  const LABELS = {
    [F.HEURE_ARRIVEE]:      "Heure d'arrivée",
    [F.HEURE_DEBUT_PAUSE]:  'Début pause',
    [F.HEURE_RETOUR_PAUSE]: 'Retour pause',
    [F.HEURE_DEPART]:       'Heure de départ',
    [F.OBSERVATION]:        'Observation',
    [F.DE_GARDE_HIER]:      'De garde hier',
  };

  // Normalise datetime Odoo "2026-03-18 08:30:00" → "08:30"
  function normalizeTime(val) {
    if (!val || val === false) return '';
    const s = String(val);
    if (s.includes(' ')) return s.split(' ')[1].slice(0, 5);
    return s;
  }

  try {
    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB, config.ODOO_USER, config.ODOO_PASSWORD,
    ]);
    if (!uid) return res.json({ success: false, message: 'Authentification Odoo refusée.' });

    const employeeMap   = await loadEmployeeMap(uid);
    let updated         = 0;
    let unchanged       = 0;
    let notFound        = 0;
    const errors        = [];
    const updatesDetail = [];
    const notFoundNames = [];

    for (const row of validRows) {

      // ── 1. Résolution / création de l'employé ──────────
      const employeeId = await resolveOrCreateEmployee(
        uid, row.employee_name, employeeMap, errors
      );
      if (!employeeId) continue;

      // ── 2. Chercher la fiche existante pour cette date ─
      let fiches = [];
      try {
        fiches = await jsonRpc('object', 'execute_kw', [
          config.ODOO_DB, uid, config.ODOO_PASSWORD,
          config.ODOO_MODEL, 'search_read',
          [[[F.DATE, '=', date], [F.EMPLOYEE_NAME, '=', employeeId]]],
          {
            fields: ['id', F.HEURE_ARRIVEE, F.HEURE_DEBUT_PAUSE,
                     F.HEURE_RETOUR_PAUSE, F.HEURE_DEPART,
                     F.OBSERVATION, F.DE_GARDE_HIER],
            limit: 1,
          },
        ]);
      } catch (e) {
        errors.push(`${row.employee_name} (erreur recherche : ${e.message})`);
        continue;
      }

      // ── 3a. Pas de fiche → créer directement ───────────
      if (!fiches.length) {
        try {
          await jsonRpc('object', 'execute_kw', [
            config.ODOO_DB, uid, config.ODOO_PASSWORD,
            config.ODOO_MODEL, 'create',
            [{
              [F.NAME]:              `${row.employee_name} - ${date}`,
              [F.DATE]:              date,
              [F.EMPLOYEE_NAME]:     employeeId,
              [F.HEURE_ARRIVEE]:     toDatetime(date, row.heure_arrivee)      || false,
              [F.HEURE_DEBUT_PAUSE]: toDatetime(date, row.heure_debut_pause)  || false,
              [F.HEURE_RETOUR_PAUSE]:toDatetime(date, row.heure_retour_pause) || false,
              [F.HEURE_DEPART]:      toDatetime(date, row.heure_depart)       || false,
              [F.OBSERVATION]:       row.observation                          || false,
              [F.DE_GARDE_HIER]:     Boolean(row.de_garde_hier),
            }],
            {},
          ]);
          updated++;
          updatesDetail.push({
            employee: row.employee_name,
            champs:   ["✨ Nouvelle fiche créée (n'existait pas pour cette date)"],
          });
        } catch (e) {
          errors.push(`${row.employee_name} (échec création fiche : ${e.message})`);
        }
        continue;
      }

      // ── 3b. Fiche existante → comparer et mettre à jour ─
      const fiche   = fiches[0];
      const ficheId = fiche.id;

      const newValues = {
        [F.HEURE_ARRIVEE]:      toDatetime(date, row.heure_arrivee)      || false,
        [F.HEURE_DEBUT_PAUSE]:  toDatetime(date, row.heure_debut_pause)  || false,
        [F.HEURE_RETOUR_PAUSE]: toDatetime(date, row.heure_retour_pause) || false,
        [F.HEURE_DEPART]:       toDatetime(date, row.heure_depart)       || false,
        [F.OBSERVATION]:        row.observation                          || false,
        [F.DE_GARDE_HIER]:      Boolean(row.de_garde_hier),
      };

      const toWrite    = {};
      const changesLog = [];

      for (const [field, newVal] of Object.entries(newValues)) {
        const oldVal = fiche[field];

        if (field === F.DE_GARDE_HIER) {
          if (Boolean(oldVal) !== Boolean(newVal)) {
            toWrite[field] = newVal;
            changesLog.push(`${LABELS[field]} : ${oldVal ? 'Oui' : 'Non'} → ${newVal ? 'Oui' : 'Non'}`);
          }
          continue;
        }

        const normOld = normalizeTime(oldVal);
        const normNew = normalizeTime(newVal);

        if (normNew !== '' && normNew !== normOld) {
          toWrite[field] = newVal;
          changesLog.push(`${LABELS[field]} : ${normOld || '(vide)'} → ${normNew}`);
        }
      }

      if (Object.keys(toWrite).length === 0) {
        unchanged++;
        continue;
      }

      try {
        await jsonRpc('object', 'execute_kw', [
          config.ODOO_DB, uid, config.ODOO_PASSWORD,
          config.ODOO_MODEL, 'write', [[ficheId], toWrite], {},
        ]);
        updated++;
        updatesDetail.push({ employee: row.employee_name, champs: changesLog });
      } catch (err) {
        errors.push(`${row.employee_name} (${err.message})`);
      }
    }

    return res.json({ success: true, updated, unchanged, notFound, notFoundNames, errors, updatesDetail });

  } catch (err) {
    return res.json({ success: false, message: 'Impossible de contacter Odoo (vérifie identifiants/réseau).' });
  }
});

module.exports = router;
