#!/bin/sh
# Installs Catalyst's session egress service on a native Linux runner machine, from the files
# that ship with this catalyst CLI. Setup prints the one command that runs it as root from a
# checked root-owned copy, passing the CLI's vendor folder as $1. It copies the files into a
# root-owned folder, checks their fingerprints there, and installs only checked bytes.
set -eu
if [ "$(id -u)" != 0 ]; then
  echo "Run this with sudo: sudo sh '$0'" >&2
  exit 1
fi
src="${1:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}/self-host/linux-session-egress"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for name in session-egress.py catalyst-session-egress.service catalyst-session-egress-attest.service catalyst-session-egress-attest.timer; do
  cp "$src/$name" "$work/$name"
done
(cd "$work" && sha256sum -c --quiet -) <<'SUMS'
a20cedfa1e883127ec461e4b7f9588d379fe1633b8244ecd703c81f589d3f142  session-egress.py
703c150ab23ec87aea47cfc394f63e061b66c4b8c1454a88a9be879c161ce2a5  catalyst-session-egress.service
94fa75ea0616f6a1172fc20ca637a5727c36456357e4a977d5bdd65f2fad2e8d  catalyst-session-egress-attest.service
176622c11c835601b95f36e375ba3c2e993136976c67e5d49559f13a3454fef9  catalyst-session-egress-attest.timer
SUMS
install -D -o root -g root -m 755 "$work/session-egress.py" /usr/lib/catalyst/session-egress.py
for unit in catalyst-session-egress.service catalyst-session-egress-attest.service catalyst-session-egress-attest.timer; do
  install -o root -g root -m 644 "$work/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now catalyst-session-egress.service catalyst-session-egress-attest.timer
/usr/bin/python3 /usr/lib/catalyst/session-egress.py attest
echo "Session egress is installed. Run the same catalyst setup command again."
