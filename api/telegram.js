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

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

function sendTelegramMessage(chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

function today() { return new Date().toISOString().split('T')[0]; }
function normalize(str) { return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function fmtMXN(n) { return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

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

// Mapeo de usernames/IDs de Telegram a miembros
// Se completa automáticamente con el nombre de Telegram
async function getCats() {
  try {
    const snap = await getDB().collection('config').doc('settings').get();
    if (snap.exists && snap.data().cats) return snap.data().cats;
  } catch (e) {}
  return DEFAULT_CATS;
}

async function getTipoCambio() {
  try {
    const snap = await getDB().collection('config').doc('settings').get();
    if (snap.exists && snap.data().tc) return snap.data().tc;
  } catch (e) {}
  return 17.5;
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const from = msg.from;
  const quien = from.first_name || from.username || 'desconocido';

  if (!text || text.startsWith('/')) {
    if (text === '/start' || text === '/ayuda') {
      await sendTelegramMessage(chatId,
        '👋 <b>Casa Finanzas Bot</b>\n\n' +
        'Registrá gastos enviando:\n' +
        '<code>Categoría monto descripción</code>\n\n' +
        'Ejemplos:\n' +
        '<code>Supermercado 1200 despensa semanal</code>\n' +
        '<code>Salidas a comer 350 sushi</code>\n' +
        '<code>Combustible 800 carga completa</code>\n\n' +
        'Comandos:\n' +
        '<code>resumen</code> → total del mes\n' +
        '<code>borrar ultimo</code> → borra el último gasto'
      );
    }
    return;
  }

  const low = normalize(text);
  const tc = await getTipoCambio();

  // resumen
  if (low === 'resumen' || low === 'resumen mes') {
    const ym = new Date().toISOString().substring(0, 7);
    const snap = await getDB().collection('gastos').get();
    const gastos = snap.docs.map(d => d.data()).filter(g => g.fecha && g.fecha.startsWith(ym));
    const total = gastos.reduce((s, g) => s + (g.moneda === 'USD' ? g.monto * tc : g.monto), 0);
    const mes = new Date().toLocaleDateString('es-MX', { month: 'long' });
    await sendTelegramMessage(chatId,
      `📊 <b>Resumen ${mes}</b>\nGastos: <b>${fmtMXN(total)} MXN</b>\nMovimientos: ${gastos.length}`
    );
    return;
  }

  // borrar ultimo
  if (low === 'borrar ultimo' || low === 'deshacer') {
    const snap = await getDB().collection('gastos').orderBy('__name__', 'desc').limit(1).get();
    if (snap.empty) { await sendTelegramMessage(chatId, '❌ No hay gastos para borrar.'); return; }
    const last = { id: snap.docs[0].id, ...snap.docs[0].data() };
    await getDB().collection('gastos').doc(last.id).delete();
    await sendTelegramMessage(chatId, `🗑 Eliminado: ${fmtMXN(last.monto)} "${last.desc || ''}"`);
    return;
  }

  // registrar gasto
  const parts = text.split(/\s+/);
  const cats = await getCats();
  let cat = null, amt = null, descStart = 0;

  for (let i = 1; i < parts.length; i++) {
    const maybeAmt = parseFloat(parts[i]);
    if (!isNaN(maybeAmt) && maybeAmt > 0) {
      const catInput = normalize(parts.slice(0, i).join(' '));
      cat = cats.find(c => normalize(c.name) === catInput)
        || cats.find(c => normalize(c.name).startsWith(catInput))
        || cats.find(c => catInput.startsWith(normalize(c.name)))
        || cats.find(c => normalize(c.id) === catInput);
      if (cat) { amt = maybeAmt; descStart = i + 1; break; }
    }
  }

  if (!cat || !amt) {
    await sendTelegramMessage(chatId,
      '🤔 No reconocí la categoría.\n\n' +
      'Categorías disponibles:\n' +
      cats.map(c => (c.emoji || '') + ' ' + c.name).join('\n') +
      '\n\nEjemplo: <code>Supermercado 350 despensa</code>'
    );
    return;
  }

  let moneda = 'MXN';
  if (parts[descStart] && parts[descStart].toUpperCase() === 'USD') { moneda = 'USD'; descStart++; }

  // Detectar si es gasto común — última palabra es "comun" o "compartido"
  let descParts = parts.slice(descStart);
  const lastWord = normalize(descParts[descParts.length - 1] || '');
  let quienFinal = quien;
  if (lastWord === 'comun' || lastWord === 'compartido' || lastWord === 'comunes') {
    descParts = descParts.slice(0, -1); // sacar la última palabra
    quienFinal = 'Comunes';
  }
  const desc = descParts.join(' ') || 'sin descripción';

  await getDB().collection('gastos').add({
    fecha: today(), quien: quienFinal, cat: cat.id, moneda, monto: amt, desc, origen: 'telegram'
  });

  const mxnDisplay = moneda === 'USD' ? ` (≈ ${fmtMXN(amt * tc)} MXN)` : '';
  const montoDisplay = moneda === 'MXN' ? fmtMXN(amt) : '$' + amt.toFixed(2) + ' USD';
  const quienLabel = quienFinal === 'Comunes' ? '👫 Gasto común' : `Por ${quien}`;
  await sendTelegramMessage(chatId,
    `✅ <b>${cat.emoji || ''} ${cat.name}</b>: ${montoDisplay}${mxnDisplay}\n"${desc}"\n<i>${quienLabel}</i>`
  );
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.json({ status: 'ok', service: 'Telegram webhook' });
  try {
    const { message } = req.body;
    if (message) await handleMessage(message);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error:', err);
    res.json({ ok: false });
  }
};
