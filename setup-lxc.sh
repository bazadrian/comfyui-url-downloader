#!/bin/bash
# =============================================================================
# ComfyUI LXC Setup Script — bazancloud homelab
# Proxmox 8.4 | Ubuntu 22.04 LXC | RTX 3090 passthrough
# =============================================================================
# Run this from the Proxmox HOST (not inside the LXC)
# Usage: bash setup-lxc.sh
# =============================================================================

set -e

LXC_ID=100
LXC_HOSTNAME="comfyui"
LXC_STORAGE="local-lvm"       # adjust to your storage pool
LXC_DISK_SIZE="120"           # GB
LXC_RAM="32768"               # MB
LXC_SWAP="8192"               # MB
LXC_CORES="14"
GPU_PCI="05:00.0"             # RTX 3090 PCI address — verify with: lspci | grep NVIDIA

COMFYUI_PORT=8188
COMFYUI_DIR="/opt/ComfyUI"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Verify running on Proxmox host ────────────────────────────────────────────
[[ -f /etc/pve/pve-ssl.pem ]] || error "This script must run on the Proxmox host."

info "=== Step 1: Verify GRUB parameters ==="
cat /etc/default/grub | grep GRUB_CMDLINE_LINUX_DEFAULT
warn "Required params: quiet nomodeset intel_iommu=on iommu=pt pci=realloc=off"
warn "If missing, edit /etc/default/grub, run update-grub and reboot before continuing."
read -p "GRUB params correct? [y/N] " ok; [[ "$ok" == "y" ]] || error "Fix GRUB first."

info "=== Step 2: Install NVIDIA driver on host ==="
if ! nvidia-smi &>/dev/null; then
    warn "NVIDIA driver not found. Installing..."
    apt-get update -q
    apt-get install -y pve-headers-$(uname -r) gcc-13 make dkms pahole
    # Download driver — update version as needed
    DRIVER_VER="595.71.05"
    wget -q "https://us.download.nvidia.com/XFree86/Linux-x86_64/${DRIVER_VER}/NVIDIA-Linux-x86_64-${DRIVER_VER}.run" \
        -O /tmp/nvidia-driver.run
    CC=gcc-13 sh /tmp/nvidia-driver.run --dkms -j2 --no-questions
    info "Driver installed. You may need to reboot."
else
    info "NVIDIA driver already present: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader)"
fi

info "=== Step 3: Create LXC container ==="
if pct status $LXC_ID &>/dev/null; then
    warn "LXC $LXC_ID already exists, skipping creation."
else
    # Download Ubuntu 22.04 template if needed
    if ! pveam list local | grep -q "ubuntu-22.04"; then
        pveam update
        pveam download local ubuntu-22.04-standard_22.04-1_amd64.tar.zst
    fi
    TEMPLATE=$(pveam list local | grep ubuntu-22.04 | awk '{print $1}' | head -1)

    pct create $LXC_ID "$TEMPLATE" \
        --hostname "$LXC_HOSTNAME" \
        --storage "$LXC_STORAGE" \
        --rootfs "${LXC_STORAGE}:${LXC_DISK_SIZE}" \
        --memory "$LXC_RAM" \
        --swap "$LXC_SWAP" \
        --cores "$LXC_CORES" \
        --net0 name=eth0,bridge=vmbr0,ip=dhcp \
        --unprivileged 0 \
        --features nesting=1
    info "LXC $LXC_ID created."
fi

info "=== Step 4: Configure GPU passthrough ==="
CONFIG_FILE="/etc/pve/lxc/${LXC_ID}.conf"
if ! grep -q "nvidia" "$CONFIG_FILE" 2>/dev/null; then
    # Get NVIDIA device IDs
    NVIDIA_DEV=$(ls /dev/nvidia* /dev/nvidiactl /dev/nvidia-uvm 2>/dev/null)
    {
        echo "# NVIDIA GPU passthrough"
        for dev in $NVIDIA_DEV; do
            major=$(stat -c '%t' "$dev" 2>/dev/null | xargs printf '%d\n')
            minor=$(stat -c '%T' "$dev" 2>/dev/null | xargs printf '%d\n')
            [[ $major -gt 0 ]] && echo "lxc.cgroup2.devices.allow: c ${major}:${minor} rwm"
            echo "lxc.mount.entry: $dev $dev none bind,optional,create=file"
        done
    } >> "$CONFIG_FILE"
    info "GPU passthrough configured."
else
    info "GPU passthrough already configured."
fi

info "=== Step 5: Start LXC ==="
pct start $LXC_ID 2>/dev/null || true
sleep 5
pct status $LXC_ID | grep -q running || error "LXC failed to start."

info "=== Step 6: Install dependencies inside LXC ==="
pct exec $LXC_ID -- bash -c "
    apt-get update -q && \
    apt-get install -y python3 python3-pip python3-venv git wget curl \
        libgl1 libglib2.0-0 ffmpeg --no-install-recommends -q
"

info "=== Step 7: Install ComfyUI ==="
pct exec $LXC_ID -- bash -c "
    if [[ -d ${COMFYUI_DIR} ]]; then
        echo 'ComfyUI already exists, skipping.'
        exit 0
    fi
    git clone https://github.com/comfyanonymous/ComfyUI.git ${COMFYUI_DIR}
    cd ${COMFYUI_DIR}
    python3 -m venv venv
    source venv/bin/activate
    # Install PyTorch with CUDA — update index URL for your CUDA version
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 -q
    pip install -r requirements.txt -q
"

info "=== Step 8: Install ComfyUI-Manager ==="
pct exec $LXC_ID -- bash -c "
    if [[ -d ${COMFYUI_DIR}/custom_nodes/ComfyUI-Manager ]]; then
        echo 'ComfyUI-Manager already exists.'
    else
        git clone https://github.com/ltdrdata/ComfyUI-Manager.git \
            ${COMFYUI_DIR}/custom_nodes/ComfyUI-Manager
        ${COMFYUI_DIR}/venv/bin/pip install \
            -r ${COMFYUI_DIR}/custom_nodes/ComfyUI-Manager/requirements.txt -q
    fi
    # Config
    mkdir -p ${COMFYUI_DIR}/user/__manager
    cat > ${COMFYUI_DIR}/user/__manager/config.ini << 'EOF'
[default]
security_level = weak
EOF
"

info "=== Step 9: Install comfyui-url-downloader ==="
pct exec $LXC_ID -- bash -c "
    if [[ -d ${COMFYUI_DIR}/custom_nodes/comfyui-url-downloader ]]; then
        cd ${COMFYUI_DIR}/custom_nodes/comfyui-url-downloader && git pull
    else
        git clone https://github.com/bazadrian/comfyui-url-downloader.git \
            ${COMFYUI_DIR}/custom_nodes/comfyui-url-downloader
    fi
"

info "=== Step 10: Configure systemd service ==="
pct exec $LXC_ID -- bash -c "
cat > /etc/systemd/system/comfyui.service << 'EOF'
[Unit]
Description=ComfyUI
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${COMFYUI_DIR}
ExecStart=${COMFYUI_DIR}/venv/bin/python3 main.py --listen 0.0.0.0 --port ${COMFYUI_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable comfyui
"

info "=== Step 11: Configure API tokens ==="
warn "You need to add your API tokens manually:"
warn ""
warn "  HuggingFace token:"
warn "  mkdir -p /etc/systemd/system/comfyui.service.d/"
warn "  echo '[Service]' > /etc/systemd/system/comfyui.service.d/tokens.conf"
warn "  echo 'Environment=\"HF_TOKEN=hf_YOUR_TOKEN\"' >> /etc/systemd/system/comfyui.service.d/tokens.conf"
warn "  (run inside LXC: pct exec $LXC_ID -- bash)"
warn ""
warn "  CivitAI token — add to ${COMFYUI_DIR}/user/__manager/config.ini:"
warn "  civitai_api_key = YOUR_TOKEN"

info "=== Step 12: Start ComfyUI ==="
pct exec $LXC_ID -- bash -c "systemctl restart comfyui && sleep 5 && systemctl is-active comfyui"

echo ""
info "=== Setup complete! ==="
info "ComfyUI running at: http://\$(pct exec $LXC_ID -- hostname -I | awk '{print \$1}'):${COMFYUI_PORT}"
info ""
info "Next steps:"
info "  1. Add API tokens (see Step 11 above)"
info "  2. Set up Cloudflare Tunnel for external access"
info "  3. Download models via the ComfyUI-Manager or URL Downloader"
