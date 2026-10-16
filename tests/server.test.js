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
const authorization = `Basic ${Buffer.from("test-user:test-password-for-integration-tests").toString("base64")}`;

function fetchAuthorized(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: authorization },
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
      const response = await fetch(`${baseUrl}/api/dashboard`);
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

test("requires authentication for the website and API", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 401);
  assert.match(page.headers.get("www-authenticate"), /Basic realm="Inspection AI"/);

  const wrongCredentials = `Basic ${Buffer.from("test-user:wrong-password").toString("base64")}`;
  const rejected = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: wrongCredentials },
  });
  assert.equal(rejected.status, 401);

  const accepted = await fetchAuthorized(`${baseUrl}/api/dashboard`);
  assert.equal(accepted.status, 200);
});

test("serves the existing website and frontend assets", async () => {
  const page = await fetchAuthorized(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /\/static\/app\.js/);
  assert.doesNotMatch(html, /url_for/);

  const script = await fetchAuthorized(`${baseUrl}/static/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /function renderStatistics/);

  const styles = await fetchAuthorized(`${baseUrl}/static/style.css`);
  assert.equal(styles.status, 200);
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
