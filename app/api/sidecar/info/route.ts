// Public, non-secret connection info for the sidecar's VNC display, so the
// Settings/Orders pages can render a working connect link instead of
// leaving users to guess the host/port after setting a password.
//
// The sidecar noVNC display is served ONLY behind the Caddy front door on
// :8088 (docker/Caddyfile proxies /vnc/* and /websockify* to websockify:6080).
// Port 3000 is raw Next.js with no /vnc route, so a same-origin *relative*
// link 404s whenever the app is browsed on :3000. Build an ABSOLUTE URL on the
// front-door port from the request host so the "connect to VNC" link works no
// matter which port the app itself was opened on.
const FRONT_DOOR_PORT = process.env.SIDECAR_FRONT_DOOR_PORT || '8088';

export async function GET(req: Request) {
  const host = (req.headers.get('host') || 'localhost').split(':')[0];
  const novncUrl = `http://${host}:${FRONT_DOOR_PORT}/vnc/vnc.html?autoconnect=true&resize=scale`;
  return Response.json({
    novncUrl,
    // Legacy relative path kept for back-compat; prefer novncUrl (works from :3000).
    novncPath: '/vnc/vnc.html?autoconnect=true&resize=scale',
    port: 5900,
  });
}
