# ComfyUI URL Downloader

A ComfyUI custom node that lets you download models directly to the server from HuggingFace or CivitAI — without saving them to your local PC.

## Features

- **Intercepts missing-model download buttons** — when a workflow has missing models, clicking the download link opens a dialog instead of downloading to the browser
- **Downloads directly to the LXC/server** where ComfyUI runs
- **Auto-detects destination folder** from the URL path (`diffusion_models`, `text_encoders`, `loras`, `vae`, etc.)
- **Resume support** — if a download is interrupted, it continues from where it left off
- **File size verification** — after completion, verifies the downloaded file matches the expected size
- **HuggingFace token support** — reads `HF_TOKEN` from environment for gated models
- **CivitAI token support** — reads from ComfyUI-Manager's `config.ini`
- **Active download tracking** — button is disabled while a download is in progress

## Installation

```bash
cd /opt/ComfyUI/custom_nodes
git clone https://github.com/bazadrian/comfyui-url-downloader.git
systemctl restart comfyui
```

## Configuration

### HuggingFace Token

Add to your ComfyUI systemd service:

```ini
# /etc/systemd/system/comfyui.service.d/tokens.conf
[Service]
Environment="HF_TOKEN=hf_your_token_here"
```

### CivitAI Token

```ini
# /opt/ComfyUI/user/__manager/config.ini
[default]
civitai_api_key = your_civitai_token_here
security_level = weak
```

## Usage

### Via missing-model dialog
Load any workflow with missing models. Instead of downloading to your browser, clicking the download button opens a dialog that downloads directly to the server.

### Via manual button
A **⬇ Download Model by URL** button appears in the bottom-right corner of the ComfyUI interface. Paste any HuggingFace or CivitAI URL and select the destination folder.

### Supported URL formats
- `https://huggingface.co/org/repo/blob/main/file.safetensors` (auto-converted)
- `https://huggingface.co/org/repo/resolve/main/file.safetensors`
- `https://civitai.com/api/download/models/12345`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/model_downloader/download` | Start a download |
| GET | `/model_downloader/progress?id=filename` | Poll download progress |
| GET | `/model_downloader/types` | List available model folders |
