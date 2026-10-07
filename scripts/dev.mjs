// Runs the API server (with reload on change) and the Vite dev server together.
import { spawn } from 'node:child_process';

const run = (cmd, args) =>
  spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });

const procs = [
  run('node', ['--watch', '--disable-warning=ExperimentalWarning', 'src/server/main.ts']),
  run('npx', ['vite']),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) stop(); }));
