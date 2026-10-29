"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const Busboy = require("busboy");
const PDFDocument = require("pdfkit");
const yauzl = require("yauzl");
const {
  fetchNspdParcelTile,
  NspdInputError,
  searchNspdFeatures,
  validateSearchQuery,
} = require("./nspd_client");

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.INSPECTION_DATA_DIR || path.join(ROOT, "inspection_data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RESULT_DIR = path.join(DATA_DIR, "results");
const DB_PATH = path.join(DATA_DIR, "inspection.sqlite3");
const MODEL_PATH = path.resolve(process.env.YOLO_MODEL_PATH || "C:\\Users\\sasak\\Desktop\\best.pt");
const WORKER_PATH = path.join(ROOT, "yolo_worker.py");
const PYTHON = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "py" : "python3");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"]);
const ARCHIVE_EXTENSIONS = new Set([".zip"]);
const ALLOWED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...ARCHIVE_EXTENSIONS]);
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_IMAGES = 5000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOGIN_BODY_BYTES = 8 * 1024;
const SESSION_COOKIE = "inspection_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOCAL_AUTH_CONFIG_PATH = path.join(ROOT, ".auth.local.json");
const localAuthConfig = fs.existsSync(LOCAL_AUTH_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(LOCAL_AUTH_CONFIG_PATH, "utf8"))
  : {};
if (
  !localAuthConfig || typeof localAuthConfig !== "object" || Array.isArray(localAuthConfig)
  || (localAuthConfig.username !== undefined && typeof localAuthConfig.username !== "string")
  || (localAuthConfig.password !== undefined && typeof localAuthConfig.password !== "string")
) {
  throw new Error(".auth.local.json должен содержать строки username и password.");
}
const APP_USERNAME = process.env.APP_USERNAME || localAuthConfig.username || "";
const APP_PASSWORD = process.env.APP_PASSWORD || localAuthConfig.password || "";
const PUBLIC_ACCESS = process.env.PUBLIC_ACCESS === "1";
const AUTH_ENABLED = Boolean(APP_USERNAME && APP_PASSWORD);
const sessions = new Map();
const loginAttempts = new Map();
const DRIVE_HOSTS = new Set([
  "drive.google.com",
  "drive.usercontent.google.com",
  "drive.googleusercontent.com",
]);
const FONT_PATHS = [
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RESULT_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY, source_name TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, operator TEXT NOT NULL,
    zone TEXT NOT NULL, confidence REAL NOT NULL, frame_count INTEGER DEFAULT 0,
    source_file_count INTEGER DEFAULT 1, detection_count INTEGER DEFAULT 0,
    detection_frame_count INTEGER DEFAULT 0, duration_seconds REAL DEFAULT 0,
    output_rel TEXT, error TEXT
  );
  CREATE TABLE IF NOT EXISTS detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    frame_index INTEGER NOT NULL, source_file TEXT NOT NULL DEFAULT '',
    time_seconds REAL NOT NULL, class_name TEXT NOT NULL, confidence REAL NOT NULL,
    x1 REAL NOT NULL, y1 REAL NOT NULL, x2 REAL NOT NULL, y2 REAL NOT NULL,
    image_rel TEXT NOT NULL, review_status TEXT NOT NULL DEFAULT 'Новая'
  );
  CREATE INDEX IF NOT EXISTS detections_analysis_idx ON detections(analysis_id, frame_index);
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
    level TEXT NOT NULL, message TEXT NOT NULL, analysis_id TEXT
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL UNIQUE
      REFERENCES analyses(id) ON DELETE CASCADE,
    report_number TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("detections", "source_file", "TEXT NOT NULL DEFAULT ''");
ensureColumn("analyses", "source_file_count", "INTEGER NOT NULL DEFAULT 1");

function validateAccessConfiguration() {
  if (PUBLIC_ACCESS && (!APP_USERNAME || !APP_PASSWORD)) {
    throw new Error("Для внешнего доступа задайте APP_USERNAME и APP_PASSWORD.");
  }
  if ((APP_USERNAME || APP_PASSWORD) && (!APP_USERNAME || !APP_PASSWORD || APP_USERNAME.includes(":"))) {
    throw new Error("APP_USERNAME и APP_PASSWORD должны быть заданы; имя пользователя не может содержать двоеточие.");
  }
  if (PUBLIC_ACCESS && APP_PASSWORD.length < 16) {
    throw new Error("Для внешнего доступа пароль APP_PASSWORD должен содержать не менее 16 символов.");
  }
}

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function sessionCookieOptions(request, value, maxAge) {
  const forwardedHttps = request.socket.remoteAddress === "127.0.0.1"
    && request.headers["x-forwarded-proto"]?.split(",")[0].trim().toLowerCase() === "https";
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(request.socket.encrypted || forwardedHttps ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ];
}

function getSessionId(request) {
  const cookieHeader = request.headers.cookie || "";
  const match = cookieHeader.split(";").map(value => value.trim())
    .find(value => value.startsWith(`${SESSION_COOKIE}=`));
  const sessionId = match?.slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(sessionId || "") ? sessionId : null;
}

function isAuthorized(request) {
  if (!AUTH_ENABLED) return true;
  const sessionId = getSessionId(request);
  if (!sessionId) return false;
  const expiresAt = sessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

function isLoginRateLimited(request) {
  const address = request.socket.remoteAddress || "unknown";
  const attempt = loginAttempts.get(address);
  if (!attempt || attempt.resetAt <= Date.now()) {
    loginAttempts.delete(address);
    return false;
  }
  return attempt.count >= 10;
}

function recordLoginFailure(request) {
  const address = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(address);
  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(address, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else {
    attempt.count += 1;
  }
}

function clearLoginFailures(request) {
  loginAttempts.delete(request.socket.remoteAddress || "unknown");
}

function sendLoginPage(response, status = 200, message = "") {
  const templatePath = path.join(ROOT, "templates", "login.html");
  const html = fs.readFileSync(templatePath, "utf8")
    .replace("{{ERROR_MESSAGE}}", message ? `<p class="login-error" role="alert">${escapeHtml(message)}</p>` : "");
  const body = Buffer.from(html);
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readLoginForm(request) {
  const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new Error("Неверный формат формы входа.");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_LOGIN_BODY_BYTES) throw new Error("Форма входа слишком большая.");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

function logActivity(level, message, analysisId = null) {
  db.prepare("INSERT INTO activity_logs (created_at,level,message,analysis_id) VALUES (?,?,?,?)")
    .run(nowIso(), level, message, analysisId);
}

function ensureReport(analysisId) {
  const existing = db.prepare("SELECT id FROM reports WHERE analysis_id=?").get(analysisId);
  if (existing) return existing.id;
  const reportId = crypto.randomUUID().replaceAll("-", "");
  const reportNumber = `REP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${analysisId.slice(0, 6).toUpperCase()}`;
  db.prepare("INSERT INTO reports(id,analysis_id,report_number,created_at) VALUES(?,?,?,?)")
    .run(reportId, analysisId, reportNumber, nowIso());
  return reportId;
}

function jsonResponse(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}

function contentType(filePath) {
  return ({
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".json": "application/json; charset=utf-8",
  })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function safeFilename(value) {
  const basename = path.posix.basename(String(value || "").replaceAll("\\", "/"));
  const safe = basename.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+|[._]+$/g, "");
  return safe || `upload-${crypto.randomUUID()}`;
}

function parseNumber(form, key, fallback, integer = false) {
  const raw = form[key] || String(fallback);
  const value = integer ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Укажите корректное значение ${key}.`);
  return value;
}

function validateSettings(form) {
  const conf = parseNumber(form, "conf", 0.25);
  const imgsz = parseNumber(form, "imgsz", 640, true);
  if (conf < 0 || conf > 1 || imgsz < 64 || imgsz > 2048) {
    throw new Error("Confidence должен быть 0–1, imgsz — 64–2048.");
  }
  return {
    conf,
    imgsz,
    operator: String(form.operator || "Оператор").trim().slice(0, 100) || "Оператор",
    zone: String(form.zone || "Не указан").trim().slice(0, 100) || "Не указан",
  };
}

async function parseMultipart(request, destination) {
  await fsp.mkdir(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 20, fields: 20, parts: 40 },
      });
    } catch (error) {
      reject(new Error("Ожидалась multipart-загрузка файлов."));
      return;
    }
    const fields = {};
    const files = [];
    const pending = [];
    let failure = null;
    parser.on("field", (name, value) => { fields[name] = value; });
    parser.on("file", (name, stream, info) => {
      if (name !== "files") {
        stream.resume();
        return;
      }
      const filename = safeFilename(info.filename);
      const filePath = path.join(destination, `${crypto.randomUUID()}-${filename}`);
      const record = { filename, path: filePath };
      files.push(record);
      stream.on("limit", () => { failure = new Error("Файл слишком большой. Максимальный размер — 512 МБ."); });
      pending.push(pipeline(stream, fs.createWriteStream(filePath)));
    });
    parser.on("filesLimit", () => { failure = new Error("За один раз можно загрузить не более 20 файлов."); });
    parser.on("error", error => { failure = error; });
    parser.on("close", async () => {
      try {
        await Promise.all(pending);
        if (failure) throw failure;
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });
    request.pipe(parser);
  });
}

function isImageName(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function extractPhotoArchive(archivePath, destination) {
  return new Promise((resolve, reject) => {
    const accepted = [];
    const seen = new Set();
    let totalBytes = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (openError) return fail(new Error(`Не удалось прочитать ZIP-архив: ${openError.message}`));
      const entries = [];
      zip.on("error", error => fail(new Error(`Не удалось распаковать ZIP: ${error.message}`)));
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        if (!accepted.length) {
          reject(new Error("В ZIP-архиве не найдены фотографии поддерживаемого формата."));
        } else resolve(accepted.length);
      });
      zip.on("entry", entry => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        const normalized = entry.fileName.replaceAll("\\", "/");
        const parts = normalized.split("/");
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const isSymlink = (mode & 0o170000) === 0o120000;
        if (path.posix.isAbsolute(normalized)
          || parts.some(part => !part || part === "." || part === ".." || part.includes(":"))
          || isSymlink) {
          fail(new Error(`Небезопасный путь в архиве: ${entry.fileName}`));
          zip.close();
          return;
        }
        if (!isImageName(normalized)) {
          zip.readEntry();
          return;
        }
        if (entry.isEncrypted()) {
          fail(new Error("Зашифрованные ZIP-архивы не поддерживаются."));
          zip.close();
          return;
        }
        if (entries.length >= MAX_ARCHIVE_IMAGES) {
          fail(new Error(`В архиве больше ${MAX_ARCHIVE_IMAGES} фотографий.`));
          zip.close();
          return;
        }
        if (entry.uncompressedSize > MAX_ARCHIVE_IMAGE_BYTES) {
          fail(new Error(`Файл внутри архива слишком большой: ${entry.fileName}`));
          zip.close();
          return;
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_ARCHIVE_UNPACKED_BYTES) {
          fail(new Error("Распакованный архив превышает ограничение 2 ГБ."));
          zip.close();
          return;
        }
        const safeParts = parts.map(safeFilename);
        const relativeName = safeParts.join(path.sep);
        const key = relativeName.toLowerCase();
        if (seen.has(key)) {
          fail(new Error(`Повторяющийся путь файла в архиве: ${entry.fileName}`));
          zip.close();
          return;
        }
        seen.add(key);
        const target = path.join(destination, relativeName);
        const resolvedDestination = path.resolve(destination);
        if (!path.resolve(target).startsWith(`${resolvedDestination}${path.sep}`)) {
          fail(new Error(`Небезопасный путь в архиве: ${entry.fileName}`));
          zip.close();
          return;
        }
        entries.push(entry);
        fsp.mkdir(path.dirname(target), { recursive: true })
          .then(() => new Promise((entryResolve, entryReject) => {
            zip.openReadStream(entry, (streamError, stream) => {
              if (streamError) return entryReject(streamError);
              let written = 0;
              const limiter = new Transform({
                transform(chunk, _encoding, callback) {
                  written += chunk.length;
                  if (written > MAX_ARCHIVE_IMAGE_BYTES) {
                    callback(new Error(`Файл внутри архива слишком большой: ${entry.fileName}`));
                  } else callback(null, chunk);
                },
              });
              pipeline(stream, limiter, fs.createWriteStream(target))
                .then(() => {
                  if (written !== entry.uncompressedSize) {
                    entryReject(new Error(`Размер файла в архиве не совпадает: ${entry.fileName}`));
                  } else {
                    accepted.push(target);
                    entryResolve();
                  }
                }, entryReject);
            });
          }))
          .then(() => zip.readEntry(), fail);
      });
      zip.readEntry();
    });
  });
}

function getGoogleDriveId(value) {
  const url = new URL(value);
  if (!["drive.google.com", "www.drive.google.com"].includes(url.hostname)) return null;
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Для Google Drive используйте безопасную ссылку https без учётных данных.");
  }
  const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
  const id = match ? match[1] : url.searchParams.get("id");
  if (!id || !/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
    throw new Error("Не удалось распознать ссылку Google Drive.");
  }
  return id;
}

function parseDriveForm(html) {
  const form = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const action = form[1].match(/\baction=["']([^"']+)["']/i)?.[1];
  const fields = {};
  for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
    const name = input[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = input[1].match(/\bvalue=["']([^"']*)["']/i)?.[1];
    if (name && value !== undefined) fields[name] = value;
  }
  return action && fields.confirm ? { action, fields } : null;
}

async function fetchDriveResponse(initialUrl) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(120_000),
          headers: { "User-Agent": "InspectionAI/1.0" },
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 2000));
      }
    }
    if (!response) {
      throw new Error(`Не удалось подключиться к Google Drive после 3 попыток: ${lastError.message}. Проверьте интернет-соединение и повторите попытку.`);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Google Drive вернул перенаправление без адреса.");
    const target = new URL(location, url);
    if (target.protocol !== "https:" || !DRIVE_HOSTS.has(target.hostname)) {
      throw new Error("Google Drive перенаправил загрузку на неподдерживаемый адрес.");
    }
    url = target.toString();
  }
  throw new Error("Google Drive выполнил слишком много перенаправлений.");
}

async function downloadDriveFile(fileId, destination) {
  const initialUrl = `https://drive.google.com/uc?${new URLSearchParams({ export: "download", id: fileId })}`;
  let response = await fetchDriveResponse(initialUrl);
  const contentTypeHeader = response.headers.get("content-type") || "";
  if (/text\/html|application\/xhtml\+xml/i.test(contentTypeHeader)) {
    const html = (await response.text()).slice(0, 2 * 1024 * 1024);
    const confirmation = parseDriveForm(html);
    if (!confirmation) {
      throw new Error("Google Drive вернул страницу доступа. Разрешите просмотр файла всем, у кого есть ссылка.");
    }
    const action = new URL(confirmation.action);
    if (action.protocol !== "https:" || !DRIVE_HOSTS.has(action.hostname)) {
      throw new Error("Google Drive вернул неподдерживаемый адрес подтверждения скачивания.");
    }
    action.search = new URLSearchParams(confirmation.fields).toString();
    response = await fetchDriveResponse(action.toString());
  }
  const mime = response.headers.get("content-type") || "";
  if (!response.ok) throw new Error(`Google Drive вернул HTTP ${response.status}. Проверьте доступ к файлу.`);
  if (/text\/html|application\/xhtml\+xml/i.test(mime)) {
    throw new Error("Google Drive не выдал файл. Проверьте, что файл открыт по ссылке и не требует входа.");
  }
  const disposition = response.headers.get("content-disposition") || "";
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  let filename = filenameMatch?.[1]?.trim().replaceAll('"', "") || `${fileId}.mp4`;
  try { filename = decodeURIComponent(filename); } catch {}
  filename = safeFilename(filename);
  const extension = path.extname(filename).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension) && !ARCHIVE_EXTENSIONS.has(extension)) {
    throw new Error("По ссылке Google Drive должен находиться видеофайл или ZIP-архив с фотографиями.");
  }
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > MAX_UPLOAD_BYTES) throw new Error("Файл превышает лимит 512 МБ.");
  await fsp.mkdir(destination, { recursive: true });
  const target = path.join(destination, filename);
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) callback(new Error("Файл превышает лимит 512 МБ."));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(
      require("node:stream").Readable.fromWeb(response.body),
      limiter,
      fs.createWriteStream(target),
    );
  } catch (error) {
    await fsp.rm(target, { force: true });
    throw new Error(`Ошибка сохранения файла из Google Drive: ${error.message}`);
  }
  if (!received) {
    await fsp.rm(target, { force: true });
    throw new Error("Google Drive вернул пустой файл.");
  }
  return target;
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
    return value !== "::" && value !== "::1"
      && !value.startsWith("fc") && !value.startsWith("fd")
      && !value.startsWith("fe8") && !value.startsWith("fe9")
      && !value.startsWith("fea") && !value.startsWith("feb")
      && !value.startsWith("ff");
  }
  return false;
}

async function validateStreamUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Введите корректную ссылку на видеопоток."); }
  if (!["rtsp:", "rtsps:", "http:", "https:"].includes(url.protocol)) {
    throw new Error("Поддерживаются RTSP/RTSPS/HTTP/HTTPS URL видеопотоков.");
  }
  if (url.username || url.password) throw new Error("Не вставляйте пароль в URL.");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) {
    throw new Error("Поток должен быть доступен по публичному IP-адресу.");
  }
  return url.toString();
}

const jobs = [];
const activeJobs = new Map();
let workerBusy = false;

function insertAnalysis({ id, sourceName, kind, conf, operator, zone, sourceFileCount = 1 }) {
  db.prepare(`INSERT INTO analyses
    (id,source_name,kind,status,created_at,operator,zone,confidence,source_file_count)
    VALUES(?,?,?,'processing',?,?,?, ?,?)`)
    .run(id, sourceName, kind, nowIso(), operator, zone, conf, sourceFileCount);
}

function enqueueJob(job) {
  activeJobs.set(job.id, { cancelled: false, child: null });
  jobs.push(job);
  void processQueue();
}

async function processQueue() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    while (jobs.length) {
      const job = jobs.shift();
      if (job.cancelled) continue;
      await processJob(job);
    }
  } finally {
    workerBusy = false;
    if (jobs.length) void processQueue();
  }
}

function processJob(job) {
  return new Promise(resolve => {
    let source = job.source;
    let kind = job.kind;
    const folder = path.join(UPLOAD_DIR, job.id);
    const outputDir = path.join(RESULT_DIR, job.id);
    let frameCount = 0;
    let detectionCount = 0;
    let detectionFrameCount = 0;
    let durationSeconds = 0;
    let workerError = null;
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    const stop = activeJobs.get(job.id);
    const complete = async (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      activeJobs.delete(job.id);
      if (stop?.cancelled) {
        db.prepare(`UPDATE analyses SET status='completed',frame_count=?,detection_count=?,
          detection_frame_count=?,duration_seconds=?,output_rel=? WHERE id=?`)
          .run(frameCount, detectionCount, detectionFrameCount, durationSeconds, job.id, job.id);
        logActivity("info", `Анализ остановлен: ${frameCount} кадров обработано`, job.id);
      } else if (spawnError || workerError || code !== 0) {
        const message = workerError || spawnError?.message || stderr.trim().slice(-2000) || `YOLO worker завершился с кодом ${code}.`;
        db.prepare("UPDATE analyses SET status='failed',error=? WHERE id=?").run(message.slice(0, 1000), job.id);
        logActivity("error", `Ошибка анализа ${job.sourceName}: ${message}`, job.id);
        console.error(`Analysis ${job.id} failed:`, message);
      } else {
        db.prepare(`UPDATE analyses SET status='completed',frame_count=?,detection_count=?,
          detection_frame_count=?,duration_seconds=?,output_rel=? WHERE id=?`)
          .run(frameCount, detectionCount, detectionFrameCount, durationSeconds, job.id, job.id);
        if (kind === "archive") ensureReport(job.id);
        logActivity("success", `Анализ завершён: ${job.sourceName}; кадров: ${frameCount}, детекций: ${detectionCount}`, job.id);
      }
      resolve();
    };

    const startWorker = async () => {
      try {
        if (job.kind === "drive") {
          source = await downloadDriveFile(getGoogleDriveId(job.source), folder);
          job.sourceName = path.basename(source);
          if (path.extname(source).toLowerCase() === ".zip") {
            source = path.join(folder, "extracted");
            const imageCount = await extractPhotoArchive(path.join(folder, job.sourceName), source);
            kind = "archive";
            job.sourceFileCount = imageCount;
            db.prepare("UPDATE analyses SET source_name=?,kind='archive',source_file_count=? WHERE id=?")
              .run(job.sourceName, imageCount, job.id);
          } else {
            db.prepare("UPDATE analyses SET source_name=? WHERE id=?").run(job.sourceName, job.id);
          }
        }
        await fsp.mkdir(outputDir, { recursive: true });
        let workerSource = source;
        let workerSourceRoot = kind === "archive" ? source : (kind === "stream" ? ROOT : path.dirname(String(source)));
        if (kind === "archive") {
          workerSourceRoot = source;
          workerSource = [];
          const walk = async directory => {
            const entries = await fsp.readdir(directory, { withFileTypes: true });
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
              const absolute = path.join(directory, entry.name);
              if (entry.isDirectory()) await walk(absolute);
              else if (entry.isFile() && isImageName(entry.name)) workerSource.push(absolute);
            }
          };
          await walk(source);
          if (!workerSource.length) throw new Error("В архиве не найдено фотографий.");
        }
        const config = JSON.stringify({
          source: workerSource,
          source_root: workerSourceRoot,
          output_dir: outputDir,
          model_path: MODEL_PATH,
          kind,
          conf: job.conf,
          imgsz: job.imgsz,
        });
        const args = process.platform === "win32"
          ? ["-3", WORKER_PATH]
          : [WORKER_PATH];
        const child = spawn(PYTHON, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        if (stop) stop.child = child;
        child.once("error", error => { void complete(null, error); });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", chunk => {
          stderr = (stderr + chunk).slice(-8000);
          console.error(`[YOLO ${job.id}] ${chunk.trimEnd()}`);
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => {
          stdoutBuffer += chunk;
          let newline;
          while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
            const line = stdoutBuffer.slice(0, newline);
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch {
              console.error(`[YOLO ${job.id}] Non-protocol output: ${line.slice(0, 300)}`);
              continue;
            }
            if (event.type === "progress") {
              frameCount = event.frame_count;
              db.prepare("UPDATE analyses SET frame_count=? WHERE id=?").run(frameCount, job.id);
            } else if (event.type === "error") {
              workerError = event.error;
            } else if (event.type === "frame") {
              frameCount = event.frame_index;
              detectionFrameCount += 1;
              detectionCount += event.detections.length;
              const insert = db.prepare(`INSERT INTO detections
                (analysis_id,frame_index,source_file,time_seconds,class_name,confidence,
                 x1,y1,x2,y2,image_rel) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
              db.exec("BEGIN IMMEDIATE");
              try {
                for (const detection of event.detections) {
                  insert.run(
                    job.id, event.frame_index, event.source_file, event.time_seconds,
                    detection.class_name, detection.confidence, detection.x1, detection.y1,
                    detection.x2, detection.y2, event.image_rel,
                  );
                }
                db.prepare("UPDATE analyses SET frame_count=?,detection_count=?,detection_frame_count=? WHERE id=?")
                  .run(frameCount, detectionCount, detectionFrameCount, job.id);
                db.exec("COMMIT");
              } catch (error) {
                db.exec("ROLLBACK");
                workerError = error.message;
                stop?.child?.kill();
              }
            } else if (event.type === "done") {
              frameCount = event.frame_count;
              detectionCount = event.detection_count;
              detectionFrameCount = event.detection_frame_count;
              durationSeconds = event.duration_seconds;
            }
          }
        });
        child.once("close", code => {
          if (stdoutBuffer.trim()) {
            try {
              const event = JSON.parse(stdoutBuffer);
              if (event.type === "error") workerError = event.error;
            } catch { workerError ||= "YOLO worker завершился с неполным ответом."; }
          }
          void complete(code);
        });
        child.stdin.end(config);
      } catch (error) {
        workerError = error.message;
        void complete(1);
      }
    };
    void startWorker();
  });
}

function collectAnalysis(row) {
  if (!row) return null;
  return {
    ...row,
    detections: db.prepare("SELECT * FROM detections WHERE analysis_id=? ORDER BY frame_index,id").all(row.id),
  };
}

function reportData(reportId) {
  const row = db.prepare(`SELECT r.id report_id,r.report_number,r.created_at report_created_at,a.*
    FROM reports r JOIN analyses a ON a.id=r.analysis_id WHERE r.id=?`).get(reportId);
  if (!row) return null;
  return { ...row, detections: collectAnalysis({ id: row.id }).detections };
}

function analysisListSql(limit = 200) {
  return db.prepare(`SELECT a.*,r.id report_id FROM analyses a
    LEFT JOIN reports r ON r.analysis_id=a.id
    ORDER BY a.created_at DESC LIMIT ?`).all(limit);
}

function totalsDashboard() {
  const totals = db.prepare(`SELECT COUNT(*) analyses,
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN status IN ('processing','stopping') THEN 1 ELSE 0 END) processing,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
    COALESCE(SUM(detection_count),0) detections,COALESCE(SUM(frame_count),0) frames
    FROM analyses`).get();
  const recent = db.prepare(`SELECT a.*,r.id report_id FROM analyses a
    LEFT JOIN reports r ON r.analysis_id=a.id ORDER BY a.created_at DESC LIMIT 8`).all();
  const classes = db.prepare(`SELECT d.class_name,COUNT(*) count FROM detections d
    JOIN analyses a ON a.id=d.analysis_id WHERE a.status='completed'
    GROUP BY d.class_name ORDER BY count DESC LIMIT 8`).all();
  const daily = db.prepare(`SELECT substr(created_at,1,10) day,COALESCE(SUM(detection_count),0) count
    FROM analyses WHERE status='completed' AND created_at>=date('now','-6 day')
    GROUP BY day ORDER BY day`).all();
  return {
    totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value || 0])),
    recent, classes, daily,
  };
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON_BYTES) throw new Error("JSON-запрос слишком большой.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readForm(request) {
  const contentTypeHeader = request.headers["content-type"] || "";
  if (contentTypeHeader.includes("application/json")) return readJson(request);
  if (contentTypeHeader.includes("application/x-www-form-urlencoded")) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
  }
  const temporaryDirectory = path.join(os.tmpdir(), `inspection-form-${crypto.randomUUID()}`);
  try {
    const parsed = await parseMultipart(request, temporaryDirectory);
    return parsed.fields;
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function makePdf(report, response) {
  const fontPath = FONT_PATHS.find(font => fs.existsSync(font));
  if (!fontPath) throw new Error("Не найден системный шрифт с поддержкой кириллицы для PDF.");
  const filename = `report-${report.report_number}.pdf`;
  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 32, bottom: 32, left: 34, right: 34 }, info: { Title: report.report_number } });
  doc.pipe(response);
  doc.font(fontPath).fillColor("#172236");
  const left = 34;
  const pageWidth = 774;
  doc.fontSize(18).text("Отчёт об инспекции", { align: "center" });
  doc.moveDown(0.7).fontSize(9).text(`${report.source_name} · ${report.report_number}`);
  doc.text(`Дата: ${report.report_created_at} · Участок: ${report.zone} · Оператор: ${report.operator}`);
  doc.text(`Обработано кадров: ${report.frame_count} · Детекций: ${report.detection_count} · Кадров с объектами: ${report.detection_frame_count}`);
  doc.moveDown(0.8);

  const columns = [
    { title: "№", width: 28 },
    { title: "Файл / кадр", width: 195 },
    { title: "Класс", width: 125 },
    { title: "Уверенность", width: 82 },
    { title: "Координаты (пиксели)", width: 180 },
    { title: "Статус", width: 130 },
  ];
  const rowHeight = 24;
  const drawHeader = () => {
    let x = left;
    const y = doc.y;
    doc.rect(left, y, pageWidth, rowHeight).fill("#172236");
    doc.font(fontPath).fontSize(8).fillColor("#ffffff");
    for (const column of columns) {
      doc.text(column.title, x + 5, y + 7, { width: column.width - 10, height: rowHeight, ellipsis: true });
      x += column.width;
    }
    doc.y = y + rowHeight;
  };
  const drawDetection = (item, index) => {
    if (doc.y + rowHeight > 555) {
      doc.addPage({ size: "A4", layout: "landscape", margins: { top: 32, bottom: 32, left: 34, right: 34 } });
      drawHeader();
    }
    let x = left;
    const y = doc.y;
    doc.rect(left, y, pageWidth, rowHeight).lineWidth(0.3).stroke("#dce3ed");
    const values = [
      String(index + 1),
      `${item.source_file || report.source_name} · кадр ${item.frame_index}`,
      item.class_name,
      `${(item.confidence * 100).toFixed(1)}%`,
      `${Math.round(item.x1)}, ${Math.round(item.y1)} – ${Math.round(item.x2)}, ${Math.round(item.y2)}`,
      item.review_status,
    ];
    doc.font(fontPath).fontSize(7).fillColor("#526178");
    values.forEach((value, position) => {
      doc.text(String(value), x + 5, y + 7, { width: columns[position].width - 10, height: rowHeight, ellipsis: true });
      x += columns[position].width;
    });
    doc.y = y + rowHeight;
  };
  drawHeader();
  if (!report.detections.length) {
    doc.font(fontPath).fontSize(9).fillColor("#526178").text("Детекций не обнаружено.", left, doc.y + 10);
  } else {
    report.detections.forEach(drawDetection);
  }

  const frames = new Map();
  for (const detection of report.detections) {
    if (!frames.has(detection.image_rel)) frames.set(detection.image_rel, []);
    frames.get(detection.image_rel).push(detection);
  }
  const frameItems = [...frames.entries()];
  const outputDir = path.resolve(RESULT_DIR, report.id);
  for (let start = 0; start < frameItems.length; start += 4) {
    doc.addPage({ size: "A4", layout: "landscape", margins: { top: 32, bottom: 32, left: 34, right: 34 } });
    doc.font(fontPath).fontSize(16).fillColor("#172236")
      .text(`Кадры с детекциями · ${start + 1}–${Math.min(start + 4, frameItems.length)} из ${frameItems.length}`, { align: "center" });
    const cellWidth = 365;
    const cellHeight = 245;
    const imageWidth = 350;
    const imageHeight = 205;
    for (let offset = 0; offset < 4; offset += 1) {
      const item = frameItems[start + offset];
      if (!item) continue;
      const [imageRel, detections] = item;
      const imagePath = path.resolve(outputDir, imageRel);
      if (!imagePath.startsWith(`${outputDir}${path.sep}`)) throw new Error("Некорректный путь кадра в отчёте.");
      if (!fs.existsSync(imagePath)) throw new Error(`Не найден сохранённый кадр: ${imageRel}`);
      const column = offset % 2;
      const row = Math.floor(offset / 2);
      const x = left + column * cellWidth;
      const y = 75 + row * cellHeight;
      doc.rect(x, y, cellWidth - 8, cellHeight - 12).lineWidth(0.5).stroke("#dce3ed");
      doc.image(imagePath, x + 7, y + 7, { fit: [imageWidth, imageHeight], align: "center", valign: "center" });
      const sourceName = detections[0].source_file || report.source_name;
      const classes = [...new Set(detections.map(detection => detection.class_name))].join(", ");
      doc.font(fontPath).fontSize(7).fillColor("#526178")
        .text(`${sourceName} · кадр ${detections[0].frame_index} · ${detections.length} детекц.: ${classes}`,
          x + 7, y + imageHeight + 14, { width: imageWidth, height: 22, ellipsis: true });
    }
  }
  doc.end();
}

async function serveFile(response, baseDirectory, relativePath) {
  const base = path.resolve(baseDirectory);
  const fullPath = path.resolve(base, relativePath);
  if (!fullPath.startsWith(`${base}${path.sep}`) && fullPath !== base) {
    jsonResponse(response, 404, { error: "Файл не найден." });
    return;
  }
  let stat;
  try { stat = await fsp.stat(fullPath); } catch {
    jsonResponse(response, 404, { error: "Файл не найден." });
    return;
  }
  if (!stat.isFile()) {
    jsonResponse(response, 404, { error: "Файл не найден." });
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType(fullPath),
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=3600",
  });
  fs.createReadStream(fullPath).pipe(response);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const method = request.method;
  if (method === "GET" && pathname === "/login") {
    if (!AUTH_ENABLED || isAuthorized(request)) {
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      response.end();
    } else sendLoginPage(response);
    return;
  }
  if (method === "POST" && pathname === "/login") {
    if (!AUTH_ENABLED) {
      response.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (isLoginRateLimited(request)) {
      sendLoginPage(response, 429, "Слишком много попыток. Попробуйте через 15 минут.");
      return;
    }
    let form;
    try {
      form = await readLoginForm(request);
    } catch (error) {
      sendLoginPage(response, 400, error.message);
      return;
    }
    const username = form.get("username") || "";
    const password = form.get("password") || "";
    if (
      !timingSafeStringEqual(username, APP_USERNAME)
      || !timingSafeStringEqual(password, APP_PASSWORD)
    ) {
      recordLoginFailure(request);
      sendLoginPage(response, 401, "Неверный логин или пароль.");
      return;
    }
    clearLoginFailures(request);
    const now = Date.now();
    for (const [id, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(id);
    }
    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.set(sessionId, now + SESSION_TTL_MS);
    response.writeHead(303, {
      Location: "/",
      "Set-Cookie": sessionCookieOptions(request, sessionId, SESSION_TTL_MS / 1000).join("; "),
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }
  if (method === "POST" && pathname === "/logout") {
    const sessionId = getSessionId(request);
    if (sessionId) sessions.delete(sessionId);
    response.writeHead(303, {
      Location: "/login",
      "Set-Cookie": sessionCookieOptions(request, "", 0).join("; "),
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }
  if (method === "GET" && pathname === "/static/login.css") {
    await serveFile(response, path.join(ROOT, "static"), "login.css");
    return;
  }
  if (!isAuthorized(request)) {
    if (pathname.startsWith("/api/")) {
      jsonResponse(response, 401, { error: "Требуется вход в систему." });
    } else {
      response.writeHead(303, { Location: "/login", "Cache-Control": "no-store" });
      response.end();
    }
    return;
  }
  if (method === "GET" && pathname === "/") {
    const html = await fsp.readFile(path.join(ROOT, "templates", "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
    response.end(html);
    return;
  }
  if (method === "GET" && pathname.startsWith("/static/")) {
    const name = pathname.slice("/static/".length);
    if (["app.js", "cadastre.js", "style.css"].includes(name)) {
      await serveFile(response, path.join(ROOT, "static"), name);
      return;
    }
    const leafletAssets = new Map([
      ["vendor/leaflet.js", "leaflet.js"],
      ["vendor/leaflet.css", "leaflet.css"],
      ["vendor/images/layers.png", "images/layers.png"],
      ["vendor/images/layers-2x.png", "images/layers-2x.png"],
      ["vendor/images/marker-icon.png", "images/marker-icon.png"],
      ["vendor/images/marker-icon-2x.png", "images/marker-icon-2x.png"],
      ["vendor/images/marker-shadow.png", "images/marker-shadow.png"],
    ]);
    const leafletAsset = leafletAssets.get(name);
    if (!leafletAsset) return jsonResponse(response, 404, { error: "Файл не найден." });
    await serveFile(response, path.join(ROOT, "node_modules", "leaflet", "dist"), leafletAsset);
    return;
  }
  if (method === "GET" && pathname === "/api/cadastre/search") {
    let query;
    let themeId;
    try {
      query = validateSearchQuery(url.searchParams.get("query"));
      themeId = Number(url.searchParams.get("themeId") || 1);
      const featureCollection = await searchNspdFeatures(query, themeId);
      jsonResponse(response, 200, featureCollection);
    } catch (error) {
      const invalidRequest = error instanceof NspdInputError;
      if (!invalidRequest) console.error("NSPD cadastral search failed:", error);
      jsonResponse(response, invalidRequest ? 400 : 502, {
        error: invalidRequest ? error.message : `Не удалось получить данные из НСПД: ${error.message}`,
      });
    }
    return;
  }
  if (method === "GET" && pathname === "/api/cadastre/wms") {
    try {
      const tile = await fetchNspdParcelTile(url.searchParams);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": tile.length,
        "Cache-Control": "public, max-age=300",
      });
      response.end(tile);
    } catch (error) {
      const invalidRequest = error instanceof NspdInputError;
      if (!invalidRequest) console.error("NSPD cadastral WMS request failed:", error);
      jsonResponse(response, invalidRequest ? 400 : 502, {
        error: invalidRequest ? error.message : `Не удалось загрузить кадастровый слой НСПД: ${error.message}`,
      });
    }
    return;
  }
  if (method === "GET" && pathname === "/api/dashboard") {
    jsonResponse(response, 200, totalsDashboard());
    return;
  }
  if (method === "GET" && pathname === "/api/analyses") {
    jsonResponse(response, 200, analysisListSql());
    return;
  }
  if (method === "POST" && pathname === "/api/analyses") {
    const batchDirectory = path.join(os.tmpdir(), `inspection-upload-${crypto.randomUUID()}`);
    let upload;
    try {
      upload = await parseMultipart(request, batchDirectory);
      if (!upload.files.length) throw new Error("Выберите хотя бы одно фото или видео.");
      const settings = validateSettings(upload.fields);
      const pending = [];
      for (const file of upload.files) {
        const extension = path.extname(file.filename).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`Неподдерживаемый тип файла: ${file.filename}`);
        const id = crypto.randomUUID().replaceAll("-", "");
        const folder = path.join(UPLOAD_DIR, id);
        await fsp.mkdir(folder, { recursive: true });
        const sourcePath = path.join(folder, file.filename);
        await fsp.rename(file.path, sourcePath);
        let kind;
        let source = sourcePath;
        let sourceFileCount = 1;
        if (ARCHIVE_EXTENSIONS.has(extension)) {
          kind = "archive";
          source = path.join(folder, "extracted");
          sourceFileCount = await extractPhotoArchive(sourcePath, source);
        } else kind = IMAGE_EXTENSIONS.has(extension) ? "image" : "video";
        insertAnalysis({
          id, sourceName: file.filename, kind, conf: settings.conf, operator: settings.operator,
          zone: settings.zone, sourceFileCount,
        });
        logActivity("info", kind === "archive"
          ? `Запущен анализ ${sourceFileCount} фотографий из архива ${file.filename}`
          : `Запущен анализ файла ${file.filename}`, id);
        enqueueJob({
          id, sourceName: file.filename, kind, source, conf: settings.conf, imgsz: settings.imgsz,
          operator: settings.operator, zone: settings.zone, sourceFileCount,
        });
        pending.push({ id, source_name: file.filename, status: "processing", kind, source_file_count: sourceFileCount });
      }
      jsonResponse(response, 202, { analyses: pending });
    } catch (error) {
      jsonResponse(response, error.message.includes("слишком большой") ? 413 : 400, { error: error.message });
    } finally {
      await fsp.rm(batchDirectory, { recursive: true, force: true });
    }
    return;
  }
  if (method === "POST" && pathname === "/api/streams") {
    try {
      const form = await readForm(request);
      const driveId = getGoogleDriveId(form.url || "");
      const streamUrl = driveId ? form.url.trim() : await validateStreamUrl(form.url || "");
      const settings = validateSettings(form);
      const id = crypto.randomUUID().replaceAll("-", "");
      const kind = driveId ? "drive" : "stream";
      const sourceName = driveId ? `Google Drive · ${driveId}` : new URL(streamUrl).hostname || "stream";
      insertAnalysis({ id, sourceName, kind, conf: settings.conf, operator: settings.operator, zone: settings.zone });
      logActivity("info", driveId
        ? `Запущено скачивание и анализ файла Google Drive: ${sourceName}`
        : `Запущен анализ потока ${sourceName}`, id);
      enqueueJob({
        id, sourceName, kind, source: streamUrl, conf: settings.conf, imgsz: settings.imgsz,
        operator: settings.operator, zone: settings.zone,
      });
      jsonResponse(response, 202, { analyses: [{ id, source_name: sourceName, status: "processing", kind }] });
    } catch (error) {
      jsonResponse(response, 400, { error: error.message });
    }
    return;
  }
  let match = pathname.match(/^\/api\/analyses\/([a-f0-9]+)$/);
  if (method === "GET" && match) {
    const analysis = collectAnalysis(db.prepare(`SELECT a.*,r.id report_id FROM analyses a
      LEFT JOIN reports r ON r.analysis_id=a.id WHERE a.id=?`).get(match[1]));
    jsonResponse(response, analysis ? 200 : 404, analysis || { error: "Анализ не найден." });
    return;
  }
  match = pathname.match(/^\/api\/analyses\/([a-f0-9]+)\/stop$/);
  if (method === "POST" && match) {
    const analysis = db.prepare("SELECT id FROM analyses WHERE id=?").get(match[1]);
    if (!analysis) return jsonResponse(response, 404, { error: "Анализ не найден." });
    const active = activeJobs.get(match[1]);
    if (!active) return jsonResponse(response, 409, { error: "Анализ уже завершён или ещё не запущен." });
    active.cancelled = true;
    db.prepare("UPDATE analyses SET status='stopping' WHERE id=?").run(match[1]);
    logActivity("info", "Запрошена остановка анализа", match[1]);
    if (active.child) active.child.kill();
    else {
      const queued = jobs.find(job => job.id === match[1]);
      if (queued) queued.cancelled = true;
      activeJobs.delete(match[1]);
      db.prepare("UPDATE analyses SET status='failed',error='Анализ отменён до запуска.' WHERE id=?").run(match[1]);
    }
    jsonResponse(response, 200, { status: "stopping" });
    return;
  }
  match = pathname.match(/^\/api\/detections\/(\d+)$/);
  if (method === "PATCH" && match) {
    try {
      const body = await readJson(request);
      const allowed = new Set(["Новая", "Проверена", "В плане ремонта", "Требует ремонта"]);
      if (!allowed.has(body.review_status)) return jsonResponse(response, 400, { error: "Недопустимый статус проверки." });
      const update = db.prepare("UPDATE detections SET review_status=? WHERE id=?").run(body.review_status, Number(match[1]));
      if (!update.changes) return jsonResponse(response, 404, { error: "Детекция не найдена." });
      jsonResponse(response, 200, { id: Number(match[1]), review_status: body.review_status });
    } catch (error) { jsonResponse(response, 400, { error: error.message }); }
    return;
  }
  if (method === "GET" && pathname === "/api/logs") {
    const rows = db.prepare(`SELECT l.*,a.source_name FROM activity_logs l
      LEFT JOIN analyses a ON a.id=l.analysis_id ORDER BY l.id DESC LIMIT 300`).all();
    jsonResponse(response, 200, rows);
    return;
  }
  if (method === "GET" && pathname === "/api/reports") {
    const rows = db.prepare(`SELECT r.id report_id,r.report_number,r.created_at report_created_at,a.*
      FROM reports r JOIN analyses a ON a.id=r.analysis_id ORDER BY r.created_at DESC LIMIT 200`).all();
    jsonResponse(response, 200, rows);
    return;
  }
  match = pathname.match(/^\/api\/analyses\/([a-f0-9]+)\/report$/);
  if (method === "POST" && match) {
    const analysis = db.prepare("SELECT * FROM analyses WHERE id=?").get(match[1]);
    if (!analysis) return jsonResponse(response, 404, { error: "Анализ не найден." });
    if (analysis.status !== "completed") return jsonResponse(response, 409, { error: "Отчёт доступен после завершения анализа." });
    const reportId = ensureReport(analysis.id);
    logActivity("success", `Создан отчёт по анализу ${analysis.source_name}`, analysis.id);
    jsonResponse(response, 200, { report_id: reportId });
    return;
  }
  match = pathname.match(/^\/api\/reports\/([a-f0-9]+)$/);
  if (method === "GET" && match) {
    const report = reportData(match[1]);
    jsonResponse(response, report ? 200 : 404, report || { error: "Отчёт не найден." });
    return;
  }
  match = pathname.match(/^\/api\/reports\/([a-f0-9]+)\/export\.json$/);
  if (method === "GET" && match) {
    const report = reportData(match[1]);
    if (!report) return jsonResponse(response, 404, { error: "Отчёт не найден." });
    const body = Buffer.from(JSON.stringify(report, null, 2));
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-${report.report_number}.json"`,
      "Content-Length": body.length,
    });
    response.end(body);
    return;
  }
  match = pathname.match(/^\/api\/reports\/([a-f0-9]+)\/pdf$/);
  if (method === "GET" && match) {
    const report = reportData(match[1]);
    if (!report) return jsonResponse(response, 404, { error: "Отчёт не найден." });
    try { makePdf(report, response); } catch (error) {
      console.error("PDF export failed:", error);
      if (!response.headersSent) jsonResponse(response, 500, { error: error.message });
      else response.destroy(error);
    }
    return;
  }
  match = pathname.match(/^\/files\/([a-f0-9]+)\/(.+)$/);
  if (method === "GET" && match) {
    await serveFile(response, path.join(RESULT_DIR, match[1]), match[2]);
    return;
  }
  match = pathname.match(/^\/api\/analyses\/([a-f0-9]+)\/video$/);
  if (method === "GET" && match) {
    const analysis = db.prepare("SELECT source_name,kind,status FROM analyses WHERE id=?").get(match[1]);
    if (!analysis) return jsonResponse(response, 404, { error: "Анализ не найден." });
    if (analysis.status !== "completed" || !["video", "stream", "drive"].includes(analysis.kind)) {
      return jsonResponse(response, 409, { error: "Размеченное видео ещё не готово." });
    }
    const videoDirectory = path.join(RESULT_DIR, match[1]);
    const candidates = (await fsp.readdir(videoDirectory, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => path.join(videoDirectory, entry.name));
    if (!candidates.length) return jsonResponse(response, 404, { error: "Размеченный видеофайл не был создан." });
    const candidate = candidates[0];
    const stat = await fsp.stat(candidate);
    response.writeHead(200, {
      "Content-Type": contentType(candidate),
      "Content-Disposition": `attachment; filename="annotated-${path.parse(analysis.source_name).name}${path.extname(candidate)}"`,
      "Content-Length": stat.size,
    });
    fs.createReadStream(candidate).pipe(response);
    return;
  }
  jsonResponse(response, 404, { error: "Маршрут не найден." });
}

function startServer() {
  validateAccessConfiguration();
  const stale = db.prepare("SELECT id FROM analyses WHERE status IN ('processing','stopping')").all();
  for (const row of stale) {
    db.prepare("UPDATE analyses SET status='failed',error='Сервер был перезапущен во время анализа.' WHERE id=?").run(row.id);
    logActivity("error", "Задача завершена: Node.js сервер перезапустился.", row.id);
  }
  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      console.error("Request failed:", error);
      if (!response.headersSent) {
        const status = error.message.includes("слишком большой") ? 413 : 500;
        jsonResponse(response, status, { error: error.message || "Внутренняя ошибка сервера." });
      } else response.destroy(error);
    });
  });
  const port = Number(process.env.PORT || 5000);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Inspection AI Node.js server listening at http://127.0.0.1:${port}`);
    console.log(`SQLite database: ${DB_PATH}`);
    console.log(`YOLO worker: ${PYTHON} ${WORKER_PATH}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
      for (const job of activeJobs.values()) job.child?.kill();
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
  return server;
}

if (require.main === module) startServer();

module.exports = {
  extractPhotoArchive,
  getGoogleDriveId,
  isPublicAddress,
  safeFilename,
  startServer,
};
