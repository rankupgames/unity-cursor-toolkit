#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('Unity Hot Reload - Unity Script Installer');
console.log('=========================================');
console.log('This script will copy the HotReloadHandler.cs file to your Unity project.');
console.log('');

rl.question('Enter the path to your Unity project root folder: ', (unityProjectPath) => {
  // Check if the path exists
  if (!fs.existsSync(unityProjectPath)) {
    console.error(`Error: The path "${unityProjectPath}" does not exist.`);
    rl.close();
    return;
  }
  
  // Check if it's a Unity project by looking for the Assets folder
  const assetsPath = path.join(unityProjectPath, 'Assets');
  if (!fs.existsSync(assetsPath)) {
    console.error(`Error: The path "${unityProjectPath}" does not appear to be a Unity project (no Assets folder found).`);
    rl.close();
    return;
  }
  
  // Create Editor folder if it doesn't exist
  const editorPath = path.join(assetsPath, 'Editor');
  if (!fs.existsSync(editorPath)) {
    console.log(`Creating Editor folder at ${editorPath}`);
    fs.mkdirSync(editorPath, { recursive: true });
  }
  
  // Source file path
  const sourceFilePath = path.join(__dirname, 'unity-assets', 'HotReloadHandler.cs');
  if (!fs.existsSync(sourceFilePath)) {
    console.error(`Error: Could not find the source file at ${sourceFilePath}`);
    rl.close();
    return;
  }
  
  // Destination file path
  const destFilePath = path.join(editorPath, 'HotReloadHandler.cs');
  
  // Copy the file
  try {
    fs.copyFileSync(sourceFilePath, destFilePath);
    console.log(`Successfully copied HotReloadHandler.cs to ${destFilePath}`);
    console.log('');
    console.log('Installation complete! Your Unity project is now set up for Hot Reload.');
    console.log('Please restart Unity if it is currently running.');
  } catch (error) {
    console.error(`Error copying file: ${error.message}`);
  }
  
  rl.close();
}); 