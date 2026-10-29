const content = document.querySelector("#page-content");
const breadcrumb = document.querySelector("#breadcrumb-current");
const toastRegion = document.querySelector("#toast-region");
const state = {
  page: "statistics", selectedFiles: [], pollTimer: null,
  cadastreMap: null,
};
const pageNames = {
  statistics: "СТАТИСТИКА",
  map: "КАДАСТРОВАЯ КАРТА",
  upload: "ЗАГРУЗКА ВИДЕО",
  logs: "ЛОГИ ОБНАРУЖЕНИЯ",
  reports: "ОТЧЁТЫ",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || `Ошибка запроса (${response.status})`);
  return body;
}

function toast(message, kind = "success") {
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = message;
  toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4800);
}

function setPage(page) {
  if (state.cadastreMap) {
    state.cadastreMap.remove();
    state.cadastreMap = null;
  }
  state.page = page;
  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  breadcrumb.textContent = pageNames[page] || "ОТЧЁТ";
  renderPage().catch(error => {
    content.innerHTML = `<div class="card empty-state">${escapeHtml(error.message)}</div>`;
    toast(error.message, "error");
  });
}

function heading(title, description, action = "") {
  return `<div class="page-heading"><div><div class="eyebrow">ПАНЕЛЬ МОНИТОРИНГА</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString("ru-RU");
}

function duration(seconds) {
  if (!seconds) return "—";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}м ${String(total % 60).padStart(2, "0")}с`;
}

function statusBadge(status) {
  const labels = {
    completed: ["Завершён", "green"],
    processing: ["В работе", "blue"],
    failed: ["Ошибка", "red"],
    stopping: ["Остановка", "amber"],
  };
  const [text, tone] = labels[status] || [status || "—", "gray"];
  return `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;
}

function openReportButton(analysis) {
  if (analysis.status !== "completed") return "";
  if (analysis.report_id) {
    return `<button class="btn" data-open-report="${escapeHtml(analysis.report_id)}">Открыть отчёт</button>`;
  }
  return `<button class="btn" data-create-report="${escapeHtml(analysis.id)}">Создать отчёт</button>`;
}

function drawTrend(canvas, data) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, rect.width);
  const height = Math.max(150, rect.height);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const pad = { left: 33, right: 8, top: 12, bottom: 25 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const dates = Array.from({ length: 7 }, (_, offset) => {
    const day = new Date();
    day.setDate(day.getDate() - 6 + offset);
    return day.toISOString().slice(0, 10);
  });
  const lookup = new Map(data.map(item => [item.day, Number(item.count)]));
  const values = dates.map(date => lookup.get(date) || 0);
  const max = Math.max(5, ...values);
  ctx.font = "10px Segoe UI,Arial,sans-serif";
  ctx.textBaseline = "middle";
  for (let line = 0; line <= 3; line++) {
    const y = pad.top + innerH * line / 3;
    ctx.strokeStyle = "#edf0f4";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = "#8793a5";
    ctx.textAlign = "left";
    ctx.fillText(String(Math.round(max * (3 - line) / 3)), 0, y);
  }
  const step = innerW / dates.length;
  const barW = Math.min(24, step * 0.42);
  values.forEach((value, index) => {
    const x = pad.left + index * step + (step - barW) / 2;
    const barH = (value / max) * innerH;
    ctx.fillStyle = "#386be8";
    ctx.beginPath();
    ctx.roundRect(x, pad.top + innerH - barH, barW, Math.max(2, barH), 4);
    ctx.fill();
    ctx.fillStyle = "#7b8799";
    ctx.textAlign = "center";
    ctx.fillText(new Date(`${dates[index]}T12:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }), x + barW / 2, height - 9);
  });
}

async function renderStatistics() {
  const dashboard = await api("/api/dashboard");
  const totals = dashboard.totals;
  const recent = dashboard.recent;
  content.innerHTML = `
    ${heading("Статистика", "Сводка по обработанным фотографиям, видео и найденным объектам.",
      `<button class="btn btn-primary" data-nav="upload">＋ Новый анализ</button>`)}
    <div class="stats-grid">
      <div class="card stat-card"><div class="stat-label">Всего анализов</div><div class="stat-value">${totals.analyses}</div><div class="stat-foot">Загружено файлов</div></div>
      <div class="card stat-card"><div class="stat-label">Найдено объектов</div><div class="stat-value">${totals.detections}</div><div class="stat-foot">По всем завершённым запускам</div></div>
      <div class="card stat-card"><div class="stat-label">Обработано кадров</div><div class="stat-value">${totals.frames}</div><div class="stat-foot">Фото и кадры видео</div></div>
      <div class="card stat-card"><div class="stat-label">Активные задачи</div><div class="stat-value">${totals.processing}</div><div class="stat-foot">${totals.failed} задач с ошибкой</div></div>
    </div>
    <div class="two-col">
      <div class="card card-pad"><div class="section-title"><h2>Динамика детекций</h2><span class="chart-legend"><i class="legend-dot"></i>Объекты</span></div><div class="chart-wrap"><canvas id="trend-chart" aria-label="Динамика количества детекций за неделю"></canvas></div></div>
      <div class="card card-pad"><div class="section-title"><h2>Классы модели</h2><small>По уверенности модели</small></div>
        <div class="bar-chart">${dashboard.classes.length ? dashboard.classes.map(item => {
          const peak = Math.max(...dashboard.classes.map(row => row.count), 1);
          return `<div class="bar-row"><span class="bar-name" title="${escapeHtml(item.class_name)}">${escapeHtml(item.class_name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, item.count / peak * 100)}%"></div></div><span class="bar-count">${item.count}</span></div>`;
        }).join("") : `<div class="empty-inline">Пока нет завершённых анализов.</div>`}</div>
      </div>
    </div>
    <div class="card card-pad"><div class="section-title"><h2>Последние анализы</h2><button class="btn" data-nav="logs">Все логи →</button></div>
      ${analysisTable(recent)}
    </div>`;
  drawTrend(content.querySelector("#trend-chart"), dashboard.daily);
}

function analysisTable(rows) {
  if (!rows.length) return `<div class="empty-inline">Анализов пока нет. Загрузите фото или видео, чтобы начать.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>ФАЙЛ</th><th>ТИП</th><th>СТАТУС</th><th>КАДРЫ</th><th>ДЕТЕКЦИИ</th><th>ДАТА</th><th></th></tr></thead><tbody>
    ${rows.map(item => `<tr>
      <td><strong>${escapeHtml(item.source_name)}</strong><div class="report-card-meta">${escapeHtml(item.zone || "Не указан")} · ${escapeHtml(item.operator || "Оператор")}</div></td>
      <td>${item.kind === "archive" ? "Фотоархив · " + item.source_file_count + " фото" : item.kind === "image" ? "Фото" : item.kind === "stream" ? "Поток" : "Видео"}</td>
      <td>${statusBadge(item.status)}</td><td>${item.frame_count || 0}</td><td>${item.detection_count || 0}</td>
      <td>${formatDate(item.created_at)}</td><td>${openReportButton(item)} ${item.status === "completed" ? `<button class="btn" data-details="${escapeHtml(item.id)}">Детали</button>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function setSelectedFiles(files) {
  const accepted = files.filter(file => /\.(jpe?g|png|bmp|webp|tiff?|mp4|avi|mov|mkv|webm|m4v|zip)$/i.test(file.name));
  state.selectedFiles = accepted.slice(0, 20);
  const list = document.querySelector("#file-list");
  if (list) list.innerHTML = state.selectedFiles.length
    ? state.selectedFiles.map(file => `<div class="file-chip">${escapeHtml(file.name)} · ${(file.size / 1024 / 1024).toFixed(1)} МБ</div>`).join("")
    : `<div class="empty-inline">Файлы не выбраны</div>`;
  if (files.length > 20) toast("За один раз можно загрузить не более 20 файлов.", "error");
  if (accepted.length !== files.length) toast("Часть файлов пропущена: поддерживаются фото, видео и ZIP-архивы с фотографиями.", "error");
}

async function renderUpload() {
  const analyses = await api("/api/analyses");
  content.innerHTML = `
    ${heading("Загрузка медиа", "Загрузите фотографии или видео для анализа моделью компьютерного зрения.")}
    <div class="upload-layout">
      <div class="upload-stack">
        <form id="upload-form" class="card card-pad">
          <label class="dropzone" id="dropzone" for="media-files">
            <span><span class="upload-symbol">⇧</span><strong>Перетащите фото, видео или ZIP-архив</strong><p>В ZIP фотографии ищутся во всех папках и обрабатываются одним заданием с общим отчётом.<br>JPG, PNG, MP4, MOV, AVI, ZIP · до 512 МБ за загрузку</p><span class="btn">Выбрать файлы</span>
              <span class="file-list" id="file-list"><span class="empty-inline">Файлы не выбраны</span></span>
            </span>
          </label>
          <input class="file-input" id="media-files" type="file" multiple accept="image/*,video/*,.zip,application/zip">
          <div class="form-grid" style="margin-top:15px">
            <label class="field">Участок / объект<input name="zone" maxlength="100" placeholder="Например: Сектор A-12"></label>
            <label class="field">Оператор<input name="operator" maxlength="100" placeholder="Имя оператора"></label>
            <label class="field">Порог уверенности<input name="conf" type="number" min="0" max="1" step="0.05" value="0.25"></label>
            <label class="field">Размер модели<input name="imgsz" type="number" min="64" max="2048" step="32" value="640"></label>
            <button class="btn btn-primary full-width" type="submit">Запустить анализ выбранных файлов</button>
          </div>
        </form>
        <form id="stream-form" class="card card-pad">
          <div class="section-title"><h2>Ссылка на видео, архив или поток</h2><span class="badge badge-blue">Google Drive / RTSP / HTTPS</span></div>
          <div class="form-grid">
            <label class="field full-width">Публичная ссылка на видео или URL потока<input name="url" type="url" required placeholder="https://drive.google.com/file/d/…/view"></label>
            <div class="full-width" style="color:var(--muted);font-size:9px;line-height:1.6">Google Drive: видео или ZIP с фотографиями должны быть доступны по ссылке («Все, у кого есть ссылка — Читатель»), размер — до 512 МБ. Для видео поддерживается повторное подключение при временных сетевых сбоях. RTSP/HTTPS-потоки должны быть доступны по публичному IP. Не указывайте пароль в URL.</div>
            <button class="btn btn-primary full-width" type="submit">Скачать и запустить анализ</button>
          </div>
        </form>
      </div>
      <div class="card analysis-panel">
        <h2>Анализ ИИ</h2><p>Задачи, последние детекции и быстрый переход к отчёту.</p>
        <div id="analysis-jobs" class="progress-list">${analyses.slice(0, 8).map(jobMarkup).join("") || `<div class="empty-inline">Загруженных файлов пока нет.</div>`}</div>
        <div class="section-title" style="margin-top:20px"><h2>Последние детекции</h2><button class="btn" data-nav="logs">Открыть логи</button></div>
        <div id="upload-detections" class="defect-list"><div class="loading">Загружаю…</div></div>
      </div>
    </div>`;

  document.querySelector("#media-files").addEventListener("change", event => setSelectedFiles([...event.target.files]));
  const dropzone = document.querySelector("#dropzone");
  dropzone.addEventListener("dragover", event => { event.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", event => { event.preventDefault(); dropzone.classList.remove("dragover"); setSelectedFiles([...event.dataTransfer.files]); });
  document.querySelector("#upload-form").addEventListener("submit", submitFiles);
  document.querySelector("#stream-form").addEventListener("submit", submitStream);
  await refreshUploadDetections();
  if (analyses.some(item => item.status === "processing")) startPolling();
}

function jobMarkup(item) {
  const stop = item.status === "processing" || item.status === "stopping"
    ? `<button class="btn btn-danger" data-stop="${escapeHtml(item.id)}">Остановить</button>` : "";
  const report = openReportButton(item);
  const count = item.kind === "archive"
    ? `${item.frame_count || 0}/${item.source_file_count} фото обработано`
    : `${item.frame_count || 0} кадров`;
  return `<div class="progress-item"><div style="min-width:0"><strong>${escapeHtml(item.source_name)}</strong><br><small>${count} · ${item.detection_count || 0} детекций ${item.error ? `· ${escapeHtml(item.error)}` : ""}</small></div><div style="display:flex;gap:6px;align-items:center">${statusBadge(item.status)}${report}${stop}</div></div>`;
}

async function submitFiles(event) {
  event.preventDefault();
  if (!state.selectedFiles.length) return toast("Сначала выберите фото или видео.", "error");
  const form = event.currentTarget;
  const formData = new FormData(form);
  state.selectedFiles.forEach(file => formData.append("files", file, file.name));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/analyses", { method: "POST", body: formData });
    state.selectedFiles = [];
    form.reset();
    document.querySelector("#file-list").innerHTML = `<div class="empty-inline">Файлы не выбраны</div>`;
    toast(`Поставлено в очередь файлов: ${result.analyses.length}`);
    startPolling();
    await refreshUploadJobs();
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

async function submitStream(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/streams", { method: "POST", body: formData });
    const isDriveFile = result.analyses.some(item => item.kind === "drive");
    toast(isDriveFile ? "Файл из Google Drive поставлен в очередь скачивания и анализа." : "Поток подключён, анализ запущен. Нажмите «Остановить» после проверки.");
    startPolling();
    await refreshUploadJobs();
    form.reset();
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(async () => {
    try {
      const analyses = await api("/api/analyses");
      if (state.page === "upload") await refreshUploadJobs(analyses);
      if (state.page === "statistics") await renderStatistics();
      if (state.page === "logs") await renderLogs();
      if (!analyses.some(item => item.status === "processing" || item.status === "stopping")) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        if (state.page === "upload") await refreshUploadDetections();
        toast("Очередь анализа завершена.");
      }
    } catch (error) { toast(error.message, "error"); clearInterval(state.pollTimer); state.pollTimer = null; }
  }, 2500);
}

async function refreshUploadJobs(analyses) {
  const container = document.querySelector("#analysis-jobs");
  if (!container) return;
  const rows = analyses || await api("/api/analyses");
  container.innerHTML = rows.slice(0, 12).map(jobMarkup).join("") || `<div class="empty-inline">Загруженных файлов пока нет.</div>`;
  await refreshUploadDetections();
}

async function refreshUploadDetections() {
  const container = document.querySelector("#upload-detections");
  if (!container) return;
  const completed = (await api("/api/analyses")).filter(item => item.status === "completed").slice(0, 4);
  const detections = [];
  for (const analysis of completed) {
    const detail = await api(`/api/analyses/${encodeURIComponent(analysis.id)}`);
    detail.detections.slice(0, 4).forEach(item => detections.push({ ...item, source_name: detail.source_name, analysis_id: detail.id }));
  }
  container.innerHTML = detections.length ? detections.slice(0, 8).map(defectCard).join("") : `<div class="empty-inline">Детекции появятся после завершения анализа.</div>`;
}

async function stopAnalysis(id) {
  try {
    await api(`/api/analyses/${encodeURIComponent(id)}/stop`, { method: "POST" });
    toast("Запрошена остановка анализа.");
  } catch (error) { toast(error.message, "error"); }
}

async function renderReports() {
  const reports = await api("/api/reports");
  content.innerHTML = `
    ${heading("Отчёты", "Сохранённые инспекции: подробные детекции, статус проверки и экспорт PDF.",
      `<button class="btn" data-nav="logs">К анализам →</button>`)}
    <div class="filter-row"><input id="report-search" type="search" placeholder="Поиск по файлу, отчёту или участку"><select id="report-status"><option value="">Все статусы</option><option value="completed">Завершён</option></select></div>
    <div id="report-list" class="report-list">${reports.length ? reports.map(reportCard).join("") : `<div class="card empty-state">Отчётов пока нет.<br>Завершите анализ и нажмите «Создать отчёт».</div>`}</div>`;
  document.querySelector("#report-search").addEventListener("input", filterReports);
  document.querySelector("#report-status").addEventListener("change", filterReports);
}

function reportCard(item) {
  return `<article class="card report-card" data-report-card data-search="${escapeHtml(`${item.report_number} ${item.source_name} ${item.zone}`.toLowerCase())}">
    <div><div class="report-card-title">${escapeHtml(item.source_name)}</div><div class="report-card-meta">${escapeHtml(item.report_number)} · ${formatDate(item.report_created_at)}</div></div>
    <div class="report-metric"><span>Участок</span><strong>${escapeHtml(item.zone)}</strong></div>
    <div class="report-metric"><span>Детекции</span><strong>${item.detection_count}</strong></div>
    <div class="report-metric"><span>Оператор</span><strong>${escapeHtml(item.operator)}</strong></div>
    <div><button class="btn btn-primary" data-open-report="${escapeHtml(item.report_id)}">Открыть</button></div>
  </article>`;
}

function filterReports() {
  const query = document.querySelector("#report-search").value.trim().toLowerCase();
  document.querySelectorAll("[data-report-card]").forEach(card => {
    card.hidden = !card.dataset.search.includes(query);
  });
}

async function showReport(reportId) {
  const report = await api(`/api/reports/${encodeURIComponent(reportId)}`);
  breadcrumb.textContent = "ОТЧЁТ";
  content.innerHTML = reportDetailMarkup(report);
  bindDetailActions(report);
}

function reportDetailMarkup(report) {
  const title = `Инспекция ${report.zone || report.source_name}`;
  const tableRows = report.detections.map((item, index) => `
    <tr><td class="mono">#${String(index + 1).padStart(2, "0")}</td>
      <td><strong>${escapeHtml(item.class_name)}</strong><div class="report-card-meta">${report.kind === "archive" ? `${escapeHtml(item.source_file)} · ` : ""}Кадр ${item.frame_index}${["video", "stream", "drive"].includes(report.kind) ? ` · ${Number(item.time_seconds).toFixed(2)} сек.` : ""}</div></td>
      <td class="mono">${Math.round(item.x1)}, ${Math.round(item.y1)} – ${Math.round(item.x2)}, ${Math.round(item.y2)}</td>
      <td><span class="badge ${item.confidence >= .75 ? "badge-red" : item.confidence >= .45 ? "badge-amber" : "badge-blue"}">${(item.confidence * 100).toFixed(1)}%</span></td>
      <td><select class="review-select" data-review-id="${item.id}">
        ${["Новая", "Проверена", "В плане ремонта", "Требует ремонта"].map(status => `<option ${item.review_status === status ? "selected" : ""}>${status}</option>`).join("")}
      </select></td>
      <td><button class="btn" data-preview="${fileUrl(report.id, item.image_rel)}">Кадр</button></td>
    </tr>`).join("");
  return `
    <div class="detail-header"><div><button class="btn" data-nav="reports">← Назад к отчётам</button><div class="page-heading" style="margin:15px 0 0">${heading(title, `${escapeHtml(report.report_number)} · Создан ${formatDate(report.report_created_at)}`)}</div></div>
      <div class="detail-actions">${["video", "stream", "drive"].includes(report.kind) ? `<a class="btn" href="/api/analyses/${encodeURIComponent(report.id)}/video">⇩ Видео с разметкой</a>` : ""}
        <a class="btn" href="/api/reports/${encodeURIComponent(report.report_id)}/export.json">⇩ Экспорт JSON</a><a class="btn btn-primary" href="/api/reports/${encodeURIComponent(report.report_id)}/pdf">⇩ Скачать PDF</a><button class="btn" data-print>Печать</button></div>
    </div>
    <div class="stats-grid">
      <div class="card stat-card"><div class="stat-label">Участок инспекции</div><div class="stat-value" style="font-size:17px">${escapeHtml(report.zone)}</div><div class="stat-foot">${escapeHtml(report.source_name)}</div></div>
      <div class="card stat-card"><div class="stat-label">Количество детекций</div><div class="stat-value">${report.detection_count}</div><div class="stat-foot">${report.detection_frame_count} кадров с объектами</div></div>
      <div class="card stat-card"><div class="stat-label">${report.kind === "archive" ? "Фотографий в архиве" : "Продолжительность"}</div><div class="stat-value">${report.kind === "archive" ? report.source_file_count : duration(report.duration_seconds)}</div><div class="stat-foot">${report.frame_count} ${report.kind === "archive" ? "фото обработано" : "кадров обработано"}</div></div>
      <div class="card stat-card"><div class="stat-label">Оператор смены</div><div class="stat-value" style="font-size:17px">${escapeHtml(report.operator)}</div><div class="stat-foot">${formatDate(report.created_at)}</div></div>
    </div>
    <div class="card card-pad"><div class="section-title"><h2>Обнаруженные объекты</h2><small>Координаты указаны в пикселях исходного кадра</small></div>
      ${report.detections.length ? `<div class="table-wrap"><table><thead><tr><th>№</th><th>Класс / кадр</th><th>Координаты X1,Y1 – X2,Y2</th><th>Уверенность</th><th>Статус проверки</th><th>Изображение</th></tr></thead><tbody>${tableRows}</tbody></table></div>` : `<div class="empty-inline">Модель не обнаружила объектов на этом материале.</div>`}
    </div>
    <div class="card card-pad" style="margin-top:14px"><div class="section-title"><h2>Кадры с детекциями</h2><small>${report.detection_frame_count} изображений</small></div>
      ${report.detections.length ? `<div class="image-grid">${report.detections.filter((item,index,array) => array.findIndex(other => other.image_rel === item.image_rel) === index).map(item => `<div class="image-tile" data-preview="${fileUrl(report.id, item.image_rel)}"><img loading="lazy" src="${fileUrl(report.id, item.image_rel)}" alt="Кадр ${item.frame_index} с детекциями"><div class="image-tile-info"><strong>Кадр ${item.frame_index}</strong>${escapeHtml(item.class_name)} · ${(item.confidence*100).toFixed(1)}%</div></div>`).join("")}</div>` : `<div class="empty-inline">Изображения для показа отсутствуют.</div>`}
    </div>`;
}

function fileUrl(analysisId, relativePath) {
  return `/files/${encodeURIComponent(analysisId)}/${String(relativePath).split("/").map(encodeURIComponent).join("/")}`;
}

function defectCard(item) {
  return `<div class="defect-card"><img class="defect-thumb" loading="lazy" src="${fileUrl(item.analysis_id, item.image_rel)}" alt="">
    <div><div class="defect-name">${escapeHtml(item.class_name)}</div><div class="defect-meta">${escapeHtml(item.source_name)}<br>Кадр ${item.frame_index} · ${(item.confidence*100).toFixed(1)}%</div></div>
    <span class="badge ${item.confidence >= .75 ? "badge-red" : item.confidence >= .45 ? "badge-amber" : "badge-blue"}">${item.confidence >= .75 ? "ВЫСОКАЯ" : item.confidence >= .45 ? "СРЕДНЯЯ" : "НИЗКАЯ"}</span>
  </div>`;
}

function bindDetailActions(report) {
  content.querySelectorAll("[data-review-id]").forEach(select => {
    select.addEventListener("change", async () => {
      try {
        await api(`/api/detections/${select.dataset.reviewId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ review_status: select.value }),
        });
        toast("Статус проверки сохранён.");
      } catch (error) { toast(error.message, "error"); }
    });
  });
  content.querySelectorAll("[data-preview]").forEach(element => {
    element.addEventListener("click", () => showImage(element.dataset.preview));
  });
  content.querySelector("[data-print]")?.addEventListener("click", () => window.print());
}

function showImage(src) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `<div class="modal-card"><img src="${escapeHtml(src)}" alt="Кадр с результатом детекции"><div style="padding:8px;text-align:right"><button class="btn" data-close>Закрыть</button></div></div>`;
  modal.addEventListener("click", event => { if (event.target === modal || event.target.closest("[data-close]")) modal.remove(); });
  document.body.append(modal);
}

async function renderLogs() {
  const analyses = await api("/api/analyses");
  content.innerHTML = `
    ${heading("Логи обнаружения", "Состояние задач, число обработанных кадров и результаты модели.")}
    <div class="card card-pad"><div class="section-title"><h2>История анализов</h2><button class="btn" data-nav="upload">＋ Загрузить медиа</button></div>
      <div class="filter-row"><input type="search" id="analysis-search" placeholder="Поиск по имени файла"><select id="analysis-state"><option value="">Все состояния</option><option value="completed">Завершён</option><option value="processing">В работе</option><option value="failed">Ошибка</option></select></div>
      <div id="analysis-table">${analysisTable(analyses)}</div>
    </div>
    <div class="card card-pad" style="margin-top:14px"><div class="section-title"><h2>Журнал событий</h2><small>Последние действия системы</small></div><div id="event-log"><div class="loading">Загружаю…</div></div></div>`;
  document.querySelector("#analysis-search").addEventListener("input", filterAnalyses);
  document.querySelector("#analysis-state").addEventListener("change", filterAnalyses);
  const logs = await api("/api/logs");
  document.querySelector("#event-log").innerHTML = logs.length ? `<div class="log-list">${logs.map(item => `<div class="log-row"><span class="mono">${formatDate(item.created_at)}</span>${statusBadge(item.level === "success" ? "completed" : item.level === "error" ? "failed" : "processing")}<span class="log-message">${escapeHtml(item.message)}</span><span class="log-source">${escapeHtml(item.source_name || "")}</span></div>`).join("")}</div>` : `<div class="empty-inline">Событий пока нет.</div>`;
}

function filterAnalyses() {
  const query = document.querySelector("#analysis-search").value.trim().toLowerCase();
  const status = document.querySelector("#analysis-state").value;
  api("/api/analyses").then(rows => {
    const filtered = rows.filter(row => row.source_name.toLowerCase().includes(query) && (!status || row.status === status));
    document.querySelector("#analysis-table").innerHTML = analysisTable(filtered);
  }).catch(error => toast(error.message, "error"));
}

async function renderMap() {
  return window.renderCadastreMap();
}

async function renderPage() {
  if (state.page === "statistics") return renderStatistics();
  if (state.page === "upload") return renderUpload();
  if (state.page === "logs") return renderLogs();
  if (state.page === "reports") return renderReports();
  if (state.page === "map") return renderMap();
}

document.addEventListener("click", async event => {
  const nav = event.target.closest("[data-page], [data-nav]");
  if (nav) {
    const page = nav.dataset.page || nav.dataset.nav;
    if (page) setPage(page);
    return;
  }
  const stop = event.target.closest("[data-stop]");
  if (stop) return stopAnalysis(stop.dataset.stop);
  const create = event.target.closest("[data-create-report]");
  if (create) {
    try {
      await api(`/api/analyses/${encodeURIComponent(create.dataset.createReport)}/report`, { method: "POST" });
      toast("Отчёт создан.");
      if (state.page === "reports") await renderReports();
      else if (state.page === "upload") await refreshUploadJobs();
      else if (state.page === "logs") await renderLogs();
      else await renderStatistics();
    } catch (error) { toast(error.message, "error"); }
    return;
  }
  const open = event.target.closest("[data-open-report]");
  if (open) {
    try { await showReport(open.dataset.openReport); } catch (error) { toast(error.message, "error"); }
    return;
  }
  const details = event.target.closest("[data-details]");
  if (details) {
    try {
      await api(`/api/analyses/${encodeURIComponent(details.dataset.details)}/report`, { method: "POST" });
      const reports = await api("/api/reports");
      const report = reports.find(item => item.id === details.dataset.details);
      if (report) await showReport(report.report_id);
    } catch (error) { toast(error.message, "error"); }
  }
});

window.addEventListener("resize", () => {
  if (state.page === "statistics") renderStatistics().catch(error => toast(error.message, "error"));
});

setPage("statistics");
api("/api/analyses").then(rows => {
  if (rows.some(item => item.status === "processing")) startPolling();
}).catch(error => toast(error.message, "error"));
