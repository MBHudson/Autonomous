// ============================================
// ATTACHMENTS.JS — images for vision-capable agents
// ============================================
//
// SECURITY POSTURE — read this before changing anything here.
//
// An image NEVER becomes a file on this server. There is no upload endpoint,
// no temp directory, no move_uploaded_file, nothing under the webroot. The
// browser reads the pasted/dropped bytes, downscales them on a canvas, and
// holds a `data:image/jpeg;base64,…` string in memory. That string is placed
// into the `image_url` field of the JSON request body and relayed to the
// provider.
//
// That is deliberate. A conventional upload endpoint stores attacker-controlled
// bytes on disk under the document root, where the whole filter-bypass family
// lives (webshell.php.jpg, double extensions, null-byte truncation, mismatched
// Content-Type, polyglot files that are valid images AND valid scripts). Here
// there is no filename, no extension, no path and no on-disk artefact, so there
// is nothing for such a filter to be bypassed around.
//
// Residual risks, and how they are handled here:
//   * SVG is a script vector (it can carry <script>) -> rejected outright.
//     Only PNG / JPEG / WebP / GIF are accepted, all of which are inert when
//     rendered through <img>.
//   * Memory and request size -> hard caps plus client-side downscale.
//   * Storage quota -> attachments are NEVER written to localStorage. They live
//     in memory for the current turn only and are dropped after sending.
//   * Prompt budget -> image parts are attached to the live turn and stripped
//     from replayed history (see chat.js _historyFor, which only replays
//     string content). So a base64 blob can never blow the character budget.
//   * Privacy -> the image is transmitted to whichever provider the agent uses.
//     That is inherent to using any vision API, not something this code adds.

/** Largest raw file we will even attempt to decode. */
export const MAX_RAW_BYTES = 8 * 1024 * 1024;

/** Longest edge, in pixels, after downscale. Vision models don't need more. */
export const MAX_EDGE = 1280;

/** JPEG quality for the re-encode. */
const JPEG_QUALITY = 0.85;

/**
 * Raster formats only. SVG is intentionally absent: it is an XML document that
 * can execute script, and "the user picked an image" is not a reason to trust
 * one. Everything listed here is decoded by the browser's image pipeline and is
 * inert inside an <img> tag.
 */
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const ACCEPT_ATTR = ALLOWED_MIME.join(',');

export const acceptAttr = () => ACCEPT_ATTR;

/**
 * A recognisable type label, so the error says WHY rather than "invalid file".
 */
function describeType(file) {
  const mime = (file.type || '').toLowerCase();
  const name = (file.name || 'file').toLowerCase();
  if (mime === 'image/svg+xml' || name.endsWith('.svg')) {
    return 'SVG images can contain scripts, so they are not accepted. '
      + 'Use a PNG, JPEG, WebP or GIF.';
  }
  if (!mime) {
    // The OS gave us no type. Trust the EXTENSION for the accept/reject
    // decision, then let the decoder prove it is really an image.
    if (/\.(png|jpe?g|webp|gif)$/.test(name)) return null;
    return `"${file.name || 'that file'}" is not a recognised image type. `
      + 'Use a PNG, JPEG, WebP or GIF.';
  }
  if (!ALLOWED_MIME.includes(mime)) {
    return `${mime} is not a supported image type. Use a PNG, JPEG, WebP or GIF.`;
  }
  return null;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error(`Could not read ${file.name || 'the file'}.`));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a decodable image.'));
    img.src = src;
  });
}

/** Downscale to fit MAX_EDGE and re-encode as JPEG on a white backdrop. */
async function downscale(img) {
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // JPEG has no alpha channel; without this, transparent regions come out
  // black. White matches what every chat app does.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), w, h };
}

/**
 * Turn a File/Blob into a sendable attachment.
 * @returns {Promise<{dataUrl:string, mime:string, bytes:number, w:number, h:number, name:string}>}
 */
export async function prepare(file) {
  const typeProblem = describeType(file);
  if (typeProblem) throw new Error(typeProblem);

  if (file.size > MAX_RAW_BYTES) {
    throw new Error(`${file.name || 'That image'} is over the ${MAX_RAW_BYTES / 1048576} MB limit `
      + `(${(file.size / 1048576).toFixed(1)} MB).`);
  }

  const raw = await readAsDataUrl(file);
  const img = await loadImage(raw);           // also proves it really is an image
  const { dataUrl, w, h } = await downscale(img);

  return {
    dataUrl,
    mime: 'image/jpeg',
    bytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
    w, h,
    name: file.name || 'image',
  };
}

/** Pull image files out of a paste/drop event, ignoring plain text. */
export function imagesFromTransfer(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.files && dt.files.length) {
    for (const f of dt.files) out.push(f);
    return out;
  }
  // Chrome puts a pasted screenshot in items as a file with no name.
  if (dt.items && dt.items.length) {
    for (const it of dt.items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/**
 * The content value for a user turn.
 *
 * With no attachments this returns a plain STRING — byte-for-byte the shape
 * the app has always sent, so nothing changes for non-vision agents. Only when
 * an image is present do we switch to the multimodal array form.
 */
export function buildContent(text, attachments) {
  if (!attachments || !attachments.length) return text;
  const parts = [];
  const t = String(text == null ? '' : text);
  // An image sent with no words used to go out as a content array whose only
  // text part was the empty string. That is a part with no content, and some
  // providers reject it outright -- so a picture pasted on its own failed while
  // the same picture with a caption worked. Drop the part instead of sending it
  // empty; with no images at all this function returns the plain string as
  // before, so nothing about text-only turns changes.
  if (t.trim()) parts.push({ type: 'text', text: t });
  parts.push(...attachments.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } })));
  return parts;
}

/**
 * Same idea, but for a message that may ALREADY be a content array — which is
 * the case for agents driven by a pasted curl/python template whose body
 * contains its own hard-coded image. Overwriting that array would silently
 * destroy the template's image, so we replace only the text part and append
 * the new images after it.
 */
export function mergeContent(msg, text, attachments) {
  const imgs = (attachments || []).map(a => ({
    type: 'image_url',
    image_url: { url: a.dataUrl },
  }));
  if (!Array.isArray(msg.content)) {
    msg.content = imgs.length
      ? [{ type: 'text', text: String(text == null ? '' : text) }, ...imgs]
      : text;
    return msg;
  }
  const textPart = msg.content.find(p => p && p.type === 'text');
  if (textPart) textPart.text = String(text == null ? '' : text);
  else msg.content.unshift({ type: 'text', text: String(text == null ? '' : text) });
  // Append rather than splice: the template's own images stay put.
  if (imgs.length) msg.content.push(...imgs);
  return msg;
}

/**
 * Belt-and-braces: drop every image part from a message list.
 * Called on anything we persist, so a base64 blob can never reach storage or
 * the replayed-history character budget.
 */
export function stripImages(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    const kept = m.content.filter(p => p && p.type !== 'image_url');
    m.content = kept.length === 1 && kept[0] && kept[0].type === 'text'
      ? kept[0].text
      : kept;
  }
  return messages;
}
