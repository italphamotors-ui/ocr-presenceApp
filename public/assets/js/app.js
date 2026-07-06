// === Orchestration générale de l'application ===
// selectedFile est déclaré dans upload.js — ne pas re-déclarer ici

// -------------------------------------------------------
// LISTE DES EMPLOYÉS ODOO (chargée une fois au démarrage)
// -------------------------------------------------------
let employeeList = []; // [{ id: 3, name: "Alice Dupont" }, ...]

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
// SAUVEGARDE DANS ODOO
// -------------------------------------------------------
async function saveAttendanceToOdoo() {
  const date       = document.getElementById('fiche_date').value;
  const saveResult = document.getElementById('saveResult');

  if (!date) {
    alert("Merci de renseigner la date de la fiche.");
    return;
  }

  // Garde-fou : si la date saisie correspond à aujourd'hui, on demande confirmation
  // explicite pour éviter d'enregistrer une fiche scannée à une date passée
  // sous la date du jour par erreur (champ non corrigé après l'OCR).
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) {
    const confirmToday = confirm(
      `La date saisie est celle d'aujourd'hui (${date}).\n` +
      `Si la fiche scannée concerne une autre date, annulez et corrigez le champ "Date de la fiche".\n\n` +
      `Continuer avec la date du jour ?`
    );
    if (!confirmToday) return;
  }

  const rows = readTableData().filter(r => r.employee_name && r.employee_name.trim() !== '');

  if (rows.length === 0) {
    alert("Aucune ligne avec un nom d'employé à enregistrer.");
    return;
  }

  const btnSave       = document.getElementById('btnSave');
  btnSave.disabled    = true;
  btnSave.textContent = "Enregistrement en cours...";

  try {
    const res = await fetch('/api/odoo/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ date, rows }),
    });
    const data = await res.json();

    saveResult.classList.remove('d-none', 'alert-danger', 'alert-success', 'alert-warning');

    if (data.success) {
      saveResult.classList.add('alert-success');
      let msg = `✅ ${data.created} fiche(s) enregistrée(s) dans Odoo.`;
      if (data.skipped > 0) {
        msg += `<br>⏭️ ${data.skipped} ligne(s) ignorée(s) (déjà existantes) : ${data.skippedNames.join(', ')}`;
      }
      if (data.errors && data.errors.length > 0) {
        msg += `<br><span class="text-warning">⚠️ ${data.errors.length} ligne(s) en erreur : ${data.errors.join(', ')}</span>`;
      }
      saveResult.innerHTML = msg;
    } else {
      saveResult.classList.add('alert-danger');
      saveResult.textContent = "❌ Erreur lors de l'enregistrement : " + (data.message || 'erreur inconnue');
    }

  } catch (err) {
    saveResult.classList.remove('d-none');
    saveResult.classList.add('alert-danger');
    saveResult.textContent = "❌ Erreur réseau. Vérifiez votre connexion et réessayez.";
  } finally {
    btnSave.disabled    = false;
    btnSave.textContent = "💾 Enregistrer dans Odoo";
  }
}

// -------------------------------------------------------
// MISE À JOUR DANS ODOO (2e scan)
// -------------------------------------------------------
async function updateAttendanceInOdoo() {
  const date       = document.getElementById('fiche_date').value;
  const saveResult = document.getElementById('saveResult');

  if (!date) {
    alert("Merci de renseigner la date de la fiche.");
    return;
  }

  const rows = readTableData().filter(r => r.employee_name && r.employee_name.trim() !== '');
  if (rows.length === 0) {
    alert("Aucune ligne avec un nom d'employé à mettre à jour.");
    return;
  }

  const btnUpdate       = document.getElementById('btnUpdate');
  btnUpdate.disabled    = true;
  btnUpdate.textContent = "Mise à jour en cours...";

  try {
    const res = await fetch('/api/odoo/update', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ date, rows }),
    });
    const data = await res.json();

    saveResult.classList.remove('d-none', 'alert-danger', 'alert-success', 'alert-warning');

    if (data.success) {
      saveResult.classList.add('alert-success');
      let msg = '<strong>Résultat de la mise à jour</strong><br>';
      msg += '🔄 ' + data.updated + ' fiche(s) mise(s) à jour.';

      if (data.unchanged > 0) {
        msg += '<br>⏭️ ' + data.unchanged + ' fiche(s) inchangée(s) (aucune différence détectée).';
      }
      if (data.notFound > 0) {
        msg += '<br>⚠️ ' + data.notFound + ' employé(s) sans fiche existante : ' + data.notFoundNames.join(', ');
      }
      if (data.updatesDetail && data.updatesDetail.length > 0) {
        msg += '<br><br><strong>Détail des modifications :</strong><ul style="margin:6px 0 0 0;">';
        for (const u of data.updatesDetail) {
          msg += '<li><strong>' + u.employee + '</strong> : ' + u.champs.join(' | ') + '</li>';
        }
        msg += '</ul>';
      }
      if (data.errors && data.errors.length > 0) {
        msg += '<br><span class="text-warning">⚠️ ' + data.errors.length + ' erreur(s) : ' + data.errors.join(', ') + '</span>';
      }

      saveResult.innerHTML = msg;
    } else {
      saveResult.classList.add('alert-danger');
      saveResult.textContent = "Erreur lors de la mise à jour : " + (data.message || 'erreur inconnue');
    }

  } catch (err) {
    saveResult.classList.remove('d-none');
    saveResult.classList.add('alert-danger');
    saveResult.textContent = "Erreur réseau. Vérifiez votre connexion et réessayez.";
  } finally {
    btnUpdate.disabled    = false;
    btnUpdate.textContent = "🔄 Mettre à jour";
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

        // Pré-remplissage de la date : on utilise UNIQUEMENT la date détectée par l'OCR
        // sur le document. On ne se rabat JAMAIS silencieusement sur la date du jour,
        // car cela conduit à enregistrer des fiches scannées (ex: 18/03/2026) sous la
        // date du jour (ex: 30/06/2026), créant de faux doublons et empêchant la
        // création des fiches réelles.
        if (data.detected_date) {
          document.getElementById('fiche_date').value = data.detected_date; // format attendu: YYYY-MM-DD
        } else {
          document.getElementById('fiche_date').value = '';
          warningMessages.push("⚠️ Date non détectée automatiquement sur le document. Merci de la saisir manuellement avant d'enregistrer.");
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


  // ── MISE À JOUR DANS ODOO ────────────────────────────
  const btnUpdate = document.getElementById('btnUpdate');
  if (btnUpdate) {
    btnUpdate.addEventListener('click', () => {
      updateAttendanceInOdoo();
    });
  }

  // ── SAUVEGARDE DANS ODOO ──────────────────────────────
  const btnSave = document.getElementById('btnSave');
  if (btnSave) {
    btnSave.addEventListener('click', () => {
      saveAttendanceToOdoo();
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
