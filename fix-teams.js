const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('./kalamela.db');

console.log("🛠️ Fixing Team Event Chest Numbers (Master G-Number per Church)...");

// 1. Fetch all team contestants
const teamContestants = db.prepare("SELECT * FROM contestants WHERE event_type = 'team'").all();

// 2. Find all unique churches participating in ANY team event and sort them alphabetically
const uniqueChurches = [...new Set(teamContestants.map(c => (c.church || '').trim().toLowerCase()))].filter(Boolean).sort();

// 3. Assign a master G-number to each church (e.g., Church A = G1, Church B = G2)
const churchToChestMap = {};
uniqueChurches.forEach((church, index) => {
    churchToChestMap[church] = 'G' + (index + 1);
});

// 4. Update the database
db.exec("BEGIN");
const updateStmt = db.prepare("UPDATE contestants SET chest_number = ? WHERE id = ?");

let updateCount = 0;

teamContestants.forEach(c => {
    const churchKey = (c.church || '').trim().toLowerCase();
    const assignedChest = churchToChestMap[churchKey];
    
    if (assignedChest) {
        updateStmt.run(assignedChest, c.id);
        updateCount++;
        console.log(`Assigned ${assignedChest} -> ${c.name || 'Team Member'} (${c.church}) - ${c.event_name}`);
    }
});

db.exec("COMMIT");

console.log(`\n✅ Success! Updated ${updateCount} team participants.`);
console.log(`\n--- MASTER CHURCH TEAM MAPPING ---`);
for (const [church, chest] of Object.entries(churchToChestMap)) {
    console.log(`${chest} : ${church}`);
}