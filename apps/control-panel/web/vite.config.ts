import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

function normalizeGeneratedHtmlLineEndings() {
  return {
    name: 'normalize-generated-html-line-endings',
    closeBundle() {
      const indexPath = path.resolve(configDirectory, '../wwwroot/index.html');
      const current = fs.readFileSync(indexPath, 'utf8');
      const normalized = current.replace(/\r\n?/gu, '\n');
      if (current !== normalized) {
        // Vite can mix source CRLF with injected LF on Windows; keep release HTML deterministic.
        fs.writeFileSync(indexPath, normalized, 'utf8');
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), normalizeGeneratedHtmlLineEndings()],
  build: {
    outDir: '../wwwroot',
    emptyOutDir: true,
  },
});
