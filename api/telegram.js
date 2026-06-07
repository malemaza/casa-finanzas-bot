const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const https = require('https');

let db;
function getDB() {
  if (!db) {
    if (!getApps().length) {
      const fbRaw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
      const firebaseConfig = fbRaw.startsWith('{') ? JSON.parse(fbRaw) : JSON.parse(Buffer.from(fbRaw, 'base64').toString('utf8'));
      initializeApp({ credential: cert(firebaseConfig) });
    }
    db = getFirestore();
  }
  return db;
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

function sendMsg(chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

function today() { return new Date().toISOString().split('T')[0]; }
function norm(str) { return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
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

async function getCats() {
  try {
    const snap = await getDB().collection('config').doc('settings').get();
    if (snap.exists && snap.data().cats) return snap.data().cats;
  } catch (e) {}
  return DEFAULT_CATS;
}

async function getTC() {
  try {
    const snap = await getDB().collection('config').doc('settings').get();
    if (snap.exists && snap.data().tc) return snap.data().tc;
  } catch (e) {}
  return 17.5;
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  const from = msg.from;
  const nameRaw = from.first_name || from.username || 'desconocido';
  const nameDisplay = nameRaw.charAt(0).toUpperCase() + nameRaw.slice(1).toLowerCase();

  // Mapear nombre Telegram → ID miembro en Firebase
  const memberMap = JSON.parse(process.env.TELEGRAM_MEMBERS || '{}');
  const comunesId = memberMap['Comunes'] || 'Comunes';
  const quienId = memberMap[nameDisplay] || nameDisplay;

  const low = norm(text);
  const tc = await getTC();

  // /start o /ayuda
  if (text.startsWith('/') || low === 'ayuda' || low === 'help') {
    await sendMsg(chatId,
      '👋 <b>Casa Finanzas Bot</b>\n\n' +
      '<b>Registrar gasto:</b>\n' +
      '<code>Supermercado 1200 despensa</code>\n' +
      '<code>Salidas a comer 350 sushi</code>\n' +
      '<code>Netflix 15.99 USD streaming</code>\n' +
      '<code>Renta 15000 comun</code> → gasto compartido\n\n' +
      '<b>Registrar ingreso:</b>\n' +
      '<code>ingreso sueldo 31250</code>\n' +
      '<code>ingreso quincena 15000</code>\n' +
      '<code>ingreso proyecto 2000 USD freelance</code>\n' +
      '<code>ingreso otro 500 bono</code>\n\n' +
      '<b>Otros comandos:</b>\n' +
      '<code>resumen</code> → total del mes\n' +
      '<code>borrar ultimo</code> → borra el último gasto'
    );
    return;
  }

  // resumen
  if (low === 'resumen') {
    const ym = new Date().toISOString().substring(0, 7);
    const snap = await getDB().collection('gastos').get();
    const gastos = snap.docs.map(d => d.data()).filter(g => g.fecha && g.fecha.startsWith(ym));
    const total = gastos.reduce((s, g) => s + (g.moneda === 'USD' ? g.monto * tc : g.monto), 0);
    const mes = new Date().toLocaleDateString('es-MX', { month: 'long' });
    await sendMsg(chatId, `📊 <b>Resumen ${mes}</b>\nGastos: <b>${fmtMXN(total)} MXN</b>\nMovimientos: ${gastos.length}`);
    return;
  }

  // borrar ultimo
  if (low === 'borrar ultimo' || low === 'deshacer') {
    const snap = await getDB().collection('gastos').orderBy('__name__', 'desc').limit(1).get();
    if (snap.empty) { await sendMsg(chatId, '❌ No hay gastos para borrar.'); return; }
    const last = { id: snap.docs[0].id, ...snap.docs[0].data() };
    await getDB().collection('gastos').doc(last.id).delete();
    await sendMsg(chatId, `🗑 Eliminado: ${fmtMXN(last.monto)} "${last.desc || ''}"`);
    return;
  }

  // ingreso — formato: ingreso tipo monto [USD] descripcion
  if (low.startsWith('ingreso')) {
    const parts = text.trim().split(/\s+/);
    const TIPOS = { sueldo: 'sueldo', quincena: 'quincena', proyecto: 'proyecto', otro: 'otro' };
    const TIPO_ICONS = { sueldo: '💼 Sueldo', quincena: '📅 Quincena', proyecto: '🚀 Proyecto', otro: '📦 Otro' };
    const tipoInput = norm(parts[1] || '');
    const tipo = TIPOS[tipoInput] || 'otro';
    const amtIdx = TIPOS[tipoInput] ? 2 : 1;
    const amt = parseFloat(parts[amtIdx]);
    if (isNaN(amt) || amt <= 0) {
      await sendMsg(chatId,
        '❌ Formato correcto:\n' +
        '<code>ingreso sueldo 31250</code>\n' +
        '<code>ingreso quincena 15000</code>\n' +
        '<code>ingreso proyecto 2000 USD freelance</code>\n' +
        '<code>ingreso otro 500 bono</code>'
      );
      return;
    }
    let moneda = 'MXN', descStart = amtIdx + 1;
    if (parts[descStart] && parts[descStart].toUpperCase() === 'USD') { moneda = 'USD'; descStart++; }
    const desc = parts.slice(descStart).join(' ') || tipo;
    const mxnDisplay = moneda === 'USD' ? ` (≈ ${fmtMXN(amt * tc)} MXN)` : '';
    const montoDisplay = moneda === 'MXN' ? fmtMXN(amt) : '$' + amt.toFixed(2) + ' USD';
    await getDB().collection('ingresos').add({ quien: quienId, tipo, desc, fecha: today(), monto: amt, moneda, activo: true });
    await sendMsg(chatId, `💰 <b>Ingreso registrado</b>\n${TIPO_ICONS[tipo]}: ${montoDisplay}${mxnDisplay}\n"${desc}"\n<i>Por ${nameDisplay}</i>`);
    return;
  }

  // gasto — formato: Categoria monto [USD] descripcion [comun]
  const parts = text.trim().split(/\s+/);
  const cats = await getCats();
  let cat = null, amt = null, descStart = 0;

  for (let i = 1; i < parts.length; i++) {
    const maybeAmt = parseFloat(parts[i]);
    if (!isNaN(maybeAmt) && maybeAmt > 0) {
      const catInput = norm(parts.slice(0, i).join(' '));
      cat = cats.find(c => norm(c.name) === catInput)
        || cats.find(c => norm(c.name).startsWith(catInput))
        || cats.find(c => catInput.startsWith(norm(c.name)))
        || cats.find(c => norm(c.id) === catInput);
      if (cat) { amt = maybeAmt; descStart = i + 1; break; }
    }
  }

  if (!cat || !amt) {
    await sendMsg(chatId,
      '🤔 No reconocí la categoría.\n\n' +
      'Categorías disponibles:\n' +
      cats.map(c => (c.emoji || '') + ' ' + c.name).join('\n') +
      '\n\nEjemplo: <code>Supermercado 350 despensa</code>'
    );
    return;
  }

  let moneda = 'MXN';
  if (parts[descStart] && parts[descStart].toUpperCase() === 'USD') { moneda = 'USD'; descStart++; }

  // detectar gasto común
  let descParts = parts.slice(descStart);
  const lastWord = norm(descParts[descParts.length - 1] || '');
  let quienFinal = quienId;
  let esComun = false;
  if (lastWord === 'comun' || lastWord === 'compartido' || lastWord === 'comunes') {
    descParts = descParts.slice(0, -1);
    quienFinal = comunesId;
    esComun = true;
  }
  const desc = descParts.join(' ') || 'sin descripción';

  await getDB().collection('gastos').add({ fecha: today(), quien: quienFinal, cat: cat.id, moneda, monto: amt, desc, origen: 'telegram' });

  const mxnDisplay = moneda === 'USD' ? ` (≈ ${fmtMXN(amt * tc)} MXN)` : '';
  const montoDisplay = moneda === 'MXN' ? fmtMXN(amt) : '$' + amt.toFixed(2) + ' USD';
  const quienLabel = esComun ? '👫 Gasto común' : `Por ${nameDisplay}`;
  await sendMsg(chatId, `✅ <b>${cat.emoji || ''} ${cat.name}</b>: ${montoDisplay}${mxnDisplay}\n"${desc}"\n<i>${quienLabel}</i>`);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.json({ status: 'ok', service: 'Casa Finanzas Telegram Bot' });
  try {
    const { message } = req.body || {};
    if (message) await handleMessage(message);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error:', err);
    res.json({ ok: false });
  }
};
