"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  searchNspdFeatures,
  validateSearchQuery,
  validateWmsParams,
} = require("../nspd_client");

test("validates cadastral search queries and allowed themes", async () => {
  assert.equal(validateSearchQuery("  77:05:0001005:19  "), "77:05:0001005:19");
  assert.throws(() => validateSearchQuery("  "), /Укажите кадастровый номер или адрес/);
  assert.throws(() => validateSearchQuery("x".repeat(161)), /160 символов/);
  await assert.rejects(searchNspdFeatures("дом", 3), /Неподдерживаемая тема поиска/);
});

test("validates bounded WMS tile requests", () => {
  const valid = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.3.0",
    LAYERS: "36048",
    CRS: "EPSG:3857",
    FORMAT: "image/png",
    WIDTH: "256",
    HEIGHT: "256",
    BBOX: "-1000,-1000,1000,1000",
  });
  assert.deepEqual(validateWmsParams(valid), {
    width: 256,
    height: 256,
    bbox: "-1000,-1000,1000,1000",
  });
  valid.set("LAYERS", "untrusted-layer");
  assert.throws(() => validateWmsParams(valid), /параметры кадастрового WMS-запроса недопустимы/i);
});

test("parses valid GeoJSON search results from NSPD", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.pathname, "/api/geoportal/v2/search/geoportal");
    assert.equal(requestUrl.searchParams.get("query"), "ул. Тестовая, 1");
    assert.equal(requestUrl.searchParams.get("thematicSearchId"), "1");
    assert.match(options.headers.Referer, /nspd\.gov\.ru\/map/);
    return new Response(JSON.stringify({
      data: {
        features: [
          { type: "Feature", properties: { cad_number: "77:01:0001001:1" }, geometry: null },
          { type: "Invalid", properties: {}, geometry: null },
          null,
        ],
      },
    }), { headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await searchNspdFeatures("ул. Тестовая, 1"), {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { cad_number: "77:01:0001001:1" }, geometry: null },
    ],
  });
});

test("rejects an unexpected NSPD response shape", async t => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: {} }), {
      headers: { "content-type": "application/json" },
    })
  );
  await assert.rejects(searchNspdFeatures("Москва"), /без массива data\.features/);
});

test("rejects oversized NSPD responses without a content-length header", async t => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("x".repeat(5 * 1024 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    })
  );
  await assert.rejects(searchNspdFeatures("Москва"), /превышает допустимый размер/);
});
