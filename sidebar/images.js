/**
 * sidebar/images.js — Attached frames: capture, the image strip, and the crop/draw editor.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

/**
 * Explain the screenshot permission and let the user decide, on a button.
 *
 * Reuses the error panel's grant-and-retry flow: its button asks, and on
 * success re-runs the capture, so one click finishes the job. Nothing is
 * requested until that button is pressed.
 */
function offerScreenshotPermission() {
  setStatus('warning', 'Attaching a frame needs one of the steps below.');
  ErrorPanel.report({
    status: null, provider: null, model: null,
    code: 'permission_missing',
    message:
      'The lecture video is copy-protected, so the frame has to be taken as a picture of the page, and Chrome guards that.\n\n' +
      'Either of these works and neither asks for anything:\n' +
      '  1. Click the extension icon in your toolbar once, then press Attach frame again. That allows this tab only, until you navigate away.\n' +
      '  2. Press ' + FRAME_SHORTCUT + '.\n\n' +
      'Or grant it permanently with the button below, if you would rather the button just worked from now on.',
    raw: { origin: '<all_urls>', host: 'all sites' },
    timestamp: Date.now()
  }, {
    onGranted: async () => {
      const { b64, error } = await captureFrame();
      if (b64) {
        attachedImages.push({ dataUrl: `data:image/jpeg;base64,${b64}`, label: 'Frame' });
        renderImageStrip();
        setStatus('ready', 'Frame attached');
        return;
      }
      setStatus('error', `Frame capture failed: ${error || 'unknown reason'}`);
      throw new Error(error || 'Frame capture failed');
    }
  });
}

function captureFrame() {
  return new Promise((resolve) => {
    const id = makeRequestId();
    window.CopilotDebug?.log('[Copilot] captureFrame: sending CAPTURE_FRAME', id);
    const timer = setTimeout(() => {
      window.CopilotDebug?.warn('[Copilot] captureFrame: timed out waiting for FRAME_CAPTURED', id);
      delete pendingRequests[id];
      resolve({ b64: null, error: 'The page did not respond within 8 seconds. Reload the lecture tab and try again.' });
    }, 8000);
    pendingRequests[id] = (result) => {
      clearTimeout(timer);
      window.CopilotDebug?.log('[Copilot] captureFrame: got result', id, result?.b64 ? 'b64 length=' + result.b64.length : 'null');
      resolve(result || { b64: null, error: 'No response from the lecture page.' });
    };
    postToContent({ type: 'CAPTURE_FRAME', requestId: id });
  });
}

// ─── Image strip helpers ──────────────────────────────────────────────────

function renderImageStrip() {
  if (!qaImageStrip) return;
  const hint = document.getElementById('qa-img-edit-hint');
  if (!attachedImages.length) {
    qaImageStrip.style.display = 'none';
    qaImageStrip.innerHTML = '';
    if (hint) hint.style.display = 'none';
    return;
  }
  qaImageStrip.style.display = 'flex';
  if (hint) hint.style.display = 'flex';
  qaImageStrip.innerHTML = attachedImages.map((img, i) => `
      <div class="qa-image-thumb" data-strip-index="${i}" title="Click to preview">
        <img src="${img.dataUrl}" alt="${img.label}">
        <button class="qa-image-remove" data-strip-index="${i}" type="button" title="Remove" aria-label="Remove image">×</button>
        <span class="qa-image-label">${img.label}</span>
      </div>
    `).join('');

  // Remove buttons
  qaImageStrip.querySelectorAll('.qa-image-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.stripIndex, 10);
      attachedImages.splice(idx, 1);
      renderImageStrip();
    });
  });

  // Click thumbnail to open image editor
  qaImageStrip.querySelectorAll('.qa-image-thumb').forEach(thumb => {
    thumb.addEventListener('click', e => {
      if (e.target.classList.contains('qa-image-remove')) return;
      const idx = parseInt(thumb.dataset.stripIndex, 10);
      openImageEditor(idx);
    });
  });
}

function processImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = e => {
    const original = e.target.result;
    // Compress: cap longest side at 1280px, re-encode as JPEG
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      let { width: w, height: h } = img;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      attachedImages.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.82), label: 'Image' });
      renderImageStrip();
    };
    img.src = original;
  };
  reader.readAsDataURL(file);
}

// ─── Image Editor ─────────────────────────────────────────────────────────

let _imgEd = null; // editor state; null when closed

function openImageEditor(imageIdx) {
  const imgData = attachedImages[imageIdx];
  if (!imgData) return;
  const overlay = document.getElementById('qa-img-editor');
  if (!overlay) return;

  const canvas = document.getElementById('qa-img-ed-canvas');
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.onload = () => {
    // Scale to fit viewport
    const maxW = Math.min(window.innerWidth - 48, 860);
    const maxH = window.innerHeight - 150;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    const cW = Math.round(img.naturalWidth * scale);
    const cH = Math.round(img.naturalHeight * scale);

    // Back the canvas at screen density and let CSS scale it down. Sizing
    // the bitmap to the CSS box made the editor show a soft, pixellated
    // copy of a sharp image — the crop was fine, the preview was not.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width  = Math.round(cW * dpr);
    canvas.height = Math.round(cH * dpr);
    canvas.style.width  = cW + 'px';
    canvas.style.height = cH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';

    // Offscreen canvas for drawing strokes
    const drawCanvas = document.createElement('canvas');
    drawCanvas.width  = cW;
    drawCanvas.height = cH;

    _imgEd = {
      imageIdx,
      img,
      // Logical editor size. The canvas bitmap is dpr times larger so the
      // preview is sharp; every coordinate below stays in these units.
      cssW: cW, cssH: cH,
      canvas, ctx,
      drawCanvas, drawCtx: drawCanvas.getContext('2d'),
      crop: { x: 0, y: 0, w: cW, h: cH },
      mode: 'crop',
      color: '#e53e3e',
      brushSize: 4,
      isDrawing: false,
      dragHandle: null, dragStart: null, dragStartCrop: null,
    };

    // Reset toolbar UI
    overlay.querySelectorAll('.qa-img-ed-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'crop');
    });
    overlay.querySelectorAll('.qa-img-ed-color').forEach(b => {
      b.classList.toggle('active', b.dataset.color === '#e53e3e');
    });
    _imgEdSetMode('crop');
    _imgEdRender();
    _imgEdUpdateHandles();
    overlay.hidden = false;
  };
  img.src = imgData.dataUrl;
}

function _imgEdRender() {
  if (!_imgEd) return;
  const { img, canvas, ctx, drawCanvas, crop } = _imgEd;
  const W = _imgEd.cssW, H = _imgEd.cssH;

  ctx.clearRect(0, 0, W, H);
  // 1. Base image
  ctx.drawImage(img, 0, 0, W, H);
  // 2. Drawing layer
  ctx.drawImage(drawCanvas, 0, 0);
  // 3. Dark overlay outside crop via even-odd path
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.52)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(crop.x, crop.y, crop.w, crop.h);
  ctx.closePath();
  ctx.fill('evenodd');
  ctx.restore();
  // 4. Crop border
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(crop.x + 0.75, crop.y + 0.75, crop.w - 1.5, crop.h - 1.5);
  ctx.restore();
}

function _imgEdUpdateHandles() {
  if (!_imgEd) return;
  const { crop } = _imgEd;
  const layer = document.getElementById('qa-img-ed-handles');
  if (!layer) return;
  const pts = {
    tl: [crop.x, crop.y],
    tm: [crop.x + crop.w / 2, crop.y],
    tr: [crop.x + crop.w, crop.y],
    ml: [crop.x, crop.y + crop.h / 2],
    mr: [crop.x + crop.w, crop.y + crop.h / 2],
    bl: [crop.x, crop.y + crop.h],
    bm: [crop.x + crop.w / 2, crop.y + crop.h],
    br: [crop.x + crop.w, crop.y + crop.h],
  };
  layer.querySelectorAll('.qa-img-ed-handle').forEach(h => {
    const p = pts[h.dataset.pos];
    if (p) { h.style.left = p[0] + 'px'; h.style.top = p[1] + 'px'; }
  });
}

function _imgEdSetMode(mode) {
  if (!_imgEd) return;
  _imgEd.mode = mode;
  const canvas = _imgEd.canvas;
  const handles = document.getElementById('qa-img-ed-handles');
  const colors  = document.getElementById('qa-img-ed-colors');
  const clearBtn = document.getElementById('qa-img-ed-clear-draw');
  if (mode === 'draw') {
    canvas.style.cursor = 'crosshair';
    if (handles) { handles.style.pointerEvents = 'none'; handles.style.opacity = '0.35'; }
    if (colors)  colors.style.opacity = '1';
    if (clearBtn) clearBtn.style.opacity = '1';
  } else {
    canvas.style.cursor = 'default';
    if (handles) { handles.style.pointerEvents = ''; handles.style.opacity = '1'; }
    if (colors)  colors.style.opacity = '0.42';
    if (clearBtn) clearBtn.style.opacity = '0.42';
  }
  document.querySelectorAll('#qa-img-ed-toolbar .qa-img-ed-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function _imgEdInitEvents() {
  const overlay  = document.getElementById('qa-img-editor');
  if (!overlay || overlay._eventsInited) return;
  overlay._eventsInited = true;

  const canvas  = document.getElementById('qa-img-ed-canvas');
  const handles = document.getElementById('qa-img-ed-handles');

  document.getElementById('qa-img-ed-backdrop')?.addEventListener('click', closeImageEditor);
  document.getElementById('qa-img-ed-cancel')?.addEventListener('click', closeImageEditor);
  document.getElementById('qa-img-ed-done')?.addEventListener('click', applyImageEditor);

  document.getElementById('qa-img-ed-clear-draw')?.addEventListener('click', () => {
    if (!_imgEd) return;
    _imgEd.drawCtx.clearRect(0, 0, _imgEd.drawCanvas.width, _imgEd.drawCanvas.height);
    _imgEdRender();
  });

  // Mode buttons
  overlay.querySelectorAll('.qa-img-ed-mode-btn').forEach(b => {
    b.addEventListener('click', () => { if (_imgEd) _imgEdSetMode(b.dataset.mode); });
  });

  // Color buttons
  overlay.querySelectorAll('.qa-img-ed-color').forEach(b => {
    b.addEventListener('click', () => {
      if (!_imgEd) return;
      _imgEd.color = b.dataset.color;
      overlay.querySelectorAll('.qa-img-ed-color').forEach(x => x.classList.toggle('active', x === b));
    });
  });

  // Drawing on canvas
  canvas?.addEventListener('mousedown', _imgEdDrawStart);
  canvas?.addEventListener('mousemove', _imgEdDrawMove);
  canvas?.addEventListener('mouseup',   _imgEdDrawEnd);
  canvas?.addEventListener('mouseleave', _imgEdDrawEnd);

  // Handle dragging (event delegation on the handles layer)
  handles?.addEventListener('mousedown', _imgEdHandleStart, true);

  // ESC closes
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _imgEd) closeImageEditor();
  });
}

// ── Drawing events ──────────────────────────────────────────────────────────

function _imgEdDrawStart(e) {
  if (!_imgEd || _imgEd.mode !== 'draw') return;
  e.preventDefault();
  _imgEd.isDrawing = true;
  const [x, y] = _imgEdCanvasXY(e);
  const dc = _imgEd.drawCtx;
  dc.beginPath();
  dc.moveTo(x, y);
  dc.strokeStyle = _imgEd.color;
  dc.lineWidth   = _imgEd.brushSize;
  dc.lineCap     = 'round';
  dc.lineJoin    = 'round';
}

function _imgEdDrawMove(e) {
  if (!_imgEd || !_imgEd.isDrawing) return;
  e.preventDefault();
  const [x, y] = _imgEdCanvasXY(e);
  _imgEd.drawCtx.lineTo(x, y);
  _imgEd.drawCtx.stroke();
  _imgEdRender();
}

function _imgEdDrawEnd() { if (_imgEd) _imgEd.isDrawing = false; }

function _imgEdCanvasXY(e) {
  const rect = _imgEd.canvas.getBoundingClientRect();
  const sx = _imgEd.cssW / rect.width;
  const sy = _imgEd.cssH / rect.height;
  return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
}

// ── Crop handle drag ────────────────────────────────────────────────────────

function _imgEdHandleStart(e) {
  if (!_imgEd || _imgEd.mode !== 'crop') return;
  const handle = e.target.closest('.qa-img-ed-handle');
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  _imgEd.dragHandle    = handle.dataset.pos;
  _imgEd.dragStart     = { x: e.clientX, y: e.clientY };
  _imgEd.dragStartCrop = { ..._imgEd.crop };
  document.addEventListener('mousemove', _imgEdHandleDrag);
  document.addEventListener('mouseup',   _imgEdHandleEnd);
}

function _imgEdHandleDrag(e) {
  if (!_imgEd?.dragHandle) return;
  const { dragHandle, dragStart, dragStartCrop: C, canvas } = _imgEd;
  const rect = canvas.getBoundingClientRect();
  const sx = _imgEd.cssW / rect.width;
  const sy = _imgEd.cssH / rect.height;
  const dx = (e.clientX - dragStart.x) * sx;
  const dy = (e.clientY - dragStart.y) * sy;
  const MIN = 20, MAX_X = _imgEd.cssW, MAX_Y = _imgEd.cssH;
  let { x, y, w, h } = C;

  switch (dragHandle) {
    case 'tl': x = Math.min(C.x+dx, C.x+C.w-MIN); y = Math.min(C.y+dy, C.y+C.h-MIN); w = C.w-(x-C.x); h = C.h-(y-C.y); break;
    case 'tm': y = Math.min(C.y+dy, C.y+C.h-MIN); h = C.h-(y-C.y); break;
    case 'tr': w = Math.max(C.w+dx, MIN); y = Math.min(C.y+dy, C.y+C.h-MIN); h = C.h-(y-C.y); break;
    case 'ml': x = Math.min(C.x+dx, C.x+C.w-MIN); w = C.w-(x-C.x); break;
    case 'mr': w = Math.max(C.w+dx, MIN); break;
    case 'bl': x = Math.min(C.x+dx, C.x+C.w-MIN); w = C.w-(x-C.x); h = Math.max(C.h+dy, MIN); break;
    case 'bm': h = Math.max(C.h+dy, MIN); break;
    case 'br': w = Math.max(C.w+dx, MIN); h = Math.max(C.h+dy, MIN); break;
  }
  // Clamp to canvas bounds
  x = Math.max(0, Math.min(x, MAX_X - MIN));
  y = Math.max(0, Math.min(y, MAX_Y - MIN));
  w = Math.min(w, MAX_X - x);
  h = Math.min(h, MAX_Y - y);
  _imgEd.crop = { x, y, w, h };
  _imgEdRender();
  _imgEdUpdateHandles();
}

function _imgEdHandleEnd() {
  if (_imgEd) { _imgEd.dragHandle = null; _imgEd.dragStart = null; _imgEd.dragStartCrop = null; }
  document.removeEventListener('mousemove', _imgEdHandleDrag);
  document.removeEventListener('mouseup',   _imgEdHandleEnd);
}

// ── Apply / Close ───────────────────────────────────────────────────────────

function closeImageEditor() {
  const overlay = document.getElementById('qa-img-editor');
  if (overlay) overlay.hidden = true;
  _imgEd = null;
}

function applyImageEditor() {
  if (!_imgEd) return;
  const { img, canvas, drawCanvas, crop, imageIdx } = _imgEd;

  // The editor shows the image shrunk to fit the panel, but the crop must be
  // saved at the SOURCE scale. Sizing the output canvas in display pixels
  // threw the resolution away: a 1920x1080 frame came out around 330px wide,
  // which is why attached frames looked soft however well they were captured.
  const scaleX = img.naturalWidth  / _imgEd.cssW;
  const scaleY = img.naturalHeight / _imgEd.cssH;

  const out = document.createElement('canvas');
  out.width  = Math.max(1, Math.round(crop.w * scaleX));
  out.height = Math.max(1, Math.round(crop.h * scaleY));
  const oc = out.getContext('2d');
  oc.imageSmoothingQuality = 'high';

  oc.drawImage(img,
    crop.x * scaleX, crop.y * scaleY, crop.w * scaleX, crop.h * scaleY,
    0, 0, out.width, out.height
  );
  // Strokes were drawn at display scale, so stretch them to match.
  oc.drawImage(drawCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
  attachedImages[imageIdx] = {
    ...attachedImages[imageIdx],
    dataUrl: out.toDataURL('image/jpeg', 0.92)
  };
  closeImageEditor();
  renderImageStrip();
}
