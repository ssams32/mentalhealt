import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    base: './',
    css: {
      postcss: {
        plugins: [
          // tailwindcss(),
          // autoprefixer(),
        ],
      },
    },
    server: {
      port: 8888,
      host: true,
      proxy: {
        '/api': {
          target: 'http://localhost:8889',
          changeOrigin: true,
          secure: false,
        },
        '/attachments': {
          target: 'http://localhost:8889',
          changeOrigin: true,
          secure: false,
        }
      }
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: 'index.html',
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('lucide-react')) return 'vendor-icons';
              if (id.includes('recharts')) return 'vendor-charts';
              if (id.includes('xlsx')) return 'vendor-excel';
              return 'vendor';
            }
          }
        },
      },
    },
    plugins: [
      react(),
      // viteSingleFile({ useRecommendedBuildConfig: true })
    ],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || '')
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    optimizeDeps: {
      exclude: [
        'tesseract.js',
        'y-webrtc',
        'yjs',
      ],
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'lucide-react',
        'recharts',
        'framer-motion',
        'lodash',
        'uuid',
      ],
    },
  };
});
