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
  const hostHeader = req.headers.get('host') || 'localhost';

  // Parse host:port, handling bracketed IPv6
  let host: string;
  let port: string | undefined;

  if (hostHeader.startsWith('[')) {
    // IPv6: [addr]:port or [addr]
    const closeBracket = hostHeader.indexOf(']');
    host = hostHeader.substring(0, closeBracket + 1);
    const afterBracket = hostHeader.substring(closeBracket + 1);
    if (afterBracket.startsWith(':')) {
      port = afterBracket.substring(1);
    }
  } else {
    // IPv4 or hostname: host:port or host
    const colonIndex = hostHeader.lastIndexOf(':');
    if (colonIndex !== -1) {
      host = hostHeader.substring(0, colonIndex);
      port = hostHeader.substring(colonIndex + 1);
    } else {
      host = hostHeader;
    }
  }

  const novncPath = '/vnc/vnc.html?autoconnect=true&resize=scale';

  // If no explicit port, or port equals FRONT_DOOR_PORT, use relative URL
  if (!port || port === FRONT_DOOR_PORT) {
    return Response.json({ novncUrl: novncPath, novncPath, port: 5900 });
  }

  // Otherwise, use absolute URL with FRONT_DOOR_PORT
  const novncUrl = `http://${host}:${FRONT_DOOR_PORT}${novncPath}`;
  return Response.json({ novncUrl, novncPath, port: 5900 });
}
