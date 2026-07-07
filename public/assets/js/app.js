// === Orchestration générale de l'application ===
// selectedFile est déclaré dans upload.js — ne pas re-déclarer ici

// -------------------------------------------------------
// LISTE DES EMPLOYÉS ODOO (chargée une fois au démarrage)
// -------------------------------------------------------
let employeeList = [];

async function loadEmployees() {
  try {
    const res = await fetch('/api/odoo/employees');

    if (res.status === 401) {
      console.warn('Session expirée, redirection vers le login.');
      window.location.href = '/login';
      return;
    }

    const data = await res.json();

    if (data.success && Array.isArray(data.employees)) {
      employeeList = data.employees;
      console.log(`✅ ${employeeList.length} employé(s) chargé(s) depuis Odoo.`);
    } else {
      console.warn('Impossible de charger les employés Odoo :', data.message || 'réponse inattendue');
    }
  } catch (err) {
    console.warn('Erreur réseau lors du chargement des employés :', err.message);
  }
}

// -------------------------------------------------------
// PRÉVISUALISATION DU DOCUMENT
// -------------------------------------------------------
function showDocumentPreview(file) {
  const documentPreview = document.getElementById('documentPreview');
  documentPreview.innerHTML = '';
  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    documentPreview.appendChild(img);
  } else {
    const iframe = document.createElement('iframe');
    iframe.src = URL.createObjectURL(file);
    documentPreview.appendChild(iframe);
  }
}

// -------------------------------------------------------
// SYNCHRONISATION ODOO — bouton unique
// Logique : tente de créer d'abord, puis met à jour
// automatiquement les lignes déjà existantes (doublons).
// Affiche un message détaillé pour chaque cas.
// -------------------------------------------------------
async function syncAttendanceToOdoo() {
  const date       = document.getElementById('fiche_date').value;
  const saveResult = document.getElementById('saveResult');

  if (!date) {
    alert("Merci de renseigner la date de la fiche.");
    return;
  }

  // Garde-fou : confirmation si date = aujourd'hui
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) {
    const ok = confirm(
      `La date saisie est celle d'aujourd'hui (${date}).\n` +
      `Si la fiche scannée concerne une autre date, annulez et corrigez le champ "Date de la fiche".\n\n` +
      `Continuer avec la date du jour ?`
    );
    if (!ok) return;
  }

  const rows = readTableData().filter(r => r.employee_name && r.employee_name.trim() !== '');
  if (rows.length === 0) {
    alert("Aucune ligne avec un nom d'employé à enregistrer.");
    return;
  }

  const btnSync       = document.getElementById('btnSync');
  btnSync.disabled    = true;
  btnSync.textContent = "⏳ Synchronisation en cours...";
  saveResult.classList.add('d-none');

  try {
    // ── Étape 1 : créer les nouvelles fiches (/save) ───
    const resSave = await fetch('/api/odoo/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ date, rows }),
    });
    const dataSave = await resSave.json();

    saveResult.classList.remove('d-none', 'alert-danger', 'alert-success', 'alert-warning', 'alert-info');

    if (!dataSave.success) {
      saveResult.classList.add('alert-danger');
      saveResult.innerHTML = '❌ Erreur de connexion Odoo : ' + (dataSave.message || 'erreur inconnue');
      return;
    }

    // ── Étape 2 : mettre à jour les doublons (/update) ─
    let updateResult = null;
    if (dataSave.skipped > 0 && Array.isArray(dataSave.skippedNames) && dataSave.skippedNames.length > 0) {
      const skippedRows = rows.filter(r =>
        dataSave.skippedNames.some(n =>
          n.trim().toUpperCase() === r.employee_name.trim().toUpperCase()
        )
      );

      if (skippedRows.length > 0) {
        const resUpdate = await fetch('/api/odoo/update', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ date, rows: skippedRows }),
        });
        updateResult = await resUpdate.json();
      }
    }

    // ── Étape 3 : construire le message de résultat ────
    const created   = dataSave.created || 0;
    const updated   = updateResult ? (updateResult.updated   || 0) : 0;
    const unchanged = updateResult ? (updateResult.unchanged || 0) : 0;
    const notFound  = updateResult ? (updateResult.notFound  || 0) : 0;
    const errSave   = dataSave.errors   || [];
    const errUpdate = updateResult ? (updateResult.errors || []) : [];
    const allErrors = [...errSave, ...errUpdate];

    let msg  = '';
    let type = 'alert-success';

    // ── Résumé chiffré ─────────────────────────────────
    if (created > 0) {
      msg += '<div style="color:#1a7a3c; font-size:15px;">✅ <strong>' + created
           + '</strong> nouvelle(s) fiche(s) créée(s) avec succès.</div>';
    }
    if (updated > 0) {
      msg += '<div style="color:#0066cc; font-size:15px;">🔄 <strong>' + updated
           + '</strong> fiche(s) mise(s) à jour.</div>';
    }
    if (unchanged > 0) {
      msg += '<div style="color:#555; font-size:14px;">⏭️ <strong>' + unchanged
           + '</strong> fiche(s) déjà à jour (aucun changement détecté).</div>';
    }
    if (notFound > 0) {
      type = 'alert-warning';
      msg += '<div style="color:#e67e22; font-size:14px;">⚠️ <strong>' + notFound
           + '</strong> employé(s) introuvable(s) dans Odoo : '
           + (updateResult.notFoundNames || []).join(', ') + '</div>';
    }

    // ── Détail des modifications ───────────────────────
    if (updateResult && updateResult.updatesDetail && updateResult.updatesDetail.length > 0) {
      const crees   = updateResult.updatesDetail.filter(u =>
        u.champs.some(c => c.includes('Nouvelle fiche'))
      );
      const majOnly = updateResult.updatesDetail.filter(u =>
        !u.champs.some(c => c.includes('Nouvelle fiche'))
      );

      if (crees.length > 0) {
        msg += '<br><strong>Fiches créées lors de la synchronisation :</strong>'
             + '<ul style="margin:4px 0 8px 16px;">';
        crees.forEach(u => { msg += '<li>' + u.employee + '</li>'; });
        msg += '</ul>';
      }
      if (majOnly.length > 0) {
        msg += '<br><strong>Détail des champs modifiés :</strong>'
             + '<ul style="margin:4px 0 8px 16px;">';
        majOnly.forEach(u => {
          msg += '<li><strong>' + u.employee + '</strong> : ' + u.champs.join(' | ') + '</li>';
        });
        msg += '</ul>';
      }
    }

    // ── Erreurs ────────────────────────────────────────
    if (allErrors.length > 0) {
      type = (created + updated === 0) ? 'alert-danger' : 'alert-warning';
      msg += '<br><strong style="color:#c0392b;">⚠️ ' + allErrors.length + ' erreur(s) :</strong>'
           + '<ul style="margin:4px 0 8px 16px; color:#c0392b;">';
      allErrors.forEach(e => { msg += '<li>' + e + '</li>'; });
      msg += '</ul>';
    }

    // ── Rien à faire ───────────────────────────────────
    if (created === 0 && updated === 0 && allErrors.length === 0) {
      type = 'alert-info';
      msg  = '⏭️ Toutes les fiches sont déjà à jour dans Odoo pour le <strong>' + date + '</strong>.';
    }

    saveResult.classList.add(type);
    saveResult.innerHTML = msg;

  } catch (err) {
    saveResult.classList.remove('d-none');
    saveResult.classList.add('alert-danger');
    saveResult.innerHTML = '❌ Erreur réseau. Vérifiez votre connexion et réessayez.<br>'
                         + '<small style="color:#888;">' + err.message + '</small>';
  } finally {
    btnSync.disabled    = false;
    btnSync.textContent = '💾 Enregistrer dans Odoo';
  }
}

// -------------------------------------------------------
// POINT D'ENTRÉE — tout ce qui touche le DOM est ici
// -------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {

  // Chargement des employés dès l'arrivée sur la page
  loadEmployees();

  // ── ANALYSE OCR ──────────────────────────────────────
  const btnAnalyze = document.getElementById('btnAnalyze');
  if (btnAnalyze) {
    btnAnalyze.addEventListener('click', async () => {
      if (!selectedFile) return;

      const loadingSpinner = document.getElementById('loadingSpinner');
      const uploadZone     = document.getElementById('uploadZone');
      const reviewZone     = document.getElementById('reviewZone');
      const ocrWarning     = document.getElementById('ocrWarning');

      loadingSpinner.classList.remove('d-none');
      btnAnalyze.disabled = true;

      try {
        const formData = new FormData();
        formData.append('document', selectedFile);
        formData.append('employees', JSON.stringify(employeeList));

        const res  = await fetch('/api/ocr', { method: 'POST', body: formData });
        const data = await res.json();

        if (!data.success) {
          alert("Erreur OCR : " + (data.error || "erreur inconnue"));
          return;
        }

        showDocumentPreview(selectedFile);

        let warningMessages = [];

        if (!data.rows || data.rows.length === 0) {
          warningMessages.push("⚠️ Aucune donnée détectée. Vérifiez la netteté de la photo ou saisissez manuellement.");
        }

        // Pré-remplissage avec la date détectée par l'OCR — jamais la date du jour par défaut
        if (data.detected_date) {
          document.getElementById('fiche_date').value = data.detected_date;
        } else {
          document.getElementById('fiche_date').value = '';
          warningMessages.push("⚠️ Date non détectée automatiquement. Merci de la saisir manuellement avant d'enregistrer.");
        }

        if (warningMessages.length > 0) {
          ocrWarning.innerHTML = warningMessages.join('<br>');
          ocrWarning.classList.remove('d-none');
        } else {
          ocrWarning.classList.add('d-none');
        }

        renderTable(data.rows || []);

        uploadZone.classList.add('d-none');
        reviewZone.classList.remove('d-none');

      } catch (err) {
        alert("Erreur réseau pendant l'analyse OCR. Réessayez.");
      } finally {
        loadingSpinner.classList.add('d-none');
        btnAnalyze.disabled = false;
      }
    });
  }

  // ── DÉCONNEXION ───────────────────────────────────────
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      await fetch('/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  }

  // ── BOUTON UNIQUE : ENREGISTRER / METTRE À JOUR ───────
  const btnSync = document.getElementById('btnSync');
  if (btnSync) {
    btnSync.addEventListener('click', () => {
      syncAttendanceToOdoo();
    });
  }

  // ── RÉINITIALISATION ──────────────────────────────────
  const btnResetAll = document.getElementById('btnResetAll');
  if (btnResetAll) {
    btnResetAll.addEventListener('click', () => {
      document.getElementById('uploadZone').classList.remove('d-none');
      document.getElementById('reviewZone').classList.add('d-none');
      document.getElementById('saveResult').classList.add('d-none');
      document.getElementById('attendanceTableBody').innerHTML = '';
      document.getElementById('documentPreview').innerHTML = '';
    });
  }

});
