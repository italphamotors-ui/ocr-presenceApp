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
// UTILITAIRE : poste une note dans le chatter Odoo
// -------------------------------------------------------
async function postChatterMessage(uid, recordId, title, body) {
  try {
    await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB,
      uid,
      config.ODOO_PASSWORD,
      config.ODOO_MODEL,
      'message_post',
      [[recordId]],
      {
        body: `<b>${title}</b><br/><br/>${body}`,
        subtype_xmlid: 'mail.mt_comment',
      },
    ]);
  } catch (e) {
    console.error("Erreur Chatter :", e.message);
  }
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
// UTILITAIRE : normalise datetime Odoo → "HH:MM"
// -------------------------------------------------------
function normalizeTime(val) {
  if (!val || val === false) return '';
  const s = String(val);
  if (s.includes(' ')) return s.split(' ')[1].slice(0, 5);
  return s;
}

// -------------------------------------------------------
// UTILITAIRE : matching approximatif nom OCR ↔ nom Odoo
// "FEZZE William" ↔ "FEZZE TCHEKOULONG William" → match ✅
// -------------------------------------------------------
function fuzzyFindEmployee(nomOcr, employeeMap) {
  const normalize = s => s.trim().toUpperCase()
    .replace(/[-_]/g, ' ')   // tirets → espaces (ALIMATOU-SADIA → ALIMATOU SADIA)
    .replace(/\s+/g, ' ');

  const wordsOcr = normalize(nomOcr).split(' ').filter(w => w.length > 1);

  // 1. Lookup exact (après normalisation tirets)
  const normOcr = normalize(nomOcr);
  for (const [nomOdoo, id] of Object.entries(employeeMap)) {
    if (normalize(nomOdoo) === normOcr) return id;
  }

  // 2. Matching fort : tous les mots d'un côté sont dans l'autre
  for (const [nomOdoo, id] of Object.entries(employeeMap)) {
    const wordsOdoo = normalize(nomOdoo).split(' ').filter(w => w.length > 1);
    const ocrInOdoo = wordsOcr.every(w => wordsOdoo.includes(w));
    const odooInOcr = wordsOdoo.every(w => wordsOcr.includes(w));
    if (ocrInOdoo || odooInOcr) return id;
  }

  // 3. Matching souple : au moins 1 mot significatif en commun (>2 chars)
  //    On prend le meilleur score (le plus de mots en commun)
  let bestMatch = false;
  let bestScore = 0;

  for (const [nomOdoo, id] of Object.entries(employeeMap)) {
    const wordsOdoo = normalize(nomOdoo).split(' ').filter(w => w.length > 2);
    const wordsOcrF = wordsOcr.filter(w => w.length > 2);
    const common    = wordsOcrF.filter(w => wordsOdoo.includes(w));

    if (common.length > 0 && common.length > bestScore) {
      bestScore = common.length;
      bestMatch = id;
    }
  }

  return bestMatch;
}

// -------------------------------------------------------
// UTILITAIRE : charge tous les employés actifs → map nom→id
// -------------------------------------------------------
async function loadEmployeeMap(uid) {
  const allEmployees = await jsonRpc('object', 'execute_kw', [
    config.ODOO_DB, uid, config.ODOO_PASSWORD,
    'hr.employee', 'search_read',
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
// -------------------------------------------------------
async function resolveOrCreateEmployee(uid, nomOcr, employeeMap, errors) {
  let employeeId = fuzzyFindEmployee(nomOcr, employeeMap);
  if (employeeId) return employeeId;

  try {
    employeeId = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB, uid, config.ODOO_PASSWORD,
      'hr.employee', 'create',
      [{ name: nomOcr.trim() }], {},
    ]);
    employeeMap[nomOcr.trim().toUpperCase()] = employeeId;
    return employeeId;
  } catch (e) {
    errors.push(`${nomOcr} (échec création employé : ${e.message})`);
    return false;
  }
}

// -------------------------------------------------------
// GET /api/odoo/employees
// -------------------------------------------------------
router.get('/employees', async (req, res) => {
  try {
    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB, config.ODOO_USER, config.ODOO_PASSWORD,
    ]);
    if (!uid) return res.json({ success: false, message: 'Authentification Odoo refusée.' });

    const employees = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB, uid, config.ODOO_PASSWORD,
      'hr.employee', 'search_read',
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
// Crée la fiche du jour (si inexistante) + les lignes employés
// -------------------------------------------------------
router.post('/save', async (req, res) => {
  const { date, rows } = req.body;

  if (!date || !Array.isArray(rows) || rows.length === 0) {
    return res.json({ success: false, message: 'Données manquantes.' });
  }

  const validRows = rows.filter(r => r.employee_name?.trim());
  if (!validRows.length) {
    return res.json({ success: false, message: 'Aucun employé détecté.' });
  }

  try {
    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB, config.ODOO_USER, config.ODOO_PASSWORD,
    ]);
    if (!uid) return res.json({ success: false, message: 'Authentification Odoo refusée.' });

    const employeeMap = await loadEmployeeMap(uid);
    let created       = 0;
    let skipped       = 0;
    const errors      = [];
    const skippedNames = [];
    // Cache local : employeeId déjà traités dans cette session
    // → évite les doublons quand 2 lignes OCR matchent le même employé Odoo
    const processedEmployeeIds = new Set();

    // ── Recherche ou création de la fiche du jour ───────
    let sheets = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB, uid, config.ODOO_PASSWORD,
      config.ODOO_MODEL, 'search_read',
      [[['x_date_2', '=', date]]],
      { fields: ['id'], limit: 1 },
    ]);

    let sheetId;
    if (!sheets.length) {
      sheetId = await jsonRpc('object', 'execute_kw', [
        config.ODOO_DB, uid, config.ODOO_PASSWORD,
        config.ODOO_MODEL, 'create',
        [{ x_name: `Présence ${date}`, x_date_2: date }], {},
      ]);
    } else {
      sheetId = sheets[0].id;
    }

    // ── Création des lignes employés ────────────────────
    for (const row of validRows) {

      const employeeId = await resolveOrCreateEmployee(
        uid, row.employee_name, employeeMap, errors
      );
      if (!employeeId) continue;

      // Ignorer si cet employé a déjà été traité dans cette session
      if (processedEmployeeIds.has(employeeId)) {
        skipped++;
        skippedNames.push(`${row.employee_name} (même employé déjà traité)`);
        continue;
      }

      // Ignorer si heure d'arrivée absente
      if (!row.heure_arrivee || row.heure_arrivee.trim() === '' || row.heure_arrivee === 'HH:MM') {
        skipped++;
        skippedNames.push(`${row.employee_name} (heure d'arrivée manquante)`);
        continue;
      }

      // Anti-doublon : même fiche + même employé
      const count = await jsonRpc('object', 'execute_kw', [
        config.ODOO_DB, uid, config.ODOO_PASSWORD,
        config.ATTENDANCE_LINE.MODEL, 'search_count',
        [[[config.ATTENDANCE_LINE.SHEET, '=', sheetId], [config.ATTENDANCE_LINE.EMPLOYEE, '=', employeeId]]],
        {},
      ]);

      if (count > 0) {
        skipped++;
        skippedNames.push(row.employee_name);
        processedEmployeeIds.add(employeeId); // marquer même si skippé
        continue;
      }

      try {
        const lineId = await jsonRpc('object', 'execute_kw', [
          config.ODOO_DB, uid, config.ODOO_PASSWORD,
          config.ATTENDANCE_LINE.MODEL, 'create',
          [{
            [ config.ATTENDANCE_LINE.SHEET ]: sheetId,
            [ config.ATTENDANCE_LINE.EMPLOYEE ]:         employeeId,
            [ config.ATTENDANCE_LINE.CHECK_IN ]:            toDatetime(date, row.heure_arrivee) || false,
            [ config.ATTENDANCE_LINE.CHECK_OUT ]:           toDatetime(date, row.heure_depart)  || false,
          }], {},
        ]);
        created++;
        processedEmployeeIds.add(employeeId); // marquer comme traité

        // Notification chatter sur la fiche principale
        const detailCreate = [
          `Employé : <b>${row.employee_name}</b>`,
          row.heure_arrivee    ? `Arrivée : ${row.heure_arrivee}`          : null,
          row.heure_debut_pause  ? `Début pause : ${row.heure_debut_pause}`  : null,
          row.heure_retour_pause ? `Retour pause : ${row.heure_retour_pause}`: null,
          row.heure_depart     ? `Départ : ${row.heure_depart}`            : null,
          row.observation      ? `Observation : ${row.observation}`        : null,
          row.de_garde_hier    ? `De garde hier : Oui`                    : null,
        ].filter(Boolean).join('<br/>');

        await postChatterMessage(uid, sheetId, '📋 Import OCR — Nouvelle ligne', detailCreate);

      } catch (e) {
        errors.push(`${row.employee_name} (${e.message})`);
      }
    }

    return res.json({ success: true, created, skipped, skippedNames, errors });

  } catch (err) {
    return res.json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------
// POST /api/odoo/update
// Met à jour les lignes existantes, crée si manquantes
// -------------------------------------------------------
router.post('/update', async (req, res) => {
  const { date, rows } = req.body;

  if (!date || !Array.isArray(rows) || rows.length === 0) {
    return res.json({ success: false, message: 'Données manquantes.' });
  }

  const validRows = rows.filter(r => r.employee_name?.trim());
  if (!validRows.length) {
    return res.json({ success: false, message: 'Aucun employé détecté.' });
  }

  try {
    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB, config.ODOO_USER, config.ODOO_PASSWORD,
    ]);
    if (!uid) return res.json({ success: false, message: 'Authentification refusée.' });

    const employeeMap = await loadEmployeeMap(uid);
    let updated       = 0;
    let created       = 0;
    let unchanged     = 0;
    const errors      = [];
    const updatesDetail = [];

    // ── Recherche de la fiche du jour ───────────────────
    const sheets = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB, uid, config.ODOO_PASSWORD,
      config.ODOO_MODEL, 'search_read',
      [[['x_date_2', '=', date]]],
      { fields: ['id'], limit: 1 },
    ]);

    let sheetId;
    if (!sheets.length) {
      // Crée la fiche si elle n'existe pas encore
      sheetId = await jsonRpc('object', 'execute_kw', [
        config.ODOO_DB, uid, config.ODOO_PASSWORD,
        config.ODOO_MODEL, 'create',
        [{ x_name: `Présence ${date}`, x_date_2: date }], {},
      ]);
    } else {
      sheetId = sheets[0].id;
    }

    // ── Parcours des employés ───────────────────────────
    for (const row of validRows) {

      const employeeId = await resolveOrCreateEmployee(
        uid, row.employee_name, employeeMap, errors
      );
      if (!employeeId) continue;

      // Ignorer si cet employé a déjà été traité dans cette session
      if (processedEmployeeIds.has(employeeId)) {
        skipped++;
        skippedNames.push(`${row.employee_name} (même employé déjà traité)`);
        continue;
      }

      // Ignorer si heure d'arrivée absente
      if (!row.heure_arrivee || row.heure_arrivee.trim() === '' || row.heure_arrivee === 'HH:MM') {
        continue;
      }

      // Recherche de la ligne existante
      const lines = await jsonRpc('object', 'execute_kw', [
        config.ODOO_DB, uid, config.ODOO_PASSWORD,
        config.ATTENDANCE_LINE.MODEL, 'search_read',
        [[[config.ATTENDANCE_LINE.SHEET, '=', sheetId], [config.ATTENDANCE_LINE.EMPLOYEE, '=', employeeId]]],
        { fields: ['id', config.ATTENDANCE_LINE.CHECK_IN, config.ATTENDANCE_LINE.CHECK_OUT], limit: 1 },
      ]);

      // ── Pas de ligne → créer ────────────────────────
      if (!lines.length) {
        try {
          await jsonRpc('object', 'execute_kw', [
            config.ODOO_DB, uid, config.ODOO_PASSWORD,
            config.ATTENDANCE_LINE.MODEL, 'create',
            [{
              [ config.ATTENDANCE_LINE.SHEET ]: sheetId,
              [ config.ATTENDANCE_LINE.EMPLOYEE ]:         employeeId,
              [ config.ATTENDANCE_LINE.CHECK_IN ]:            toDatetime(date, row.heure_arrivee) || false,
              [ config.ATTENDANCE_LINE.CHECK_OUT ]:           toDatetime(date, row.heure_depart)  || false,
            }], {},
          ]);
          created++;
          updatesDetail.push({
            employee: row.employee_name,
            champs:   ["✨ Nouvelle ligne créée"],
          });

          await postChatterMessage(
            uid, sheetId,
            '✨ Import OCR — Nouvelle ligne (synchronisation)',
            `Employé : <b>${row.employee_name}</b><br/>`
            + (row.heure_arrivee ? `Arrivée : ${row.heure_arrivee}<br/>` : '')
            + (row.heure_depart  ? `Départ : ${row.heure_depart}`        : '')
          );
        } catch (e) {
          errors.push(`${row.employee_name} (${e.message})`);
        }
        continue;
      }

      // ── Ligne trouvée → comparer champ par champ ────
      const line        = lines[0];
      const values      = {};
      const changesLog  = [];

      const newCheckIn  = toDatetime(date, row.heure_arrivee) || false;
      const newCheckOut = toDatetime(date, row.heure_depart)  || false;

      const oldIn  = normalizeTime(line[config.ATTENDANCE_LINE.CHECK_IN]);
      const newIn  = normalizeTime(newCheckIn);
      const oldOut = normalizeTime(line[config.ATTENDANCE_LINE.CHECK_OUT]);
      const newOut = normalizeTime(newCheckOut);

      if (newIn && newIn !== oldIn) {
        values[config.ATTENDANCE_LINE.CHECK_IN] = newCheckIn;
        changesLog.push(`Arrivée : ${oldIn || '(vide)'} → ${newIn}`);
      }
      if (newOut && newOut !== oldOut) {
        values[config.ATTENDANCE_LINE.CHECK_OUT] = newCheckOut;
        changesLog.push(`Départ : ${oldOut || '(vide)'} → ${newOut}`);
      }

      if (Object.keys(values).length === 0) {
        unchanged++;
        continue;
      }

      // ── Mise à jour ─────────────────────────────────
      try {
        await jsonRpc('object', 'execute_kw', [
          config.ODOO_DB, uid, config.ODOO_PASSWORD,
          config.ATTENDANCE_LINE.MODEL, 'write',
          [[line.id], values], {},
        ]);
        updated++;
        updatesDetail.push({ employee: row.employee_name, champs: changesLog });

        // ✅ Correction bug : on utilise sheetId (fiche principale) pas ficheId
        await postChatterMessage(
          uid, sheetId,
          '🔄 Mise à jour OCR',
          `Employé : <b>${row.employee_name}</b><br/>${changesLog.join('<br/>')}`
        );
      } catch (e) {
        errors.push(`${row.employee_name} (${e.message})`);
      }
    }

    return res.json({ success: true, updated, created, unchanged, errors, updatesDetail });

  } catch (err) {
    return res.json({ success: false, message: err.message });
  }
});

module.exports = router;
