// No ES module imports — use window.comfyAPI directly to avoid Vite bundling issues

(function () {
    "use strict";

    console.log("[URLDownloader] Script executing...");

    // Track active downloads: filename → interval ID
    const activeDownloads = new Map();

    const MODEL_SOURCES = ["huggingface.co", "civitai.com"];

    function isModelAnchor(el) {
        if (!el || el.tagName !== "A") return false;
        const href = el.href || "";
        return MODEL_SOURCES.some(s => href.includes(s));
    }

    // Strategy 1: real user clicks on <a> elements in the DOM
    document.addEventListener("click", function (e) {
        const anchor = e.target.closest("a");
        if (!anchor || anchor.dataset.allowBrowserDownload) return;
        if (!isModelAnchor(anchor)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const href = anchor.href;
        const filename = anchor.download || filenameFromUrl(href);
        console.log("[URLDownloader] User click intercepted:", href);
        showConfirmDialog(href, filename, guessModelType(href, filename));
    }, true);

    // Strategy 2: programmatic element.click() — used by ComfyUI's downloadModel()
    const _origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (!this.dataset.allowBrowserDownload && isModelAnchor(this)) {
            const href = this.href;
            const filename = this.download || filenameFromUrl(href);
            console.log("[URLDownloader] Programmatic click intercepted:", href);
            showConfirmDialog(href, filename, guessModelType(href, filename));
            return;
        }
        return _origClick.call(this);
    };

    console.log("[URLDownloader] Interceptors installed.");

    // Register ComfyUI extension for the manual download button
    function registerExtension() {
        const api = window.comfyAPI;
        if (!api || !api.app || !api.app.app) {
            setTimeout(registerExtension, 200);
            return;
        }
        api.app.app.registerExtension({
            name: "URLModelDownloader",
            async setup() {
                const btnModel = document.createElement("button");
                btnModel.textContent = "⬇ Download Model by URL";
                btnModel.style.cssText = [
                    "position:fixed", "bottom:20px", "right:20px", "z-index:9999",
                    "background:#1e88e5", "color:white", "border:none", "border-radius:6px",
                    "padding:8px 14px", "font-size:13px", "cursor:pointer",
                    "box-shadow:0 2px 8px rgba(0,0,0,0.4)"
                ].join(";");
                btnModel.onclick = () => showDialog();
                document.body.appendChild(btnModel);

                const btnWorkflow = document.createElement("button");
                btnWorkflow.textContent = "⬇ Download Workflow";
                btnWorkflow.style.cssText = [
                    "position:fixed", "bottom:56px", "right:20px", "z-index:9999",
                    "background:#7b1fa2", "color:white", "border:none", "border-radius:6px",
                    "padding:8px 14px", "font-size:13px", "cursor:pointer",
                    "box-shadow:0 2px 8px rgba(0,0,0,0.4)"
                ].join(";");
                btnWorkflow.onclick = () => showWorkflowDialog();
                document.body.appendChild(btnWorkflow);

                console.log("[URLDownloader] Buttons added.");
            }
        });
    }
    registerExtension();

    // ── helpers ──────────────────────────────────────────────────────────────

    function guessModelType(url, filename) {
        const s = (url + "/" + filename).toLowerCase();
        if (s.includes("diffusion_model") || s.includes("/unet/")) return "diffusion_models";
        if (s.includes("text_encoder") || s.includes("clip_l") || /[/_]t5/i.test(s)) return "text_encoders";
        if (s.includes("controlnet")) return "controlnet";
        if (s.includes("/lora") || /lora/i.test(filename)) return "loras";
        if (/vae/i.test(filename) || s.includes("/vae/")) return "vae";
        if (s.includes("upscale") || s.includes("esrgan")) return "upscale_models";
        return "checkpoints";
    }

    function filenameFromUrl(url) {
        try { return url.split("/").pop().split("?")[0] || ""; }
        catch { return ""; }
    }

    async function getModelTypes() {
        try {
            const res = await fetch("/model_downloader/types");
            return (await res.json()).types || [];
        } catch {
            return ["checkpoints", "diffusion_models", "loras", "vae", "controlnet", "text_encoders", "unet", "upscale_models"];
        }
    }

    async function showConfirmDialog(url, filename, model_type) {
        showDialog(url, filename, model_type, await getModelTypes());
    }

    function showDialog(prefillUrl, prefillFilename, prefillType, cachedTypes) {
        prefillUrl = prefillUrl || "";
        prefillFilename = prefillFilename || "";
        prefillType = prefillType || "checkpoints";

        Promise.resolve(cachedTypes || getModelTypes()).then(function (types) {
            const selectedType = types.includes(prefillType) ? prefillType : "checkpoints";
            const alreadyActive = prefillFilename && activeDownloads.has(prefillFilename);

            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center";

            const dialog = document.createElement("div");
            dialog.style.cssText = "background:#1a1a2e;color:#eee;border-radius:10px;padding:28px;width:520px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.6);font-family:sans-serif";

            const startBtnLabel = alreadyActive
                ? "⏳ Descargando..."
                : "⬇ Descargar al servidor";
            const startBtnStyle = "padding:8px 18px;border:none;border-radius:5px;cursor:" +
                (alreadyActive ? "not-allowed;background:#555;color:#aaa" : "pointer;background:#1e88e5;color:white");

            dialog.innerHTML =
                '<h2 style="margin:0 0 20px;font-size:16px;color:#90caf9">⬇ Download Model to Server</h2>' +
                '<label style="font-size:12px;color:#aaa">URL del modelo</label>' +
                '<input id="mdu-url" type="text" placeholder="https://huggingface.co/.../model.safetensors" value="' + escHtml(prefillUrl) + '" style="width:100%;box-sizing:border-box;margin:4px 0 14px;padding:8px 10px;background:#0d0d1a;border:1px solid #444;border-radius:5px;color:#eee;font-size:13px"/>' +
                '<label style="font-size:12px;color:#aaa">Nombre de archivo</label>' +
                '<input id="mdu-filename" type="text" placeholder="model.safetensors" value="' + escHtml(prefillFilename) + '" style="width:100%;box-sizing:border-box;margin:4px 0 14px;padding:8px 10px;background:#0d0d1a;border:1px solid #444;border-radius:5px;color:#eee;font-size:13px"/>' +
                '<label style="font-size:12px;color:#aaa">Carpeta destino</label>' +
                '<select id="mdu-type" style="width:100%;box-sizing:border-box;margin:4px 0 20px;padding:8px 10px;background:#0d0d1a;border:1px solid #444;border-radius:5px;color:#eee;font-size:13px">' +
                types.map(function (t) { return '<option value="' + t + '"' + (t === selectedType ? " selected" : "") + ">" + t + "</option>"; }).join("") +
                "</select>" +
                '<div id="mdu-status" style="font-size:12px;color:#90caf9;min-height:18px;margin-bottom:14px">' +
                (alreadyActive ? "Descarga en progreso..." : "") + "</div>" +
                '<div style="display:flex;gap:10px;justify-content:flex-end">' +
                '<button id="mdu-cancel" style="padding:8px 18px;background:#333;color:#eee;border:none;border-radius:5px;cursor:pointer">Cerrar</button>' +
                '<button id="mdu-start" ' + (alreadyActive ? "disabled " : "") + 'style="' + startBtnStyle + '">' + startBtnLabel + "</button>" +
                "</div>";

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const urlInput = dialog.querySelector("#mdu-url");
            const filenameInput = dialog.querySelector("#mdu-filename");
            const typeSelect = dialog.querySelector("#mdu-type");
            const statusDiv = dialog.querySelector("#mdu-status");
            const startBtn = dialog.querySelector("#mdu-start");
            const cancelBtn = dialog.querySelector("#mdu-cancel");

            // If already downloading, attach to existing poll
            if (alreadyActive) {
                pollProgress(prefillFilename, statusDiv, startBtn, cancelBtn, overlay);
            }

            urlInput.addEventListener("input", function () {
                const url = urlInput.value.trim();
                const auto = filenameFromUrl(url);
                if (auto) filenameInput.value = auto;
                const guessed = guessModelType(url, auto);
                if (types.includes(guessed)) typeSelect.value = guessed;
            });

            cancelBtn.onclick = function () { overlay.remove(); };
            overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

            startBtn.onclick = function () {
                const url = urlInput.value.trim();
                const filename = filenameInput.value.trim();
                const model_type = typeSelect.value;
                if (!url || !filename) {
                    statusDiv.textContent = "⚠ URL y nombre de archivo son obligatorios.";
                    statusDiv.style.color = "#f44";
                    return;
                }
                startBtn.disabled = true;
                cancelBtn.disabled = true;
                statusDiv.style.color = "#90caf9";
                statusDiv.textContent = "Iniciando descarga...";

                fetch("/model_downloader/download", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url: url, filename: filename, model_type: model_type })
                }).then(function (res) {
                    if (!res.ok) {
                        return res.json().catch(function () { return res.text().then(function (t) { return { error: t }; }); }).then(function (err) {
                            statusDiv.textContent = "Error: " + (err.error || "unknown");
                            statusDiv.style.color = "#f44";
                            startBtn.disabled = false;
                            cancelBtn.disabled = false;
                        });
                    }
                    statusDiv.textContent = "Descargando... 0%";
                    activeDownloads.set(filename, true);
                    pollProgress(filename, statusDiv, startBtn, cancelBtn, overlay);
                }).catch(function (e) {
                    statusDiv.textContent = "Error: " + e.message;
                    statusDiv.style.color = "#f44";
                    startBtn.disabled = false;
                    startBtn.style.background = "#1e88e5";
                    startBtn.style.cursor = "pointer";
                });
            };

            urlInput.focus();
        });
    }

    function pollProgress(id, statusDiv, startBtn, cancelBtn, overlay) {
        var interval = setInterval(function () {
            fetch("/model_downloader/progress?id=" + encodeURIComponent(id))
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.status === "downloading") {
                        statusDiv.textContent = "Descargando... " + data.progress + "%";
                        statusDiv.style.color = "#90caf9";
                    } else if (data.status === "done") {
                        clearInterval(interval);
                        activeDownloads.delete(id);
                        var size = data.size ? " (" + (data.size / 1024 / 1024 / 1024).toFixed(2) + " GB)" : "";
                        statusDiv.textContent = "✓ Completado: " + id + size;
                        statusDiv.style.color = "#4caf50";
                        startBtn.textContent = "✓ Listo";
                        startBtn.disabled = true;
                        startBtn.style.background = "#2e7d32";
                        cancelBtn.textContent = "Cerrar";
                    } else if (data.status === "error") {
                        clearInterval(interval);
                        activeDownloads.delete(id);
                        statusDiv.textContent = "Error: " + data.error;
                        statusDiv.style.color = "#f44";
                        startBtn.disabled = false;
                        startBtn.textContent = "⬇ Reintentar";
                        startBtn.style.background = "#1e88e5";
                        startBtn.style.cursor = "pointer";
                    }
                }).catch(function () { clearInterval(interval); });
        }, 1500);
    }

    function showWorkflowDialog() {
        var overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center";

        var dialog = document.createElement("div");
        dialog.style.cssText = "background:#1a1a2e;color:#eee;border-radius:10px;padding:28px;width:500px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.6);font-family:sans-serif";

        dialog.innerHTML =
            '<h2 style="margin:0 0 8px;font-size:16px;color:#ce93d8">⬇ Download Workflow</h2>' +
            '<p style="font-size:11px;color:#888;margin:0 0 16px">Acepta .json o .zip (se extrae automáticamente a workflows/)</p>' +
            '<label style="font-size:12px;color:#aaa">URL del workflow</label>' +
            '<input id="wfd-url" type="text" placeholder="https://github.com/.../workflow.zip"' +
            ' style="width:100%;box-sizing:border-box;margin:4px 0 20px;padding:8px 10px;background:#0d0d1a;border:1px solid #444;border-radius:5px;color:#eee;font-size:13px"/>' +
            '<div id="wfd-status" style="font-size:12px;color:#aaa;min-height:18px;margin-bottom:14px"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button id="wfd-cancel" style="padding:8px 18px;background:#333;color:#eee;border:none;border-radius:5px;cursor:pointer">Cancelar</button>' +
            '<button id="wfd-start" style="padding:8px 18px;background:#7b1fa2;color:white;border:none;border-radius:5px;cursor:pointer">⬇ Descargar</button>' +
            "</div>";

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        var urlInput = dialog.querySelector("#wfd-url");
        var statusDiv = dialog.querySelector("#wfd-status");
        var startBtn = dialog.querySelector("#wfd-start");
        var cancelBtn = dialog.querySelector("#wfd-cancel");

        cancelBtn.onclick = function () { overlay.remove(); };
        overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };

        startBtn.onclick = function () {
            var url = urlInput.value.trim();
            if (!url) {
                statusDiv.textContent = "⚠ URL es obligatoria.";
                statusDiv.style.color = "#f44";
                return;
            }
            startBtn.disabled = true;
            startBtn.textContent = "⏳ Descargando...";
            cancelBtn.disabled = true;
            statusDiv.style.color = "#ce93d8";
            statusDiv.textContent = "Iniciando...";

            fetch("/model_downloader/download_workflow", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: url })
            }).then(function (res) {
                return res.json();
            }).then(function (data) {
                if (data.error) {
                    statusDiv.textContent = "Error: " + data.error;
                    statusDiv.style.color = "#f44";
                    startBtn.disabled = false;
                    startBtn.textContent = "⬇ Descargar";
                    cancelBtn.disabled = false;
                    return;
                }
                var id = data.id;
                var interval = setInterval(function () {
                    fetch("/model_downloader/progress?id=" + encodeURIComponent(id))
                        .then(function (r) { return r.json(); })
                        .then(function (d) {
                            if (d.status === "downloading") {
                                statusDiv.textContent = "Descargando... " + d.progress + "%";
                                statusDiv.style.color = "#ce93d8";
                            } else if (d.status === "done") {
                                clearInterval(interval);
                                var files = d.files || [];
                                statusDiv.innerHTML = "✓ <b>" + d.count + " archivo(s)</b> guardados en workflows/:<br>" +
                                    '<span style="font-size:11px;color:#aaa">' + files.join(", ") + "</span>";
                                statusDiv.style.color = "#4caf50";
                                startBtn.textContent = "✓ Listo";
                                startBtn.style.background = "#2e7d32";
                                cancelBtn.textContent = "Cerrar";
                                cancelBtn.disabled = false;
                            } else if (d.status === "error") {
                                clearInterval(interval);
                                statusDiv.textContent = "Error: " + d.error;
                                statusDiv.style.color = "#f44";
                                startBtn.disabled = false;
                                startBtn.textContent = "⬇ Reintentar";
                                cancelBtn.disabled = false;
                            }
                        }).catch(function () { clearInterval(interval); });
                }, 1000);
            }).catch(function (e) {
                statusDiv.textContent = "Error: " + e.message;
                statusDiv.style.color = "#f44";
                startBtn.disabled = false;
                startBtn.textContent = "⬇ Descargar";
                cancelBtn.disabled = false;
            });
        };

        urlInput.focus();
    }

    function escHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    }

})();
