"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

let serverProcess;
let baseUrl;
let dataDirectory;
let stderr = "";
let sessionCookie = "";

function fetchAuthorized(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Cookie: sessionCookie },
  });
}

before(async () => {
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "inspection-node-test-"));
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const { port } = portProbe.address();
  await new Promise(resolve => portProbe.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      INSPECTION_DATA_DIR: dataDirectory,
      PUBLIC_ACCESS: "1",
      APP_USERNAME: "test-user",
      APP_PASSWORD: "test-password-for-integration-tests",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stderr.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/dashboard`, { redirect: "manual" });
      if (response.status === 401) return;
    } catch {}
    if (serverProcess.exitCode !== null) throw new Error(`Node server exited: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Node server did not start: ${stderr}`);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await new Promise(resolve => serverProcess.once("exit", resolve));
  }
  if (dataDirectory) await fs.rm(dataDirectory, { recursive: true, force: true });
});

test("shows a login page and creates a cookie session for valid credentials", async () => {
  const page = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  assert.equal(page.headers.get("www-authenticate"), null);

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Вход в Inspection AI/);

  const wrongLogin = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "test-user", password: "wrong-password" }),
    redirect: "manual",
  });
  assert.equal(wrongLogin.status, 401);
  assert.match(await wrongLogin.text(), /Неверный логин или пароль/);

  const acceptedLogin = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-Proto": "https",
    },
    body: new URLSearchParams({
      username: "test-user",
      password: "test-password-for-integration-tests",
    }),
    redirect: "manual",
  });
  assert.equal(acceptedLogin.status, 303);
  const setCookie = acceptedLogin.headers.get("set-cookie");
  assert.match(setCookie, /^inspection_session=[a-f0-9]{64};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  sessionCookie = setCookie.split(";")[0];
  const accepted = await fetchAuthorized(`${baseUrl}/api/dashboard`);
  assert.equal(accepted.status, 200);
});

test("rejects API access without a session cookie", async () => {
  const response = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Требуется вход в систему." });
});

test("serves the existing website and frontend assets", async () => {
  const page = await fetchAuthorized(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /\/static\/app\.js/);
  assert.match(html, /Кадастровая карта/);
  assert.match(html, /\/static\/vendor\/leaflet\.css/);
  assert.doesNotMatch(html, /url_for/);
  assert.match(html, /href="\/training\/"/);
  assert.match(html, /Дообучение модели/);

  const script = await fetchAuthorized(`${baseUrl}/static/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /function renderStatistics/);

  const styles = await fetchAuthorized(`${baseUrl}/static/style.css`);
  assert.equal(styles.status, 200);

  const loginStyles = await fetch(`${baseUrl}/static/login.css`);
  assert.equal(loginStyles.status, 200);

  const cadastre = await fetchAuthorized(`${baseUrl}/static/cadastre.js`);
  assert.equal(cadastre.status, 200);
  assert.match(await cadastre.text(), /renderCadastreMap/);

  for (const asset of ["leaflet.js", "leaflet.css", "images/marker-icon.png"]) {
    const response = await fetchAuthorized(`${baseUrl}/static/vendor/${asset}`);
    assert.equal(response.status, 200, `expected Leaflet asset ${asset}`);
  }
});

test("validates NSPD proxy inputs without making upstream requests", async () => {
  const invalidSearch = await fetchAuthorized(`${baseUrl}/api/cadastre/search`);
  assert.equal(invalidSearch.status, 400);
  assert.match((await invalidSearch.json()).error, /Укажите кадастровый номер или адрес/);

  const invalidWms = await fetchAuthorized(`${baseUrl}/api/cadastre/wms`);
  assert.equal(invalidWms.status, 400);
});

test("exposes dashboard, analysis, log and report APIs", async () => {
  const dashboard = await fetchAuthorized(`${baseUrl}/api/dashboard`).then(response => response.json());
  assert.deepEqual(Object.keys(dashboard).sort(), ["classes", "daily", "recent", "totals"]);
  assert.equal(dashboard.totals.analyses, 0);
  for (const endpoint of ["/api/analyses", "/api/logs", "/api/reports"]) {
    const response = await fetchAuthorized(`${baseUrl}${endpoint}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  }
});

test("rejects unsupported stream URLs without scheduling a YOLO job", async () => {
  const form = new FormData();
  form.set("url", "ftp://example.com/video.mp4");
  form.set("conf", "0.25");
  form.set("imgsz", "640");
  const response = await fetchAuthorized(`${baseUrl}/api/streams`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /RTSP\/RTSPS\/HTTP\/HTTPS/);
});

test("requires a media file for upload", async () => {
  const form = new FormData();
  form.set("conf", "0.25");
  form.set("imgsz", "640");
  const response = await fetchAuthorized(`${baseUrl}/api/analyses`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Выберите хотя бы одно фото или видео/);
});

test("auth-check returns 204 with a session and 401 without", async () => {
  const allowed = await fetchAuthorized(`${baseUrl}/auth-check`);
  assert.equal(allowed.status, 204);
  const denied = await fetch(`${baseUrl}/auth-check`, { redirect: "manual" });
  assert.equal(denied.status, 401);
});

test("logs out and invalidates the session cookie", async () => {
  const response = await fetchAuthorized(`${baseUrl}/logout`, {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  const rejected = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(rejected.status, 401);
});

test("direct navigation to logout redirects to login and clears the session", async () => {
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "test-user",
      password: "test-password-for-integration-tests",
    }),
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const logout = await fetch(`${baseUrl}/logout`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/login");
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  const rejected = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Cookie: cookie },
  });
  assert.equal(rejected.status, 401);
});
