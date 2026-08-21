// Public, non-secret connection info for the sidecar's VNC display, so the
// Settings page can render a working vnc:// link instead of leaving users
// to guess the host/port after setting a password.
export async function GET() {
  const ip = process.env.SIDECAR_IP || '10.0.12.40';
  return Response.json({ ip, port: 5900 });
}
