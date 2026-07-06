const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '..', 'tmp_uploads'),
  limits: { fileSize: config.MAX_UPLOAD_SIZE },
});

const MIME_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', pdf: 'application/pdf',
};

function logOcr(msg) {
  const line = `${new Date().toISOString()} | ${msg}\n`;
  fs.appendFile(path.join(__dirname, '..', 'ocr_debug.log'), line, () => {});
}

// -------------------------------------------------------
// CONSTRUCTION DU PROMPT DE STRUCTURATION
// Reçoit la liste des employés Odoo pour coupler nom ↔ ID
// -------------------------------------------------------
function buildStructurePrompt(employeeList) {
  const hasEmployees = Array.isArray(employeeList) && employeeList.length > 0;

  const employeeSection = hasEmployees
    ? `Tu disposes de la liste officielle des employés Odoo ci-dessous.
Pour chaque ligne de la fiche, associe le nom détecté à l'employé le plus proche
de cette liste et renseigne son "employee_id" (entier).
Si aucun employé ne correspond, mets employee_id à null.

Liste des employés Odoo :
${employeeList.map(e => `- ID ${e.id} : ${e.name}`).join('\n')}
`
    : `Aucune liste d'employés disponible : laisse employee_id à null pour toutes les lignes.
`;

  return `Voici le texte brut extrait d'une fiche de présence (issu d'un OCR).
${employeeSection}
Analyse le texte et retourne UNIQUEMENT un objet JSON valide (sans aucun texte
autour, sans balises markdown) avec cette structure exacte :
{
  "date": "YYYY-MM-DD",
  "rows": [{
    "employee_id": 42,
    "employee_name": "...",
    "heure_arrivee": "HH:MM",
    "heure_debut_pause": "HH:MM",
    "heure_retour_pause": "HH:MM",
    "heure_depart": "HH:MM",
    "observation": "...",
    "de_garde_hier": false
  }]
}

Règles :
- "date" : extrais la date en haut du document (ex: "18/03/2026" → "2026-03-18"). Si absente, mets null.
- Respecte le format HH:MM pour toutes les heures.
- Si une heure n'est pas renseignée, retourne null (pas une chaîne vide).
- "de_garde_hier" est un booléen.
- "employee_id" est un entier (ID Odoo) ou null.
- Ne retourne RIEN d'autre que cet objet JSON.

Texte extrait :
`;
}

// -------------------------------------------------------
// ROUTE POST /api/ocr
// -------------------------------------------------------
router.post('/', upload.single('document'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.json({ success: false, error: 'Aucun fichier reçu.' });
  }

  const ext = path.extname(file.originalname).slice(1).toLowerCase();

  if (!config.ALLOWED_EXTENSIONS.includes(ext)) {
    fs.unlink(file.path, () => {});
    return res.json({ success: false, error: 'Format de fichier non autorisé.' });
  }

  // Lecture de la liste des employés envoyée par le frontend (peut être absente)
  let employeeList = [];
  try {
    employeeList = JSON.parse(req.body.employees || '[]');
  } catch (e) {
    logOcr(`Avertissement : impossible de parser employees — ${e.message}`);
  }

  logOcr(`Employés reçus : ${employeeList.length}`);

  try {
    const fileBuffer = fs.readFileSync(file.path);
    const base64 = fileBuffer.toString('base64');
    const mime = MIME_TYPES[ext];
    const dataUrl = `data:${mime};base64,${base64}`;

    // --- ÉTAPE 1 : extraction du texte brut via l'endpoint OCR dédié ---
    const isPdf = ext === 'pdf';
    const documentPayload = isPdf
      ? { type: 'document_url', document_url: dataUrl }
      : { type: 'image_url', image_url: dataUrl };

    const ocrResponse = await axios.post(
      'https://api.mistral.ai/v1/ocr',
      { model: 'mistral-ocr-latest', document: documentPayload },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.MISTRAL_API_KEY}`,
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );

    logOcr(`OCR HTTP ${ocrResponse.status} | ${JSON.stringify(ocrResponse.data).slice(0, 1000)}`);

    if (ocrResponse.status === 401) {
      return res.json({ success: false, error: 'Clé API Mistral invalide.' });
    }
    if (ocrResponse.status !== 200) {
      return res.json({ success: false, error: `Erreur du service OCR (code ${ocrResponse.status}).` });
    }

    const pages = ocrResponse.data?.pages || [];
    const rawText = pages.map(p => p.markdown || '').join('\n\n');

    if (!rawText.trim()) {
      return res.json({ success: false, error: 'Aucun texte détecté dans le document.' });
    }

    // --- ÉTAPE 2 : structuration en JSON via chat completions ---
    // Le prompt est construit dynamiquement avec la liste des employés
    const structurePrompt = buildStructurePrompt(employeeList);

    const chatResponse = await axios.post(
      config.MISTRAL_API_URL,
      {
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: structurePrompt + rawText }],
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.MISTRAL_API_KEY}`,
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    );

    logOcr(`Chat HTTP ${chatResponse.status} | ${JSON.stringify(chatResponse.data).slice(0, 1500)}`);

    if (chatResponse.status !== 200) {
      return res.json({ success: false, error: `Erreur de structuration (code ${chatResponse.status}).` });
    }

    const content = chatResponse.data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content);

    if (parsed === null) {
      logOcr(`Échec extraction JSON depuis : ${content}`);
      return res.json({ success: false, error: 'Format de réponse OCR inattendu.' });
    }

    logOcr(`Date détectée : ${parsed.date || 'aucune'} | ${parsed.rows.length} ligne(s)`);
    return res.json({ success: true, rows: parsed.rows, detected_date: parsed.date });

  } catch (err) {
    logOcr(`Erreur réseau : ${err.message}`);
    return res.json({ success: false, error: 'Impossible de contacter le service OCR (réseau).' });
  } finally {
    fs.unlink(file.path, () => {});
  }
});

// -------------------------------------------------------
// UTILITAIRE : extraction de l'objet JSON depuis la réponse Mistral
// Retourne { date, rows } ou null en cas d'échec
// -------------------------------------------------------
function extractJsonObject(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();

  // Tentative 1 : objet { date, rows }
  const objStart = cleaned.indexOf('{');
  const objEnd   = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1));
      if (parsed && Array.isArray(parsed.rows)) {
        return { date: parsed.date || null, rows: parsed.rows };
      }
    } catch (e) { /* on essaie le fallback */ }
  }

  // Tentative 2 : tableau brut (ancien format, rétrocompatibilité)
  const arrStart = cleaned.indexOf('[');
  const arrEnd   = cleaned.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed)) {
        return { date: null, rows: parsed };
      }
    } catch (e) { /* échec total */ }
  }

  return null;
}

module.exports = router;
