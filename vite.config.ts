import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    tsconfigPaths(),
    viteStaticCopy({
      targets: [
        {
          src: 'public/manifest.json',
          dest: '.',
        },
        {
          src: 'public/icons/*',
          dest: '.',
        },
      ],
    }),
  ],
  build: {
    outDir: 'dist', // Where built files go
    rollupOptions: {
      input: {
        popup: './src/popup/index.html',
        options: './src/options/index.html',
      },
    },
  },
});
