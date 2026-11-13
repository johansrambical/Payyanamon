const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const upload = multer({ dest: 'uploads/' });

const db = new DatabaseSync('./kalamela.db');

// --- DATABASE INITIALIZATION ---
db.exec(`CREATE TABLE IF NOT EXISTS contestants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    church TEXT,
    event_name TEXT,
    event_type TEXT,
    chest_number TEXT,
    j1_score REAL DEFAULT 0,
    j2_score REAL DEFAULT 0,
    total REAL DEFAULT 0,
    average REAL DEFAULT 0,
    rank INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0
)`);
try { db.exec("ALTER TABLE contestants ADD COLUMN category TEXT DEFAULT 'Group 1'"); } catch (e) {}
try { db.exec("ALTER TABLE contestants ADD COLUMN gender TEXT DEFAULT 'Male'"); } catch (e) {}

// Setup and forcefully update the User accounts
db.exec(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT,
    role TEXT
)`);
db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', 'admin', 'admin')").run();
db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES ('editor', 'editor', 'editor')").run();
try { db.prepare("DELETE FROM users WHERE username = 'superadmin'").run(); } catch(e) {}

db.prepare("UPDATE users SET password = 'admin', role = 'admin' WHERE username = 'admin'").run();
db.prepare("UPDATE users SET password = 'editor', role = 'editor' WHERE username = 'editor'").run();

// Setup Settings table
db.exec(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    main_name TEXT,
    sub_name TEXT,
    event_title TEXT
)`);
try { db.exec("ALTER TABLE settings ADD COLUMN default_prefix TEXT DEFAULT 'TE'"); } catch (e) {}

const settingsCount = db.prepare("SELECT COUNT(*) as c FROM settings").get().c;
if (settingsCount === 0) {
    db.prepare("INSERT INTO settings (id, main_name, sub_name, event_title, default_prefix) VALUES (1, ?, ?, ?, ?)").run('Mar Thoma Yuvajana Sakhyam', 'Thiruvalla East Centre', 'അനന്യം-26', 'TE');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname, { index: false })); 

// --- AUTHENTICATION & ROLES ---
app.use((req, res, next) => {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(/(?:^|; )auth=([^;]+)/);
    if (match) req.userRole = match[1];
    next();
});

function requireRole(roles) {
    return (req, res, next) => {
        if (!req.userRole || !roles.includes(req.userRole)) {
            return res.status(403).json({ error: "Forbidden. Insufficient permissions." });
        }
        next();
    };
}

function getLoginHtml(settings) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Login - Tabulation</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@300;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Inter', sans-serif; background: #f9fafb; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 40px 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 100%; max-width: 320px; text-align: center; border: 1px solid #e5e7eb; }
            input { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #d1d5db; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
            button { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 15px; }
            button:hover { background: #4338ca; }
        </style>
    </head>
    <body>
        <div class="card">
            <img src="/Sabha%20Logo.png" alt="Sabha Logo" style="height: 70px; margin-bottom: 10px;">
            <h3 style="margin: 0; font-family: 'Montserrat', sans-serif; font-weight: 300;">${settings.main_name}</h3>
            <h4 style="margin: 5px 0 25px 0; font-family: 'Montserrat', sans-serif; font-weight: 700;">${settings.sub_name}</h4>
            
            <form method="POST" action="/login">
                <input type="text" name="username" placeholder="Username" required autocomplete="off">
                <input type="password" name="password" placeholder="Password" required>
                <button type="submit">Secure Login</button>
            </form>
        </div>
    </body>
    </html>`;
}

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.send('Missing credentials. <a href="/">Try again</a>');
    
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username.toLowerCase().trim());
    if (user && user.password === password) {
        res.setHeader('Set-Cookie', `auth=${user.role}; HttpOnly; Path=/`);
        res.redirect('/');
    } else {
        res.send('<div style="font-family:sans-serif; text-align:center; margin-top:50px;"><h2>Invalid credentials</h2><a href="/">Try again</a></div>');
    }
});

app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `auth=; HttpOnly; Path=/; Max-Age=0`);
    res.redirect('/');
});

app.post('/api/settings', requireRole(['admin']), (req, res) => {
    const { main_name, sub_name, event_title, default_prefix } = req.body;
    db.prepare("UPDATE settings SET main_name = ?, sub_name = ?, event_title = ?, default_prefix = ? WHERE id = 1")
      .run(main_name, sub_name, event_title, default_prefix || 'TE');
    res.json({ success: true });
});

app.post('/api/regenerate_chest_numbers', requireRole(['admin']), (req, res) => {
    try {
        const currentSettings = db.prepare("SELECT default_prefix FROM settings WHERE id = 1").get() || { default_prefix: 'TE' };
        const defaultPrefix = currentSettings.default_prefix;
        
        const contestants = db.prepare("SELECT * FROM contestants ORDER BY category ASC, church ASC, name ASC").all();
        
        const personMap = new Map();
        const counters = new Map();

        db.exec("BEGIN");
        const updateStmt = db.prepare("UPDATE contestants SET chest_number = ? WHERE id = ?");

        contestants.forEach(c => {
            const prefix = getEventPrefix(c.event_name, c.event_type, defaultPrefix);
            
            let identityKey;
            if ((c.event_type || '').toLowerCase() === 'team') {
                identityKey = prefix + '|' + (c.church || '').trim().toLowerCase() + '|' + (c.category || '').trim().toLowerCase();
            } else {
                identityKey = prefix + '|' + (c.name || '').trim().toLowerCase() + '|' + (c.church || '').trim().toLowerCase() + '|' + (c.category || '').trim().toLowerCase();
            }
            
            if (!personMap.has(identityKey)) {
                const counterKey = prefix + '|' + (c.category || '').trim().toLowerCase();
                
                if (!counters.has(counterKey)) {
                    if (!prefix.endsWith('-')) { 
                        counters.set(counterKey, (c.category.toLowerCase().includes('group 2')) ? 200 : 100);
                    } else { 
                        counters.set(counterKey, 0);
                    }
                }
                
                let currentVal = counters.get(counterKey) + 1;
                counters.set(counterKey, currentVal);
                
                let newChest = prefix + String(currentVal);
                personMap.set(identityKey, newChest);
            }
            
            updateStmt.run(personMap.get(identityKey), c.id);
        });

        db.exec("COMMIT");
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        try { db.exec("ROLLBACK"); } catch(e) {}
        res.status(500).json({ error: "Failed to regenerate chest numbers" });
    }
});

// Bulk Rename API
app.post('/api/rename_church', requireRole(['admin']), (req, res) => {
    try {
        const { oldName, newName } = req.body;
        if (!oldName || !newName) return res.status(400).json({ error: "Missing names" });
        db.prepare("UPDATE contestants SET church = ? WHERE church = ?").run(newName.trim(), oldName.trim());
        res.json({ success: true });
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: "Rename failed" });
    }
});

// --- HELPER FUNCTIONS ---
function getEventPrefix(eventName, eventType, defaultPrefix = 'TE') {
    const type = (eventType || '').toLowerCase();
    const name = (eventName || '').toLowerCase();
    
    if (type === 'team' || type === 'group') {
        if (name.includes('choreography') || name.includes('കൊറിയോഗ്രഫി')) return 'CHR-';
        if (name.includes('margamkali') || name.includes('മാർഗ്ഗംകളി')) return 'MAR-';
        if (name.includes('tableau') || name.includes('ടാബ്ലോ')) return 'TAB-';
        if (name.includes('mime') || name.includes('മൂകാഭിനയം')) return 'MIM-';
        if (name.includes('song') || name.includes('ഗാനം')) return 'GS-';
        if (name.includes('natak') || name.includes('നാടകം') || name.includes('play') || name.includes('drama')) return 'NAT-';
        return 'GRP-'; 
    }
    return defaultPrefix; 
}

function getNextChestNumber(prefix, category) {
    const allRows = db.prepare("SELECT chest_number FROM contestants WHERE chest_number LIKE ?").all(`${prefix}%`);
    
    let isTeam = prefix.endsWith('-');
    let isGroup2 = category && category.toLowerCase().includes('group 2');
    
    let maxNum = isTeam ? 0 : (isGroup2 ? 200 : 100);

    allRows.forEach(r => {
        if (r.chest_number) {
            const matches = r.chest_number.match(/\d+/);
            if (matches) {
                const val = parseInt(matches[0], 10);
                if (!isTeam) {
                    if (isGroup2 && val > 200 && val < 300) {
                        if (val > maxNum) maxNum = val;
                    } else if (!isGroup2 && val > 100 && val < 200) {
                        if (val > maxNum) maxNum = val;
                    }
                } else {
                    if (val > maxNum) maxNum = val;
                }
            }
        }
    });
    
    return prefix + String(maxNum + 1);
}

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MTYS Kalamela Tabulation</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@300;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #4f46e5;
            --primary-hover: #4338ca;
            --success: #10b981;
            --success-hover: #059669;
            --danger: #ef4444;
            --danger-hover: #dc2626;
            --bg: #f9fafb;
            --surface: #ffffff;
            --text-main: #111827;
            --text-muted: #6b7280;
            --border: #e5e7eb;
        }
        body { font-family: 'Inter', sans-serif; padding: 0; margin: 0; background: var(--bg); color: var(--text-main); }
        .navbar { background: linear-gradient(135deg, #1e1b4b, #312e81); padding: 15px 40px; display: flex; justify-content: space-between; align-items: center; color: white; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        .nav-brand { display: flex; align-items: center; gap: 15px; }
        .nav-brand img { height: 50px; }
        .nav-titles { display: flex; flex-direction: column; justify-content: center; }
        .nav-title-main { font-family: 'Montserrat', sans-serif; font-weight: 300; font-size: 18px; letter-spacing: 0.5px; margin: 0; }
        .nav-title-sub { font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 14px; letter-spacing: 1px; margin: 0; color: #fde047; }
        .nav-links button { background: transparent; border: none; color: #a5b4fc; font-size: 15px; font-weight: 600; cursor: pointer; padding: 10px 18px; border-radius: 8px; transition: all 0.2s ease; }
        .nav-links button:hover { color: white; background: rgba(255,255,255,0.1); }
        .nav-links button.active { color: white; background: var(--primary); box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .container { padding: 30px 40px; max-width: 1400px; margin: auto; }
        .flex { display: flex; gap: 24px; margin-bottom: 24px; }
        .flex > div { flex: 1; }
        .card { background: var(--surface); padding: 24px; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card h3 { margin-top: 0; color: #374151; font-weight: 600; border-bottom: 2px solid #f3f4f6; padding-bottom: 10px; margin-bottom: 20px; }
        .btn { padding: 9px 16px; background: var(--primary); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.1s; }
        .btn:hover { background: var(--primary-hover); }
        .btn-green { background: var(--success); }
        .btn-green:hover { background: var(--success-hover); }
        .btn-danger { background: var(--danger); }
        .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text-main); }
        input[type="text"], input[type="file"], select, input[type="number"] { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); font-size: 14px; outline: none; }
        input[type="number"] { width: 70px; text-align: center; font-weight: 600; }
        table { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 10px; }
        th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; }
        th { background: #f8fafc; color: var(--text-muted); font-weight: 600; font-size: 13px; text-transform: uppercase; }
        tbody tr:hover { background: #f1f5f9; }
        .tab-container { display: flex; overflow-x: auto; gap: 8px; margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
        .tab-button { padding: 8px 16px; background: white; border: 1px solid var(--border); cursor: pointer; border-radius: 8px; color: var(--text-muted); font-weight: 500; }
        .tab-button.active { background: var(--primary); color: white; border-color: var(--primary); }
        .rank-badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-weight: 700; font-size: 12px; }
        .rank-1 { background: #fef08a; color: #854d0e; }
        .rank-2 { background: #e2e8f0; color: #475569; }
        .rank-3 { background: #fed7aa; color: #9a3412; }
        ol { padding-left: 20px; margin: 0; }
        ol li { margin-bottom: 8px; font-size: 14px; }
        .edit-icon { cursor: pointer; margin-left: 6px; opacity: 0.5; font-size: 12px; }
        .edit-icon:hover { opacity: 1; }
        
        #undoToast {
            display: none; position: fixed; bottom: 20px; right: 20px; 
            background: #1e293b; color: white; padding: 15px 20px; 
            border-radius: 8px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.2); 
            z-index: 9999; font-weight: 500;
        }
        #undoToast button {
            background: transparent; border: none; color: #a5b4fc; 
            font-weight: bold; cursor: pointer; margin-left: 10px; 
            text-decoration: underline; font-size: 14px;
        }
        .footer {
            text-align: center; padding: 20px; font-size: 12px; color: #64748b; 
            font-family: 'Montserrat', sans-serif; margin-top: 40px; 
            border-top: 1px solid var(--border); background: white;
        }
    </style>
</head>
<body>
    <div class="navbar">
        <div class="nav-brand">
            <img src="/Sabha%20Logo.png" alt="Sabha Logo" onerror="this.style.display='none';">
            <div class="nav-titles">
                <p class="nav-title-main">__MAIN_NAME__</p>
                <p class="nav-title-sub">__SUB_NAME__</p>
            </div>
            <img src="/Ananyam.png" alt="Ananyam-26" style="height: 40px; margin-left: 10px;" onerror="this.style.display='none';">
        </div>
        <div style="display: flex; align-items: center;">
            <div class="nav-links" id="navbarLinks">
                <button id="nav-Group 1" class="active" onclick="setCategory('Group 1')">Group 1</button>
                <button id="nav-Group 2" onclick="setCategory('Group 2')">Group 2</button>
                <button id="nav-Team Events" onclick="setCategory('Team Events')">Team Events</button>
            </div>
            <a href="/logout" style="margin-left: 20px; color: #fca5a5; font-weight: bold; text-decoration: none; font-size: 14px; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 6px;">Logout</a>
        </div>
    </div>

    <div class="container">
        
        <div class="card" id="settingsSection" style="display: none; margin-bottom: 24px;">
            <h3 style="margin-bottom: 15px;">⚙️ Organization Settings (Admin)</h3>
            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                <div style="flex: 1; min-width: 200px;">
                    <label style="font-size: 12px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 5px;">Main Organization Name</label>
                    <input type="text" id="setMain" value="__MAIN_NAME__">
                </div>
                <div style="flex: 1; min-width: 200px;">
                    <label style="font-size: 12px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 5px;">Sub-Unit / Centre Name</label>
                    <input type="text" id="setSub" value="__SUB_NAME__">
                </div>
                <div style="flex: 1; min-width: 150px;">
                    <label style="font-size: 12px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 5px;">Event Name</label>
                    <input type="text" id="setEvent" value="__EVENT_TITLE__">
                </div>
                <div style="flex: 0.5; min-width: 100px;">
                    <label style="font-size: 12px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 5px;">Chest Prefix</label>
                    <input type="text" id="setPrefix" value="__DEFAULT_PREFIX__">
                </div>
                <div style="display: flex; gap: 10px; align-items: flex-end;">
                    <button class="btn btn-green" style="height: 38px; margin-bottom: 15px;" onclick="saveSettings()">Save</button>
                    <button class="btn btn-outline" style="height: 38px; margin-bottom: 15px; border-color: #ea580c; color: #ea580c;" onclick="regenerateChestNumbers()">🔄 Auto-Fix Chest Numbers</button>
                </div>
            </div>
        </div>

        <div class="flex">
            <div class="card" style="flex: 1.1;" id="manageContestantsCard">
                <h3>📂 Manage Contestants</h3>
                <div id="csvUploadSection" style="display: flex; gap: 10px; margin-bottom: 15px;">
                    <input type="file" id="csvFile" accept=".csv" style="flex: 1;">
                    <button class="btn" onclick="uploadCSV()">Upload CSV</button>
                </div>
                <div id="manualAddSection" style="border-top: 1px solid var(--border); padding-top: 15px;">
                    <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--text-muted);">➕ Manually Add Participant</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
                        <input type="text" id="mName" placeholder="Participant Name">
                        <input type="text" id="mChurch" placeholder="Church Name">
                        <select id="mGender">
                            <option value="Male">Male</option>
                            <option value="Female">Female</option>
                        </select>
                        <input type="text" id="mEvent" placeholder="Event Name">
                        <select id="mType">
                            <option value="individual">Individual</option>
                            <option value="team">Team Event</option>
                        </select>
                        <button class="btn btn-green" onclick="addManually()">Add to Event</button>
                    </div>
                </div>

                <div id="bulkRenameSection" style="border-top: 1px solid var(--border); padding-top: 15px; margin-top: 15px;">
                    <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--text-muted);">🛠️ Fix Church Spellings (Bulk Rename)</h4>
                    <div style="display: flex; gap: 8px;">
                        <select id="wrongChurchSelect" style="flex: 1; font-size: 14px;"></select>
                        <input type="text" id="correctChurchName" placeholder="Correct Spelling" style="flex: 1;">
                        <button class="btn btn-outline" style="border-color: #ea580c; color: #ea580c;" onclick="renameChurch()">Rename All</button>
                    </div>
                </div>

            </div>

            <div class="card" style="flex: 1.5;" id="printablesSection">
                <h3>🖨️ Printables & Reports</h3>
                
                <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 12px; background: #e0f2fe; padding: 12px; border-radius: 8px; border: 1px solid #7dd3fc; flex-wrap: wrap;">
                    <select id="churchSelect" style="flex: 1; min-width: 150px;"></select>
                    <button class="btn btn-outline" style="border-color: #0284c7; color: #0284c7; font-weight: bold;" onclick="downloadChurchPrizes()">📄 Print / PDF Prizes</button>
                    <button class="btn btn-outline" style="border-color: #0284c7; color: #0284c7; font-weight: bold;" onclick="printAllChurchPoints()">🏛️ Overall Points List</button>
                </div>

                <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 12px; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid var(--border); flex-wrap: wrap;">
                    <select id="printEventSelect" style="flex: 1; min-width: 150px;"></select>
                    <button class="btn btn-outline" onclick="printDocument('judge1')">Judge 1</button>
                    <button class="btn btn-outline" onclick="printDocument('judge2')">Judge 2</button>
                    <button class="btn btn-outline" onclick="printDocument('participant')">Participants</button>
                    <button class="btn btn-outline" onclick="printDocument('master')">Tabulation</button>
                    <button class="btn btn-outline" style="border-color: #b8860b; color: #b8860b; font-weight: bold;" onclick="printCertificates()">📜 Certificates</button>
                </div>

                <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 12px; background: #f0fdf4; padding: 12px; border-radius: 8px; border: 1px solid #86efac; flex-wrap: wrap;">
                    <button class="btn btn-outline" style="border-color: #059669; color: #059669; font-weight: bold;" onclick="printAllJudgeSheets(1)">📄 Print All Judge 1</button>
                    <button class="btn btn-outline" style="border-color: #059669; color: #059669; font-weight: bold;" onclick="printAllJudgeSheets(2)">📄 Print All Judge 2</button>
                    <button class="btn btn-outline" style="border-color: #059669; color: #059669; font-weight: bold;" onclick="printParticipantSummary()">👥 Master Participant Summary</button>
                </div>
                
                <div style="display: flex; gap: 10px; background: #fffbeb; padding: 12px; border-radius: 8px; border: 1px solid #fde68a; flex-wrap: wrap;">
                    <button class="btn" style="background: #4f46e5;" onclick="printChestCards()">🪪 Print 12x18 Chest Cards</button>
                    <button class="btn" style="background: #ea580c;" onclick="printAllRankings()">Print All Rankings</button>
                    <button class="btn" style="background: #9333ea;" onclick="printChurchSummary()">Church Prize Summary</button>
                </div>
            </div>
        </div>

        <div class="card" id="tabulationSection">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <h3 style="border: none; margin: 0;">📝 Data Entry & Auto-Ranking</h3>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-outline" onclick="loadContestants()">Refresh Data</button>
                    <button class="btn btn-green" onclick="downloadCSV()">Export Ranked CSV</button>
                </div>
            </div>
            <div id="tabs" class="tab-container"></div>
            <div id="tabContent" style="overflow-x: auto;">
                <table id="tabulationTable">
                    <thead>
                        <tr>
                            <th>Chest No.</th>
                            <th>Name</th>
                            <th>Church</th>
                            <th style="text-align: center;">J1 (100)</th>
                            <th style="text-align: center;">J2 (100)</th>
                            <th>Action</th>
                            <th>Total</th>
                            <th>Avg</th>
                            <th>Rank</th>
                            <th>Pts</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>

        <div class="flex" id="leaderboardSection">
            <div class="card">
                <h3 style="margin-bottom: 10px;">🏛️ Church Championship</h3>
                <ol id="churchList"></ol>
            </div>
            <div class="card">
                <h3 style="margin-bottom: 5px;">👑 Kalaprathibha (Male)</h3>
                <p style="margin: 0 0 15px 0; font-size: 12px; color: var(--text-muted);">*Must reach 13 points to win title</p>
                <ol id="kalaprathibhaList"></ol>
            </div>
            <div class="card">
                <h3 style="margin-bottom: 5px;">🌟 Kalathilakam (Female)</h3>
                <p style="margin: 0 0 15px 0; font-size: 12px; color: var(--text-muted);">*Must reach 13 points to win title</p>
                <ol id="kalathilakamList"></ol>
            </div>
        </div>
    </div>
    
    <div class="footer">
        &copy;2026 All Rights Reserved and Designed and Developed by johansrambical
    </div>

    <div id="undoToast">
        Participant deleted successfully. 
        <button onclick="undoDelete()">Undo (Ctrl+Z)</button>
    </div>

    <script>
        const USER_ROLE = '__USER_ROLE__';
        const ORG_MAIN = '__MAIN_NAME__';
        const ORG_SUB = '__SUB_NAME__';
        const EVENT_TITLE = '__EVENT_TITLE__';
        const DEFAULT_PREFIX = '__DEFAULT_PREFIX__';
        
        let contestantsData = [];
        let activeCategory = 'Group 1';
        let activeTab = '';
        let lastDeletedContestant = null;

        function applyRoleRestrictions() {
            if (USER_ROLE === 'admin') {
                document.getElementById('settingsSection').style.display = 'block';
            } else if (USER_ROLE === 'editor') {
                document.getElementById('manageContestantsCard').style.display = 'none';
            }
        }

        async function saveSettings() {
            const main_name = document.getElementById('setMain').value.trim();
            const sub_name = document.getElementById('setSub').value.trim();
            const event_title = document.getElementById('setEvent').value.trim();
            const default_prefix = document.getElementById('setPrefix').value.trim() || 'TE';
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({main_name, sub_name, event_title, default_prefix})
            });
            if (res.ok) window.location.reload();
            else alert('Failed to save settings.');
        }

        async function regenerateChestNumbers() {
            if (confirm("⚠️ WARNING: This will automatically overwrite and fix ALL chest numbers in the database based on your current Prefix settings, category rules (100 vs 200), and Team Event rules. It will NOT delete any participants or scores.\\n\\nAre you sure you want to regenerate all chest numbers?")) {
                const res = await fetch('/api/regenerate_chest_numbers', { method: 'POST' });
                if (res.ok) {
                    alert('✅ Chest numbers successfully regenerated and perfectly aligned!');
                    window.location.reload();
                } else {
                    alert('❌ Failed to regenerate chest numbers.');
                }
            }
        }

        async function renameChurch() {
            const oldName = document.getElementById('wrongChurchSelect').value;
            const newName = document.getElementById('correctChurchName').value.trim();
            if (!oldName || !newName) return alert("Select an existing church and type the new name.");
            if (confirm(\`Are you sure you want to completely rename ALL instances of "\${oldName}" to "\${newName}"?\`)) {
                const res = await fetch('/api/rename_church', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldName, newName })
                });
                if (res.ok) {
                    alert("Church names merged successfully!");
                    window.location.reload();
                } else {
                    alert("Failed to rename church.");
                }
            }
        }

        function setCategory(cat) {
            activeCategory = cat;
            document.querySelectorAll('.nav-links button').forEach(b => b.classList.remove('active'));
            document.getElementById('nav-' + cat).classList.add('active');
            activeTab = ''; 
            renderTabs();
            populatePrintSelect();
            loadLeaderboards();
        }

        async function uploadCSV() {
            const fileInput = document.getElementById('csvFile');
            if (!fileInput.files[0]) return alert('Please select a file');
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            
            try {
                const res = await fetch('/upload', { method: 'POST', body: formData });
                if(res.ok) {
                    await loadContestants();
                    alert('Upload Complete! Duplicates were automatically ignored.');
                    fileInput.value = '';
                } else {
                    alert('Upload Failed! Check the server terminal for error details.');
                }
            } catch(e) {
                alert('Network Error during upload.');
            }
        }

        async function addManually() {
            const name = document.getElementById('mName').value.trim();
            const church = document.getElementById('mChurch').value.trim();
            const event_name = document.getElementById('mEvent').value.trim();
            const gender = document.getElementById('mGender').value;
            const event_type = document.getElementById('mType').value;

            if (!church || !event_name) return alert('Church and Event Name are required!');

            const res = await fetch('/api/add_manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, church, event_name, event_type, category: activeCategory, gender })
            });

            if (res.ok) {
                document.getElementById('mName').value = '';
                document.getElementById('mEvent').value = '';
                activeTab = event_name; 
                await loadContestants();
            } else {
                alert('Failed to add participant');
            }
        }

        async function loadContestants() {
            try {
                const res = await fetch('/api/contestants');
                if (!res.ok) {
                    if (res.status === 403) window.location = '/logout';
                    return;
                }
                contestantsData = await res.json();
                renderTabs();
                populatePrintSelect();
                populateChurchSelect();
                loadLeaderboards();
            } catch (e) {
                console.error("Failed to load data", e);
            }
        }

        function populatePrintSelect() {
            const catData = contestantsData.filter(c => c.category === activeCategory);
            const events = [...new Set(catData.map(c => c.event_name))];
            document.getElementById('printEventSelect').innerHTML = events.map(evt => '<option value="' + evt + '">' + evt + '</option>').join('');
        }

        function populateChurchSelect() {
            const churches = [...new Set(contestantsData.map(c => c.church).filter(Boolean))].sort();
            const options = '<option value="">-- Select Church --</option>' + churches.map(evt => '<option value="' + evt + '">' + evt + '</option>').join('');
            document.getElementById('churchSelect').innerHTML = options;
            
            if (document.getElementById('wrongChurchSelect')) {
                document.getElementById('wrongChurchSelect').innerHTML = options;
            }
        }

        function renderTabs() {
            const tabsDiv = document.getElementById('tabs');
            const catData = contestantsData.filter(c => c.category === activeCategory);
            const events = [...new Set(catData.map(c => c.event_name))];
            
            if (events.length === 0) {
                tabsDiv.innerHTML = '<div style="padding: 10px; color: var(--text-muted);">No events for ' + activeCategory + '</div>';
                document.querySelector('#tabulationTable tbody').innerHTML = '';
                return;
            }
            if (!events.includes(activeTab)) activeTab = events[0]; 
            
            tabsDiv.innerHTML = events.map(evt => {
                const isActive = (evt === activeTab) ? 'active' : '';
                return '<button class="tab-button ' + isActive + '" onclick="switchTab(\\'' + evt.replace(/'/g, "\\\\'") + '\\')">' + evt + '</button>';
            }).join('');
            renderTable();
        }

        function switchTab(evt) { activeTab = evt; renderTabs(); }

        function renderTable() {
            const tbody = document.querySelector('#tabulationTable tbody');
            tbody.innerHTML = '';
            const activeData = contestantsData.filter(c => c.category === activeCategory && c.event_name === activeTab);
            
            activeData.forEach(row => {
                let rankDisplay = (row.rank === 0 || !row.rank) ? '<span style="color:#cbd5e1;">-</span>' : '<span class="rank-badge rank-' + row.rank + '">' + row.rank + '</span>';
                let displayName = (row.event_type || '').toLowerCase() === 'team' ? '<span style="color:#94a3b8; font-style:italic;">Team Event</span>' : (row.name || '');
                
                let safeChest = (row.chest_number || '').replace(/'/g, "\\\\'");
                let safeName = (row.name || '').replace(/'/g, "\\\\'");
                let safeChurch = (row.church || '').replace(/'/g, "\\\\'");

                let editIcon = (USER_ROLE === 'admin') ? ' <span class="edit-icon" onclick="editContestant(' + row.id + ', \\'' + safeChest + '\\', \\'' + safeName + '\\', \\'' + safeChurch + '\\')">✏️</span>' : '';
                let deleteBtn = (USER_ROLE === 'admin') ? ' <button class="btn btn-danger" style="padding: 6px 10px; font-size: 12px; margin-left: 5px;" onclick="deleteContestant(' + row.id + ')">🗑️</button>' : '';
                let saveBtn = '<button class="btn btn-green" style="padding: 6px 12px; font-size: 12px;" onclick="saveScore(' + row.id + ')">Save</button>';

                let j1Cell = '<td style="text-align: center;"><input type="number" id="j1_' + row.id + '" value="' + (row.j1_score || 0) + '" min="0" max="100" oninput="if(this.value>100)this.value=100;if(this.value<0)this.value=0;"></td>';
                let j2Cell = '<td style="text-align: center;"><input type="number" id="j2_' + row.id + '" value="' + (row.j2_score || 0) + '" min="0" max="100" oninput="if(this.value>100)this.value=100;if(this.value<0)this.value=0;"></td>';

                let actionHtml = saveBtn;
                if (deleteBtn) actionHtml += deleteBtn;
                let actionCell = '<td style="white-space: nowrap;">' + actionHtml + '</td>';

                let tr = '<tr>' +
                    '<td style="font-family: monospace; font-size: 15px; font-weight: 600; color: var(--primary);">' + (row.chest_number || '') + editIcon + '</td>' +
                    '<td style="font-weight: 500;">' + displayName + editIcon + '</td>' +
                    '<td>' + (row.church || '') + editIcon + '</td>' +
                    j1Cell +
                    j2Cell +
                    actionCell +
                    '<td style="font-weight: 700; color: #1e293b;">' + (row.total || 0) + '</td>' +
                    '<td style="font-weight: 500; color: #475569;">' + (row.average || 0) + '</td>' +
                    '<td>' + rankDisplay + '</td>' +
                    '<td style="font-weight: 700; color: var(--success);">' + (row.points || 0) + '</td>' +
                '</tr>';
                tbody.innerHTML += tr;
            });
        }

        async function editContestant(id, currentChest, currentName, currentChurch) {
            const newChest = prompt("Edit Chest Number:", currentChest);
            if (newChest === null) return; 
            const newName = prompt("Edit Participant Name:", currentName);
            if (newName === null) return; 
            const newChurch = prompt("Edit Church Name:", currentChurch);
            if (newChurch === null) return; 

            await fetch('/api/edit_info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: Number(id), chest_number: newChest.trim(), name: newName.trim(), church: newChurch.trim() })
            });
            await loadContestants(); 
        }

        async function deleteContestant(id) {
            if (confirm("Delete this contestant from this event?")) {
                lastDeletedContestant = contestantsData.find(c => c.id === id);
                
                await fetch('/api/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: Number(id) })
                });
                
                await loadContestants();
                
                const toast = document.getElementById('undoToast');
                toast.style.display = 'block';
                setTimeout(() => { toast.style.display = 'none'; }, 12000);
            }
        }

        async function undoDelete() {
            if (!lastDeletedContestant) return;
            
            await fetch('/api/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(lastDeletedContestant)
            });
            
            lastDeletedContestant = null;
            document.getElementById('undoToast').style.display = 'none';
            await loadContestants();
        }

        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                if (lastDeletedContestant && document.getElementById('undoToast').style.display === 'block') {
                    e.preventDefault();
                    undoDelete();
                }
            }
        });

        async function saveScore(id) {
            const j1Val = document.getElementById('j1_' + id).value;
            const j2Val = document.getElementById('j2_' + id).value;
            const res = await fetch('/api/score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: Number(id), j1_score: Number(j1Val) || 0, j2_score: Number(j2Val) || 0 })
            });
            if (res.ok) {
                await loadContestants();
            } else alert('Save failed.');
        }

        async function loadLeaderboards() {
            try {
                const resChurch = await fetch('/api/leaderboard/church');
                if (!resChurch.ok) return;
                const churchData = await resChurch.json();
                document.getElementById('churchList').innerHTML = churchData.length > 0 
                    ? churchData.map(c => '<li>' + c.church + ': <strong>' + c.total_points + ' pts</strong></li>').join('')
                    : '<li>No points awarded yet.</li>';

                const resInd = await fetch('/api/leaderboard/individual');
                const indData = await resInd.json();
                
                const activeIndData = indData.filter(i => i.category === activeCategory);
                
                const males = activeIndData.filter(i => {
                    const g = (i.gender || '').toLowerCase();
                    return g === 'male' || g === 'm' || g === 'boy';
                });
                males.sort((a, b) => Number(b.total_points) - Number(a.total_points));
                const maxMalePts = males.length > 0 ? Number(males[0].total_points) : 0;
                const tiedMales = males.filter(m => Number(m.total_points) === maxMalePts).length;
                
                const females = activeIndData.filter(i => {
                    const g = (i.gender || '').toLowerCase();
                    return g === 'female' || g === 'f' || g === 'girl';
                });
                females.sort((a, b) => Number(b.total_points) - Number(a.total_points));
                const maxFemalePts = females.length > 0 ? Number(females[0].total_points) : 0;
                const tiedFemales = females.filter(f => Number(f.total_points) === maxFemalePts).length;

                document.getElementById('kalaprathibhaList').innerHTML = males.length > 0 
                    ? males.map((i) => {
                        let isTop = (Number(i.total_points) === maxMalePts);
                        let badgeText = isTop ? (tiedMales > 1 ? '👑 TIED WINNER' : '👑 WINNER') : 'ELIGIBLE';
                        let badgeColor = isTop ? '#b91c1c' : '#059669';
                        let badge = ' <span style="background:' + badgeColor + ';color:white;padding:2px 6px;border-radius:12px;font-size:10px;margin-left:5px;vertical-align:middle;">' + badgeText + '</span>';
                        return '<li>' + i.name + ' <span style="color:var(--text-muted);font-size:13px;">(' + i.church + ')</span>: <strong>' + i.total_points + ' pts</strong>' + badge + '</li>';
                    }).join('')
                    : '<li><span style="color:var(--text-muted); font-style:italic;">No eligible participants yet (requires 13+ points).</span></li>';

                document.getElementById('kalathilakamList').innerHTML = females.length > 0 
                    ? females.map((i) => {
                        let isTop = (Number(i.total_points) === maxFemalePts);
                        let badgeText = isTop ? (tiedFemales > 1 ? '🌟 TIED WINNER' : '🌟 WINNER') : 'ELIGIBLE';
                        let badgeColor = isTop ? '#b91c1c' : '#059669';
                        let badge = ' <span style="background:' + badgeColor + ';color:white;padding:2px 6px;border-radius:12px;font-size:10px;margin-left:5px;vertical-align:middle;">' + badgeText + '</span>';
                        return '<li>' + i.name + ' <span style="color:var(--text-muted);font-size:13px;">(' + i.church + ')</span>: <strong>' + i.total_points + ' pts</strong>' + badge + '</li>';
                    }).join('')
                    : '<li><span style="color:var(--text-muted); font-style:italic;">No eligible participants yet (requires 13+ points).</span></li>';
            } catch(e) {}
        }

        function downloadCSV() {
            const catData = contestantsData.filter(c => c.category === activeCategory);
            const headers = ["Category,Gender,Chest Number,Name,Church,Event,Type,J1 Score,J2 Score,Total,Average,Rank,Points"];
            const rows = catData.map(r => {
                let displayName = (r.event_type || '').toLowerCase() === 'team' ? '-' : r.name;
                return r.category + ',' + r.gender + ',' + r.chest_number + ',"' + displayName + '","' + r.church + '","' + r.event_name + '",' + r.event_type + ',' + r.j1_score + ',' + r.j2_score + ',' + r.total + ',' + r.average + ',' + r.rank + ',' + r.points;
            });
            const link = document.createElement("a");
            link.href = "data:text/csv;charset=utf-8," + encodeURI(headers.concat(rows).join("\\n"));
            link.download = "Results_" + activeCategory.replace(/ /g, "_") + ".csv";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        function deduplicateTeams(dataArray) {
            let dedup = [];
            let seen = new Set();
            dataArray.forEach(r => {
                if ((r.event_type || '').toLowerCase() === 'team') {
                    if (!seen.has(r.chest_number)) {
                        seen.add(r.chest_number);
                        dedup.push(r);
                    }
                } else {
                    dedup.push(r);
                }
            });
            return dedup;
        }

        // ---------- PDF GENERATION SCRIPT INJECTION ----------
        const pdfScriptBlock = \`
            <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\\/script>
            <script>
                function downloadPDF(filename, isLandscape, customFormat) {
                    const element = document.getElementById('pdf-content');
                    const formatStr = customFormat ? customFormat : 'a4';
                    const opt = {
                        margin:       [0.4, 0.4, 0.4, 0.4],
                        filename:     filename + '.pdf',
                        image:        { type: 'jpeg', quality: 1 },
                        html2canvas:  { scale: 2, useCORS: true },
                        jsPDF:        { unit: 'in', format: formatStr, orientation: isLandscape ? 'landscape' : 'portrait' },
                        pagebreak:    { mode: 'css', before: '.page-break', after: '.page' }
                    };
                    html2pdf().set(opt).from(element).save();
                }
            <\\/script>\`;

        function downloadChurchPrizes() {
            const churchName = document.getElementById('churchSelect').value;
            if (!churchName) return alert('Please select a church from the dropdown first.');

            let rankedData = contestantsData.filter(c => c.rank > 0 && c.church === churchName);
            
            let uniqueData = [];
            let seenTeams = new Set();
            rankedData.forEach(r => {
                if ((r.event_type || '').toLowerCase() === 'team') {
                    let key = r.event_name + '|' + r.category;
                    if (!seenTeams.has(key)) {
                        seenTeams.add(key);
                        uniqueData.push(r);
                    }
                } else {
                    uniqueData.push(r);
                }
            });

            if (uniqueData.length === 0) return alert("No prizes found for " + churchName + " yet.");

            uniqueData.sort((a,b) => {
                if (a.category < b.category) return -1;
                if (a.category > b.category) return 1;
                if (a.event_name < b.event_name) return -1;
                if (a.event_name > b.event_name) return 1;
                return a.rank - b.rank;
            });

            let totalPoints = uniqueData.reduce((sum, r) => sum + r.points, 0);

            let html = '<html><head><title>' + churchName + ' - Prizes</title><style>' +
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");' +
                'body{font-family:sans-serif;padding:40px;color:#1e1b4b;} ' +
                'table{width:100%;border-collapse:collapse;margin-top:20px;font-size:15px;} ' +
                'th,td{border:1px solid #cbd5e1;padding:12px;} ' +
                'th{background:#f1f5f9;text-align:left;text-transform:uppercase;} ' +
                '@media print{button, .no-print{display:none;}}' +
                '</style></head><body>' +
                '<div class="no-print" style="margin-bottom: 20px; display: flex; gap: 10px;">' +
                '<button onclick="window.print()" style="padding: 10px 20px; font-weight: bold; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">🖨️ Print</button>' +
                '<button onclick="downloadPDF(\\'' + churchName.replace(/ /g, '_') + '_Prizes\\', false)" style="padding: 10px 20px; font-weight: bold; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">💾 Download PDF</button>' +
                '</div>' +
                '<div id="pdf-content">' +
                '<div style="text-align: center; margin-bottom: 20px;">' +
                '<img src="/Sabha%20Logo.png" alt="Logo" style="height: 60px; margin-bottom: 5px;" onerror="this.style.display=\\'none\\';">' +
                '<h3 style="margin: 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 300;">' + ORG_MAIN + '</h3>' +
                '<h4 style="margin: 5px 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 700;">' + ORG_SUB + '</h4>' +
                '<img src="/Ananyam.png" alt="' + EVENT_TITLE + '" style="height: 50px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));" onerror="this.style.display=\\'none\\';">' +
                '<h3 style="margin-top: 15px; text-decoration: underline;">Prize Details: ' + churchName + '</h3>' +
                '<h3 style="color: #059669; margin-top: 5px;">Total Points: ' + totalPoints + '</h3>' +
                '</div>' +
                '<table><tr><th width="15%">Category</th><th width="30%">Event</th><th width="10%" style="text-align:center;">Rank</th><th width="35%">Participant Name</th><th width="10%" style="text-align:center;">Points</th></tr>';

            uniqueData.forEach(r => {
                let displayName = ((r.event_type || '').toLowerCase() === 'team') ? 'Team Event' : r.name;
                html += '<tr>' +
                    '<td>' + r.category + '</td>' +
                    '<td><strong>' + r.event_name + '</strong></td>' +
                    '<td style="text-align:center; font-weight:bold; color:#b91c1c; font-size:16px;">' + r.rank + '</td>' +
                    '<td>' + displayName + '</td>' +
                    '<td style="text-align:center; font-weight:bold;">' + r.points + '</td>' +
                '</tr>';
            });

            html += '</table></div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        function hashString(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = (hash << 5) - hash + str.charCodeAt(i);
                hash |= 0;
            }
            return hash;
        }

        function getRubricsForEvent(evt) {
            const e = evt.toLowerCase();
            if (e.includes('elocution') || e.includes('പ്രസംഗം')) return [{ name: 'Stage Presence', max: 15 }, { name: 'Clarity', max: 15 }, { name: 'Language Purity', max: 15 }, { name: 'Clarity of Ideas', max: 15 }, { name: 'Fluency', max: 10 }, { name: 'Voice Modulation', max: 10 }, { name: 'Bible Usage', max: 20 }];
            if (e.includes('bible reading') || e.includes('വേദപുസ്തകവായന')) return [{ name: 'Accuracy', max: 20 }, { name: 'Voice Mod.', max: 20 }, { name: 'Pronunciation', max: 30 }, { name: 'Presentation', max: 20 }, { name: 'Speed', max: 10 }];
            if (e.includes('group song') || e.includes('സംഘഗാനം')) return [{ name: 'Pitch (Sruthi)', max: 30 }, { name: 'Rhythm (Thalam)', max: 30 }, { name: 'Harmony & Coord.', max: 30 }, { name: 'Note Clarity', max: 10 }];
            if (e.includes('tableau') || e.includes('ടാബ്ലോ')) return [{ name: 'Costume', max: 20 }, { name: 'Creative Present.', max: 30 }, { name: 'Use of Props', max: 25 }, { name: 'Stillness/Pose', max: 25 }];
            if (e.includes('recitation') || e.includes('പദ്യപാരായണം')) return [{ name: 'Pronunciation', max: 25 }, { name: 'Clarity', max: 25 }, { name: 'Expression', max: 25 }, { name: 'Meaning & Clarity', max: 25 }];
            if (e.includes('clay model') || e.includes('ക്ലേ മോഡലിംഗ്')) return [{ name: 'Relevance', max: 30 }, { name: 'Perfection', max: 30 }, { name: 'Combination', max: 20 }, { name: 'Creativity', max: 20 }];
            if (e.includes('margamkali') || e.includes('മാർഗ്ഗംകളി')) return [{ name: 'Costume', max: 20 }, { name: 'Devotion/Coord.', max: 20 }, { name: 'Rhythm', max: 20 }, { name: 'Steps', max: 20 }, { name: 'Music', max: 20 }];
            if (e.includes('solo') || e.includes('ലളിതഗാനം') || e.includes('song')) return [{ name: 'Voice Quality', max: 20 }, { name: 'Pitch & Rhythm', max: 20 }, { name: 'Expression', max: 20 }, { name: 'Rhythm/Beat', max: 20 }, { name: 'Diction', max: 20 }];
            if (e.includes('instrumental') || e.includes('ഉപകരണ')) return [{ name: 'Tone/Sound', max: 20 }, { name: 'Raga/Expression', max: 20 }, { name: 'Rhythm', max: 20 }, { name: 'Technique/Improv.', max: 20 }, { name: 'Pitch/Present.', max: 20 }];
            if (e.includes('drawing') || e.includes('ചിത്രരചന') || e.includes('paint') || e.includes('പെയിൻ്റിംഗ്') || e.includes('cartoon') || e.includes('കാർട്ടൂൺ')) return [{ name: 'Relevance', max: 20 }, { name: 'Composition', max: 20 }, { name: 'Skill/Style', max: 20 }, { name: 'Details/Satire', max: 20 }, { name: 'Perfection', max: 20 }];
            if (e.includes('choreography') || e.includes('കൊറിയോഗ്രഫി') || e.includes('mime') || e.includes('മൂകാഭിനയം')) return [{ name: 'Theme/Costumes', max: 20 }, { name: 'Acting/Rhythm', max: 20 }, { name: 'Coordination', max: 20 }, { name: 'Steps/Creativity', max: 20 }, { name: 'Overall Present.', max: 20 }];
            if (e.includes('essay') || e.includes('ഉപന്യാസ') || e.includes('story') || e.includes('കഥാ') || e.includes('poem') || e.includes('കവിതാ')) return [{ name: 'Language', max: 20 }, { name: 'Creativity/Arrange.', max: 20 }, { name: 'Style/Expression', max: 20 }, { name: 'Knowledge/Aesthetics', max: 20 }, { name: 'Bible Ref/Narr.', max: 20 }];
            return [{ name: 'Rubric 1', max: 20 }, { name: 'Rubric 2', max: 20 }, { name: 'Rubric 3', max: 20 }, { name: 'Rubric 4', max: 20 }, { name: 'Rubric 5', max: 20 }];
        }

        function printDocument(type) {
            const eventName = document.getElementById('printEventSelect').value;
            if(!eventName) return alert("Select an event first.");
            
            let rawData = contestantsData.filter(c => c.category === activeCategory && c.event_name === eventName);
            if (type === 'master') {
                rawData.sort((a, b) => b.average - a.average);
            } else {
                rawData.sort((a, b) => hashString(a.chest_number + eventName) - hashString(b.chest_number + eventName));
            }
            
            let eventData = deduplicateTeams(rawData);
            
            let html = '<html><head><title>Print</title><style>'+
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");'+
                'body{font-family:sans-serif;padding:20px;} table{width:100%;border-collapse:collapse;} th,td{border:1px solid #333;padding:8px;} .editable { cursor: text; padding: 4px; border: 1px dashed #94a3b8; background: #f8fafc; border-radius: 4px; display: block; box-sizing: border-box; } .editable:focus { outline: 2px solid #4f46e5; background: #fff; } @media print{button, .no-print{display:none;} .editable { border: none; background: transparent; padding: 0; display: inline; } }</style></head><body>' +
                '<div class="no-print" style="margin-bottom: 20px; display: flex; gap: 10px;">' +
                '<button onclick="window.print()" style="padding: 10px 20px; font-weight: bold; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">🖨️ Print</button>' +
                '<button onclick="downloadPDF(\\'Score_Sheet\\', false)" style="padding: 10px 20px; font-weight: bold; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">💾 Download PDF</button>' +
                '</div><div id="pdf-content">';
            
            html += '<div style="text-align: center; margin-bottom: 20px;">';
            html += '<img src="/Sabha%20Logo.png" alt="Logo" style="height: 60px; margin-bottom: 5px;" onerror="this.style.display=\\'none\\';">';
            html += '<h3 style="margin: 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 300;">' + ORG_MAIN + '</h3>';
            html += '<h4 style="margin: 5px 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 700;">' + ORG_SUB + '</h4>';
            html += '<img src="/Ananyam.png" alt="' + EVENT_TITLE + '" style="height: 50px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));" onerror="this.style.display=\\'none\\';">';
            
            if (type.startsWith('judge')) {
                const jNum = type === 'judge1' ? '1' : '2';
                let rubrics = getRubricsForEvent(eventName);

                html += '<h3 style="margin-top: 15px; text-decoration: underline;">' + eventName + ' (' + activeCategory + ') - Judge ' + jNum + ' Score Sheet</h3>';
                html += '</div>';
                
                html += '<table><tr><th width="15%">Chest No</th>';
                rubrics.forEach(r => {
                    html += '<th style="text-align:center;"><span contenteditable="true" class="editable">' + r.name + ' (' + r.max + ')</span></th>';
                });
                html += '<th width="12%" style="text-align:center;">Total (100)</th></tr>';
                
                eventData.forEach(r => { 
                    html += '<tr><td style="text-align:center;"><strong>' + r.chest_number + '</strong></td>';
                    rubrics.forEach(() => { html += '<td></td>'; });
                    html += '<td></td></tr>'; 
                });

                html += '</table>';
                html += '<div style="margin-top: 60px; display: flex; justify-content: space-between; padding: 0 40px; font-size: 16px;">';
                html += '<div><strong>Judge\\'s Name:</strong> ___________________________</div>';
                html += '<div><strong>Signature:</strong> ___________________________</div>';
                html += '</div>';

            } else if (type === 'participant') {
                html += '<h3 style="margin-top: 15px; text-decoration: underline;">' + eventName + ' (' + activeCategory + ') - Participant List (Stage Order)</h3>';
                html += '</div><table><tr><th>Chest No</th><th>Name</th><th>Church</th></tr>';
                eventData.forEach(r => { html += '<tr><td><strong>' + r.chest_number + '</strong></td><td>' + ((r.event_type || '').toLowerCase() === 'team' ? '-' : r.name) + '</td><td>' + r.church + '</td></tr>'; });
                html += '</table>';
            } else {
                html += '<h3 style="margin-top: 15px; text-decoration: underline;">' + eventName + ' (' + activeCategory + ') - Master Tabulation</h3>';
                html += '</div><table><tr><th>Rank</th><th>Chest No</th><th>Name</th><th>Church</th><th>J1</th><th>J2</th><th>Total</th><th>Avg</th></tr>';
                eventData.forEach(r => { html += '<tr><td>' + (r.rank || '-') + '</td><td><strong>' + r.chest_number + '</strong></td><td>' + ((r.event_type || '').toLowerCase() === 'team' ? '-' : r.name) + '</td><td>' + r.church + '</td><td>' + r.j1_score + '</td><td>' + r.j2_score + '</td><td><strong>' + r.total + '</strong></td><td>' + r.average + '</td></tr>'; });
                html += '</table>';
            }
            
            html += '</div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        function printAllJudgeSheets(jNum) {
            let events = [...new Set(contestantsData.filter(c => c.category === activeCategory).map(c => c.event_name))].sort();
            if (events.length === 0) return alert("No events found in this category.");

            let html = '<html><head><title>Print All Judge ' + jNum + ' Sheets (' + activeCategory + ')</title><style>' +
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");' +
                'body{font-family:sans-serif;padding:0;margin:0;} ' +
                '.page { padding: 40px; box-sizing: border-box; page-break-after: always; min-height: 100vh; position: relative; } ' +
                'table{width:100%;border-collapse:collapse;margin-top:20px;} th,td{border:1px solid #333;padding:12px 8px;} ' +
                '.editable { cursor: text; padding: 4px; border: 1px dashed #94a3b8; background: #f8fafc; border-radius: 4px; display: block; box-sizing: border-box; } ' +
                '.editable:focus { outline: 2px solid #4f46e5; background: #fff; } ' +
                '@media print{button, .no-print{display:none;} .editable { border: none; background: transparent; padding: 0; display: inline; } }' +
                '</style></head><body>' +
                '<div class="no-print" style="position:fixed; top:20px; right:20px; z-index:1000; display:flex; gap:10px; background:#fffbeb; padding:15px; border:1px solid #fde68a; border-radius:8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">' +
                '<button onclick="window.print()" style="padding: 10px 20px; font-weight: bold; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer;">🖨️ Print</button>' +
                '<button onclick="downloadPDF(\\'All_Judge_Sheets\\', false)" style="padding: 10px 20px; font-weight: bold; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer;">💾 Download PDF</button>' +
                '</div><div id="pdf-content">';

            events.forEach(eventName => {
                let rawData = contestantsData.filter(c => c.category === activeCategory && c.event_name === eventName);
                if (rawData.length === 0) return;
                
                rawData.sort((a, b) => hashString(a.chest_number + eventName) - hashString(b.chest_number + eventName));
                let rubrics = getRubricsForEvent(eventName);

                let eventData = deduplicateTeams(rawData);

                html += '<div class="page">';
                html += '<div style="text-align: center; margin-bottom: 20px;">';
                html += '<img src="/Sabha%20Logo.png" alt="Logo" style="height: 60px; margin-bottom: 5px;" onerror="this.style.display=\\'none\\';">';
                html += '<h3 style="margin: 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 300;">' + ORG_MAIN + '</h3>';
                html += '<h4 style="margin: 5px 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 700;">' + ORG_SUB + '</h4>';
                html += '<img src="/Ananyam.png" alt="' + EVENT_TITLE + '" style="height: 50px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));" onerror="this.style.display=\\'none\\';">';
                html += '<h3 style="margin-top: 15px; text-decoration: underline;">' + eventName + ' (' + activeCategory + ') - Judge ' + jNum + ' Score Sheet</h3>';
                html += '</div>';

                html += '<table><tr><th width="15%">Chest No</th>';
                rubrics.forEach(r => {
                    html += '<th style="text-align:center;"><span contenteditable="true" class="editable">' + r.name + ' (' + r.max + ')</span></th>';
                });
                html += '<th width="12%" style="text-align:center;">Total (100)</th></tr>';

                eventData.forEach(r => {
                    html += '<tr><td style="text-align:center;"><strong>' + r.chest_number + '</strong></td>';
                    rubrics.forEach(() => { html += '<td></td>'; });
                    html += '<td></td></tr>';
                });
                
                html += '</table>';
                html += '<div style="margin-top: 60px; display: flex; justify-content: space-between; padding: 0 40px; font-size: 16px;">';
                html += '<div><strong>Judge\\'s Name:</strong> ___________________________</div>';
                html += '<div><strong>Signature:</strong> ___________________________</div>';
                html += '</div>';
                html += '</div>';
            });

            html += '</div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        function printCertificates() {
            const eventName = document.getElementById('printEventSelect').value;
            if(!eventName) return alert("Please select an event first.");
            
            let eventData = contestantsData.filter(c => c.category === activeCategory && c.event_name === eventName && c.rank > 0 && c.rank <= 3);
            if (eventData.length === 0) return alert("No ranked winners (1st, 2nd, or 3rd) found for this event yet.");

            eventData.sort((a, b) => a.rank - b.rank);
            
            let html = '<html><head><title>Certificates - ' + eventName + '</title><style>' +
                '@import url("https://fonts.googleapis.com/css2?family=Cinzel:wght@700&family=Great+Vibes&family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700&display=swap");' +
                '@page { size: A4 landscape; margin: 0; } ' +
                'body { margin: 0; font-family: "Montserrat", sans-serif; background: #fff; } ' +
                '.page { width: 297mm; height: 210mm; page-break-after: always; display: flex; justify-content: center; align-items: center; padding: 12mm; box-sizing: border-box; position: relative; } ' +
                '.cert-outer { width: 100%; height: 100%; border: 15px solid #1e1b4b; padding: 8px; box-sizing: border-box; background: #fdfbfb; position: relative; } ' +
                '.cert-inner { width: 100%; height: 100%; border: 3px solid #b8860b; padding: 25px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; align-items: center; text-align: center; } ' +
                '.cert-header { display: flex; flex-direction: column; align-items: center; } ' +
                '.logo { width: 70px; height: auto; margin-bottom: 10px; } ' +
                '.title-main { font-family: "Cinzel", serif; font-size: 52px; color: #b8860b; margin: 0; letter-spacing: 5px; line-height: 1.1; text-transform: uppercase; } ' +
                '.title-sub { font-size: 16px; font-weight: 300; color: #1e1b4b; margin: 10px 0 0 0; text-transform: uppercase; letter-spacing: 2px; } ' +
                '.title-sub-bold { font-size: 14px; font-weight: 700; color: #1e1b4b; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 1px; } ' +
                '.title-mal-img { height: 40px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1)); } ' +
                '.presented { font-size: 15px; font-weight: 600; color: #475569; margin-top: 25px; text-transform: uppercase; letter-spacing: 1.5px; } ' +
                '.name { font-family: "Great Vibes", cursive; font-size: 75px; color: #1e1b4b; margin: 5px 0; line-height: 1; font-weight: 400; } ' +
                '.body-text { font-size: 18px; color: #334155; line-height: 1.6; max-width: 85%; margin: 10px 0 0 0; } ' +
                '.body-text strong { color: #1e1b4b; font-weight: 700; } ' +
                '.signatures { display: flex; justify-content: space-between; width: 100%; margin-top: 30px; padding: 0 10px; box-sizing: border-box; } ' +
                '.sig-block { display: flex; flex-direction: column; align-items: center; width: 22%; } ' +
                '.sig-line { width: 100%; border-bottom: 1px solid #1e1b4b; margin-bottom: 8px; } ' +
                '.sig-title { font-size: 13px; font-weight: 700; color: #1e1b4b; text-transform: uppercase; letter-spacing: 1px; margin: 0; } ' +
                '@media print { .no-print { display: none; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }' +
                '</style></head><body>' +
                '<div class="no-print" style="position:fixed; top:20px; right:20px; padding:15px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; z-index:1000; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">' +
                '<p style="margin:0 0 10px 0;"><strong>🖨️ Printing Instructions:</strong></p>' +
                '<ul style="margin:0 0 10px 0; padding-left:20px; font-size:14px;"><li>Paper Size: <strong>A4</strong></li><li>Layout: <strong>Landscape</strong></li><li><strong>Enable "Background Graphics"</strong></li></ul>' +
                '<div style="display:flex; gap:10px;">' +
                '<button onclick="window.print()" style="width:100%; padding:10px; background:#4f46e5; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">Print</button>' +
                '<button onclick="downloadPDF(\\'Certificates\\', true)" style="width:100%; padding:10px; background:#059669; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">Download PDF</button>' +
                '</div></div><div id="pdf-content">';

            const rankWords = { 1: 'First Place', 2: 'Second Place', 3: 'Third Place' };

            eventData.forEach(r => {
                let rWord = rankWords[r.rank] || (r.rank + 'th Place');
                let dName = r.name;
                if ((!r.name || r.name === '-') && (r.event_type || '').toLowerCase() === 'team') dName = r.church + ' Team';
                
                html += '<div class="page"><div class="cert-outer"><div class="cert-inner">' +
                    '<div class="cert-header">' +
                        '<img src="/Sabha%20Logo.png" class="logo" alt="Logo" onerror="this.style.display=\\'none\\';">' +
                        '<h1 class="title-main">CERTIFICATE OF MERIT</h1>' +
                        '<h2 class="title-sub">' + ORG_MAIN + '</h2>' +
                        '<h3 class="title-sub-bold">' + ORG_SUB + '</h3>' +
                        '<img src="/Ananyam.png" class="title-mal-img" alt="' + EVENT_TITLE + '" onerror="this.style.display=\\'none\\';">' +
                    '</div>' +
                    '<p class="presented">This certificate is proudly presented to</p>' +
                    '<h2 class="name">' + dName + '</h2>' +
                    '<p class="body-text">of <strong>' + r.church + '</strong> for securing <strong>' + rWord + '</strong> in the <strong>' + r.event_name + '</strong> (' + r.category + ') competition.</p>' +
                    '<div class="signatures">' +
                        '<div class="sig-block"><div class="sig-line"></div><p class="sig-title">President</p></div>' +
                        '<div class="sig-block"><div class="sig-line"></div><p class="sig-title">Vice President</p></div>' +
                        '<div class="sig-block"><div class="sig-line"></div><p class="sig-title">Secretary</p></div>' +
                        '<div class="sig-block"><div class="sig-line"></div><p class="sig-title">Treasurer</p></div>' +
                    '</div>' +
                '</div></div></div>';
            });
            
            html += '</div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        async function printAllRankings() {
            let rankedData = contestantsData.filter(c => c.rank > 0);
            if (rankedData.length === 0) return alert("No rankings available yet.");

            const resChurch = await fetch('/api/leaderboard/church');
            const churchData = await resChurch.json();

            // Calculate points by Individual to accurately find Kalaprathibha/Kalathilakam per group
            let indPoints = {};
            contestantsData.forEach(c => {
                if ((c.event_type || '').toLowerCase() !== 'individual' || Number(c.points) === 0) return;
                let key = c.category + '|' + (c.name || '').trim().toLowerCase() + '|' + (c.church || '').trim().toLowerCase();
                if (!indPoints[key]) {
                    indPoints[key] = { 
                        name: c.name, 
                        church: c.church, 
                        gender: (c.gender || '').toLowerCase().trim(), 
                        category: c.category, 
                        points: 0 
                    };
                }
                indPoints[key].points += Number(c.points);
            });
            let eligibleIndividuals = Object.values(indPoints).filter(p => p.points >= 13);

            let categories = [...new Set(rankedData.map(c => c.category))].sort();

            let html = '<html><head><title>All Rankings</title><style>'+
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");'+
                'body{font-family:sans-serif;padding:20px;color:#1e1b4b;} table{width:100%;border-collapse:collapse;margin-top:10px;margin-bottom:30px;font-size:14px;} th,td{border:1px solid #cbd5e1;padding:10px;} th{background:#f1f5f9;text-align:left;text-transform:uppercase;} .page-break { page-break-after: always; position: relative; min-height: 95vh; } @media print{button, .no-print{display:none;}}</style></head><body>' +
                '<div class="no-print" style="margin-bottom: 20px; display: flex; gap: 10px;">' +
                '<button onclick="window.print()" style="padding: 10px 20px; font-weight: bold; background: #ea580c; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">🖨️ Print Rankings</button>' +
                '<button onclick="downloadPDF(\\'All_Rankings\\', false)" style="padding: 10px 20px; font-weight: bold; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">💾 Download PDF</button>' +
                '</div><div id="pdf-content">';

            categories.forEach((cat) => {
                html += '<div class="page-break">';
                html += '<div style="text-align: center; margin-bottom: 20px;">';
                html += '<img src="/Sabha%20Logo.png" alt="Logo" style="height: 60px; margin-bottom: 5px;" onerror="this.style.display=\\'none\\';">';
                html += '<h3 style="margin: 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 300;">' + ORG_MAIN + '</h3>';
                html += '<h4 style="margin: 5px 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 700;">' + ORG_SUB + '</h4>';
                html += '<img src="/Ananyam.png" alt="' + EVENT_TITLE + '" style="height: 50px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));" onerror="this.style.display=\\'none\\';">';
                html += '<h2 style="text-align:center; font-size: 24px; text-transform: uppercase; margin-top: 15px;">Overall Winners - ' + cat + '</h2>';
                html += '</div>';

                html += '<table><tr><th width="25%">Event</th><th width="10%" style="text-align:center;">Rank</th><th width="15%">Chest Number</th><th width="25%">Name</th><th width="25%">Church Name</th></tr>';
                
                let catData = rankedData.filter(c => c.category === cat).sort((a, b) => {
                    if (a.event_name < b.event_name) return -1;
                    if (a.event_name > b.event_name) return 1;
                    return a.rank - b.rank;
                });

                catData.forEach(r => {
                    let dName = r.name;
                    if ((!r.name || r.name === '-') && (r.event_type || '').toLowerCase() === 'team') dName = 'Team Event';

                    html += '<tr>' +
                        '<td><strong>' + r.event_name + '</strong></td>' +
                        '<td style="text-align:center; font-weight:bold; color:#b91c1c; font-size:16px;">' + r.rank + '</td>' +
                        '<td style="font-family: monospace; font-size: 15px; font-weight: 600;">' + r.chest_number + '</td>' +
                        '<td>' + dName + '</td>' +
                        '<td>' + r.church + '</td>' +
                    '</tr>';
                });
                
                html += '</table>';

                // Locate the exact top scorer(s) for Kalaprathibha
                let males = eligibleIndividuals.filter(p => p.category === cat && (p.gender === 'male' || p.gender === 'm' || p.gender === 'boy'));
                males.sort((a, b) => Number(b.points) - Number(a.points));
                let maxMalePts = males.length > 0 ? Number(males[0].points) : 0;
                let topMales = males.filter(m => Number(m.points) === maxMalePts);

                // Locate the exact top scorer(s) for Kalathilakam
                let females = eligibleIndividuals.filter(p => p.category === cat && (p.gender === 'female' || p.gender === 'f' || p.gender === 'girl'));
                females.sort((a, b) => Number(b.points) - Number(a.points));
                let maxFemalePts = females.length > 0 ? Number(females[0].points) : 0;
                let topFemales = females.filter(f => Number(f.points) === maxFemalePts);

                if (topMales.length > 0 || topFemales.length > 0) {
                    html += '<div style="display:flex; justify-content:space-around; align-items:flex-start; margin-top: 30px; padding: 20px; background: #fffbeb; border: 2px solid #fde68a; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">';
                    
                    // Male Winners Block
                    html += '<div style="text-align:center; width: 45%;">';
                    html += '<h3 style="margin:0 0 15px 0; color:#b91c1c; font-size: 20px; text-transform: uppercase;">👑 Kalaprathibha' + (topMales.length > 1 ? ' (TIED)' : '') + '</h3>';
                    if (topMales.length > 0) {
                        topMales.forEach(m => {
                            html += '<div style="margin-bottom: 12px;">';
                            html += '<p style="margin:0; font-size:18px; font-weight:bold;">' + m.name + ' <span style="color:#059669;">(' + m.points + ' pts)</span></p>';
                            html += '<p style="margin:4px 0 0 0; font-size:15px; color:#475569; font-weight:600;">' + m.church + '</p>';
                            html += '</div>';
                        });
                    } else {
                        html += '<div style="color:#94a3b8; font-style:italic;">No eligible Kalaprathibha</div>';
                    }
                    html += '</div>';

                    // Female Winners Block
                    html += '<div style="text-align:center; width: 45%; border-left: 2px solid #fde68a;">';
                    html += '<h3 style="margin:0 0 15px 0; color:#b91c1c; font-size: 20px; text-transform: uppercase;">🌟 Kalathilakam' + (topFemales.length > 1 ? ' (TIED)' : '') + '</h3>';
                    if (topFemales.length > 0) {
                        topFemales.forEach(f => {
                            html += '<div style="margin-bottom: 12px;">';
                            html += '<p style="margin:0; font-size:18px; font-weight:bold;">' + f.name + ' <span style="color:#059669;">(' + f.points + ' pts)</span></p>';
                            html += '<p style="margin:4px 0 0 0; font-size:15px; color:#475569; font-weight:600;">' + f.church + '</p>';
                            html += '</div>';
                        });
                    } else {
                        html += '<div style="color:#94a3b8; font-style:italic;">No eligible Kalathilakam</div>';
                    }
                    html += '</div>';
                    
                    html += '</div>';
                }

                html += '</div>';
            });

            // Final Church Championship Page
            html += '<div style="position: relative; min-height: 95vh;"><h2 style="text-align:center; font-size: 24px; text-transform: uppercase; margin-top:30px;">🏆 Church Championship Top 3 🏆</h2>';
            html += '<table style="width:60%; margin: 0 auto;"><tr><th style="text-align:center; width:20%;">Position</th><th>Church Name</th><th style="text-align:center; width:20%;">Total Points</th></tr>';
            
            const top3Churches = churchData.slice(0, 3);
            top3Churches.forEach((ch, idx) => {
                let pos = idx === 0 ? '🥇 1st' : (idx === 1 ? '🥈 2nd' : '🥉 3rd');
                html += '<tr><td style="text-align:center; font-size:18px; font-weight:bold;">' + pos + '</td>' +
                        '<td style="font-size:18px; font-weight:bold;">' + ch.church + '</td>' +
                        '<td style="text-align:center; font-size:18px; font-weight:bold; color:#059669;">' + ch.total_points + '</td></tr>';
            });
            html += '</table></div>';

            html += '</div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        async function printAllChurchPoints() {
            const res = await fetch('/api/leaderboard/church');
            const churchData = await res.json();
            
            if (churchData.length === 0) return alert("No points awarded yet.");

            let html = '<html><head><title>Overall Church Points</title><style>'+
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");'+
                'body{font-family:sans-serif;padding:20px;color:#1e1b4b;} table{width:80%;margin:0 auto;border-collapse:collapse;margin-top:20px;font-size:16px;} th,td{border:1px solid #cbd5e1;padding:12px;} th{background:#f1f5f9;text-align:left;text-transform:uppercase;} @media print{button, .no-print{display:none;}}</style></head><body>' +
                '<div class="no-print" style="margin-bottom: 20px; display: flex; gap: 10px;">' +
                '<button onclick="window.print()" style="padding: 10px 20px; font-weight: bold; background: #0284c7; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">🖨️ Print Points</button>' +
                '<button onclick="downloadPDF(\\'Church_Points\\', false)" style="padding: 10px 20px; font-weight: bold; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">💾 Download PDF</button>' +
                '</div><div id="pdf-content">';
                
            html += '<div style="text-align: center; margin-bottom: 20px;">';
            html += '<img src="/Sabha%20Logo.png" alt="Logo" style="height: 60px; margin-bottom: 5px;" onerror="this.style.display=\\'none\\';">';
            html += '<h3 style="margin: 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 300;">' + ORG_MAIN + '</h3>';
            html += '<h4 style="margin: 5px 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 700;">' + ORG_SUB + '</h4>';
            html += '<img src="/Ananyam.png" alt="' + EVENT_TITLE + '" style="height: 50px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));" onerror="this.style.display=\\'none\\';">';
            html += '<h2 style="margin-top: 15px;">🏛️ Overall Church Championship Points</h2>';
            html += '</div>';

            html += '<table><tr><th width="15%" style="text-align:center;">Rank</th><th>Church Name</th><th width="20%" style="text-align:center;">Total Points</th></tr>';

            churchData.forEach((ch, idx) => {
                html += '<tr><td style="text-align:center; font-weight:bold;">' + (idx + 1) + '</td><td>' + ch.church + '</td><td style="text-align:center; font-weight:bold; color:#b91c1c;">' + ch.total_points + '</td></tr>';
            });

            html += '</table></div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        function printChurchSummary() {
            let rankedData = contestantsData.filter(c => c.rank > 0);
            
            let html = '<html><head><title>Church Prizes</title><style>'+
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");'+
                'body{font-family:sans-serif;padding:20px;} table{width:100%;border-collapse:collapse;margin-bottom:20px;} th,td{border:1px solid #333;padding:8px;} @media print{button{display:none;}}</style></head><body>' +
                '<div class="no-print" style="margin-bottom: 20px; display: flex; gap: 10px;">' +
                '<button onclick="window.print()" style="padding: 10px 20px; font-weight: bold; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">🖨️ Print Summary</button>' +
                '<button onclick="downloadPDF(\\'Church_Summary\\', false)" style="padding: 10px 20px; font-weight: bold; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">💾 Download PDF</button>' +
                '</div><div id="pdf-content">';
            
            html += '<div style="text-align: center; margin-bottom: 20px;">';
            html += '<img src="/Sabha%20Logo.png" alt="Logo" style="height: 60px; margin-bottom: 5px;" onerror="this.style.display=\\'none\\';">';
            html += '<h3 style="margin: 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 300;">' + ORG_MAIN + '</h3>';
            html += '<h4 style="margin: 5px 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 700;">' + ORG_SUB + '</h4>';
            html += '<img src="/Ananyam.png" alt="' + EVENT_TITLE + '" style="height: 50px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));" onerror="this.style.display=\\'none\\';">';
            html += '<h2 style="margin-top: 15px; text-decoration: underline;">Church Prizes Summary</h2>';
            html += '</div>';

            let churchMap = {};
            rankedData.forEach(r => {
                if(!churchMap[r.church]) churchMap[r.church] = [];
                const exists = churchMap[r.church].find(x => x.event_name === r.event_name && x.category === r.category && x.event_type === 'team');
                if (!exists || r.event_type === 'individual') churchMap[r.church].push(r);
            });
            Object.keys(churchMap).sort().forEach(ch => {
                html += '<h3>🏛️ ' + ch + '</h3><table><tr><th>Rank</th><th>Category</th><th>Event</th><th>Participant</th></tr>';
                churchMap[ch].sort((a,b) => a.rank - b.rank).forEach(item => {
                    html += '<tr><td><strong>' + item.rank + '</strong></td><td>' + item.category + '</td><td>' + item.event_name + '</td><td>' + (item.event_type === 'team' ? 'Team Event' : item.name) + '</td></tr>';
                });
                html += '</table>';
            });
            
            html += '</div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        function printParticipantSummary() {
            let grouped = {};
            let activeData = contestantsData.filter(c => c.category === activeCategory);
            
            activeData.forEach(c => {
                if (!c.chest_number) return;
                if (!grouped[c.chest_number]) grouped[c.chest_number] = { name: c.name, church: c.church, chest_number: c.chest_number, events: [] };
                grouped[c.chest_number].events.push(c.event_name);
            });

            let items = Object.keys(grouped).map(k => grouped[k]).sort((a, b) => a.chest_number.localeCompare(b.chest_number));
            
            let html = '<html><head><title>Participant Event Summary</title><style>'+
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");'+
                'body{font-family:sans-serif;padding:20px;color:#1e1b4b;} table{width:100%;border-collapse:collapse;margin-top:15px;font-size:14px;} th,td{border:1px solid #cbd5e1;padding:10px;} th{background:#f1f5f9;text-align:left;text-transform:uppercase;} @media print{button, .no-print{display:none;}}</style></head><body>' +
                '<div class="no-print" style="margin-bottom: 20px; display: flex; gap: 10px;">' +
                '<button onclick="window.print()" style="padding: 10px 20px; font-weight: bold; background: #059669; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">🖨️ Print Summary</button>' +
                '<button onclick="downloadPDF(\\'Participant_Summary\\', false)" style="padding: 10px 20px; font-weight: bold; background: #0284c7; color: white; border: none; border-radius: 6px; cursor: pointer; flex: 1;">💾 Download PDF</button>' +
                '</div><div id="pdf-content">';

            html += '<div style="text-align: center; margin-bottom: 20px;">';
            html += '<img src="/Sabha%20Logo.png" alt="Logo" style="height: 60px; margin-bottom: 5px;" onerror="this.style.display=\\'none\\';">';
            html += '<h3 style="margin: 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 300;">' + ORG_MAIN + '</h3>';
            html += '<h4 style="margin: 5px 0; font-family: \\'Montserrat\\', sans-serif; font-weight: 700;">' + ORG_SUB + '</h4>';
            html += '<img src="/Ananyam.png" alt="' + EVENT_TITLE + '" style="height: 50px; margin-top: 8px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));" onerror="this.style.display=\\'none\\';">';
            html += '<h2 style="margin-top: 15px; text-decoration: underline;">Participant Summary - ' + activeCategory + '</h2>';
            html += '</div>';

            html += '<table><tr><th width="10%">Chest No</th><th width="25%">Participant Name</th><th width="25%">Church</th><th width="10%" style="text-align:center;">Total Events</th><th width="30%">Registered Competitions</th></tr>';

            items.forEach(item => {
                let displayName = (!item.name || item.name === '-') ? 'Team Event' : item.name;
                html += '<tr>' +
                    '<td><strong>' + item.chest_number + '</strong></td>' +
                    '<td>' + displayName + '</td>' +
                    '<td>' + item.church + '</td>' +
                    '<td style="text-align:center; font-size:16px; font-weight:bold; color:#b91c1c;">' + item.events.length + '</td>' +
                    '<td style="color:#475569;">' + item.events.join(', ') + '</td>' +
                '</tr>';
            });

            html += '</table></div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        // --- 12x18 INCH (Super B) 8-CARD GRID GENERATOR ---
        function printChestCards() {
            let grouped = {};
            contestantsData.forEach(c => {
                if (!c.chest_number) return;
                if (!grouped[c.chest_number]) {
                    grouped[c.chest_number] = { 
                        name: ((c.event_type || '').toLowerCase() === 'team') ? c.church + ' Team' : c.name, 
                        church: c.church, 
                        events: [] 
                    };
                }
                const eventLabel = c.event_name + (c.event_type==='team' ? ' (Team)' : '');
                if (!grouped[c.chest_number].events.includes(eventLabel)) {
                    grouped[c.chest_number].events.push(eventLabel);
                }
            });

            let items = Object.keys(grouped).map(k => ({chest_number: k, ...grouped[k]}));
            
            let html = '<html><head><title>Chest Number Cards</title><style>' +
                '@import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700&family=Noto+Sans+Malayalam:wght@700;800&display=swap");' +
                '@page { size: 18in 12in; margin: 0; } ' +
                'body { margin: 0; padding: 0; font-family: "Segoe UI", sans-serif; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; } ' +
                '.page { width: 18in; height: 12in; padding: 0.3in; box-sizing: border-box; page-break-after: always; display: flex; flex-wrap: wrap; align-content: flex-start; } ' +
                '.card-wrapper { width: 25%; height: 50%; padding: 0; box-sizing: border-box; } ' +
                '.card { border: 1px solid #000; margin-top: -1px; margin-left: -1px; border-radius: 0; padding: 6mm; background: #fff; width: 100%; height: 100%; box-sizing: border-box; display: flex; justify-content: center; align-items: center; } ' +
                '.card-front { width: 100%; height: 100%; background: url("/image_13a609_2.jpg") no-repeat center center; background-size: cover; border: none; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; box-sizing: border-box; padding: 10px; position: relative; gap: 6px; } ' +
                '.card-back { width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; box-sizing: border-box; padding: 10px; } ' +
                '.logo { height: 60px; width: auto; max-width: 100%; margin-bottom: 0; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2)); image-rendering: -webkit-optimize-contrast; image-rendering: high-quality; object-fit: contain; } ' +
                '.title-mtys { font-family: "Montserrat", sans-serif; font-size: 14px; font-weight: 300; color: #fff; margin: 0; text-transform: uppercase; letter-spacing: 0.5px; text-shadow: 1px 1px 2px rgba(0,0,0,0.6); } ' +
                '.title-centre { font-family: "Montserrat", sans-serif; font-size: 11px; font-weight: 700; color: #fde047; margin: 2px 0 8px 0; text-transform: uppercase; letter-spacing: 1px; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); } ' +
                '.chest-box { background: rgba(255, 255, 255, 0.95); border: 3px solid #1e1b4b; border-radius: 10px; padding: 6px 10px; width: 90%; box-shadow: 0 4px 10px rgba(0,0,0,0.4); margin: 0; backdrop-filter: blur(4px); display: flex; flex-direction: column; align-items: center; } ' +
                '.chest-te { font-family: "Montserrat", sans-serif; font-size: 24px; font-weight: 800; color: #b91c1c; margin: 0; line-height: 1; } ' +
                '.chest-num { font-size: 85px; font-weight: 800; color: #1e1b4b; margin: 0; line-height: 0.95; margin-top: 5px; } ' +
                '.back-name { font-size: 18px; font-weight: 700; color: #1e1b4b; margin: 0 0 5px 0; } ' +
                '.back-church { font-size: 13px; font-weight: 600; color: #64748b; margin: 0 0 10px 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; width: 100%; } ' +
                '.back-title { font-size: 13px; font-weight: bold; color: #475569; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; } ' +
                '.event-list { font-size: 12px; color: #111827; text-align: center; list-style: none; padding: 0; margin: 0; line-height: 1.4; font-weight: 500; } ' +
                '@media print { .no-print { display: none; } }' +
                '</style></head><body>' +
                '<div class="no-print" style="position:fixed; top:20px; right:20px; padding:15px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; z-index:1000; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">' +
                '<p style="margin:0 0 10px 0;"><strong>🖨️ Printing Instructions:</strong></p>' +
                '<ul style="margin:0 0 10px 0; padding-left:20px; font-size:14px;"><li>Paper Size: <strong>12x18 inches (Super B)</strong></li><li>Margins: <strong>None</strong></li><li><strong style="color:#dc2626;">Two-Sided: Flip on SHORT Edge</strong></li><li><strong>Enable "Background Graphics"</strong></li></ul>' +
                '<div style="display:flex; gap:10px;">' +
                '<button onclick="window.print()" style="width:100%; padding:10px; background:#4f46e5; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">Print 12x18</button>' +
                '<button onclick="downloadPDF(\\'Chest_Cards\\', true, [18, 12])" style="width:100%; padding:10px; background:#059669; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">Download PDF</button>' +
                '</div></div><div id="pdf-content">';

            for (let i = 0; i < items.length; i += 8) {
                let chunk = items.slice(i, i + 8);
                
                // FRONT PAGE
                html += '<div class="page">';
                for(let j=0; j<8; j++) {
                    let card = chunk[j];
                    html += '<div class="card-wrapper">';
                    if(card) {
                        let match = card.chest_number.match(/^([^0-9]+)(\d+)$/);
                        let prefixStr = match ? match[1] : '';
                        let chestNumStr = match ? match[2] : card.chest_number;

                        html += '<div class="card"><div class="card-front">' +
                                '<div>' +
                                '<img src="/Sabha%20Logo.png" class="logo" alt="Logo" onerror="this.style.display=\\'none\\';">' + 
                                '<p class="title-mtys">' + ORG_MAIN + '</p>' +
                                '<p class="title-centre">' + ORG_SUB + '</p>' +
                                '<h2 style="font-family: \\'Noto Sans Malayalam\\', \\'Montserrat\\', sans-serif; font-size: 26px; font-weight: 800; color: #ffffff; margin: 5px 0 15px 0; text-shadow: 2px 2px 6px rgba(0,0,0,0.9); letter-spacing: 1px; text-transform: uppercase;">' + EVENT_TITLE + '</h2>' +
                                '</div>' +
                                '<div class="chest-box">' +
                                '<p class="chest-te">' + prefixStr + '</p>' +
                                '<p class="chest-num">' + chestNumStr + '</p>' +
                                '</div>' +
                                '</div></div>';
                    }
                    html += '</div>';
                }
                html += '</div>';
                
                // BACK PAGE (Mirrored 8-grid [3, 2, 1, 0, 7, 6, 5, 4] for Short-Edge/Book Flip)
                let backOrder = [3, 2, 1, 0, 7, 6, 5, 4];
                html += '<div class="page">';
                for(let j=0; j<8; j++) {
                    let card = chunk[backOrder[j]];
                    html += '<div class="card-wrapper">';
                    if(card) {
                        html += '<div class="card"><div class="card-back">' +
                                '<div style="width: 100%; text-align: center;">' +
                                '<p class="back-name">' + (card.name || '-') + '</p>' +
                                '<p class="back-church">' + card.church + '</p>' +
                                '</div>' +
                                '<div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: center; text-align: center;">' +
                                '<p class="back-title">Registered Competitions</p>' +
                                '<ul class="event-list">' + card.events.map(e => '<li>' + e + '</li>').join('') + '</ul>' +
                                '</div>' +
                                '</div></div>';
                    }
                    html += '</div>';
                }
                html += '</div>';
            }
            
            html += '</div>' + pdfScriptBlock + '</body></html>';
            const win = window.open('', '_blank');
            win.document.write(html);
            win.document.close();
        }

        window.onload = () => {
            applyRoleRestrictions();
            loadContestants();
        };
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get() || { main_name: 'Mar Thoma Yuvajana Sakhyam', sub_name: 'Thiruvalla East Centre', event_title: 'അനന്യം-26', default_prefix: 'TE' };
    if (!settings.default_prefix) settings.default_prefix = 'TE';
    
    if (!req.userRole) return res.send(getLoginHtml(settings));
    res.send(
        htmlContent
            .replace(/__USER_ROLE__/g, req.userRole)
            .replace(/__MAIN_NAME__/g, settings.main_name)
            .replace(/__SUB_NAME__/g, settings.sub_name)
            .replace(/__EVENT_TITLE__/g, settings.event_title)
            .replace(/__DEFAULT_PREFIX__/g, settings.default_prefix)
    );
});

app.post('/upload', requireRole(['admin']), upload.single('file'), (req, res) => {
    if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/\s+/g, '_') }))
        .on('data', (data) => {
            if (Object.values(data).some(v => v && v.toString().trim() !== '')) results.push(data);
        })
        .on('end', () => {
            try {
                const currentSettings = db.prepare("SELECT default_prefix FROM settings WHERE id = 1").get() || { default_prefix: 'TE' };
                
                const stmt = db.prepare(`INSERT INTO contestants (name, church, event_name, event_type, category, gender, chest_number) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                const existing = db.prepare("SELECT name, church, chest_number, event_name, event_type, category FROM contestants").all();
                const personMap = new Map();
                existing.forEach(p => {
                    const existingPrefix = getEventPrefix(p.event_name, p.event_type, currentSettings.default_prefix);
                    let key = ((p.event_type || '').toLowerCase() === 'team')
                        ? existingPrefix + '|' + (p.church || '').trim().toLowerCase() + '|' + (p.category || 'Group 1').trim().toLowerCase()
                        : existingPrefix + '|' + (p.name || '').trim().toLowerCase() + '|' + (p.church || '').trim().toLowerCase() + '|' + (p.category || 'Group 1').trim().toLowerCase();
                    personMap.set(key, p.chest_number);
                });

                const dupCheck = db.prepare("SELECT id FROM contestants WHERE lower(name) = ? AND lower(church) = ? AND lower(event_name) = ? AND lower(category) = ?");
                db.exec("BEGIN"); 

                results.forEach(row => {
                    const name = (row.name || '').toString().trim();
                    const church = (row.church || '').toString().trim();
                    const event_name = (row.event_name || row.event || '').toString().trim();
                    const category = (row.category || 'Group 1').toString().trim();
                    
                    let gender = (row.gender || row.sex || 'Male').toString().trim();
                    if (gender.toLowerCase() === 'm' || gender.toLowerCase() === 'boy') gender = 'Male';
                    if (gender.toLowerCase() === 'f' || gender.toLowerCase() === 'girl') gender = 'Female';

                    let event_type = (row.event_type || row.type || 'individual').toString().trim().toLowerCase();
                    if (event_type === 'group') event_type = 'team';
                    if (event_type === 'solo') event_type = 'individual';

                    if (!church || !event_name) return; 

                    const isDup = dupCheck.get(name.toLowerCase(), church.toLowerCase(), event_name.toLowerCase(), category.toLowerCase());
                    if (!isDup) {
                        const prefix = getEventPrefix(event_name, event_type, currentSettings.default_prefix);
                        let key = (event_type === 'team')
                            ? prefix + '|' + church.toLowerCase() + '|' + category.toLowerCase()
                            : prefix + '|' + name.toLowerCase() + '|' + church.toLowerCase() + '|' + category.toLowerCase();
                        
                        let chest_number = personMap.get(key);
                        if (!chest_number) {
                            chest_number = getNextChestNumber(prefix, category);
                            personMap.set(key, chest_number);
                        }
                        stmt.run(name, church, event_name, event_type, category, gender, chest_number);
                    }
                });

                db.exec("COMMIT");
                res.json({ success: true });
            } catch (err) {
                console.error("CSV Processing Error:", err);
                try { db.exec("ROLLBACK"); } catch(e) {}
                res.status(500).json({ error: "Upload failed" });
            }
        });
});

app.get('/api/contestants', requireRole(['admin', 'editor']), (req, res) => {
    res.json(db.prepare("SELECT * FROM contestants ORDER BY event_name ASC, chest_number ASC").all());
});

app.post('/api/add_manual', requireRole(['admin']), (req, res) => {
    try {
        const { name, church, event_name, event_type, category, gender } = req.body;
        const cleanName = (name || '').trim();
        const cleanChurch = (church || '').trim();
        const cleanEvent = (event_name || '').trim();
        const cleanCategory = (category || 'Group 1').trim();
        const cleanGender = (gender || 'Male').trim();
        
        let cleanType = (event_type || 'individual').trim().toLowerCase();
        if (cleanType === 'group') cleanType = 'team';
        if (cleanType === 'solo') cleanType = 'individual';

        if (!cleanChurch || !cleanEvent) return res.status(400).json({ error: "Required fields missing" });

        const currentSettings = db.prepare("SELECT default_prefix FROM settings WHERE id = 1").get() || { default_prefix: 'TE' };
        const prefix = getEventPrefix(cleanEvent, cleanType, currentSettings.default_prefix);
        
        let existingPerson;
        if (cleanType === 'team') {
            existingPerson = db.prepare(`SELECT chest_number FROM contestants WHERE lower(trim(church)) = lower(?) AND lower(trim(event_name)) = lower(?) AND lower(trim(category)) = lower(?) AND chest_number LIKE ? LIMIT 1`).get(cleanChurch, cleanEvent, cleanCategory, `${prefix}%`);
        } else {
            existingPerson = db.prepare(`SELECT chest_number FROM contestants WHERE lower(trim(name)) = lower(?) AND lower(trim(church)) = lower(?) AND lower(trim(event_name)) = lower(?) AND lower(trim(category)) = lower(?) AND chest_number LIKE ? LIMIT 1`).get(cleanName, cleanChurch, cleanEvent, cleanCategory, `${prefix}%`);
        }
        const chest_number = existingPerson ? existingPerson.chest_number : getNextChestNumber(prefix, cleanCategory);

        db.prepare(`INSERT INTO contestants (name, church, event_name, event_type, category, gender, chest_number) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(cleanName, cleanChurch, cleanEvent, cleanType, cleanCategory, cleanGender, chest_number);
        recalculateEventRanks(cleanEvent, cleanCategory);
        
        res.json({ success: true, chest_number });
    } catch (err) {
        console.error("Manual add failed:", err);
        res.status(500).json({ error: "Failed to insert contestant" });
    }
});

app.post('/api/delete', requireRole(['admin']), (req, res) => {
    const target = db.prepare("SELECT event_name, category FROM contestants WHERE id = ?").get(req.body.id);
    db.prepare("DELETE FROM contestants WHERE id = ?").run(req.body.id);
    if (target) recalculateEventRanks(target.event_name, target.category);
    res.json({ success: true });
});

app.post('/api/restore', requireRole(['admin']), (req, res) => {
    try {
        const c = req.body;
        db.prepare(`INSERT INTO contestants (name, church, event_name, event_type, category, gender, chest_number, j1_score, j2_score, total, average, rank, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            c.name, c.church, c.event_name, c.event_type, c.category, c.gender, c.chest_number, c.j1_score, c.j2_score, c.total, c.average, c.rank, c.points
        );
        recalculateEventRanks(c.event_name, c.category);
        res.json({ success: true });
    } catch (err) {
        console.error("Restore failed:", err);
        res.status(500).json({ error: "Failed to restore contestant" });
    }
});

app.post('/api/edit_info', requireRole(['admin']), (req, res) => {
    db.prepare("UPDATE contestants SET chest_number = ?, name = ?, church = ? WHERE id = ?").run(req.body.chest_number || '', req.body.name || '', req.body.church || '', req.body.id);
    res.json({ success: true });
});

app.post('/api/score', requireRole(['admin', 'editor']), (req, res) => {
    const id = Number(req.body.id);
    let j1 = Number(req.body.j1_score) || 0;
    let j2 = Number(req.body.j2_score) || 0;
    
    if (j1 < 0) j1 = 0;
    if (j1 > 100) j1 = 100;
    if (j2 < 0) j2 = 0;
    if (j2 > 100) j2 = 100;

    const total = Number((j1 + j2).toFixed(2));
    const average = Number((total / 2).toFixed(2));

    const target = db.prepare("SELECT church, event_name, category, event_type FROM contestants WHERE id = ?").get(id);
    if (!target) return res.json({ success: false });

    // If it's a team event, update the score for EVERY member of that church's team at once
    if (target.event_type === 'team') {
        db.prepare("UPDATE contestants SET j1_score = ?, j2_score = ?, total = ?, average = ? WHERE church = ? AND event_name = ? AND category = ?").run(j1, j2, total, average, target.church, target.event_name, target.category);
    } else {
        db.prepare("UPDATE contestants SET j1_score = ?, j2_score = ?, total = ?, average = ? WHERE id = ?").run(j1, j2, total, average, id);
    }

    recalculateEventRanks(target.event_name, target.category);
    
    res.json({ success: true });
});

function recalculateEventRanks(eventName, category) {
    if (!eventName || !category) return;
    const contestants = db.prepare("SELECT * FROM contestants WHERE event_name = ? AND category = ? ORDER BY average DESC, id ASC").all(eventName, category);
    let currentRank = 0;
    let lastAvg = -1;

    const updateStmt = db.prepare("UPDATE contestants SET rank = ?, points = ? WHERE id = ?");

    contestants.forEach((c) => {
        let rank = 0;
        let points = 0;

        if (c.average >= 50) {
            if (c.average !== lastAvg) currentRank++;
            
            if (currentRank <= 3) {
                rank = currentRank;
                const isTeam = (c.event_type || '').toLowerCase() === 'team' || (c.event_type || '').toLowerCase() === 'group';
                if (!isTeam) {
                    points = rank === 1 ? 5 : (rank === 2 ? 3 : 1);
                } else {
                    points = rank === 1 ? 15 : (rank === 2 ? 10 : 5);
                }
            }
            lastAvg = c.average;
        }
        updateStmt.run(rank, points, c.id);
    });
}

app.get('/api/leaderboard/church', requireRole(['admin', 'editor']), (req, res) => {
    const query = `
        SELECT church, SUM(pts) as total_points FROM (
            SELECT church, points as pts FROM contestants WHERE event_type = 'individual' AND points > 0
            UNION ALL
            SELECT church, MAX(points) as pts FROM contestants WHERE event_type = 'team' AND points > 0 GROUP BY church, event_name, category
        )
        GROUP BY church ORDER BY total_points DESC
    `;
    res.json(db.prepare(query).all());
});

app.get('/api/leaderboard/individual', requireRole(['admin', 'editor']), (req, res) => {
    const query = `
        SELECT name, church, gender, category, SUM(points) as total_points 
        FROM contestants 
        WHERE event_type = 'individual' AND points > 0
        GROUP BY name, church, gender, category 
        HAVING total_points >= 13 
        ORDER BY total_points DESC
    `;
    res.json(db.prepare(query).all());
});

app.listen(3000, () => console.log('✅ Server online at http://localhost:3000'));