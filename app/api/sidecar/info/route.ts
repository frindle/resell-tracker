// Public, non-secret connection info for the sidecar's VNC display, so the
// Settings/Orders pages can render a working connect link instead of
// leaving users to guess the host/port after setting a password.
export async function GET() {
  return Response.json({
    novncPath: '/vnc/vnc.html?autoconnect=true&resize=scale',
    port: 5900,
  });
}
