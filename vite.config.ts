import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

const SOUND_NAMES = new Set([
  'startup',
  'click',
  'leave_call',
  'join_call',
  'mute',
  'camera',
  'post',
  'like',
]);
const SOUND_EXTS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.webm', '.aac', '.flac']);

export default defineConfig(() => {
  return {
    base: process.env.VITE_BASE_PATH || '/',
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets & Sounds into dist/ and generates static sounds-manifest.json + 404.html for GitHub Pages.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
          const srcSounds = path.resolve(__dirname, 'Sounds');
          const distSounds = path.resolve(distDir, 'Sounds');
          if (fs.existsSync(distDir) && fs.existsSync(srcSounds)) {
            fs.cpSync(srcSounds, distSounds, {recursive: true, force: true});
          }

          if (fs.existsSync(distDir)) {
            const manifest: Record<string, string> = {};
            const publicSounds = path.resolve(__dirname, 'public/Sounds');
            for (const dir of [srcSounds, publicSounds]) {
              if (!fs.existsSync(dir)) continue;
              for (const file of fs.readdirSync(dir)) {
                const parsed = path.parse(file);
                const base = parsed.name.toLowerCase();
                const ext = parsed.ext.toLowerCase();
                if (!SOUND_NAMES.has(base) || !SOUND_EXTS.has(ext) || manifest[base]) continue;
                const stat = fs.statSync(path.join(dir, file));
                manifest[base] = `Sounds/${encodeURIComponent(file)}?v=${Math.floor(stat.mtimeMs)}`;
              }
            }
            fs.writeFileSync(
              path.join(distDir, 'sounds-manifest.json'),
              JSON.stringify({sounds: manifest}),
              'utf8'
            );

            const idxPath = path.join(distDir, 'index.html');
            const notFoundPath = path.join(distDir, '404.html');
            if (fs.existsSync(idxPath)) {
              fs.copyFileSync(idxPath, notFoundPath);
            }
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
