import os
import threading
from aiohttp import web
import folder_paths

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./js"

download_status = {}


def _get_remote_size(url, hf_token):
    import urllib.request
    try:
        req = urllib.request.Request(url, method="HEAD")
        if hf_token and "huggingface.co" in url:
            req.add_header("Authorization", f"Bearer {hf_token}")
        with urllib.request.urlopen(req) as r:
            # HuggingFace uses x-linked-size for the actual file behind the redirect
            size = r.headers.get("x-linked-size") or r.headers.get("Content-Length")
            return int(size) if size else 0
    except Exception:
        return 0


def _do_download(download_id, url, dest_path, hf_token):
    import urllib.request

    existing = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
    download_status[download_id] = {"status": "downloading", "progress": 0, "error": None}

    try:
        req = urllib.request.Request(url)
        if hf_token and "huggingface.co" in url:
            req.add_header("Authorization", f"Bearer {hf_token}")
        if existing:
            req.add_header("Range", f"bytes={existing}-")

        with urllib.request.urlopen(req) as response:
            content_range = response.headers.get("Content-Range", "")
            content_length = int(response.headers.get("Content-Length", 0))

            if content_range:
                total = int(content_range.split("/")[-1])
            else:
                total = content_length
                existing = 0

            downloaded = existing
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            mode = "ab" if existing else "wb"
            with open(dest_path, mode) as f:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        download_status[download_id]["progress"] = round(downloaded / total * 100, 1)

        # Verify final file size
        actual = os.path.getsize(dest_path)
        expected = total if total else _get_remote_size(url, hf_token)
        if expected and actual != expected:
            download_status[download_id] = {
                "status": "error",
                "progress": 0,
                "error": f"Tamaño incorrecto: esperado {expected:,} bytes, descargado {actual:,} bytes. Intenta de nuevo."
            }
            return

        download_status[download_id] = {"status": "done", "progress": 100, "error": None, "size": actual}

    except Exception as e:
        download_status[download_id] = {"status": "error", "progress": 0, "error": str(e)}


async def download_model(request):
    data = await request.json()
    url = data.get("url", "").strip()
    filename = data.get("filename", "").strip()
    model_type = data.get("model_type", "checkpoints")

    if not url or not filename:
        return web.json_response({"error": "url and filename are required"}, status=400)

    url = url.replace("/blob/main/", "/resolve/main/").replace("/blob/master/", "/resolve/master/")

    type_map = folder_paths.folder_names_and_paths
    if model_type not in type_map:
        return web.json_response({"error": f"Unknown model type: {model_type}"}, status=400)

    dest_dir = type_map[model_type][0][0]
    dest_path = os.path.join(dest_dir, filename)

    # Block duplicate active downloads
    if download_status.get(filename, {}).get("status") == "downloading":
        return web.json_response({"status": "already_running", "id": filename})

    existing = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
    resume_msg = f" (reanudando desde {existing // 1024 // 1024}MB)" if existing else ""
    print(f"[URL Downloader] Iniciando descarga{resume_msg}: {filename}")

    hf_token = os.environ.get("HF_TOKEN", "")
    thread = threading.Thread(target=_do_download, args=(filename, url, dest_path, hf_token), daemon=True)
    thread.start()

    return web.json_response({"status": "started", "id": filename, "resume": existing > 0})


async def download_progress(request):
    download_id = request.rel_url.query.get("id", "")
    if download_id not in download_status:
        return web.json_response({"status": "unknown"})
    return web.json_response(download_status[download_id])


async def list_model_types(request):
    types = list(folder_paths.folder_names_and_paths.keys())
    return web.json_response({"types": sorted(types)})


try:
    from server import PromptServer
    PromptServer.instance.app.router.add_post("/model_downloader/download", download_model)
    PromptServer.instance.app.router.add_get("/model_downloader/progress", download_progress)
    PromptServer.instance.app.router.add_get("/model_downloader/types", list_model_types)
except Exception as e:
    print(f"[URL Downloader] Failed to register routes: {e}")
