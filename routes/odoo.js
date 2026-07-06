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
  const { date, rows } = req.body;

  if (!date || !Array.isArray(rows) || rows.length === 0) {
    return res.json({
      success: false,
      message: "Données manquantes."
    });
  }

  const validRows = rows.filter(r => r.employee_name?.trim());

  if (!validRows.length) {
    return res.json({
      success: false,
      message: "Aucun employé détecté."
    });
  }

  try {

    const uid = await jsonRpc('common', 'login', [
      config.ODOO_DB,
      config.ODOO_USER,
      config.ODOO_PASSWORD
    ]);

    if (!uid) {
      return res.json({
        success: false,
        message: "Authentification Odoo refusée."
      });
    }

    const employeeMap = await loadEmployeeMap(uid);

    let created = 0;
    const errors = [];

    //-------------------------------------------------------
    // Recherche de la fiche du jour
    //-------------------------------------------------------

    let sheets = await jsonRpc('object', 'execute_kw', [
      config.ODOO_DB,
      uid,
      config.ODOO_PASSWORD,
      config.ODOO_MODEL,
      'search_read',
      [
        [
          ['x_date_2', '=', date]
        ]
      ],
      {
        fields: ['id'],
        limit: 1
      }
    ]);

    let sheetId;

    //-------------------------------------------------------
    // Si elle n'existe pas → création
    //-------------------------------------------------------

    if (!sheets.length) {

      sheetId = await jsonRpc('object', 'execute_kw', [
        config.ODOO_DB,
        uid,
        config.ODOO_PASSWORD,
        config.ODOO_MODEL,
        'create',
        [
          {
            x_name: `Présence ${date}`,
            x_date_2: date
          }
        ],
        {}
      ]);

    } else {

      sheetId = sheets[0].id;

    }

    //-------------------------------------------------------
    // Création des lignes
    //-------------------------------------------------------

    for (const row of validRows) {

      const employeeId = await resolveOrCreateEmployee(
        uid,
        row.employee_name,
        employeeMap,
        errors
      );

      if (!employeeId)
        continue;

      //---------------------------------------------------
      // Anti doublon
      //---------------------------------------------------

      const count = await jsonRpc('object', 'execute_kw', [
        config.ODOO_DB,
        uid,
        config.ODOO_PASSWORD,
        'x_manual_attendance_line',
        'search_count',
        [
          [
            ['x_attendance_sheet_id', '=', sheetId],
            ['x_employee_id', '=', employeeId]
          ]
        ],
        {}
      ]);

      if (count)
        continue;

      //---------------------------------------------------
      // Création ligne
      //---------------------------------------------------

      try {

        await jsonRpc('object', 'execute_kw', [
          config.ODOO_DB,
          uid,
          config.ODOO_PASSWORD,
          'x_manual_attendance_line',
          'create',
          [
            {
              x_attendance_sheet_id: sheetId,
              x_employee_id: employeeId,
              x_check_in: toDatetime(date, row.heure_arrivee) || false,
              x_check_out: toDatetime(date, row.heure_depart) || false
            }
          ],
          {}
        ]);

        created++;

      } catch (e) {

        errors.push(`${row.employee_name} (${e.message})`);

      }

    }

    return res.json({
      success: true,
      created,
      errors
    });

  } catch (err) {

    return res.json({
      success: false,
      message: err.message
    });

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
        return res.json({
            success: false,
            message: 'Données manquantes.'
        });
    }

    const validRows = rows.filter(
        r => r.employee_name && r.employee_name.trim() !== ''
    );

    if (!validRows.length) {
        return res.json({
            success: false,
            message: "Aucun employé détecté."
        });
    }

    try {

        //----------------------------------------------------
        // Connexion Odoo
        //----------------------------------------------------

        const uid = await jsonRpc('common', 'login', [
            config.ODOO_DB,
            config.ODOO_USER,
            config.ODOO_PASSWORD
        ]);

        if (!uid) {
            return res.json({
                success: false,
                message: 'Authentification refusée.'
            });
        }

        const employeeMap = await loadEmployeeMap(uid);

        let updated = 0;
        let created = 0;

        const errors = [];

        //----------------------------------------------------
        // Recherche de la fiche du jour
        //----------------------------------------------------

        const sheets = await jsonRpc(
            'object',
            'execute_kw',
            [
                config.ODOO_DB,
                uid,
                config.ODOO_PASSWORD,
                config.ODOO_MODEL,
                'search_read',
                [
                    [
                        ['x_date_2', '=', date]
                    ]
                ],
                {
                    fields: ['id'],
                    limit: 1
                }
            ]
        );

        if (!sheets.length) {

            return res.json({
                success: false,
                message: "Aucune fiche de présence n'existe pour cette date. Lance d'abord le premier scan."
            });

        }

        const sheetId = sheets[0].id;

        //----------------------------------------------------
        // Parcours des employés
        //----------------------------------------------------

        for (const row of validRows) {

            const employeeId =
                await resolveOrCreateEmployee(
                    uid,
                    row.employee_name,
                    employeeMap,
                    errors
                );

            if (!employeeId)
                continue;
                      //----------------------------------------------------
            // Recherche de la ligne de présence
            //----------------------------------------------------

            const lines = await jsonRpc(
                'object',
                'execute_kw',
                [
                    config.ODOO_DB,
                    uid,
                    config.ODOO_PASSWORD,
                    'x_manual_attendance_line',
                    'search_read',
                    [
                        [
                            ['x_attendance_sheet_id', '=', sheetId],
                            ['x_employee_id', '=', employeeId]
                        ]
                    ],
                    {
                        fields: [
                            'id',
                            'x_check_in',
                            'x_check_out'
                        ],
                        limit: 1
                    }
                ]
            );

            //----------------------------------------------------
            // Si aucune ligne → création
            //----------------------------------------------------

            if (!lines.length) {

                try {

                    await jsonRpc(
                        'object',
                        'execute_kw',
                        [
                            config.ODOO_DB,
                            uid,
                            config.ODOO_PASSWORD,
                            'x_manual_attendance_line',
                            'create',
                            [
                                {
                                    x_attendance_sheet_id: sheetId,
                                    x_employee_id: employeeId,
                                    x_check_in:
                                        toDatetime(date, row.heure_arrivee) || false,
                                    x_check_out:
                                        toDatetime(date, row.heure_depart) || false
                                }
                            ],
                            {}
                        ]
                    );

                    created++;

                } catch (e) {

                    errors.push(
                        `${row.employee_name} (${e.message})`
                    );

                }

                continue;

            }

            //----------------------------------------------------
            // Ligne trouvée → comparaison
            //----------------------------------------------------

            const line = lines[0];

            const values = {};

            const newCheckIn =
                toDatetime(date, row.heure_arrivee) || false;

            const newCheckOut =
                toDatetime(date, row.heure_depart) || false;

            if (newCheckIn && newCheckIn !== line.x_check_in) {
                values.x_check_in = newCheckIn;
            }

            if (newCheckOut && newCheckOut !== line.x_check_out) {
                values.x_check_out = newCheckOut;
            }

            if (Object.keys(values).length === 0) {
                continue;
            }
                      //----------------------------------------------------
            // Mise à jour de la ligne
            //----------------------------------------------------

            try {

                await jsonRpc(
                    'object',
                    'execute_kw',
                    [
                        config.ODOO_DB,
                        uid,
                        config.ODOO_PASSWORD,
                        'x_manual_attendance_line',
                        'write',
                        [
                            [line.id],
                            values
                        ],
                        {}
                    ]
                );

                updated++;

            } catch (e) {

                errors.push(
                    `${row.employee_name} (${e.message})`
                );

            }

        }

        //----------------------------------------------------
        // Réponse
        //----------------------------------------------------

        return res.json({
            success: true,
            updated,
            created,
            errors
        });

    } catch (err) {

        return res.json({
            success: false,
            message: err.message
        });

    }

});

module.exports = router;
