const HEADER = "x-catalyst-cli-version";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Public package metadata on the selected cloud API transport. All fetch semantics stay intact. */
export function reportCliVersion(transport: typeof fetch, version: string, origins: () => readonly string[]): typeof fetch {
  if (version.length > 80 || !VERSION.test(version)) return transport;
  return (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
      const selected = origins().some(origin => {
        try { return new URL(origin).origin === url.origin; } catch { return false; }
      });
      if (!selected || !(url.pathname.startsWith("/api/v1/") || ["/snapshot", "/changes", "/events"].includes(url.pathname))) return transport(input, init);
    } catch {
      return transport(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(HEADER, version);
    return transport(input, { ...init, headers });
  };
}
