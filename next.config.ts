import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pdfkit'],
  // The Docker build sets SKIP_BUILD_TYPECHECK=1: CI's TypeScript job already runs
  // `tsc --noEmit` on every PR and push to main, and the type check is about half of
  // `next build` (sandbox: 38s with it, 21s without). A local `npm run build` still checks.
  typescript: { ignoreBuildErrors: process.env.SKIP_BUILD_TYPECHECK === '1' },
  // proxy.ts matches every route, and Next buffers request bodies behind a proxy up to this size
  // (default 10 MB, then it silently truncates). Uploads allow 25 MB (lib/uploadSniff.ts) plus multipart overhead.
  experimental: { proxyClientMaxBodySize: '30mb' },
  async headers() {
    return [
      {
        source: '/api/import',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, X-Extension-User-Id' },
        ],
      },
      {
        source: '/api/users',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, X-Extension-User-Id' },
        ],
      },
    ];
  },
};

export default nextConfig;
