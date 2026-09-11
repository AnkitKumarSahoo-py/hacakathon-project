import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()], server: { host: true, port: 5173, strictPort: true, allowedHosts: ['stifle-huff-alabaster.ngrok-free.dev'], proxy: { '/api': 'http://127.0.0.1:8787' } } })
