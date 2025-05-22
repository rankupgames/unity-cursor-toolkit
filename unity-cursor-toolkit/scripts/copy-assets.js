const fs = require("fs-extra");
const path = require("path");

const sourceDir = path.join(__dirname, "..", "unity-assets");
const destDir = path.join(__dirname, "..", "out", "unity-assets");

async function copyAssets() {
  try {
    await fs.ensureDir(destDir);
    await fs.copy(sourceDir, destDir);
    console.log("Successfully copied unity-assets to out/unity-assets");
  } catch (err) {
    console.error("Error copying assets:", err);
    process.exit(1);
  }
}

copyAssets();
