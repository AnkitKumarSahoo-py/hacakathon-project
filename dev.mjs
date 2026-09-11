import { spawn } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const processes = [
  spawn(npm, ['run', 'api'], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev:client'], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' }),
]

function stop() {
  for (const child of processes) child.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of processes) child.on('exit', code => { if (code && code !== 130) process.exitCode = code })
