"use strict";

const CADASTRE_TITLES = {
  cadastral_number: "Кадастровый номер",
  cad_number: "Кадастровый номер",
  address: "Адрес",
  land_record_type: "Тип объекта",
  category_name: "Категория",
  area: "Площадь",
  area_value: "Площадь",
  status: "Статус",
  utilization: "Вид использования",
};

function cadastralProperties(feature) {
  const properties = feature?.properties || {};
  return properties.options && typeof properties.options === "object"
    ? { ...properties, ...properties.options }
    : properties;
}

function cadastralTitle(feature, index) {
  const properties = cadastralProperties(feature);
  return properties.cad_number || properties.cadastral_number || properties.cadNumber
    || properties.address || properties.category_name || `Объект ${index + 1}`;
}

function cadastralDetails(feature) {
  const properties = cadastralProperties(feature);
  const preferred = [
    "cad_number", "cadastral_number", "address", "land_record_type",
    "category_name", "area", "area_value", "status", "utilization",
  ];
  const entries = preferred
    .filter(key => properties[key] !== undefined && properties[key] !== null && properties[key] !== "")
    .map(key => [CADASTRE_TITLES[key] || key, properties[key]]);
  if (!entries.length) {
    entries.push(...Object.entries(properties)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 8));
  }
  return entries.slice(0, 12).map(([label, value]) =>
    `<div class="cadastre-detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  ).join("") || `<div class="empty-inline">НСПД не вернул атрибуты объекта.</div>`;
}

async function renderCadastreMap() {
  content.innerHTML = `
    ${heading("Кадастровая карта", "Поиск объектов недвижимости и земельных участков по данным НСПД.")}
    <div class="card card-pad cadastre-card">
      <form id="cadastre-search-form" class="cadastre-search">
        <label class="cadastre-query-label" for="cadastre-query">Кадастровый номер или адрес</label>
        <div class="cadastre-search-row">
          <input id="cadastre-query" type="search" maxlength="160" required
            placeholder="Например, 77:05:0001005:19 или адрес объекта">
          <select id="cadastre-theme" aria-label="Тип кадастрового объекта">
            <option value="1">Объекты недвижимости</option>
            <option value="2">Кадастровое деление</option>
            <option value="4">Административные границы</option>
            <option value="5">Зоны и территории</option>
            <option value="7">Территориальные зоны</option>
            <option value="15">Комплексы объектов</option>
          </select>
          <button id="cadastre-search-button" class="btn btn-primary" type="submit">Найти</button>
        </div>
      </form>
      <div id="cadastre-status" class="cadastre-status" role="status">Введите номер участка или адрес и нажмите «Найти».</div>
      <div class="cadastre-layout">
        <div id="cadastre-map" class="cadastre-map" role="application" aria-label="Кадастровая карта"></div>
        <aside class="cadastre-sidebar">
          <div class="cadastre-results-heading"><strong>Результаты</strong><span id="cadastre-result-count">0</span></div>
          <div id="cadastre-results" class="cadastre-results">
            <div class="empty-inline">Результаты поиска появятся здесь.</div>
          </div>
          <div id="cadastre-object" class="cadastre-object">
            <div class="empty-inline">Выберите объект, чтобы посмотреть сведения.</div>
          </div>
        </aside>
      </div>
      <div class="cadastre-attribution-note">
        Кадастровые границы и карточки объектов предоставляются ФГИС ЕЦП НСПД.
        Базовая подложка — OpenStreetMap. Данные и доступность сервиса контролируются их владельцами.
      </div>
    </div>`;

  const mapElement = document.querySelector("#cadastre-map");
  if (!window.L) {
    document.querySelector("#cadastre-status").textContent = "Не удалось загрузить библиотеку карты.";
    return;
  }
  const map = window.L.map(mapElement, { preferCanvas: true }).setView([55.751244, 37.618423], 10);
  state.cadastreMap = map;
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
  }).addTo(map);
  const parcelLayer = window.L.tileLayer.wms("/api/cadastre/wms", {
    layers: "36048",
    format: "image/png",
    transparent: true,
    version: "1.3.0",
    crs: window.L.CRS.EPSG3857,
    uppercase: true,
    attribution: '<a href="https://nspd.gov.ru/map" target="_blank" rel="noopener noreferrer">НСПД</a>',
  }).addTo(map);
  let tileErrorShown = false;
  parcelLayer.on("tileerror", () => {
    if (tileErrorShown || !mapElement.isConnected) return;
    tileErrorShown = true;
    const status = document.querySelector("#cadastre-status");
    if (status) status.textContent = "Кадастровый слой НСПД временно недоступен; проверьте подключение к nspd.gov.ru.";
  });

  const searchForm = document.querySelector("#cadastre-search-form");
  const queryInput = document.querySelector("#cadastre-query");
  const searchButton = document.querySelector("#cadastre-search-button");
  const status = document.querySelector("#cadastre-status");
  const resultsElement = document.querySelector("#cadastre-results");
  const resultCount = document.querySelector("#cadastre-result-count");
  const objectElement = document.querySelector("#cadastre-object");
  let resultsLayer = null;
  let features = [];

  const selectFeature = index => {
    const feature = features[index];
    if (!feature) return;
    objectElement.innerHTML = `<div class="cadastre-object-title">${escapeHtml(cadastralTitle(feature, index))}</div>${cadastralDetails(feature)}`;
    if (feature.geometry) {
      const selected = window.L.geoJSON(feature);
      if (selected.getBounds().isValid()) map.fitBounds(selected.getBounds(), { maxZoom: 17, padding: [30, 30] });
    }
    if (resultsLayer) {
      resultsLayer.setStyle(layerFeature => ({
        color: layerFeature.feature === feature ? "#e24b39" : "#1554c0",
        weight: layerFeature.feature === feature ? 4 : 2,
        fillColor: layerFeature.feature === feature ? "#ffb34f" : "#4285f4",
        fillOpacity: layerFeature.feature === feature ? 0.32 : 0.18,
      }));
    }
  };

  resultsElement.addEventListener("click", event => {
    const button = event.target.closest("[data-cadastre-feature]");
    if (button) selectFeature(Number(button.dataset.cadastreFeature));
  });
  searchForm.addEventListener("submit", async event => {
    event.preventDefault();
    const query = queryInput.value.trim();
    if (!query) return;
    searchButton.disabled = true;
    status.textContent = "Выполняю поиск в НСПД…";
    resultsElement.innerHTML = `<div class="loading">Получаю кадастровые объекты…</div>`;
    objectElement.innerHTML = `<div class="empty-inline">Выберите объект из результатов.</div>`;
    resultCount.textContent = "…";
    try {
      const themeId = Number(document.querySelector("#cadastre-theme").value);
      const collection = await api(`/api/cadastre/search?${new URLSearchParams({ query, themeId })}`);
      features = collection.features;
      if (resultsLayer) map.removeLayer(resultsLayer);
      resultsLayer = window.L.geoJSON(features, {
        style: {
          color: "#1554c0",
          weight: 2,
          fillColor: "#4285f4",
          fillOpacity: 0.18,
        },
        pointToLayer: (_feature, latlng) => window.L.circleMarker(latlng, {
          radius: 7,
          color: "#1554c0",
          fillColor: "#4285f4",
          fillOpacity: 0.8,
        }),
      }).addTo(map);
      resultCount.textContent = String(features.length);
      resultsElement.innerHTML = features.length
        ? features.map((feature, index) => `
          <button class="cadastre-result" type="button" data-cadastre-feature="${index}">
            <strong>${escapeHtml(cadastralTitle(feature, index))}</strong>
            <span>${escapeHtml(cadastralProperties(feature).category_name || "Объект НСПД")}</span>
          </button>`).join("")
        : `<div class="empty-inline">НСПД не нашёл объектов по этому запросу.</div>`;
      if (features.length) {
        const bounds = resultsLayer.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { maxZoom: 16, padding: [24, 24] });
        selectFeature(0);
        status.textContent = `Найдено объектов: ${features.length}.`;
      } else {
        status.textContent = "По запросу ничего не найдено.";
      }
    } catch (error) {
      features = [];
      resultCount.textContent = "0";
      resultsElement.innerHTML = `<div class="empty-inline">${escapeHtml(error.message)}</div>`;
      status.textContent = `Поиск не выполнен: ${error.message}`;
    } finally {
      searchButton.disabled = false;
    }
  });
  window.setTimeout(() => map.invalidateSize(), 0);
}

window.renderCadastreMap = renderCadastreMap;
