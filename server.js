/**
 * TrailTrack Server — con integración Neon (PostgreSQL + PostGIS)
 * ───────────────────────────────────────────────────────────────
 * Requisitos:
 *   npm install ws pg
 *
 * Variables de entorno — crear archivo .env en esta misma carpeta:
 *   DATABASE_URL=postgresql://usuario:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
 *
 * Uso:
 *   node server.js
 */

'use strict';

// ─── Cargar .env si existe ────────────────────────────────────
try {
  const fs = require('fs');
  if (fs.existsSync('.env')) {
    fs.readFileSync('.env','utf8').split('\n').forEach(line => {
      const [k,...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    });
  }
} catch(_) {}

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

// ─── CONFIG ──────────────────────────────────────────────────
const PORT   = parseInt(process.argv.find(a=>a.startsWith('--port='))?.split('=')[1]??8080);
const DB_URL = process.env.DATABASE_URL;
const COLORS = ['#D4A843','#5BBF8A','#6AABE8','#CF6EBF','#E85A4A','#5BC4BF'];
const STATIC = __dirname;
const MIME   = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript',
  '.css':'text/css','.json':'application/json','.png':'image/png',
  '.svg':'image/svg+xml','.ico':'image/x-icon',
};

// ─── NEON POOL ────────────────────────────────────────────────
let pool = null, dbOk = false;
if (DB_URL) {
  pool = new Pool({ connectionString:DB_URL, ssl:{ rejectUnauthorized:false }, max:5 });
  pool.connect()
    .then(c=>{ c.release(); dbOk=true; console.log('[DB] ✓ Neon conectado'); })
    .catch(e=>console.error('[DB] ✗',e.message));
} else {
  console.warn('[DB] ⚠ DATABASE_URL no configurado — API de DB desactivada');
}

const q = (sql,p=[]) => pool.query(sql,p);

// ─── HTTP HELPERS ─────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
};

function jsonRes(res, data, status=200) {
  res.writeHead(status,{ 'Content-Type':'application/json',...CORS });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((ok,fail)=>{
    let d='';
    req.on('data',c=>{ d+=c; if(d.length>10_000_000) fail(new Error('Payload muy grande')); });
    req.on('end',()=>{ try{ ok(JSON.parse(d)); }catch(e){ fail(e); } });
    req.on('error',fail);
  });
}

// ════════════════════════════════════════════════
//   API HANDLERS
// ════════════════════════════════════════════════
async function handleAPI(method, pathname, req, res) {

  // GET /api/status
  if (method==='GET' && pathname==='/api/status') {
    return jsonRes(res,{ server:'ok', db:dbOk?'ok':'sin_conexion', clients:clients.size });
  }

  if (!dbOk) return jsonRes(res,{ error:'DB no disponible' },503);

  // ── GET/POST /api/rutas ──────────────────────
  if (pathname==='/api/rutas') {
    if (method==='GET') {
      const { rows } = await q(`
        SELECT id,nombre,descripcion,dificultad,distancia_km,ganancia_m,
               elev_max_m,elev_min_m,puntos_gpx,autor,zona,created_at,
               ST_Y(ST_Centroid(geom)) AS lat_centro,
               ST_X(ST_Centroid(geom)) AS lon_centro,
               ARRAY[ST_XMin(geom::box3d),ST_YMin(geom::box3d),
                     ST_XMax(geom::box3d),ST_YMax(geom::box3d)] AS bbox
        FROM rutas ORDER BY created_at DESC LIMIT 100
      `);
      return jsonRes(res,rows);
    }
    if (method==='POST') {
      const b = await parseBody(req);
      if (!b.nombre || !b.puntos?.length) return jsonRes(res,{error:'nombre y puntos requeridos'},400);
      const coords = b.puntos.map(p=>`${p.lon} ${p.lat} ${p.ele??0}`).join(',');
      const { rows } = await q(`
        INSERT INTO rutas
          (nombre,descripcion,dificultad,distancia_km,ganancia_m,perdida_m,
           elev_max_m,elev_min_m,puntos_gpx,geom,gpx_raw,autor,zona)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                ST_GeomFromText($10,4326),$11,$12,$13)
        RETURNING id,nombre,created_at
      `,[b.nombre,b.descripcion||'',b.dificultad||'moderada',
         b.distancia_km,b.ganancia_m,b.perdida_m,b.elev_max_m,b.elev_min_m,
         b.puntos_gpx,`LINESTRING Z(${coords})`,b.gpx_raw||'',b.autor||'anon',b.zona||'']);
      console.log(`[DB] Ruta guardada: "${b.nombre}" (${b.distancia_km} km)`);
      return jsonRes(res,rows[0],201);
    }
  }

  // ── GET/DELETE /api/rutas/:id ────────────────
  const mRuta = pathname.match(/^\/api\/rutas\/(\d+)$/);
  if (mRuta) {
    const id = mRuta[1];
    if (method==='GET') {
      const { rows } = await q(`
        SELECT *,ST_AsGeoJSON(geom)::json AS geojson FROM rutas WHERE id=$1
      `,[id]);
      if (!rows.length) return jsonRes(res,{error:'No encontrada'},404);
      rows[0].puntos = rows[0].geojson?.coordinates?.map(c=>({lon:c[0],lat:c[1],ele:c[2]??0}))??[];
      delete rows[0].geojson;
      return jsonRes(res,rows[0]);
    }
    if (method==='DELETE') {
      await q('DELETE FROM rutas WHERE id=$1',[id]);
      return jsonRes(res,{ok:true});
    }
  }

  // ── GET/POST /api/rutas/:id/pois ─────────────
  const mPoi = pathname.match(/^\/api\/rutas\/(\d+)\/pois$/);
  if (mPoi) {
    const ruta_id = mPoi[1];
    if (method==='GET') {
      const { rows } = await q(`
        SELECT id,nombre,tipo,descripcion,foto_url,km_en_ruta,altitud_m,
               ST_Y(geom) AS lat,ST_X(geom) AS lon,autor,created_at
        FROM poi WHERE ruta_id=$1 ORDER BY km_en_ruta
      `,[ruta_id]);
      return jsonRes(res,rows);
    }
    if (method==='POST') {
      const b = await parseBody(req);
      if (!b.nombre||!b.lat||!b.lon) return jsonRes(res,{error:'nombre,lat,lon requeridos'},400);
      const { rows } = await q(`
        INSERT INTO poi (ruta_id,nombre,tipo,descripcion,foto_url,
                         km_en_ruta,altitud_m,geom,autor)
        VALUES ($1,$2,$3,$4,$5,$6,$7,ST_MakePoint($8,$9),$10)
        RETURNING id,nombre,tipo,created_at
      `,[ruta_id,b.nombre,b.tipo||'otro',b.descripcion||'',b.foto_url||'',
         b.km_en_ruta||0,b.altitud_m||0,b.lon,b.lat,b.autor||'anon']);
      return jsonRes(res,rows[0],201);
    }
  }

  // ── POST /api/sesiones ───────────────────────
  if (pathname==='/api/sesiones' && method==='POST') {
    const b = await parseBody(req);
    if (!b.puntos?.length) return jsonRes(res,{error:'puntos requeridos'},400);
    const coords = b.puntos.map(p=>`${p.lon} ${p.lat} ${p.ele??0}`).join(',');
    const { rows } = await q(`
      INSERT INTO sesiones
        (ruta_id,usuario,track,distancia_km,duracion_min,
         velocidad_media,ganancia_m,elev_max_m,fecha_inicio,fecha_fin)
      VALUES ($1,$2,ST_GeomFromText($3,4326),$4,$5,$6,$7,$8,$9,$10)
      RETURNING id,created_at
    `,[b.ruta_id||null,b.usuario||'anon',`LINESTRING Z(${coords})`,
       b.distancia_km,b.duracion_min,b.velocidad_media,
       b.ganancia_m,b.elev_max_m,b.fecha_inicio,b.fecha_fin]);
    console.log(`[DB] Sesión guardada: ${b.usuario} (${b.distancia_km} km)`);
    return jsonRes(res,rows[0],201);
  }

  jsonRes(res,{error:'Endpoint no encontrado'},404);
}

// ════════════════════════════════════════════════
//   HTTP SERVER
// ════════════════════════════════════════════════
const server = http.createServer(async (req,res)=>{
  const { method, url } = req;
  const pathname = url.split('?')[0];

  if (method==='OPTIONS') {
    res.writeHead(204,CORS); res.end(); return;
  }

  if (pathname.startsWith('/api/')) {
    try { await handleAPI(method,pathname,req,res); }
    catch(e){ console.error('[API]',e.message); jsonRes(res,{error:e.message},500); }
    return;
  }

  const filePath = path.join(STATIC, pathname==='/'?'/index.html':pathname);
  if (!filePath.startsWith(STATIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath,(err,data)=>{
    if (err) { res.writeHead(err.code==='ENOENT'?404:500); res.end(); return; }
    res.writeHead(200,{ 'Content-Type':MIME[path.extname(filePath)]||'application/octet-stream',
                        'Cache-Control':'no-cache','Access-Control-Allow-Origin':'*' });
    res.end(data);
  });
});

// ════════════════════════════════════════════════
//   WEBSOCKET
// ════════════════════════════════════════════════
const wss = new WebSocketServer({ server });
const clients = new Map();
let colorIdx = 0;

function broadcast(data,excludeId=null){
  const j=JSON.stringify(data);
  clients.forEach((c,id)=>{ if(id!==excludeId&&c.ws.readyState===1) c.ws.send(j); });
}

wss.on('connection',(ws,req)=>{
  const id    = Math.random().toString(36).slice(2,10);
  const color = COLORS[colorIdx++%COLORS.length];
  clients.set(id,{ws,name:`User_${id.slice(0,4)}`,color,position:null});
  console.log(`[WS+] ${id} desde ${req.socket.remoteAddress}. Total:${clients.size}`);

  const peers={};
  clients.forEach((c,pid)=>{ if(pid!==id) peers[pid]={name:c.name,color:c.color,position:c.position}; });
  ws.send(JSON.stringify({type:'welcome',id,color,peers}));

  ws.on('message',raw=>{
    let msg; try{msg=JSON.parse(raw);}catch(_){return;}
    const c=clients.get(id); if(!c) return;
    if(msg.type==='hello'&&typeof msg.name==='string'){
      c.name=msg.name.slice(0,20);
      broadcast({type:'join',id,name:c.name,color:c.color},id);
    }
    if(msg.type==='position'&&msg.position?.lat){
      c.position=msg.position;
      broadcast({type:'pos',id,name:c.name,color:c.color,position:msg.position},id);
    }
    if(msg.type==='msg'&&msg.text?.trim()){
      broadcast({type:'msg',id,name:c.name,color:c.color,
                 text:msg.text.slice(0,500),time:new Date().toISOString()});
    }
  });

  ws.on('close',()=>{ console.log(`[WS-] ${clients.get(id)?.name||id}`); clients.delete(id); broadcast({type:'leave',id}); });
  ws.on('error',e=>console.error(`[WS!]`,e.message));
});

// ════════════════════════════════════════════════
//   QR EN CONSOLA (sin dependencias externas)
// ════════════════════════════════════════════════
function qrInConsole(text) {
  // Genera QR Mode Byte, EC Level M usando solo JS puro
  // Usa la librería qrcode-terminal si está disponible, si no imprime la URL
  try {
    const qrt = require('qrcode-terminal');
    qrt.generate(text, { small: true }, q => {
      console.log(q);
    });
  } catch(_) {
    // Sin qrcode-terminal: imprime URL grande para copiar
    console.log('  URL: ' + text);
    console.log('  (instala qrcode-terminal para ver QR: npm install qrcode-terminal)');
  }
}

// ════════════════════════════════════════════════
//   mDNS — nombre fijo en red local
// ════════════════════════════════════════════════
function startMDNS(port) {
  try {
    const bonjour = require('bonjour')();
    bonjour.publish({ name:'TrailTrack', type:'http', port });
    console.log(`  mDNS: http://trailtrack.local:${port}`);
  } catch(_) {
    console.log('  (instala bonjour para mDNS: npm install bonjour)');
  }
}

// ════════════════════════════════════════════════
//   START
// ════════════════════════════════════════════════
server.listen(PORT,'0.0.0.0',()=>{
  const ips=Object.values(require('os').networkInterfaces()).flat()
    .filter(i=>i.family==='IPv4'&&!i.internal).map(i=>i.address);
  const primaryIP = ips[0] || 'localhost';
  const appURL = `http://${primaryIP}:${PORT}`;

  console.log('\n═══════════════════════════════════════');
  console.log('  ◈ TRAILTRACK + NEON  ● ACTIVO');
  console.log('═══════════════════════════════════════');
  console.log(`  DB:  ${dbOk?'✓ Neon':'⚠ configurar DATABASE_URL'}`);
  ips.forEach(ip=>console.log(`  →  http://${ip}:${PORT}`));
  console.log('───────────────────────────────────────');
  console.log('  Escanea el QR con tu teléfono:\n');
  qrInConsole(appURL);
  console.log('───────────────────────────────────────');
  startMDNS(PORT);
  console.log('═══════════════════════════════════════\n');
});
server.on('error',e=>{ console.error('[!]',e.message); process.exit(1); });
