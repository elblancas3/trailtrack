-- ═══════════════════════════════════════════════════════════
--   TrailTrack — Schema Neon / PostgreSQL + PostGIS
--   Ejecutar en: Neon Console → SQL Editor
-- ═══════════════════════════════════════════════════════════

-- 1. Habilitar PostGIS (Neon lo tiene disponible)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- ─── RUTAS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rutas (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  descripcion   TEXT,
  dificultad    TEXT CHECK (dificultad IN ('fácil','moderada','difícil','extrema')),

  -- Métricas calculadas al guardar
  distancia_km  NUMERIC(8,3),
  ganancia_m    NUMERIC(8,1),
  perdida_m     NUMERIC(8,1),
  elev_max_m    NUMERIC(8,1),
  elev_min_m    NUMERIC(8,1),
  puntos_gpx    INT,

  -- Geometría: LineString 3D (lon, lat, ele) en WGS84
  -- Permite queries espaciales: ¿rutas cerca de mí? ¿se cruzan? etc.
  geom          GEOMETRY(LineStringZ, 4326),

  -- GPX original guardado como texto para descarga fiel
  gpx_raw       TEXT,

  -- Metadatos
  autor         TEXT DEFAULT 'anon',
  zona          TEXT,            -- p.ej. "Sierra Madre Occidental"
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Índice espacial (GIST) — fundamental para queries de proximidad
CREATE INDEX IF NOT EXISTS rutas_geom_idx ON rutas USING GIST (geom);
CREATE INDEX IF NOT EXISTS rutas_created_idx ON rutas (created_at DESC);

-- ─── PUNTOS DE INTERÉS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS poi (
  id          SERIAL PRIMARY KEY,
  ruta_id     INT REFERENCES rutas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  tipo        TEXT CHECK (tipo IN (
                'agua','cumbre','mirador','refugio','peligro',
                'desvío','campamento','inicio','meta','otro'
              )),
  descripcion TEXT,
  foto_url    TEXT,             -- URL externa (Cloudflare R2, imgbb, etc.)
  km_en_ruta  NUMERIC(8,3),    -- Distancia desde el inicio de la ruta
  altitud_m   NUMERIC(8,1),

  -- Geometría punto
  geom        GEOMETRY(Point, 4326),

  autor       TEXT DEFAULT 'anon',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS poi_geom_idx    ON poi USING GIST (geom);
CREATE INDEX IF NOT EXISTS poi_ruta_idx    ON poi (ruta_id);
CREATE INDEX IF NOT EXISTS poi_tipo_idx    ON poi (tipo);

-- ─── SESIONES (tracks GPS reales de cada salida) ─────────────
CREATE TABLE IF NOT EXISTS sesiones (
  id              SERIAL PRIMARY KEY,
  ruta_id         INT REFERENCES rutas(id) ON DELETE SET NULL,
  usuario         TEXT DEFAULT 'anon',

  -- Track real recorrido (puede diferir de la ruta de referencia)
  track           GEOMETRY(LineStringZ, 4326),

  -- Métricas de la sesión
  distancia_km    NUMERIC(8,3),
  duracion_min    INT,
  velocidad_media NUMERIC(6,2),  -- km/h
  ganancia_m      NUMERIC(8,1),
  elev_max_m      NUMERIC(8,1),

  fecha_inicio    TIMESTAMPTZ,
  fecha_fin       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sesiones_ruta_idx  ON sesiones (ruta_id);
CREATE INDEX IF NOT EXISTS sesiones_track_idx ON sesiones USING GIST (track);
CREATE INDEX IF NOT EXISTS sesiones_user_idx  ON sesiones (usuario);

-- ─── VISTAS ÚTILES ──────────────────────────────────────────

-- Vista pública de rutas (sin gpx_raw para respuestas rápidas)
CREATE OR REPLACE VIEW rutas_resumen AS
SELECT
  id, nombre, descripcion, dificultad,
  distancia_km, ganancia_m, elev_max_m, elev_min_m,
  puntos_gpx, autor, zona, created_at,
  -- Bounding box como array [minLon, minLat, maxLon, maxLat]
  ARRAY[
    ST_XMin(geom::box3d), ST_YMin(geom::box3d),
    ST_XMax(geom::box3d), ST_YMax(geom::box3d)
  ] AS bbox,
  -- Centroide para mostrar en mapa de exploración
  ST_Y(ST_Centroid(geom)) AS lat_centro,
  ST_X(ST_Centroid(geom)) AS lon_centro
FROM rutas
ORDER BY created_at DESC;

-- ─── EJEMPLOS DE QUERIES ESPACIALES ─────────────────────────
/*
-- ¿Rutas en un radio de 10 km desde mi posición?
SELECT nombre, distancia_km, ganancia_m
FROM rutas
WHERE ST_DWithin(
  geom::geography,
  ST_MakePoint(-99.13, 19.42)::geography,
  10000   -- metros
);

-- ¿Rutas dentro de un bbox (para mostrar en el mapa)?
SELECT id, nombre, lat_centro, lon_centro
FROM rutas_resumen
WHERE geom && ST_MakeEnvelope(-100.5, 19.0, -98.5, 20.5, 4326);

-- POIs de tipo agua en un radio de 5km
SELECT p.nombre, p.descripcion, ST_Y(p.geom) lat, ST_X(p.geom) lon
FROM poi p
WHERE p.tipo = 'agua'
  AND ST_DWithin(p.geom::geography, ST_MakePoint(-99.13,19.42)::geography, 5000);
*/
