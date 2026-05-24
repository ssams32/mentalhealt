
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
        root: '.',
        base: './',
        server: {
            port: 3000,
            host: '0.0.0.0',
            proxy: {
                '/api': {
                    target: 'http://localhost:3001',
                    changeOrigin: true,
                    secure: false,
                },
                '/attachments': {
                    target: 'http://localhost:3001',
                    changeOrigin: true,
                    secure: false,
                }
            }
        },
        build: {
            outDir: 'dist-local',
            minify: false,
            assetsDir: 'assets',
            emptyOutDir: true,
            chunkSizeWarningLimit: 1000,
            rollupOptions: {
                output: {
                    manualChunks(id) {
                        if (id.includes('node_modules')) {
                            if (id.includes('lucide-react')) return 'vendor-icons';
                            if (id.includes('recharts')) return 'vendor-charts';
                            if (id.includes('xlsx')) return 'vendor-excel';
                            if (id.includes('@fullcalendar')) return 'vendor-calendar';
                            if (id.includes('@tiptap')) return 'vendor-editor';
                            return 'vendor';
                        }
                    }
                }
            }
        },
        plugins: [
            react(),
            // viteSingleFile() // Removed for NAS build to prevent silent OOM crashes
        ],
        define: {
            'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
            'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || '')
        },
        resolve: {
            alias: {
                '@': path.resolve(__dirname, '.'),
            }
        }
    };
});
