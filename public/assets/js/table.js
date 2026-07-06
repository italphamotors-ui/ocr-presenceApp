// === Gestion du tableau de correction ===

const tableBody = document.getElementById('attendanceTableBody');
let originalRows = []; // copie des données OCR brutes, pour le "Réinitialiser tout"

function renderTable(rows) {
  originalRows = JSON.parse(JSON.stringify(rows)); // clone profond
  tableBody.innerHTML = '';
  rows.forEach((row, index) => addRow(row, index));
}

function addRow(row, index) {
  const tr = document.createElement('tr');
  tr.dataset.index = index;

  tr.innerHTML = `
    <td><input type="text" class="form-control form-control-sm" data-field="employee_name" value="${escapeHtml(row.employee_name || '')}"></td>
    <td><input type="text" class="form-control form-control-sm" data-field="heure_arrivee" value="${escapeHtml(row.heure_arrivee || '')}" placeholder="HH:MM"></td>
    <td><input type="text" class="form-control form-control-sm" data-field="heure_debut_pause" value="${escapeHtml(row.heure_debut_pause || '')}" placeholder="HH:MM"></td>
    <td><input type="text" class="form-control form-control-sm" data-field="heure_retour_pause" value="${escapeHtml(row.heure_retour_pause || '')}" placeholder="HH:MM"></td>
    <td><input type="text" class="form-control form-control-sm" data-field="heure_depart" value="${escapeHtml(row.heure_depart || '')}" placeholder="HH:MM"></td>
    <td class="text-center"><input type="checkbox" class="form-check-input" data-field="de_garde_hier" ${row.de_garde_hier ? 'checked' : ''}></td>
    <td><input type="text" class="form-control form-control-sm" data-field="observation" value="${escapeHtml(row.observation || '')}"></td>
    <td><button class="btn btn-sm btn-outline-danger btn-clear-row" title="Effacer cette ligne">✕</button></td>
  `;

  tableBody.appendChild(tr);

  // Highlight quand une cellule est modifiée
  tr.querySelectorAll('input[type="text"]').forEach(input => {
    input.addEventListener('input', () => input.classList.add('cell-edited'));
  });
  tr.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => input.classList.add('cell-edited'));
  });

  // Effacer une ligne
  tr.querySelector('.btn-clear-row').addEventListener('click', () => {
    tr.querySelectorAll('input[type="text"]').forEach(i => { i.value = ''; i.classList.add('cell-edited'); });
    tr.querySelector('input[type="checkbox"]').checked = false;
  });
}

// Réinitialiser tout le tableau aux valeurs OCR d'origine
document.getElementById('btnResetAll').addEventListener('click', () => {
  if (confirm("Réinitialiser toutes les corrections aux valeurs détectées par l'OCR ?")) {
    renderTable(originalRows);
  }
});

// Lecture de l'état actuel du tableau (pour l'envoi à Odoo)
function readTableData() {
  const rows = [];
  tableBody.querySelectorAll('tr').forEach(tr => {
    const row = {};
    tr.querySelectorAll('input[data-field]').forEach(input => {
      if (input.type === 'checkbox') {
        row[input.dataset.field] = input.checked;
      } else {
        row[input.dataset.field] = input.value.trim();
      }
    });
    rows.push(row);
  });
  return rows;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
