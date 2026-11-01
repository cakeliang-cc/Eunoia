#!/usr/bin/env bash
#
# Install the production sandbox runtime: containerd + gVisor (runsc) + nerdctl,
# a dedicated containerd namespace, an egress network and an AppArmor profile.
#
# This script is intentionally a separate, reviewable artifact: it needs root,
# it writes under /etc and it restarts a system service. `npm run dev` never runs
# it, and the sandbox refuses to start with gVisor required until it has been run
# on the target host.
#
# Usage:
#   sudo RUNSC_VERSION=20240917.0 ./scripts/sandbox-install.sh
#
# After it finishes:
#   SANDBOX_RUNTIME_CLIENT=nerdctl
#   SANDBOX_RUNTIME_CLASS=gvisor
#   SANDBOX_IMAGE_DIGEST=sha256:...
#
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "this script installs a Linux runtime; on macOS use Docker Desktop and set SANDBOX_RUNTIME_CLASS=runc with SANDBOX_ALLOW_NON_GVISOR=1 for development" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root (sudo ...)" >&2
  exit 1
fi

RUNSC_VERSION="${RUNSC_VERSION:-20240917.0}"
NERDCTL_VERSION="${NERDCTL_VERSION:-2.0.0}"
CONTAINERD_VERSION="${CONTAINERD_VERSION:-2.0.0}"
NAMESPACE="${EUNOIA_CONTAINERD_NAMESPACE:-eunoia}"
EGRESS_NETWORK="${EUNOIA_EGRESS_NETWORK:-eunoia-egress}"

case "$(uname -m)" in
  x86_64) RUNSC_ARCH="x86_64"; NERDCTL_ARCH="amd64" ;;
  aarch64|arm64) RUNSC_ARCH="aarch64"; NERDCTL_ARCH="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required tool: $1" >&2
    exit 1
  }
}

need curl
need install
need systemctl

echo "==> installing containerd ${CONTAINERD_VERSION} if absent"
if ! command -v containerd >/dev/null 2>&1; then
  curl -fsSL "https://github.com/containerd/containerd/releases/download/v${CONTAINERD_VERSION}/containerd-${CONTAINERD_VERSION}-linux-${NERDCTL_ARCH}.tar.gz" \
    | tar -C /usr/local -xz
  install -D -m 0644 /dev/stdin /etc/systemd/system/containerd.service <<'UNIT'
[Unit]
Description=containerd container runtime
After=network.target
Documentation=https://containerd.io

[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/local/bin/containerd
Delegate=yes
KillMode=process
Restart=always
RestartSec=5
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
OOMScoreAdjust=-999

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now containerd
fi

echo "==> installing gVisor runsc ${RUNSC_VERSION}"
curl -fsSL "https://storage.googleapis.com/gvisor/releases/release/${RUNSC_VERSION}/${RUNSC_ARCH}/runsc" \
  -o /usr/local/bin/runsc
chmod 0755 /usr/local/bin/runsc
curl -fsSL "https://storage.googleapis.com/gvisor/releases/release/${RUNSC_VERSION}/${RUNSC_ARCH}/runsc.sha512" \
  -o /tmp/runsc.sha512 || true
if [[ -s /tmp/runsc.sha512 ]]; then
  (cd /usr/local/bin && sha512sum -c /tmp/runsc.sha512)
fi

echo "==> installing nerdctl ${NERDCTL_VERSION}"
curl -fsSL "https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-${NERDCTL_VERSION}-linux-${NERDCTL_ARCH}.tar.gz" \
  | tar -C /usr/local/bin -xz nerdctl
chmod 0755 /usr/local/bin/nerdctl

echo "==> registering the gVisor runtime handler"
mkdir -p /etc/containerd
if [[ -f /etc/containerd/config.toml ]]; then
  cp /etc/containerd/config.toml "/etc/containerd/config.toml.bak.$(date +%s)"
fi
if ! grep -q 'io.containerd.runsc.v1' /etc/containerd/config.toml 2>/dev/null; then
  cat >>/etc/containerd/config.toml <<EOF

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
  TypeUrl = "io.containerd.runsc.v1.options"
  ConfigPath = "/etc/containerd/runsc.toml"
EOF
fi
cat >/etc/containerd/runsc.toml <<'EOF'
[runsc_config]
  # No host networking, no direct filesystem access beyond the sandbox root.
  network = "none"
  platform = "systrap"
EOF
systemctl restart containerd

echo "==> creating the egress network (${EGRESS_NETWORK})"
nerdctl --namespace "${NAMESPACE}" network create --driver bridge "${EGRESS_NETWORK}" 2>/dev/null || true

echo "==> installing the sandbox AppArmor profile"
install -D -m 0644 /dev/stdin /etc/apparmor.d/eunoia-sandbox <<'APPARMOR'
#include <tunables/global>
profile eunoia-sandbox flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  # The workspace is the only writable tree.
  /workspace/** rwkl,
  /tmp/** rwkl,
  /proc/*/status r,
  /proc/*/fd/ r,
  deny /etc/shadow r,
  deny /etc/gshadow r,
  deny /etc/sudoers r,
  deny /root/** rwkl,
  deny /run/docker.sock rw,
  deny /var/run/docker.sock rw,
  deny /run/containerd/** rw,
  deny /var/run/containerd/** rw,
  deny mount,
  deny umount,
  deny pivot_root,
  deny ptrace,
  deny /sys/** w,
}
APPARMOR
apparmor_parser -r /etc/apparmor.d/eunoia-sandbox 2>/dev/null || true

echo "==> pull/verify the sandbox image and print its digest"
cat <<'EOF'

Runtime installed. Next:

  1. Load a trusted base image into the eunoia namespace and record its digest:
       nerdctl --namespace eunoia pull <image>
       nerdctl --namespace eunoia image inspect --format '{{.ID}}' <image>

  2. Configure the application:
       SANDBOX_ENABLED=1
       WORKSPACE_ROOT=/srv/eunoia/workspaces/project
       SANDBOX_RUNTIME_CLIENT=nerdctl
       SANDBOX_RUNTIME_CLASS=gvisor
       SANDBOX_IMAGE_DIGEST=sha256:...
       SANDBOX_APPARMOR_PROFILE=eunoia-sandbox
       SANDBOX_RESOURCE_PROFILE=default
       # egress, only when needed:
       # SANDBOX_NETWORK_MODE=proxy_only
       # SANDBOX_EGRESS_NETWORK=eunoia-egress
       # SANDBOX_PROXY_URL=http://<proxy-address>:8788
       # SANDBOX_ALLOWED_DOMAINS=registry.npmjs.org,api.example.com
       # SANDBOX_ALLOWED_PORTS=443

  3. Restrict the egress bridge so the sandbox can only reach the proxy. This is
     host-level and site-specific; the application cannot do it for you. Example
     (nftables), replacing the subnet and proxy address:

       nft add table inet eunoia
       nft add chain inet eunoia forward '{ type filter hook forward priority 0; policy drop; }'
       nft add rule inet eunoia forward ip saddr <egress-subnet> ip daddr <proxy-ip> tcp dport 8788 accept
       nft add rule inet eunoia forward ip daddr <egress-subnet> ct state established,related accept

  4. Verify:
       npm run sandbox:check

EOF
