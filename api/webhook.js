const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const https = require('https');

// Firebase init
let db;
function getDB() {
  if (!db) {
    if (!getApps().length) {
      const fbRaw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
      const firebaseConfig = fbRaw.startsWith('{')
        ? JSON.parse(fbRaw)
        : JSON.parse(Buffer.from(fbRaw, 'base64').toString('utf8'));
      initializeApp({ credential: cert(firebaseConfig) });
    }
    db = getFirestore();
  }
  return db;
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function fmtMXN(n) {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

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

const MEMBERS = JSON.parse(process.env.MEMBERS || '{}');

async function getTipoCambio() {
  try {
    const snap = await getDB().collection('config').doc('settings').get();
    if (snap.exists && snap.data().tc) return snap.data().tc;
  } catch (e) {}
  return new Promise((resolve) => {
    https.get('https://open.er-api.com/v6/latest/USD', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.rates && json.rates.MXN) return resolve(parseFloat(json.rates.MXN.toFixed(4)));
        } catch (e) {}
        resolve(17.5);
      });
    }).on('error', () => resolve(17.5));
  });
}

async function getCats() {
  try {
    const snap = await getDB().collection('config').doc('settings').get();
    if (snap.exists && snap.data().cats) return snap.data().cats;
  } catch (e) {}
  return DEFAULT_CATS;
}

async function parseMessage(text, fromNumber) {
  const low = normalize(text.trim());
  const quien = MEMBERS[fromNumber] || 'yo';
  const tc = await getTipoCambio();

  if (low === 'resumen' || low === 'resumen mes') {
    const ym = new Date().toISOString().substring(0, 7);
    const snap = await getDB().collection('gastos').get();
    const gastos = snap.docs.map(d => d.data()).filter(g => g.fecha && g.fecha.startsWith(ym));
    const total = gastos.reduce((s, g) => s + (g.moneda === 'USD' ? g.monto * tc : g.monto), 0);
    const mes = new Date().toLocaleDateString('es-MX', { month: 'long' });
    return `📊 *Resumen ${mes}*\nGastos: ${fmtMXN(total)} MXN\nMovimientos: ${gastos.length}`;
  }

  if (low === 'borrar ultimo' || low === 'deshacer') {
    const snap = await getDB().collection('gastos').orderBy('__name__', 'desc').limit(1).get();
    if (snap.empty) return '❌ No hay gastos para borrar.';
    const last = { id: snap.docs[0].id, ...snap.docs[0].data() };
    await getDB().collection('gastos').doc(last.id).delete();
    return `🗑 Eliminado: ${fmtMXN(last.monto)} "${last.desc || ''}"`;
  }

  if (low === 'ayuda' || low === 'help' || low === '?') {
    return `💡 *Comandos:*\n\nComida 350 tacos\nTransporte 80 uber\nNetflix 15.99 USD\n\nresumen → total del mes\nborrar ultimo → borra el último`;
  }

  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return '🤔 No entendí. Ejemplo: *Comida 350 tacos*';

  const cats = await getCats();
  const catInput = normalize(parts[0]);
  const cat = cats.find(c => normalize(c.name).startsWith(catInput) || normalize(c.id) === catInput);
  const amt = parseFloat(parts[1]);

  if (!cat || isNaN(amt) || amt <= 0) {
    return `🤔 No reconocí *"${parts[0]}"*.\nCategorías: ${cats.map(c => c.name).join(', ')}`;
  }

  let moneda = 'MXN', descStart = 2;
  if (parts[2] && parts[2].toUpperCase() === 'USD') { moneda = 'USD'; descStart = 3; }
  const desc = parts.slice(descStart).join(' ') || 'sin descripción';

  await getDB().collection('gastos').add({ fecha: today(), quien, cat: cat.id, moneda, monto: amt, desc, origen: 'whatsapp' });

  const mxnDisplay = moneda === 'USD' ? ` (≈ ${fmtMXN(amt * tc)} MXN)` : '';
  const montoDisplay = moneda === 'MXN' ? fmtMXN(amt) : '$' + amt.toFixed(2) + ' USD';
  return `✅ *${cat.emoji} ${cat.name}*: ${montoDisplay}${mxnDisplay}\n"${desc}"\n_Por ${quien}_`;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.json({ status: 'ok', service: 'Casa Finanzas Bot webhook' });
  }

  const { Body, From } = req.body || {};
  if (!Body || !From) return res.status(400).send('Missing Body or From');

  try {
    const reply = await parseMessage(Body, From);
    res.setHeader('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error('Error:', err);
    res.setHeader('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>❌ Error. Intentá de nuevo.</Message></Response>`);
  }
};
