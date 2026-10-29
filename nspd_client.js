"use strict";

const NSPD_BASE_URL = "https://nspd.gov.ru";
const NSPD_SEARCH_PATH = "/api/geoportal/v2/search/geoportal";
const NSPD_PARCEL_WMS_PATH = "/api/aeggis/v3/36048/wms";
const MAX_SEARCH_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_WMS_TILE_BYTES = 2 * 1024 * 1024;
const MAX_WEB_MERCATOR = 20037508.342789244;

class NspdInputError extends TypeError {}

function validateSearchQuery(query) {
  if (typeof query !== "string") throw new NspdInputError("Укажите кадастровый номер или адрес.");
  const normalized = query.trim();
  if (!normalized) throw new NspdInputError("Укажите кадастровый номер или адрес.");
  if (normalized.length > 160) throw new NspdInputError("Поисковый запрос не должен превышать 160 символов.");
  return normalized;
}

async function readLimitedBody(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("Ответ НСПД превышает допустимый размер.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Ответ НСПД превышает допустимый размер.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function searchNspdFeatures(query, themeId = 1) {
  const normalized = validateSearchQuery(query);
  if (![1, 2, 4, 5, 7, 15].includes(themeId)) {
    throw new NspdInputError("Неподдерживаемая тема поиска НСПД.");
  }
  const url = new URL(NSPD_SEARCH_PATH, NSPD_BASE_URL);
  url.search = new URLSearchParams({
    query: normalized,
    thematicSearchId: String(themeId),
    CRS: "EPSG:4326",
  });
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://nspd.gov.ru/map",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`НСПД ответил HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("НСПД вернул ответ не в формате JSON.");
  }
  const body = await readLimitedBody(response, MAX_SEARCH_RESPONSE_BYTES);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error("Не удалось разобрать ответ JSON от НСПД.", { cause: error });
  }
  const features = payload?.data?.features;
  if (!Array.isArray(features)) throw new Error("НСПД вернул ответ без массива data.features.");
  return {
    type: "FeatureCollection",
    features: features.filter(feature =>
      feature && feature.type === "Feature" && feature.properties && typeof feature.properties === "object"
    ),
  };
}

function validateWmsParams(params) {
  const normalizedParams = new Map();
  for (const [key, value] of params) {
    const normalizedKey = key.toLowerCase();
    if (normalizedParams.has(normalizedKey)) {
      throw new NspdInputError("Повторяющиеся параметры кадастрового WMS-запроса недопустимы.");
    }
    normalizedParams.set(normalizedKey, value);
  }
  const get = key => normalizedParams.get(key);
  const service = (get("service") || "").toUpperCase();
  const request = (get("request") || "").toUpperCase();
  const layers = get("layers");
  const crs = (get("crs") || get("srs") || "").toUpperCase();
  const format = (get("format") || "").toLowerCase();
  const version = get("version");
  const width = Number(get("width"));
  const height = Number(get("height"));
  const bbox = (get("bbox") || "").split(",").map(Number);

  if (
    service !== "WMS" || request !== "GETMAP" || layers !== "36048"
    || crs !== "EPSG:3857" || format !== "image/png" || version !== "1.3.0"
  ) {
    throw new NspdInputError("Параметры кадастрового WMS-запроса недопустимы.");
  }
  if (
    !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > 1024 || height > 1024
  ) {
    throw new NspdInputError("Недопустимый размер кадастровой карты.");
  }
  if (
    bbox.length !== 4 || !bbox.every(Number.isFinite)
    || bbox.some(value => Math.abs(value) > MAX_WEB_MERCATOR * 1.01)
    || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]
  ) {
    throw new NspdInputError("Недопустимая область кадастровой карты.");
  }
  return { width, height, bbox: bbox.join(",") };
}

async function fetchNspdParcelTile(params) {
  const validated = validateWmsParams(params);
  const url = new URL(NSPD_PARCEL_WMS_PATH, NSPD_BASE_URL);
  url.search = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.3.0",
    LAYERS: "36048",
    STYLES: "",
    FORMAT: "image/png",
    TRANSPARENT: "true",
    CRS: "EPSG:3857",
    BBOX: validated.bbox,
    WIDTH: String(validated.width),
    HEIGHT: String(validated.height),
  });
  const response = await fetch(url, {
    headers: {
      Accept: "image/png",
      Referer: "https://nspd.gov.ru/map?thematic=Default&active_layers=36048",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Кадастровый слой НСПД ответил HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("image/png")) {
    throw new Error("НСПД не вернул изображение кадастрового слоя.");
  }
  return readLimitedBody(response, MAX_WMS_TILE_BYTES);
}

module.exports = {
  fetchNspdParcelTile,
  NspdInputError,
  searchNspdFeatures,
  validateSearchQuery,
  validateWmsParams,
};
