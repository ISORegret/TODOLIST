import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project URLs can differ in casing from github.event.repository.name;
// a wrong base yields 404 on JS/CSS → blank dark page. Relative base works for any subpath.
const base =
  process.env.VITE_USE_RELATIVE_BASE === 'true'
    ? './'
    : (process.env.VITE_BASE_PATH || '/')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
})
