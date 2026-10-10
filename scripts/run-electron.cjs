// Lance electron.exe en neutralisant ELECTRON_RUN_AS_NODE.
// Ce flag (parfois défini globalement sur le poste) fait démarrer le binaire
// en mode Node pur : require('electron') renvoie alors un chemin au lieu de
// l'API. Le supprimer dans main.ts arrive trop tard — le flag est consommé
// au démarrage du process. On le retire donc ici, AVANT de spawner electron.
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('node:child_process');
const electron = require('electron'); // le package npm exporte le chemin du binaire

const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
