const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
 
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
 
// ── Firebase Admin Init ──
const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(firebaseConfig) });
const db = getFirestore();
 
// ── Tipo de cambio — se actualiza automáticamente cada hora ──
let cachedTC = 17.5;
let lastTCFetch = 0;
 
async function getTipoCambio() {
  const now = Date.now();
  // Actualizar solo si pasó más de 1 hora
  if (now - lastTCFetch < 60 * 60 * 1000) return cachedTC;
 
  try {
    // Primero intentar leer el TC guardado en Firebase (el que actualiza la app)
    const snap = await db.collection('config').doc('settings').get();
    if (snap.exists && snap.data().tc) {
      cachedTC = snap.data().tc;
      lastTCFetch = now;
      console.log(`TC desde Firebase: ${cachedTC}`);
      return cachedTC;
    }
  } catch (e) {}
 
  // Si no hay en Firebase, llamar a la API directamente
  return new Promise((resolve) => {
    https.get('https://open.er-api.com/v6/latest/USD', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.rates && json.rates.MXN) {
            cachedTC = parseFloat(json.rates.MXN.toFixed(4));
            lastTCFetch = now;
            console.log(`TC desde API: ${cachedTC}`);
          }
        } catch (e) {}
        resolve(cachedTC);
      });
    }).on('error', () => resolve(cachedTC));
  });
}
 
// ── Helpers ──
function today() {
  return new Date().toISOString().split('T')[0];
}
 
function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
 
function fmtMXN(n) {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
 
// Categorías por defecto
const DEFAULT_CATS = [
  { id: 'hogar', name: 'Hogar', emoji: '🏠' },
  { id: 'comida', name: 'Comida', emoji: '🍽️' },
  { id: 'transporte', name: 'Transporte', emoji: '🚗' },
  { id: 'salud', name: 'Salud', emoji: '💊' },
  { id: 'entret', name: 'Entretenimiento', emoji: '🎬' },
  { id: 'educacion', name: 'Educación', emoji: '📚' },
  { id: 'ropa', name: 'Ropa', emoji: '👗' },
  { id: 'subs', name: 'Subscripciones', emoji: '📱' },
  { id: 'otros', name: 'Otros', emoji: '📦' },
];
 
// Mapeo de números a miembros
const MEMBERS = JSON.parse(process.env.MEMBERS || '{}');
 
async function getCats() {
  try {
    const snap = await db.collection('config').doc('settings').get();
    if (snap.exists && snap.data().cats) return snap.data().cats;
  } catch (e) {}
  return DEFAULT_CATS;
}
 
async function getLastGasto() {
  const snap = await db.collection('gastos')
    .orderBy('__name__', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}
 
async function parseMessage(text, fromNumber) {
  const low = normalize(text.trim());
  const quien = MEMBERS[fromNumber] || 'yo';
  const tc = await getTipoCambio();
 
  // ── resumen ──
  if (low === 'resumen' || low === 'resumen mes') {
    const now = new Date();
    const ym = now.toISOString().substring(0, 7);
    const snap = await db.collection('gastos').get();
    const gastos = snap.docs.map(d => d.data()).filter(g => g.fecha && g.fecha.startsWith(ym));
    const total = gastos.reduce((s, g) => s + (g.moneda === 'USD' ? g.monto * tc : g.monto), 0);
    const mes = now.toLocaleDateString('es-MX', { month: 'long' });
    return `📊 *Resumen ${mes}*\nGastos: ${fmtMXN(total)} MXN\nMovimientos: ${gastos.length}\nTC: $${tc} MXN/USD`;
  }
 
  // ── borrar ultimo ──
  if (low === 'borrar ultimo' || low === 'deshacer') {
    const last = await getLastGasto();
    if (!last) return '❌ No hay gastos para borrar.';
    await db.collection('gastos').doc(last.id).delete();
    return `🗑 Eliminado: ${last.emoji || ''} ${fmtMXN(last.monto)} "${last.desc || ''}"`;
  }
 
  // ── ayuda ──
  if (low === 'ayuda' || low === 'help' || low === '?') {
    return `💡 *Comandos:*\n\nComida 350 tacos\nTransporte 80 uber\nNetflix 15.99 USD streaming\n\nresumen → total del mes\nborrar ultimo → borra el último\nayuda → este mensaje\n\nTC actual: $${tc} MXN/USD`;
  }
 
  // ── registrar gasto ──
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    return '🤔 No entendí. Ejemplo: *Comida 350 tacos*\nEscribí *ayuda* para ver comandos.';
  }
 
  const cats = await getCats();
  const catInput = normalize(parts[0]);
  const cat = cats.find(c =>
    normalize(c.name).startsWith(catInput) || normalize(c.id) === catInput
  );
  const amt = parseFloat(parts[1]);
 
  if (!cat || isNaN(amt) || amt <= 0) {
    const catNames = cats.map(c => c.name).join(', ');
    return `🤔 No reconocí *"${parts[0]}"*.\n\nCategorías: ${catNames}\n\nEjemplo: *Comida 350 tacos*`;
  }
 
  let moneda = 'MXN';
  let descStart = 2;
  if (parts[2] && parts[2].toUpperCase() === 'USD') {
    moneda = 'USD';
    descStart = 3;
  }
 
  const desc = parts.slice(descStart).join(' ') || 'sin descripción';
 
  await db.collection('gastos').add({
    fecha: today(),
    quien,
    cat: cat.id,
    moneda,
    monto: amt,
    desc,
    origen: 'whatsapp',
  });
 
  const mxnDisplay = moneda === 'USD' ? ` (≈ ${fmtMXN(amt * tc)} MXN)` : '';
  const montoDisplay = moneda === 'MXN' ? fmtMXN(amt) : '$' + amt.toFixed(2) + ' USD';
 
  return `✅ *${cat.emoji} ${cat.name}*: ${montoDisplay}${mxnDisplay}\n"${desc}"\n_Por ${quien}_`;
}
 
// ── Webhook Twilio ──
app.post('/webhook', async (req, res) => {
  const { Body, From } = req.body;
  if (!Body || !From) return res.status(400).send('Missing Body or From');
 
  console.log(`[${new Date().toISOString()}] ${From}: ${Body}`);
 
  try {
    const reply = await parseMessage(Body, From);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error('Error:', err);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>❌ Hubo un error. Intentá de nuevo.</Message></Response>`);
  }
});
 
// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Casa Finanzas Bot', tc: cachedTC });
});
 
// Precalentar el TC al iniciar
getTipoCambio().then(tc => console.log(`Bot iniciado. TC: $${tc} MXN/USD`));
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
 
