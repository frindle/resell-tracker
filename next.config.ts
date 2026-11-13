import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pdfkit'],
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
