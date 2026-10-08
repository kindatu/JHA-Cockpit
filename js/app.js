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

// --- CORE FUNCTIONS ---
async function readCsv(file) {
    console.log("Starte CSV-Einlesen...");
    return new Promise((resolve, reject) => {
        if (typeof Papa === 'undefined') {
            reject(new Error("PapaParse Bibliothek nicht geladen!"));
            return;
        }
        Papa.parse(file, {
            header: false,
            skipEmptyLines: 'greedy',
            encoding: "windows-1252",
            complete: function (results) {
                console.log("CSV erfolgreich eingelesen:", results.data.length, "Zeilen");
                const rows = results.data;
                if (rows.length < 1) {
                    resolve([]);
                    return;
                }

                const rawHeaders = rows[0].map(h => String(h || "").trim());
                const headers = rawHeaders.map(h => {
                    const s = h.toLowerCase();
                    if (s === 'vorname') return 'Vorname';
                    if (s === 'name' || s === 'nachname') return 'Nachname';
                    if (s.includes('stat') || s.includes('rolle')) return 'Status';
                    if (s.includes('org') || s.includes('frak') || s.includes('part') || s.includes('typ')) return 'Typ';
                    if (s.includes('stadt')) return 'Stadtrat';
                    if (s.includes('kennung')) return 'Kennung';
                    if (s.includes('bemerk')) return 'Bemerkung';
                    return h;
                });

                let members = rows.slice(1).map(values => {
                    const obj = { Vorname: "", Nachname: "", Status: "", Typ: "", Stadtrat: "", Kennung: "", Bemerkung: "" };
                    headers.forEach((header, i) => { if (values[i] !== undefined) obj[header] = String(values[i] || "").trim(); });
                    obj['DisplayName'] = `${obj['Vorname']} ${obj['Nachname']}`.trim() || "Unbekannt";
                    return obj;
                });

                const getWeight = (s) => {
                    s = (s || "").toLowerCase();
                    const isStellv = s.includes('stellv');
                    const isVoting = s.includes('stimmbereit') || s.includes('stimmberecht') || s.includes('beschließend');
                    const isConsulting = s.includes('beratend');
                    if (isVoting && !isStellv) return 1;
                    if (isConsulting && !isStellv) return 2;
                    if (isStellv) return 3;
                    return 4;
                };

                members.sort((a, b) => {
                    const wA = getWeight(a.Status); const wB = getWeight(b.Status);
                    if (wA !== wB) return wA - wB;
                    return (a.Typ || "").localeCompare(b.Typ || "") || (a.DisplayName || "").localeCompare(b.DisplayName || "");
                });

                resolve(members);
            },
            error: function (err) {
                console.error("PapaParse Fehler:", err);
                reject(err);
            }
        });
    });
}

async function readXlsx(file) {
    console.log("Starte Excel-Einlesen...");
    return new Promise((resolve, reject) => {
        if (typeof XLSX === 'undefined') {
            reject(new Error("SheetJS (xlsx) Bibliothek nicht geladen!"));
            return;
        }
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                // Finde das Blatt für die Mitgliederliste (JHA oder erstes Blatt)
                let membersSheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'jha') || workbook.SheetNames[0];
                const worksheet = workbook.Sheets[membersSheetName];
                
                // Konvertiere Worksheet zu JSON-Array (Header-basiert)
                const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
                
                if (rows.length < 1) {
                    resolve([]);
                    return;
                }

                // Verteilung einlesen falls vorhanden
                let distSheetName = workbook.SheetNames.find(n => n.toLowerCase() === 'verteilung');
                if (distSheetName) {
                    const distWorksheet = workbook.Sheets[distSheetName];
                    const distRows = XLSX.utils.sheet_to_json(distWorksheet, { header: 1, defval: "" });
                    if (distRows.length > 1) {
                        const rawDistHeaders = distRows[0].map(h => String(h || "").trim());
                        const orgIdx = rawDistHeaders.findIndex(h => h.toLowerCase().includes('org'));
                        const countIdx = rawDistHeaders.findIndex(h => h.toLowerCase().includes('wieviel') || h.toLowerCase().includes('anzahl'));
                        const roleIdx = rawDistHeaders.findIndex(h => h.toLowerCase().includes('was') || h.toLowerCase().includes('rolle') || h.toLowerCase().includes('status'));
                        
                        if (orgIdx !== -1 && countIdx !== -1) {
                            session.distribution = distRows.slice(1).map(row => ({
                                Organisation: String(row[orgIdx] || "").trim(),
                                wieviel: parseInt(row[countIdx]) || 0,
                                was: roleIdx !== -1 ? String(row[roleIdx] || "").trim() : ""
                            })).filter(d => d.Organisation && d.wieviel > 0);
                            console.log("Verteilungsdaten eingelesen:", session.distribution.length, "Einträge");
                        }
                    }
                } else {
                    session.distribution = [];
                }

                // Header normalisieren
                const rawHeaders = rows[0].map(h => String(h || "").trim());
                const headers = rawHeaders.map(h => {
                    const s = h.toLowerCase();
                    if (s === 'vorname') return 'Vorname';
                    if (s === 'name' || s === 'nachname') return 'Nachname';
                    if (s.includes('stat') || s.includes('rolle')) return 'Status';
                    if (s.includes('org') || s.includes('frak') || s.includes('part') || s.includes('typ')) return 'Typ';
                    if (s.includes('stadt')) return 'Stadtrat';
                    if (s.includes('kennung')) return 'Kennung';
                    if (s.includes('bemerk')) return 'Bemerkung';
                    return h;
                });

                let members = rows.slice(1).map(values => {
                    const obj = { Vorname: "", Nachname: "", Status: "", Typ: "", Stadtrat: "", Kennung: "", Bemerkung: "" };
                    headers.forEach((header, i) => { if (values[i] !== undefined) obj[header] = String(values[i] || "").trim(); });
                    obj['DisplayName'] = `${obj['Vorname']} ${obj['Nachname']}`.trim() || "Unbekannt";
                    return obj;
                });

                // Leere Zeilen filtern
                members = members.filter(m => m.Vorname || m.Nachname);

                const getWeight = (s) => {
                    s = (s || "").toLowerCase();
                    const isStellv = s.includes('stellv');
                    const isVoting = s.includes('stimmbereit') || s.includes('stimmberecht') || s.includes('beschließend');
                    const isConsulting = s.includes('beratend');
                    if (isVoting && !isStellv) return 1;
                    if (isConsulting && !isStellv) return 2;
                    if (isStellv) return 3;
                    return 4;
                };

                members.sort((a, b) => {
                    const wA = getWeight(a.Status); const wB = getWeight(b.Status);
                    if (wA !== wB) return wA - wB;
                    return (a.Typ || "").localeCompare(b.Typ || "") || (a.DisplayName || "").localeCompare(b.DisplayName || "");
                });

                console.log("Excel erfolgreich eingelesen:", members.length, "Mitglieder");
                resolve(members);
            } catch (err) {
                console.error("Fehler beim Verarbeiten der Excel-Datei:", err);
                reject(err);
            }
        };
        reader.onerror = function(err) {
            reject(err);
        };
        reader.readAsArrayBuffer(file);
    });
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
            const fileName = mFile.name.toLowerCase();
            if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
                session.members = await readXlsx(mFile);
            } else {
                session.members = await readCsv(mFile);
            }
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
        const s = (m.Status || "").toLowerCase();
        const isStellv = s.includes('stellv');
        const isVoting = (s.includes('stimmbereit') || s.includes('stimmberecht') || s.includes('beschließend'));
        const isConsulting = s.includes('beratend');
        
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
        const getWeight = (s) => {
            s = (s || "").toLowerCase();
            const isStellv = s.includes('stellv');
            const isVoting = s.includes('stimmbereit') || s.includes('stimmberecht') || s.includes('beschließend');
            const isConsulting = s.includes('beratend');
            if (isVoting && !isStellv) return 1;
            if (isConsulting && !isStellv) return 2;
            if (isStellv) return 3;
            return 4;
        };
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
            <td class="p-3">${sr}${vsBadge}${m.DisplayName}${substitutionLabel}</td>
            <td class="p-3 text-[10px] text-slate-500 font-bold uppercase tracking-tighter">${m.Typ || '-'}</td>
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
    c.innerHTML = session.globalGuests.map((g, i) => `<div class="flex justify-between items-center p-2 bg-slate-50 border border-slate-100 rounded-lg text-xs mb-1 transition hover:bg-slate-100 font-medium text-slate-700"><div>${g.Name} <span class="text-slate-400 text-[9px] uppercase font-bold ml-1">(${g.Org || '-'})</span></div><button onclick="session.globalGuests.splice(${i},1); renderGuests();" class="text-red-400 hover:text-red-600 px-1 transition">×</button></div>`).join('');
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
            <div class="font-bold text-slate-800 mb-1 text-[9px] uppercase tracking-tighter text-blue-900 top-nr">TOP ${item.nr}</div>
            <div class="text-slate-600 font-medium line-clamp-2 leading-tight">${item.titel}</div>
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
                attHtml += `<div class="flex py-1 px-2 text-[11px] text-slate-900"><div class="w-1/2 font-bold">${member.DisplayName} <span class="text-[9px] text-slate-400 font-normal">| ${member.Typ} ${srText}</span></div><div class="w-1/2 text-slate-500 text-right italic font-medium">${statusText}</div></div>`;
            });
            attContainer.innerHTML = `<div class="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden shadow-sm">${attHtml}</div>`;
        }

        const gSection = document.getElementById('print-guests-section');
        const gContent = document.getElementById('print-guests-content');
        if (gSection && gContent) {
            if (session.globalGuests && session.globalGuests.length > 0) {
                gSection.classList.remove('hidden');
                gContent.innerHTML = session.globalGuests.map(g => `${g.Name} (${g.Org || 'Gast'})`).join(', ');
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
                protHtml += `<div class="print-top-block"><div class="flex items-baseline gap-3 mb-4"><span class="bg-slate-900 text-white font-black text-[9px] px-2 py-0.5 rounded tracking-widest">TOP ${item.nr}</span><h4 class="text-base font-bold text-slate-900 uppercase tracking-tight">${item.titel}</h4></div>${notes ? `<div class="mb-6 pl-4 border-l-2 border-slate-200 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">${notes}</div>` : '<p class="text-[11px] italic text-slate-400 pl-4 mb-6">Keine inhaltlichen Aufzeichnungen vorhanden.</p>'}${hasV ? `<div class="bg-slate-50 p-4 rounded-xl border border-slate-100 flex justify-between items-center"><div class="flex gap-6 text-[10px] font-bold"><span class="text-green-700">Dafür: ${v.yes}</span><span class="text-red-700">Dagegen: ${v.no}</span></div><div class="text-[10px] font-black uppercase text-slate-500 italic">${v.text || 'Beschluss gefasst'}</div></div>` : ''}</div>`;
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
                <td class="p-3 font-bold">${d.Organisation}</td>
                <td class="p-3 text-slate-500">${d.was || "-"}</td>
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
