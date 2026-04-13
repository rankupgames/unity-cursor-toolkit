/**
 * Auto-bump version: 0.6.<increment><MMDDYY>
 * - If bumped same day, increment prefix digit
 * - If new day, reset to 1
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const now = new Date();
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');
const yy = String(now.getFullYear()).slice(-2);
const todayStamp = `${mm}${dd}${yy}`;

const current = pkg.version; // e.g. "0.6.1031226"
const parts = current.split('.');
const patch = parts[2] || '0';

let increment = 1;
if (patch.length > 6) {
  const datePart = patch.slice(-6);
  const incPart = patch.slice(0, -6);
  if (datePart === todayStamp && incPart) {
    increment = parseInt(incPart, 10) + 1;
  }
}

const newVersion = `0.6.${increment}${todayStamp}`;
pkg.version = newVersion;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Version: ${current} -> ${newVersion}`);
