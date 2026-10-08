let session = {
    title: "Jugendhilfeausschuss",
    date: new Date().toLocaleDateString('de-DE'),
    members: [],
    globalGuests: [],
    generalNotes: "",
    agenda: [],
    currentTopIndex: 0,
    viewMode: "top",
    topData: {},
    distribution: []
};

let isAttendanceUIVisible = true;
let currentSortMode = "default";

// --- PERSISTENCE ---
// Speicherung erfolgt ausschließlich über JSON-Export/-Import ("Speichern"/"Laden").
// Die App warnt stattdessen beim Schließen/Neuladen vor Datenverlust.

// Warnung vor Datenverlust beim Schließen/Neuladen
window.addEventListener('beforeunload', (e) => {
    if (session.members && session.members.length > 0) {
        e.preventDefault();
        e.returnValue = ''; // Standard-Browserdialog triggern
    }
});

// --- HILFSFUNKTIONEN ---
// HTML-Maskierung: Alles, was aus Dateien oder Eingabefeldern stammt und per innerHTML
// ausgegeben wird, läuft hier durch (Namen, Organisationen, Notizen, Beschlusstexte).
function esc(v) {
    return String(v === undefined || v === null ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Kleinschreibung, ohne Satzzeichen/Leerraum (für tolerante Vergleiche)
function normText(v) {
    return String(v === undefined || v === null ? "" : v).toLowerCase().replace(/ß/g, "ss").replace(/[^a-zäöü0-9]/g, "");
}

function levenshtein(a, b) {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0]; prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
}

// --- STATUS-ERKENNUNG ---
// Zerlegt einen Status-Text wie "stellv. Stimmbereichtigt" in seine Bedeutung. Wortweise und
// tolerant gegenüber Tippfehlern, Abkürzungen und Zeichensetzung. Die ganze App fragt die Rolle
// ausschließlich hierüber ab (nie mehr per includes() auf dem Rohtext).
const STATUS_WORTE = {
    voting: { start: ['stimm', 'beschl'], nah: ['stimmberechtigt', 'beschliessend', 'stimmberechtigte'], max: 3 },
    consulting: { start: ['berat'], nah: ['beratend', 'beratende'], max: 2 },
    stellv: { start: ['stell', 'stv', 'vertret'], nah: ['stellvertretend', 'stellvertreter', 'stellvertretung', 'stellv'], max: 3 }
};

function roleOf(status) {
    const words = String(status || "").toLowerCase().replace(/ß/g, "ss").split(/[^a-zäöü]+/).filter(Boolean);
    const found = { voting: false, consulting: false, stellv: false };
    words.forEach(w => {
        Object.keys(STATUS_WORTE).forEach(k => {
            const d = STATUS_WORTE[k];
            if (d.start.some(p => w.startsWith(p)) || (w.length >= 5 && d.nah.some(n => levenshtein(w, n) <= d.max && levenshtein(w, n) < w.length / 2))) found[k] = true;
        });
    });
    return { isVoting: found.voting, isConsulting: found.consulting, isStellv: found.stellv, known: found.voting || found.consulting };
}

function roleLabel(status) {
    const r = roleOf(status);
    if (!String(status || "").trim()) return null;
    if (r.isVoting) return r.isStellv ? "Stellvertretung (stimmberechtigt)" : "Stimmberechtigt";
    if (r.isConsulting) return r.isStellv ? "Stellvertretung (beratend)" : "Beratend";
    if (r.isStellv) return "Stellvertretung (Stimmrecht unklar)";
    return null;
}

// Rollen-Gewicht für die Standardsortierung
function getWeight(status) {
    const r = roleOf(status);
    if (r.isVoting && !r.isStellv) return 1;
    if (r.isConsulting && !r.isStellv) return 2;
    if (r.isStellv) return 3;
    return 4;
}

// Platzhalter-Namen aus der Quellliste ("nn", "N.N.", "-") gelten als unbesetzt
function isPlaceholderName(s) {
    return /^(n\.?\s?n\.?|-+|\?+|tbd|offen|n\.?\s?b\.?)$/i.test((s || "").trim());
}

// --- SPALTEN-ZUORDNUNG ---
const FELDER = [
    { key: 'Vorname', label: 'Vorname', exact: ['vorname', 'rufname', 'firstname'], contains: ['vorname'] },
    { key: 'Nachname', label: 'Nachname', exact: ['name', 'nachname', 'familienname', 'lastname', 'surname'], contains: ['nachname', 'familienname'] },
    { key: 'Typ', label: 'Organisation / Fraktion', exact: ['organisation', 'org', 'fraktion', 'partei', 'gruppe', 'verband', 'institution', 'entsendung', 'typ'], contains: ['organisation', 'fraktion', 'partei', 'gruppe', 'verband', 'institution', 'entsend', 'typ'] },
    { key: 'Status', label: 'Status / Rolle', exact: ['status', 'rolle', 'funktion', 'stimmrecht', 'mitgliedschaft'], contains: ['status', 'rolle', 'funktion', 'stimmrecht', 'mitgliedschaft'] },
    { key: 'Stadtrat', label: 'Stadtrat (ja/nein)', exact: ['stadtrat', 'stadträtin', 'sr'], contains: ['stadtrat', 'stadträt'] },
    { key: 'Kennung', label: 'Kennung', exact: ['kennung'], contains: ['kennung'] },
    { key: 'Bemerkung', label: 'Bemerkung', exact: ['bemerkung', 'anmerkung', 'notiz', 'kommentar'], contains: ['bemerk', 'anmerk', 'notiz', 'kommentar'] }
];

// Findet die Kopfzeile: unter den ersten 15 Zeilen diejenige mit den meisten erkannten Überschriften
// (Titelzeilen oder Leerzeilen über der Tabelle stören dann nicht).
function detectHeaderRow(rows) {
    let best = 0, bestScore = -1;
    rows.slice(0, 15).forEach((row, i) => {
        const cells = row.map(normText);
        const score = FELDER.filter(f => cells.some(c => f.exact.includes(c))).length;
        if (score > bestScore) { best = i; bestScore = score; }
    });
    return best;
}

// Erst exakte Überschriften, dann Teiltreffer; jede Spalte nur einmal vergeben.
function guessMapping(headers) {
    const norm = headers.map(normText);
    const mapping = {};
    const used = new Set();
    const pass = (words, exact) => FELDER.forEach(f => {
        if (mapping[f.key] !== undefined) return;
        const i = norm.findIndex((h, idx) => h && !used.has(idx) && words(f).some(w => exact ? h === w : h.includes(w)));
        if (i !== -1) { mapping[f.key] = i; used.add(i); }
    });
    pass(f => f.exact, true);
    pass(f => f.contains, false);
    FELDER.forEach(f => { if (mapping[f.key] === undefined) mapping[f.key] = -1; });
    return mapping;
}

function cleanCell(v) {
    return String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim();
}

// Baut Mitglieder und Prüfbericht aus Rohzeilen + Zuordnung.
function buildMembers(state) {
    const { rows, headerRow, mapping } = state;
    const warnings = [];
    const get = (row, key) => mapping[key] >= 0 ? cleanCell(row[mapping[key]]) : "";

    if (mapping.Vorname < 0 && mapping.Nachname < 0) warnings.push({ level: 'error', text: "Es ist weder Vorname noch Nachname zugeordnet – so lassen sich keine Mitglieder bilden." });
    if (mapping.Status < 0) warnings.push({ level: 'error', text: "Keine Spalte für den Status zugeordnet – alle Mitglieder würden unter „Sonstige“ landen und niemand wäre stimmberechtigt." });
    if (mapping.Typ < 0) warnings.push({ level: 'warn', text: "Keine Spalte für die Organisation zugeordnet – Nachrücken von Stellvertretern und der Soll-Ist-Vergleich funktionieren dann nicht." });

    let leer = 0;
    const members = [];
    rows.slice(headerRow + 1).forEach((row, i) => {
        const obj = { Vorname: get(row, 'Vorname'), Nachname: get(row, 'Nachname'), Status: get(row, 'Status'), Typ: get(row, 'Typ'),
            Stadtrat: get(row, 'Stadtrat'), Kennung: get(row, 'Kennung'), Bemerkung: get(row, 'Bemerkung'), _zeile: headerRow + i + 2 };
        const hatInhalt = row.some(c => cleanCell(c));
        if (isPlaceholderName(obj.Vorname)) obj.Vorname = "";
        if (isPlaceholderName(obj.Nachname)) obj.Nachname = "";
        if (/^(ja|j|x|yes|true|1|sr)$/i.test(obj.Stadtrat)) obj.Stadtrat = "ja";
        obj.DisplayName = `${obj.Vorname} ${obj.Nachname}`.trim();
        if (!obj.DisplayName) { if (hatInhalt) leer++; return; }
        members.push(obj);
    });
    if (leer > 0) warnings.push({ level: 'info', text: `${leer} Zeile(n) ohne Namen oder mit Platzhalter (z. B. „nn“) übersprungen – unbesetzte Sitze, nicht als Person geführt.` });

    // Status-Erkennung: jeder Rohwert und was daraus wurde
    const statusTabelle = {};
    members.forEach(m => {
        const k = m.Status;
        statusTabelle[k] = statusTabelle[k] || { n: 0, label: roleLabel(k) };
        statusTabelle[k].n++;
    });
    const ohneStatus = members.filter(m => !m.Status.trim());
    if (ohneStatus.length && mapping.Status >= 0) warnings.push({ level: 'warn', text: `${ohneStatus.length} Mitglied(er) ohne Status: ${ohneStatus.slice(0, 5).map(m => m.DisplayName).join(', ')}${ohneStatus.length > 5 ? ' …' : ''} – erscheinen unter „Sonstige“.` });
    Object.keys(statusTabelle).forEach(k => {
        if (k.trim() && !statusTabelle[k].label) warnings.push({ level: 'warn', text: `Status „${k}“ (${statusTabelle[k].n}×) nicht erkannt – erscheint unter „Sonstige“, nicht stimmberechtigt.` });
        if (statusTabelle[k].label === "Stellvertretung (Stimmrecht unklar)") warnings.push({ level: 'warn', text: `Status „${k}“ (${statusTabelle[k].n}×): Stellvertretung ohne Angabe „stimmberechtigt“ oder „beratend“ – wird als Stellvertretung ohne Stimmrecht geführt.` });
    });

    // Stimmberechtigte ohne Organisation können nicht vertreten werden
    const ohneOrg = members.filter(m => mapping.Typ >= 0 && !m.Typ && roleOf(m.Status).isVoting);
    if (ohneOrg.length) warnings.push({ level: 'warn', text: `${ohneOrg.length} stimmberechtigte(r) Mitglied(er) ohne Organisation: ${ohneOrg.slice(0, 5).map(m => m.DisplayName).join(', ')} – Stellvertretung kann nicht zugeordnet werden.` });

    // Doppelte Einträge
    const gesehen = {};
    members.forEach(m => {
        const k = normText(m.DisplayName) + "|" + normText(m.Typ) + "|" + normText(m.Status);
        if (gesehen[k]) warnings.push({ level: 'warn', text: `„${m.DisplayName}“ (${m.Typ || 'ohne Organisation'}) kommt doppelt vor (Zeilen ${gesehen[k]} und ${m._zeile}).` });
        else gesehen[k] = m._zeile;
    });

    // Stellvertreter in Organisationen ohne ordentliches stimmberechtigtes Mitglied
    const ordOrgs = new Set(members.filter(m => { const r = roleOf(m.Status); return r.isVoting && !r.isStellv; }).map(m => normText(m.Typ)));
    const verwaist = members.filter(m => { const r = roleOf(m.Status); return r.isVoting && r.isStellv && !ordOrgs.has(normText(m.Typ)); });
    if (verwaist.length) warnings.push({ level: 'info', text: `${verwaist.length} Stellvertretung(en) ohne ordentliches stimmberechtigtes Mitglied in der Organisation: ${verwaist.slice(0, 4).map(m => m.DisplayName + ' (' + (m.Typ || '–') + ')').join(', ')}.` });

    members.sort((a, b) => {
        const wA = getWeight(a.Status); const wB = getWeight(b.Status);
        if (wA !== wB) return wA - wB;
        return (a.Typ || "").localeCompare(b.Typ || "") || (a.DisplayName || "").localeCompare(b.DisplayName || "");
    });
    members.forEach(m => delete m._zeile);
    return { members, warnings, statusTabelle };
}

// --- DATEI EINLESEN (Rohzeilen) ---
// Text einlesen: UTF-8 (auch mit BOM) bevorzugt, sonst Windows-1252 (Excel-"CSV")
function decodeText(buffer) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
    } catch (e) {
        return new TextDecoder('windows-1252').decode(buffer);
    }
}

async function readCsvRows(file) {
    if (typeof Papa === 'undefined') throw new Error("PapaParse Bibliothek nicht geladen!");
    const text = decodeText(await file.arrayBuffer());
    const results = Papa.parse(text, { header: false, skipEmptyLines: 'greedy', delimiter: "" });
    return { rows: results.data, distribution: [] };
}

async function readXlsxRows(file) {
    if (typeof XLSX === 'undefined') throw new Error("SheetJS (xlsx) Bibliothek nicht geladen!");
    const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    // Blatt für die Mitgliederliste (JHA oder erstes Blatt)
    const membersSheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'jha') || workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[membersSheetName], { header: 1, defval: "" });

    // Soll-Verteilung einlesen, falls vorhanden
    let distribution = [];
    const distSheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'verteilung');
    if (distSheetName) {
        const distRows = XLSX.utils.sheet_to_json(workbook.Sheets[distSheetName], { header: 1, defval: "" });
        if (distRows.length > 1) {
            const rawDistHeaders = distRows[0].map(h => String(h || "").trim());
            const orgIdx = rawDistHeaders.findIndex(h => h.toLowerCase().includes('org'));
            const countIdx = rawDistHeaders.findIndex(h => h.toLowerCase().includes('wieviel') || h.toLowerCase().includes('anzahl'));
            const roleIdx = rawDistHeaders.findIndex(h => h.toLowerCase().includes('was') || h.toLowerCase().includes('rolle') || h.toLowerCase().includes('status'));
            if (orgIdx !== -1 && countIdx !== -1) {
                distribution = distRows.slice(1).map(row => ({
                    Organisation: String(row[orgIdx] || "").trim(),
                    wieviel: parseInt(row[countIdx]) || 0,
                    was: roleIdx !== -1 ? String(row[roleIdx] || "").trim() : ""
                })).filter(d => d.Organisation && d.wieviel > 0);
            }
        }
    }
    return { rows, distribution };
}

async function loadImportState(file) {
    const name = file.name.toLowerCase();
    const raw = (name.endsWith('.xlsx') || name.endsWith('.xls')) ? await readXlsxRows(file) : await readCsvRows(file);
    const headerRow = detectHeaderRow(raw.rows);
    const headers = (raw.rows[headerRow] || []).map(cleanCell);
    return { file, rows: raw.rows, distribution: raw.distribution, headerRow, headers, mapping: guessMapping(headers) };
}

// --- PRÜFBEREICH IM SETUP ---
let importState = null;

async function onMemberFileChosen(input) {
    const box = document.getElementById('import-review');
    const file = input.files[0];
    importState = null;
    if (!file) { box.classList.add('hidden'); box.innerHTML = ""; return; }
    try {
        importState = await loadImportState(file);
        renderImportReview();
    } catch (err) {
        console.error("Fehler beim Einlesen:", err);
        box.classList.remove('hidden');
        box.innerHTML = `<div class="imp-msg imp-error">Datei konnte nicht gelesen werden: ${esc(err.message)}</div>`;
    }
}

function onMappingChange(key, value) {
    importState.mapping[key] = parseInt(value);
    renderImportReview();
}

function renderImportReview() {
    const box = document.getElementById('import-review');
    if (!importState) { box.classList.add('hidden'); return; }
    const { headers, mapping } = importState;
    const result = buildMembers(importState);
    importState.result = result;

    const options = (sel) => `<option value="-1">– nicht vorhanden –</option>` + headers.map((h, i) =>
        `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `Spalte ${i + 1}`)}</option>`).join('');
    const mappingHtml = FELDER.map(f => `
        <label class="imp-field"><span>${esc(f.label)}</span>
            <select onchange="onMappingChange('${f.key}', this.value)">${options(mapping[f.key])}</select>
        </label>`).join('');

    const statusRows = Object.keys(result.statusTabelle).map(k => {
        const e = result.statusTabelle[k];
        return `<tr><td>${esc(k || '(leer)')}</td><td class="${e.label ? '' : 'imp-bad'}">${esc(e.label || 'nicht erkannt → Sonstige')}</td><td class="imp-num">${e.n}</td></tr>`;
    }).join('');

    const order = { error: 0, warn: 1, info: 2 };
    const warnHtml = result.warnings.slice().sort((a, b) => order[a.level] - order[b.level]).map(w =>
        `<div class="imp-msg imp-${w.level}">${esc(w.text)}</div>`).join('') || `<div class="imp-msg imp-ok">Keine Auffälligkeiten.</div>`;

    const vorschau = result.members.slice(0, 5).map(m =>
        `<tr><td>${esc(m.DisplayName)}</td><td>${esc(m.Typ)}</td><td>${esc(m.Status)}</td></tr>`).join('');

    box.classList.remove('hidden');
    box.innerHTML = `
        <div class="imp-title">Prüfung der Mitgliederliste: ${result.members.length} Mitglieder erkannt</div>
        <div class="imp-grid">${mappingHtml}</div>
        <div class="imp-sub">Hinweise</div>${warnHtml}
        <details class="imp-details"><summary>Status-Erkennung (${Object.keys(result.statusTabelle).length} Schreibweisen)</summary>
            <table class="imp-table"><thead><tr><th>In der Liste</th><th>Erkannt als</th><th>Anzahl</th></tr></thead><tbody>${statusRows}</tbody></table>
        </details>
        <details class="imp-details"><summary>Vorschau (erste 5 von ${result.members.length})</summary>
            <table class="imp-table"><thead><tr><th>Name</th><th>Organisation</th><th>Status</th></tr></thead><tbody>${vorschau}</tbody></table>
        </details>`;
}


function parseAgenda(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return lines.map((line, idx) => {
        const match = line.match(/^(\d+(?:\.\d+)*|TOP\s*\d+(?:\.\d+)*)[\.\)\s:-]*(.*)/i);
        return match ? { nr: match[1], titel: match[2].trim() } : { nr: (idx + 1).toString(), titel: line };
    });
}

async function initializeSession() {
    console.log("initializeSession aufgerufen");
    const mFileElem = document.getElementById('memberCsv');
    const aTextElem = document.getElementById('agendaText');

    if (!mFileElem || !aTextElem) {
        console.error("Fehler: Eingabefelder im DOM nicht gefunden!");
        return;
    }

    const mFile = mFileElem.files[0];
    const aText = aTextElem.value.trim();

    // Validierung: Entweder neue Datei oder bereits geladene Mitglieder
    if (!mFile && (!session.members || session.members.length === 0)) {
        alert("Bitte wählen Sie eine Mitglieder-Datei (Excel oder CSV) aus.");
        return;
    }
    if (!aText) {
        alert("Bitte geben Sie die Tagesordnung ein.");
        return;
    }

    try {
        console.log("Initialisiere Session...");
        if (mFile) {
            // Prüfbereich nutzen (inkl. manueller Spaltenzuordnung); sonst Datei jetzt einlesen
            if (!importState || importState.file !== mFile) importState = await loadImportState(mFile);
            const result = buildMembers(importState);
            if (result.members.length === 0) {
                renderImportReview();
                alert("In der Datei wurden keine Mitglieder erkannt. Bitte die Spaltenzuordnung unter der Dateiauswahl prüfen.");
                return;
            }
            const fehler = result.warnings.filter(w => w.level === 'error');
            if (fehler.length && !confirm(fehler.map(w => w.text).join('\n\n') + '\n\nTrotzdem fortfahren?')) return;
            session.members = result.members;
            session.distribution = importState.distribution; // leer bei CSV
        }

        const newAgenda = parseAgenda(aText);

        // Versuchen, bestehende Notizen/Stimmen zu erhalten, wenn sich nur die Tagesordnung ändert
        const newTopData = {};
        newAgenda.forEach((item, idx) => {
            // Wenn der Index bereits existierte, nehmen wir die alten Daten als Basis
            // (Einfache Heuristik: Wir behalten Daten nach Positions-Index)
            if (session.topData && session.topData[idx]) {
                newTopData[idx] = session.topData[idx];
            } else {
                // Fallback: Daten vom ersten TOP (Anwesenheit) kopieren, falls vorhanden
                const baseAttendance = session.topData && session.topData[0] ? [...session.topData[0].attendance] : [];
                newTopData[idx] = { attendance: baseAttendance, notes: "", vote: { yes: 0, no: 0, text: "" } };
            }
        });

        session.agenda = newAgenda;
        session.topData = newTopData;
        session.globalGuests = session.globalGuests || [];
        session.generalNotes = session.generalNotes || "";
        session.viewMode = "top";
        session.currentTopIndex = 0;

        startWorkspace();
    } catch (err) {
        console.error("Fehler bei initializeSession:", err);
        alert("Import-Fehler: " + err.message);
    }
}

function startWorkspace() {
    console.log("Starte Workspace...");
    const setupView = document.getElementById('setup-view');
    const mainWorkspace = document.getElementById('main-workspace');
    const backBtn = document.getElementById('btn-back-to-setup');
    const editBtn = document.getElementById('btn-edit-setup');

    if (setupView) setupView.classList.add('hidden');
    if (mainWorkspace) mainWorkspace.classList.remove('hidden');
    if (backBtn) backBtn.classList.remove('hidden');
    if (editBtn) editBtn.classList.remove('hidden');

    document.getElementById('session-title').innerText = `${session.title} - ${session.date}`;
    
    const distCheckBtn = document.getElementById('btn-distribution-check');
    if (distCheckBtn) {
        if (session.distribution && session.distribution.length > 0) distCheckBtn.classList.remove('hidden');
        else distCheckBtn.classList.add('hidden');
    }

    renderSidebar();
    switchTop(session.currentTopIndex || 0, true);
}

function switchTop(newIndex, skipSave) {
    // skipSave = true beim Wiederherstellen einer Sitzung: Die DOM-Felder enthalten
    // dann noch alte/leere Werte und dürfen die geladenen Daten nicht überschreiben.
    if (!skipSave) saveCurrentTopState();
    session.viewMode = "top";
    if (!session.topData[newIndex]) {
        let sourceIdx = -1;
        for (let i = newIndex - 1; i >= 0; i--) { if (session.topData[i]) { sourceIdx = i; break; } }
        if (sourceIdx === -1 && session.topData[session.currentTopIndex]) sourceIdx = session.currentTopIndex;
        const sourceData = sourceIdx !== -1 ? session.topData[sourceIdx] : { attendance: [] };
        session.topData[newIndex] = { attendance: [...sourceData.attendance], notes: "", vote: { yes: 0, no: 0, text: "" } };
    }
    isAttendanceUIVisible = (newIndex === 0);
    session.currentTopIndex = newIndex;
    document.getElementById('top-view-container').classList.remove('hidden');
    document.getElementById('general-view-container').classList.add('hidden');
    renderSidebar();
    loadTopData();
}

function switchToGeneralNotes() {
    saveCurrentTopState();
    session.viewMode = "general";
    document.getElementById('top-view-container').classList.add('hidden');
    document.getElementById('general-view-container').classList.remove('hidden');
    document.getElementById('general-notes-area').value = session.generalNotes || "";
    renderSidebar();
}

function loadTopData() {
    const data = session.topData[session.currentTopIndex];
    const agendaItem = session.agenda[session.currentTopIndex];
    if (!data || !agendaItem) {
        console.error("Daten oder TOP nicht gefunden für Index:", session.currentTopIndex);
        return;
    }
    document.getElementById('top-title').innerText = `TOP ${agendaItem.nr}: ${agendaItem.titel}`;
    document.getElementById('top-notes').value = data.notes || "";
    document.getElementById('vote-yes').value = data.vote.yes || 0;
    document.getElementById('vote-no').value = data.vote.no || 0;
    document.getElementById('vote-result-text').value = data.vote.text || "";
    document.getElementById('top-indicator-badge').innerText = `Punkt ${agendaItem.nr}`;
    updateAttendanceVisibility();
    renderAttendance();
    renderGuests();
}

function toggleAttendanceUI() { isAttendanceUIVisible = !isAttendanceUIVisible; updateAttendanceVisibility(); }
function updateAttendanceVisibility() {
    const c = document.getElementById('attendance-table-container');
    const p = document.getElementById('attendance-collapsed-info');
    const b = document.getElementById('toggle-attendance-btn');
    if (isAttendanceUIVisible) { c.classList.remove('collapsed'); p.classList.add('hidden'); b.innerText = "Einklappen"; }
    else { c.classList.add('collapsed'); p.classList.remove('hidden'); b.innerText = "Details einblenden"; }
}

function changeSortMode(mode) {
    currentSortMode = mode;
    renderAttendance();
}

function normalizeOrg(name) {
    if (!name) return "";
    let s = String(name).toLowerCase().trim();
    s = s.replace(/[^a-z0-9äöüß]/g, ""); // Entferne Punkte, Leerzeichen, Bindestriche
    if (s.includes("jüdische")) return "juedischekultusgemeinde";
    if (s.includes("islamische")) return "islamischegemeinschaft";
    if (s.includes("jugendpflege")) return "jugendpflege";
    return s;
}

function getActiveTopAttendanceAnalysis() {
    const data = session.topData[session.currentTopIndex];
    if (!data) return { memberStatuses: [], activeSubstitutes: {} };

    // Gruppen zuordnen
    const memberStatuses = session.members.map((m, idx) => {
        const isPresent = data.attendance.includes(idx);
        const { isStellv, isVoting, isConsulting } = roleOf(m.Status);
        
        let group = "Stellvertretung / Sonstige";
        if (isVoting && !isStellv) group = "Stimmberechtigte Mitglieder";
        else if (isConsulting && !isStellv) group = "Beratende Mitglieder";

        return {
            member: m,
            index: idx,
            isPresent,
            isVoting,
            isStellv,
            group,
            normOrg: normalizeOrg(m.Typ)
        };
    });

    // Abwesende ordentliche Stimmen zählen
    const orgAbsentPrimariesCount = {};
    memberStatuses.forEach(ms => {
        if (ms.group === "Stimmberechtigte Mitglieder") {
            if (!ms.isPresent) {
                orgAbsentPrimariesCount[ms.normOrg] = (orgAbsentPrimariesCount[ms.normOrg] || 0) + 1;
            }
        }
    });

    // Nachrückende Stellvertreter identifizieren
    const activeSubstitutes = {};
    const orgSubstitutedCount = {};
    memberStatuses.forEach(ms => {
        if (ms.isVoting && ms.isStellv && ms.isPresent) {
            const absentCount = orgAbsentPrimariesCount[ms.normOrg] || 0;
            const alreadySubbed = orgSubstitutedCount[ms.normOrg] || 0;
            if (alreadySubbed < absentCount) {
                activeSubstitutes[ms.index] = true;
                orgSubstitutedCount[ms.normOrg] = alreadySubbed + 1;
            }
        }
    });

    return {
        memberStatuses,
        activeSubstitutes
    };
}

function renderAttendance() {
    const container = document.getElementById('attendance-list');
    const { memberStatuses, activeSubstitutes } = getActiveTopAttendanceAnalysis();
    
    // Sortierung anwenden
    const sortedStatuses = [...memberStatuses];
    if (currentSortMode === 'name') {
        sortedStatuses.sort((a, b) => {
            return (a.member.Nachname || "").localeCompare(b.member.Nachname || "") || 
                   (a.member.Vorname || "").localeCompare(b.member.Vorname || "");
        });
    } else if (currentSortMode === 'org') {
        sortedStatuses.sort((a, b) => {
            return (a.member.Typ || "").localeCompare(b.member.Typ || "") || 
                   (a.member.Nachname || "").localeCompare(b.member.Nachname || "");
        });
    } else {
        // Standard (Rolle)
        sortedStatuses.sort((a, b) => {
            const wA = getWeight(a.member.Status); const wB = getWeight(b.member.Status);
            if (wA !== wB) return wA - wB;
            return (a.member.Typ || "").localeCompare(b.member.Typ || "") || (a.member.DisplayName || "").localeCompare(b.member.DisplayName || "");
        });
    }

    let presentCount = 0;
    let totalVoting = 0;
    let lastGroup = "";
    let html = "";
    
    sortedStatuses.forEach(ms => {
        const m = ms.member;
        const idx = ms.index;
        const isPresent = ms.isPresent;
        const group = ms.group;
        
        if (currentSortMode === 'default' && group !== lastGroup) {
            html += `<tr><td colspan="3" class="group-header">${group}</td></tr>`;
            lastGroup = group;
        }
        
        const isPrimaryVoting = group === "Stimmberechtigte Mitglieder";
        const isActiveSubstitute = activeSubstitutes[idx];
        
        if (isPrimaryVoting) {
            totalVoting++;
            if (isPresent) {
                presentCount++;
            }
        } else if (isActiveSubstitute) {
            presentCount++;
        }
        
        const isPrimaryChair = (m.Kennung || "").toLowerCase() === 'vorsitz' || 
                               ((m.Bemerkung || "").toLowerCase().includes('vorsitz') && !(m.Bemerkung || "").toLowerCase().includes('stellv'));
        const isDeputyChair = (m.Kennung || "").toLowerCase().includes('stellv') && 
                              ((m.Kennung || "").toLowerCase().includes('vorsitz') || (m.Bemerkung || "").toLowerCase().includes('vorsitz'));
        
        let vsBadge = "";
        if (isPrimaryChair) {
            vsBadge = '<span class="bg-orange-100 text-orange-700 text-[9px] font-black uppercase px-2 py-0.5 rounded tracking-tighter mr-1.5" title="Vorsitzende(r)">Vorsitz</span> ';
        } else if (isDeputyChair) {
            vsBadge = '<span class="bg-amber-100 text-amber-700 text-[9px] font-black uppercase px-2 py-0.5 rounded tracking-tighter mr-1.5" title="Stellv. Vorsitzende(r)">Stellv. Vorsitz</span> ';
        }
        
        const sr = m.Stadtrat && m.Stadtrat.toLowerCase() === 'ja' ? '<span class="text-blue-600 font-black mr-1" title="Stadtratsmitglied">SR</span> ' : '';
        
        let substitutionLabel = "";
        if (isActiveSubstitute) {
            substitutionLabel = ` <span class="bg-green-100 text-green-700 text-[9px] font-black uppercase px-2 py-0.5 rounded tracking-tighter ml-2 badge-pop" title="Tritt stimmberechtigt ein für abwesendes Mitglied">Nachrücker (stimmber.)</span>`;
        } else if (ms.isVoting && ms.isStellv && !isPresent) {
            substitutionLabel = ` <span class="text-slate-400 text-[9px] italic ml-1">(Stellvertretung)</span>`;
        }
        
        html += `<tr class="member-row transition hover:bg-slate-50 text-slate-800 font-medium">
            <td class="p-3">${sr}${vsBadge}${esc(m.DisplayName)}${substitutionLabel}</td>
            <td class="p-3 text-[10px] text-slate-500 font-bold uppercase tracking-tighter">${esc(m.Typ || '-')}</td>
            <td class="p-3 text-center"><input type="checkbox" ${isPresent ? 'checked' : ''} onchange="toggleMember(${idx})" class="w-5 h-5 cursor-pointer accent-blue-600 rounded"></td>
        </tr>`;
    });
    
    container.innerHTML = html;
    updateQuorum(presentCount, totalVoting);
}

function toggleMember(id) {
    const cur = session.topData[session.currentTopIndex].attendance;
    const idx = cur.indexOf(id);
    if (idx > -1) cur.splice(idx, 1); else cur.push(id);
    const updated = [...cur];
    for (let i = session.currentTopIndex + 1; i < session.agenda.length; i++) {
        if (session.topData[i]) session.topData[i].attendance = [...updated];
    }
    renderSidebar();
    renderAttendance();
}

function addGlobalGuest() {
    const n = document.getElementById('guest-name').value.trim();
    const o = document.getElementById('guest-org').value.trim();
    if (!n) return;
    session.globalGuests.push({ Name: n, Org: o });
    document.getElementById('guest-name').value = ""; document.getElementById('guest-org').value = "";
    renderSidebar();
    renderGuests();
}

function renderGuests() {
    const c = document.getElementById('global-guest-list');
    if (session.globalGuests.length === 0) { c.innerHTML = '<p class="text-slate-400 text-[10px] italic">Keine Gäste erfasst.</p>'; return; }
    c.innerHTML = session.globalGuests.map((g, i) => `<div class="flex justify-between items-center p-2 bg-slate-50 border border-slate-100 rounded-lg text-xs mb-1 transition hover:bg-slate-100 font-medium text-slate-700"><div>${esc(g.Name)} <span class="text-slate-400 text-[9px] uppercase font-bold ml-1">(${esc(g.Org || '-')})</span></div><button onclick="session.globalGuests.splice(${i},1); renderGuests();" class="text-red-400 hover:text-red-600 px-1 transition">×</button></div>`).join('');
}

function updateQuorum(p, t) {
    const b = document.getElementById('quorum-info');
    const q = t > 0 && (p > (t / 2));
    b.innerText = `Präsenz: ${p} von ${t} (stimmber.)`;
    b.className = q ? "text-xs font-bold px-4 py-2 rounded-xl bg-green-50 text-green-700 border-green-200 border-2" : "text-xs font-bold px-4 py-2 rounded-xl bg-red-50 text-red-700 border-red-200 border-2";
}

function saveCurrentTopState() {
    if (!session.topData) return;

    if (session.viewMode === "top" && session.topData[session.currentTopIndex]) {
        const notesElem = document.getElementById('top-notes');
        const yesElem = document.getElementById('vote-yes');
        const noElem = document.getElementById('vote-no');
        const textElem = document.getElementById('vote-result-text');

        if (notesElem) session.topData[session.currentTopIndex].notes = notesElem.value;
        if (yesElem && noElem && textElem) {
            session.topData[session.currentTopIndex].vote = {
                yes: parseInt(yesElem.value) || 0,
                no: parseInt(noElem.value) || 0,
                text: textElem.value
            };
        }
    } else if (session.viewMode === "general") {
        const genNotesElem = document.getElementById('general-notes-area');
        if (genNotesElem) session.generalNotes = genNotesElem.value;
    }
    renderSidebar();
}

function renderSidebar() {
    document.getElementById('agenda-sidebar').innerHTML = session.agenda.map((item, index) => `
        <div onclick="switchTop(${index})" class="sidebar-item cursor-pointer p-4 border-b text-xs transition ${session.viewMode === 'top' && session.currentTopIndex === index ? 'sidebar-active shadow-inner' : ''}">
            <div class="font-bold text-slate-800 mb-1 text-[9px] uppercase tracking-tighter text-blue-900 top-nr">TOP ${esc(item.nr)}</div>
            <div class="text-slate-600 font-medium line-clamp-2 leading-tight">${esc(item.titel)}</div>
        </div>
    `).join('');
    const genItem = document.getElementById('sidebar-general-notes');
    if (session.viewMode === 'general') { genItem.classList.add('sidebar-active', 'bg-blue-100'); }
    else { genItem.classList.remove('sidebar-active', 'bg-blue-100'); }
}

function prepareAndPrint() {
    console.log("prepareAndPrint aufgerufen");
    try {
        saveCurrentTopState();
        const total = session.agenda.length;
        console.log("Drucke Sitzung mit", total, "TOPs");

        const sessionInfo = document.getElementById('print-session-info');
        if (sessionInfo) sessionInfo.innerText = `${session.title} - ${session.date}`;

        const timestamp = document.getElementById('print-timestamp');
        if (timestamp) timestamp.innerText = `Erstellt am: ${new Date().toLocaleString('de-DE')}`;

        const attContainer = document.getElementById('print-attendance-content');
        if (attContainer) {
            let attHtml = "";
            session.members.forEach((member, memberIdx) => {
                const presentIn = [];
                for (let i = 0; i < total; i++) {
                    if (session.topData[i] && session.topData[i].attendance && session.topData[i].attendance.includes(memberIdx)) {
                        presentIn.push(i);
                    }
                }
                if (presentIn.length === 0) return;
                let statusText = (presentIn.length === total) ? "vollständig" : "";
                if (!statusText) {
                    const first = presentIn[0]; const last = presentIn[presentIn.length - 1];
                    if ((last - first + 1) === presentIn.length && first === 0) statusText = `bis TOP ${session.agenda[last].nr}`;
                    else if ((last - first + 1) === presentIn.length && last === total - 1) statusText = `ab TOP ${session.agenda[first].nr}`;
                    else statusText = `anwesend während TOPs ${presentIn.map(i => session.agenda[i].nr).join(', ')}`;
                }
                const srText = member.Stadtrat?.toLowerCase() === 'ja' ? '(SR)' : '';
                attHtml += `<div class="flex py-1 px-2 text-[11px] text-slate-900"><div class="w-1/2 font-bold">${esc(member.DisplayName)} <span class="text-[9px] text-slate-400 font-normal">| ${esc(member.Typ)} ${srText}</span></div><div class="w-1/2 text-slate-500 text-right italic font-medium">${statusText}</div></div>`;
            });
            attContainer.innerHTML = `<div class="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden shadow-sm">${attHtml}</div>`;
        }

        const gSection = document.getElementById('print-guests-section');
        const gContent = document.getElementById('print-guests-content');
        if (gSection && gContent) {
            if (session.globalGuests && session.globalGuests.length > 0) {
                gSection.classList.remove('hidden');
                gContent.innerHTML = session.globalGuests.map(g => `${esc(g.Name)} (${esc(g.Org || 'Gast')})`).join(', ');
            } else gSection.classList.add('hidden');
        }

        const genSection = document.getElementById('print-general-notes-section');
        const genContent = document.getElementById('print-general-notes-content');
        if (genSection && genContent) {
            if (session.generalNotes && session.generalNotes.trim()) {
                genSection.classList.remove('hidden');
                genContent.innerText = session.generalNotes;
            } else genSection.classList.add('hidden');
        }

        const protContainer = document.getElementById('print-protocol-content');
        if (protContainer) {
            let protHtml = "";
            session.agenda.forEach((item, idx) => {
                const data = session.topData[idx]; if (!data) return;
                const notes = (data.notes || "").trim();
                const v = data.vote || { yes: 0, no: 0, text: "" };
                const hasV = (v.yes > 0 || v.no > 0 || v.text.length > 0);
                protHtml += `<div class="print-top-block"><div class="flex items-baseline gap-3 mb-4"><span class="bg-slate-900 text-white font-black text-[9px] px-2 py-0.5 rounded tracking-widest">TOP ${esc(item.nr)}</span><h4 class="text-base font-bold text-slate-900 uppercase tracking-tight">${esc(item.titel)}</h4></div>${notes ? `<div class="mb-6 pl-4 border-l-2 border-slate-200 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">${esc(notes)}</div>` : '<p class="text-[11px] italic text-slate-400 pl-4 mb-6">Keine inhaltlichen Aufzeichnungen vorhanden.</p>'}${hasV ? `<div class="bg-slate-50 p-4 rounded-xl border border-slate-100 flex justify-between items-center"><div class="flex gap-6 text-[10px] font-bold"><span class="text-green-700">Dafür: ${v.yes}</span><span class="text-red-700">Dagegen: ${v.no}</span></div><div class="text-[10px] font-black uppercase text-slate-500 italic">${esc(v.text || 'Beschluss gefasst')}</div></div>` : ''}</div>`;
            });
            protContainer.innerHTML = protHtml;
        }

        console.log("Starte Druck...");
        window.print();
    } catch (err) {
        console.error("Fehler beim Drucken:", err);
        alert("Druckfehler: " + err.message);
    }
}

function openSetupView() {
    saveCurrentTopState();
    const setupView = document.getElementById('setup-view');
    const mainWorkspace = document.getElementById('main-workspace');
    const backBtn = document.getElementById('btn-back-to-setup');
    const editBtn = document.getElementById('btn-edit-setup');

    if (setupView) setupView.classList.remove('hidden');
    if (mainWorkspace) mainWorkspace.classList.add('hidden');
    if (backBtn) backBtn.classList.add('hidden');
    if (editBtn) editBtn.classList.add('hidden');

    // Aktuelle Tagesordnung ins Textfeld laden
    const aTextElem = document.getElementById('agendaText');
    if (aTextElem && session.agenda) {
        aTextElem.value = session.agenda.map(item => `${item.nr}. ${item.titel}`).join('\n');
    }

    const distCheckBtn = document.getElementById('btn-distribution-check');
    if (distCheckBtn) distCheckBtn.classList.add('hidden');
}

function checkSeatDistribution() {
    if (!session.distribution || session.distribution.length === 0) {
        return "Keine Soll-Verteilungsdaten vorhanden (Blatt 'Verteilung' fehlt oder ist leer).";
    }

    const { memberStatuses, activeSubstitutes } = getActiveTopAttendanceAnalysis();

    // Normalisierte Helfer zur Identifizierung der Rollen
    const isPrimaryChair = (m) => {
        const k = (m.Kennung || "").toLowerCase();
        const b = (m.Bemerkung || "").toLowerCase();
        return k === 'vorsitz' || (b.includes('vorsitz') && !b.includes('stellv') && !k.includes('stellv'));
    };

    const isDeputyChair = (m) => {
        const k = (m.Kennung || "").toLowerCase();
        const b = (m.Bemerkung || "").toLowerCase();
        return k.includes('stellv') && k.includes('vorsitz');
    };

    // Wir zählen die ANWESENDEN Mitglieder pro Organisation für den aktuellen TOP
    const memberCounts = {};
    memberStatuses.forEach(ms => {
        const normOrg = ms.normOrg;
        const isPresent = ms.isPresent;
        const isStellv = ms.isStellv;
        
        if (!memberCounts[normOrg]) {
            memberCounts[normOrg] = { ordPresent: 0, stellvPresent: 0 };
        }
        
        if (isPresent) {
            if (isStellv) {
                memberCounts[normOrg].stellvPresent++;
            } else {
                memberCounts[normOrg].ordPresent++;
            }
        }
    });

    const htmlRows = [];
    session.distribution.forEach(d => {
        const normOrg = normalizeOrg(d.Organisation);
        const counts = memberCounts[normOrg] || { ordPresent: 0, stellvPresent: 0 };
        const isVorsitzRow = (d.was || "").toLowerCase().includes('vorsitz');
        
        // Finde alle anwesenden Mitglieder dieser Organisation
        const presentMembers = memberStatuses.filter(ms => ms.normOrg === normOrg && ms.isPresent);
        
        const primaryChairPresent = presentMembers.find(ms => isPrimaryChair(ms.member));
        const deputyChairPresent = presentMembers.find(ms => isDeputyChair(ms.member));

        let istOrd = 0;
        let istStellv = 0;
        let sollOrd = d.wieviel;

        if (isVorsitzRow) {
            // Für den Vorsitz-Sitz:
            // Wenn der primäre Vorsitzende anwesend ist -> besetzt
            if (primaryChairPresent) {
                istOrd = 1;
            } 
            // Wenn der primäre Vorsitzende abwesend ist, aber der Stellvertreter anwesend -> besetzt (Vertreten)
            else if (deputyChairPresent) {
                istOrd = 1;
            } else {
                istOrd = 0;
            }
            istStellv = 0;
        } else {
            // Für reguläre Sitze:
            // Zähle anwesende reguläre Mitglieder (die weder primärer noch stellvertretender Vorsitzender sind)
            const regularPresent = presentMembers.filter(ms => !isPrimaryChair(ms.member) && !isDeputyChair(ms.member));
            istOrd = regularPresent.length;
            
            // Falls der stellvertretende Vorsitzende anwesend ist, aber NICHT den Vorsitz-Sitz einnehmen musste
            // (weil der primäre Vorsitzende anwesend ist), zählt er als regulär Stimmberechtigter mit
            if (deputyChairPresent && primaryChairPresent) {
                istOrd++;
            }
            
            // Zähle anwesende reguläre Stellvertreter (Status enthält "stellv", ist aber nicht stellv. Vorsitz)
            const stellvPresent = presentMembers.filter(ms => ms.isStellv && !isDeputyChair(ms.member));
            istStellv = stellvPresent.length;
        }

        const istEffektiv = istOrd + Math.min(Math.max(0, sollOrd - istOrd), istStellv);
        
        let statusColor = "status-green";
        let statusText = "Soll erfüllt";
        
        if (istEffektiv === 0) {
            statusColor = "status-red";
            statusText = "Abwesend (0)";
        } else if (istOrd > sollOrd) {
            statusColor = "status-blue";
            statusText = "Überbesetzt";
        } else if (istEffektiv < sollOrd) {
            statusColor = "status-yellow";
            statusText = "Unterbesetzt";
        } else if (istOrd < sollOrd && istEffektiv === sollOrd) {
            statusColor = "status-green";
            statusText = "Vertreten";
        } else {
            statusColor = "status-green";
            statusText = "Soll erfüllt";
        }

        // Detail-Text anpassen für Vorsitz-Reihe vs reguläre Reihe
        let isAnwesendText = `${istOrd} / ${d.wieviel} anwesend`;
        let stellvText = isVorsitzRow ? "" : `${istStellv} anwesend`;
        if (isVorsitzRow) {
            if (primaryChairPresent) {
                isAnwesendText = "Vorsitzende(r) anwesend";
            } else if (deputyChairPresent) {
                isAnwesendText = "Vertreten durch Stellv. Vorsitz";
            } else {
                isAnwesendText = "Abwesend";
            }
        }

        htmlRows.push(`
            <tr class="border-b hover:bg-slate-50 font-medium">
                <td class="p-3 font-bold">${esc(d.Organisation)}</td>
                <td class="p-3 text-slate-500">${esc(d.was || "-")}</td>
                <td class="p-3 text-center font-bold">${d.wieviel}</td>
                <td class="p-3 text-center ${istOrd < sollOrd && istEffektiv < sollOrd ? 'text-amber-600 font-bold' : ''}">${isAnwesendText}</td>
                <td class="p-3 text-center">${stellvText}</td>
                <td class="p-3 text-center"><span class="px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${statusColor}">${statusText}</span></td>
            </tr>
        `);
    });

    return htmlRows.join('');
}

function openDistributionModal() {
    const tableBody = document.getElementById('distribution-modal-table-body');
    if (tableBody) {
        if (!session.distribution || session.distribution.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 italic">Keine Verteilungsdaten vorhanden. Bitte laden Sie eine Excel-Datei hoch, die das Tabellenblatt "Verteilung" enthält.</td></tr>`;
        } else {
            tableBody.innerHTML = checkSeatDistribution();
        }
    }
    document.getElementById('distribution-modal').classList.remove('hidden');
}

function closeDistributionModal() {
    document.getElementById('distribution-modal').classList.add('hidden');
}

function confirmReset() { document.getElementById('reset-modal').classList.remove('hidden'); }
function cancelReset() { document.getElementById('reset-modal').classList.add('hidden'); }
function executeReset() { location.reload(); }
function exportFullSession() { saveCurrentTopState(); const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(session)); const dl = document.createElement('a'); dl.setAttribute("href", dataStr); dl.setAttribute("download", `JHA_Export_${session.date}.json`); dl.click(); }

function importFullSession(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const loaded = JSON.parse(e.target.result);
            if (!Array.isArray(loaded.members) || !Array.isArray(loaded.agenda)) {
                alert("Die Datei ist keine gültige JHA-Sitzungsdatei (Mitglieder oder Tagesordnung fehlen).");
                return;
            }
            // Fehlende Felder (z.B. aus älteren Exporten) mit Defaults auffüllen
            loaded.title = loaded.title || "Jugendhilfeausschuss";
            loaded.date = loaded.date || new Date().toLocaleDateString('de-DE');
            loaded.globalGuests = loaded.globalGuests || [];
            loaded.generalNotes = loaded.generalNotes || "";
            loaded.distribution = loaded.distribution || [];
            loaded.topData = loaded.topData || {};
            loaded.currentTopIndex = loaded.currentTopIndex || 0;
            loaded.viewMode = "top";
            Object.values(loaded.topData).forEach(d => {
                d.attendance = d.attendance || [];
                d.notes = d.notes || "";
                d.vote = d.vote || { yes: 0, no: 0, text: "" };
            });
            session = loaded;
            startWorkspace();
        } catch (err) {
            console.error("Fehler beim Laden der Sitzungsdatei:", err);
            alert("Fehler beim Laden: " + err.message);
        } finally {
            // Input zurücksetzen, damit dieselbe Datei erneut gewählt werden kann
            event.target.value = "";
        }
    };
    reader.readAsText(file);
}

// --- INTIALIZATION ---
window.addEventListener('DOMContentLoaded', () => {
    // Start immer im Setup-Modus; bestehende Sitzungen werden über "Laden" importiert.
    const setupView = document.getElementById('setup-view');
    const mainWorkspace = document.getElementById('main-workspace');
    if (setupView) setupView.classList.remove('hidden');
    if (mainWorkspace) mainWorkspace.classList.add('hidden');
    console.log("Setup-Modus.");
});
