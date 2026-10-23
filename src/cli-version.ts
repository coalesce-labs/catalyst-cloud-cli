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
    return transport(input, { ...init, headers: withVersion(init?.headers ?? (input instanceof Request ? input.headers : undefined), version) });
  };
}

/** Adds the header in the shape the caller used, so a transport that reads a plain record keeps
 *  reading one. A caller's own copy of the header, in any case, is replaced. */
function withVersion(headers: HeadersInit | undefined, version: string): HeadersInit {
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set(HEADER, version);
    return copy;
  }
  if (Array.isArray(headers)) return [...headers.filter(([name]) => name.toLowerCase() !== HEADER), [HEADER, version]];
  const record: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) if (name.toLowerCase() !== HEADER) record[name] = value;
  record[HEADER] = version;
  return record;
}
