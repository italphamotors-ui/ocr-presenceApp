const express = require('express');
const axios = require('axios');
const config = require('../config');

const router = express.Router();

/* =====================================================
                    JSON RPC
===================================================== */

async function jsonRpc(service, method, args) {

    const response = await axios.post(
        config.ODOO_JSONRPC_URL,
        {
            jsonrpc: "2.0",
            method: "call",
            params: {
                service,
                method,
                args
            },
            id: Date.now()
        },
        {
            headers: {
                "Content-Type": "application/json"
            },
            timeout: 30000
        }
    );

    if (response.data.error) {
        throw new Error(JSON.stringify(response.data.error));
    }

    return response.data.result;

}

/* =====================================================
                    LOGIN
===================================================== */

async function login() {

    return await jsonRpc(
        "common",
        "login",
        [
            config.ODOO_DB,
            config.ODOO_USER,
            config.ODOO_PASSWORD
        ]
    );

}

/* =====================================================
              DATE + HEURE -> DATETIME
===================================================== */

function toDatetime(date, heure) {

    if (!heure) return false;

    const match = heure.trim().match(/^(\d{1,2})[hH:](\d{2})$/);

    if (!match) return false;

    const h = match[1].padStart(2, "0");

    const m = match[2];

    return `${date} ${h}:${m}:00`;

}

/* =====================================================
            MATCH APPROXIMATIF EMPLOYE
===================================================== */

function fuzzyFindEmployee(name, map) {

    const upper = name.trim().toUpperCase();

    if (map[upper]) {
        return map[upper];
    }

    const wordsOCR = upper
        .split(/\s+/)
        .filter(w => w.length > 1);

    for (const [employeeName, id] of Object.entries(map)) {

        const wordsOdoo = employeeName
            .split(/\s+/)
            .filter(w => w.length > 1);

        const a = wordsOCR.every(w => wordsOdoo.includes(w));

        const b = wordsOdoo.every(w => wordsOCR.includes(w));

        if (a || b) {
            return id;
        }

    }

    return false;

}

/* =====================================================
             CHARGE LES EMPLOYES
===================================================== */

async function loadEmployeeMap(uid) {

    const employees = await jsonRpc(
        "object",
        "execute_kw",
        [
            config.ODOO_DB,
            uid,
            config.ODOO_PASSWORD,

            "hr.employee",

            "search_read",

            [
                [
                    ["active", "=", true]
                ]
            ],

            {
                fields: [
                    "id",
                    "name"
                ],
                limit: 1000
            }

        ]
    );

    const map = {};

    for (const employee of employees) {

        map[
            employee.name
                .trim()
                .toUpperCase()
        ] = employee.id;

    }

    return map;

}

/* =====================================================
         CHERCHE OU CREE EMPLOYE
===================================================== */

async function resolveOrCreateEmployee(uid, employeeName, employeeMap, errors) {

    let employeeId = fuzzyFindEmployee(employeeName, employeeMap);

    if (employeeId) {
        return employeeId;
    }

    try {

        employeeId = await jsonRpc(
            "object",
            "execute_kw",
            [

                config.ODOO_DB,
                uid,
                config.ODOO_PASSWORD,

                "hr.employee",

                "create",

                [
                    {
                        name: employeeName.trim()
                    }
                ]

            ]
        );

        employeeMap[
            employeeName
                .trim()
                .toUpperCase()
        ] = employeeId;

        return employeeId;

    }
    catch (e) {

        errors.push(
            employeeName +
            " : " +
            e.message
        );

        return false;

    }

}
/* =====================================================
                GET /employees
===================================================== */

router.get('/employees', async (req, res) => {

    try {

        const uid = await login();

        if (!uid) {
            return res.json({
                success: false,
                message: "Authentification Odoo refusée."
            });
        }

        const employees = await jsonRpc(
            "object",
            "execute_kw",
            [
                config.ODOO_DB,
                uid,
                config.ODOO_PASSWORD,

                "hr.employee",

                "search_read",

                [
                    [
                        ["active", "=", true]
                    ]
                ],

                {
                    fields: [
                        "id",
                        "name"
                    ],
                    order: "name asc",
                    limit: 1000
                }
            ]
        );

        return res.json({
            success: true,
            employees
        });

    }
    catch (e) {

        return res.json({
            success: false,
            message: e.message
        });

    }

});


/* =====================================================
                GET /fields
===================================================== */

router.get('/fields', async (req, res) => {

    try {

        const uid = await login();

        const fields = await jsonRpc(
            "object",
            "execute_kw",
            [
                config.ODOO_DB,
                uid,
                config.ODOO_PASSWORD,

                config.ODOO_MODEL,

                "fields_get",

                [],

                {
                    attributes: [
                        "string",
                        "type",
                        "relation"
                    ]
                }

            ]
        );

        return res.json(fields);

    }
    catch (e) {

        return res.json({

            success: false,

            message: e.message

        });

    }

});
/* =====================================================
                    POST /save
===================================================== */

router.post('/save', async (req, res) => {

    const { date, rows } = req.body;

    if (!date || !Array.isArray(rows) || rows.length === 0) {

        return res.json({
            success: false,
            message: "Données manquantes."
        });

    }

    const validRows = rows.filter(r =>
        r.employee_name &&
        r.employee_name.trim() !== ""
    );

    if (!validRows.length) {

        return res.json({
            success: false,
            message: "Aucun employé détecté."
        });

    }

    try {

        const uid = await login();

        if (!uid) {

            return res.json({
                success: false,
                message: "Authentification refusée."
            });

        }

        const employeeMap = await loadEmployeeMap(uid);

        let created = 0;
        let updated = 0;

        const errors = [];

        //--------------------------------------------------
        // Recherche fiche du jour
        //--------------------------------------------------

        let attendance = await jsonRpc(
            "object",
            "execute_kw",
            [

                config.ODOO_DB,
                uid,
                config.ODOO_PASSWORD,

                "x_manual.attendance",

                "search_read",

                [
                    [
                        [config.FIELDS.DATE, "=", date]
                    ]
                ],

                {
                    fields: [
                        "id"
                    ],
                    limit: 1
                }

            ]
        );

        //--------------------------------------------------
        // Création si absente
        //--------------------------------------------------

        let attendanceId;

        if (attendance.length) {

            attendanceId = attendance[0].id;

        }
        else {

            attendanceId = await jsonRpc(
                "object",
                "execute_kw",
                [

                    config.ODOO_DB,
                    uid,
                    config.ODOO_PASSWORD,

                    "x_manual.attendance",

                    "create",

                    [
                        {
                            [config.FIELDS.DATE]: date
                        }
                    ]

                ]
            );

        }

        //--------------------------------------------------
        // Parcours OCR
        //--------------------------------------------------

        for (const row of validRows) {

            //--------------------------------------------------
            // Employé
            //--------------------------------------------------

            const employeeId =
                await resolveOrCreateEmployee(
                    uid,
                    row.employee_name,
                    employeeMap,
                    errors
                );

            if (!employeeId)
                continue;

            //--------------------------------------------------
            // Vérifie si ligne existe
            //--------------------------------------------------

            const line = await jsonRpc(
                "object",
                "execute_kw",
                [

                    config.ODOO_DB,
                    uid,
                    config.ODOO_PASSWORD,

                    "x_manual.attendance.line",

                    "search_read",

                    [
                        [

                            ["x_attendance_id", "=", attendanceId],

                            ["x_employee_id", "=", employeeId]

                        ]
                    ],

                    {

                        fields: [
                            "id"
                        ],

                        limit: 1

                    }

                ]
            );

            //--------------------------------------------------
            // Valeurs
            //--------------------------------------------------

            const values = {

                x_attendance_id: attendanceId,

                x_employee_id: employeeId,

                x_check_in:
                    toDatetime(
                        date,
                        row.heure_arrivee
                    ) || false,

                x_check_out:
                    toDatetime(
                        date,
                        row.heure_depart
                    ) || false

            };

            //--------------------------------------------------
            // Mise à jour
            //--------------------------------------------------

            if (line.length) {

                await jsonRpc(
                    "object",
                    "execute_kw",
                    [

                        config.ODOO_DB,
                        uid,
                        config.ODOO_PASSWORD,

                        "x_manual.attendance.line",

                        "write",

                        [

                            [line[0].id],

                            values

                        ]

                    ]
                );

                updated++;

            }

            //--------------------------------------------------
            // Création
            //--------------------------------------------------

            else {

                await jsonRpc(
                    "object",
                    "execute_kw",
                    [

                        config.ODOO_DB,
                        uid,
                        config.ODOO_PASSWORD,

                        "x_manual.attendance.line",

                        "create",

                        [

                            values

                        ]

                    ]
                );

                created++;

            }

        }

        return res.json({

            success: true,

            created,

            updated,

            errors

        });

    }

    catch (e) {

        return res.json({

            success: false,

            message: e.message

        });

    }

});
/* =====================================================
                    POST /update
===================================================== */

router.post('/update', async (req, res) => {

    const { date, rows } = req.body;

    if (!date || !Array.isArray(rows) || rows.length === 0) {

        return res.json({
            success: false,
            message: "Données manquantes."
        });

    }

    const validRows = rows.filter(r =>
        r.employee_name &&
        r.employee_name.trim() !== ""
    );

    if (!validRows.length) {

        return res.json({
            success: false,
            message: "Aucun employé."
        });

    }

    try {

        const uid = await login();

        const employeeMap = await loadEmployeeMap(uid);

        //--------------------------------------------------
        // Recherche fiche du jour
        //--------------------------------------------------

        const attendance = await jsonRpc(
            "object",
            "execute_kw",
            [

                config.ODOO_DB,
                uid,
                config.ODOO_PASSWORD,

                "x_manual.attendance",

                "search_read",

                [
                    [
                        [config.FIELDS.DATE, "=", date]
                    ]
                ],

                {
                    fields: ["id"],
                    limit: 1
                }

            ]
        );

        if (!attendance.length) {

            return res.json({

                success: false,

                message:
                    "Aucune fiche de présence pour cette date."

            });

        }

        const attendanceId = attendance[0].id;

        let updated = 0;
        let created = 0;

        const errors = [];

        //--------------------------------------------------
        // Parcours OCR
        //--------------------------------------------------

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

            //--------------------------------------------------
            // Recherche ligne
            //--------------------------------------------------

            const line = await jsonRpc(
                "object",
                "execute_kw",
                [

                    config.ODOO_DB,
                    uid,
                    config.ODOO_PASSWORD,

                    "x_manual.attendance.line",

                    "search_read",

                    [
                        [

                            ["x_attendance_id","=",attendanceId],

                            ["x_employee_id","=",employeeId]

                        ]
                    ],

                    {

                        fields:[
                            "id",
                            "x_check_in",
                            "x_check_out"
                        ],

                        limit:1

                    }

                ]
            );

            const values = {

                x_attendance_id:attendanceId,

                x_employee_id:employeeId,

                x_check_in:
                    toDatetime(
                        date,
                        row.heure_arrivee
                    ) || false,

                x_check_out:
                    toDatetime(
                        date,
                        row.heure_depart
                    ) || false

            };

            //--------------------------------------------------
            // Création
            //--------------------------------------------------

            if (!line.length) {

                await jsonRpc(
                    "object",
                    "execute_kw",
                    [

                        config.ODOO_DB,
                        uid,
                        config.ODOO_PASSWORD,

                        "x_manual.attendance.line",

                        "create",

                        [
                            values
                        ]

                    ]
                );

                created++;

                continue;

            }

            //--------------------------------------------------
            // Comparaison
            //--------------------------------------------------

            const old = line[0];

            const toWrite = {};

            if (
                old.x_check_in !== values.x_check_in
            ) {

                toWrite.x_check_in =
                    values.x_check_in;

            }

            if (
                old.x_check_out !== values.x_check_out
            ) {

                toWrite.x_check_out =
                    values.x_check_out;

            }

            if (
                Object.keys(toWrite).length
            ) {

                await jsonRpc(
                    "object",
                    "execute_kw",
                    [

                        config.ODOO_DB,
                        uid,
                        config.ODOO_PASSWORD,

                        "x_manual.attendance.line",

                        "write",

                        [

                            [old.id],

                            toWrite

                        ]

                    ]
                );

                updated++;

            }

        }

        return res.json({

            success:true,

            updated,

            created,

            errors

        });

    }

    catch(e){

        return res.json({

            success:false,

            message:e.message

        });

    }

});
/* =====================================================
            OUTILS DE COMPARAISON
===================================================== */

// Transforme
// "2026-07-07 08:30:00"
// en
// "08:30"

function normalizeTime(value) {

    if (!value)
        return "";

    const str = String(value);

    if (str.includes(" ")) {
        return str.split(" ")[1].substring(0,5);
    }

    return str;

}


/* =====================================================
        RECHERCHE LA FICHE JOURNALIERE
===================================================== */

async function getAttendance(uid, date){

    const attendance = await jsonRpc(
        "object",
        "execute_kw",
        [

            config.ODOO_DB,
            uid,
            config.ODOO_PASSWORD,

            "x_manual.attendance",

            "search_read",

            [
                [
                    [config.FIELDS.DATE,"=",date]
                ]
            ],

            {
                fields:["id"],
                limit:1
            }

        ]
    );

    if(attendance.length){
        return attendance[0];
    }

    return null;

}


/* =====================================================
        CREE LA FICHE JOURNALIERE
===================================================== */

async function createAttendance(uid,date){

    return await jsonRpc(
        "object",
        "execute_kw",
        [

            config.ODOO_DB,
            uid,
            config.ODOO_PASSWORD,

            "x_manual.attendance",

            "create",

            [
                {
                    [config.FIELDS.DATE]:date
                }
            ]

        ]
    );

}


/* =====================================================
        CHARGE TOUTES LES LIGNES
===================================================== */

async function loadAttendanceLines(uid,attendanceId){

    return await jsonRpc(
        "object",
        "execute_kw",
        [

            config.ODOO_DB,
            uid,
            config.ODOO_PASSWORD,

            "x_manual.attendance.line",

            "search_read",

            [
                [
                    ["x_attendance_id","=",attendanceId]
                ]
            ],

            {
                fields:[
                    "id",
                    "x_employee_id",
                    "x_check_in",
                    "x_check_out"
                ]
            }

        ]
    );

}


/* =====================================================
      CONSTRUIT UNE MAP employee -> line
===================================================== */

function buildAttendanceMap(lines){

    const map = {};

    for(const line of lines){

        if(!line.x_employee_id)
            continue;

        map[line.x_employee_id[0]] = line;

    }

    return map;

}


/* =====================================================
      DETAIL DES MODIFICATIONS
===================================================== */

function buildChanges(oldLine,newValues){

    const changes=[];

    const oldIn =
        normalizeTime(oldLine.x_check_in);

    const newIn =
        normalizeTime(newValues.x_check_in);

    if(oldIn!==newIn){

        changes.push(
            `Check In : ${oldIn||"(vide)"} → ${newIn}`
        );

    }

    const oldOut =
        normalizeTime(oldLine.x_check_out);

    const newOut =
        normalizeTime(newValues.x_check_out);

    if(oldOut!==newOut){

        changes.push(
            `Check Out : ${oldOut||"(vide)"} → ${newOut}`
        );

    }

    return changes;

}
