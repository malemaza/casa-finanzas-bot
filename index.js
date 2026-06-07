const express = require('express');
const bodyParser = require('body-parser');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Firebase Admin Init ──
const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(firebaseConfig) });
const db = getFirestore();

// ── Helpers ──
function today() {
  return new Date().toISOString().split('T')[0];
}

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Categorías por defecto — se sincronizan con las que están en Firebase config
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

// Mapeo de números de teléfono a miembros
// Formato: 'whatsapp:+5491112345678': 'yo' o 'marido'
const MEMBERS = JSON.parse(process.env.MEMBERS || '{}');
// Ej: { "whatsapp:+5491112345678": "yo", "whatsapp:+5491198765432": "marido" }

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

function fmtMXN(n) {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

async function parseMessage(text, fromNumber) {
  const low = normalize(text.trim());
  const quien = MEMBERS[fromNumber] || 'yo';

  // ── Comando: resumen ──
  if (low === 'resumen' || low === 'resumen mes') {
    const now = new Date();
    const ym = now.toISOString().substring(0, 7);
    const snap = await db.collection('gastos').get();
    const gastos = snap.docs.map(d => d.data()).filter(g => g.fecha && g.fecha.startsWith(ym));
    const total = gastos.reduce((s, g) => {
      const tc = parseFloat(process.env.TC || '17.5');
      return s + (g.moneda === 'USD' ? g.monto * tc : g.monto);
    }, 0);
    const mes = now.toLocaleDateString('es-MX', { month: 'long' });
    return `📊 *Resumen ${mes}*\nGastos: ${fmtMXN(total)} MXN\nMovimientos: ${gastos.length}`;
  }

  // ── Comando: borrar ultimo ──
  if (low === 'borrar ultimo' || low === 'deshacer') {
    const last = await getLastGasto();
    if (!last) return '❌ No hay gastos para borrar.';
    await db.collection('gastos').doc(last.id).delete();
    return `🗑 Eliminado: ${last.emoji || ''} ${fmtMXN(last.monto)} "${last.desc || ''}"`;
  }

  // ── Comando: ayuda ──
  if (low === 'ayuda' || low === 'help' || low === '?') {
    return `💡 *Comandos disponibles:*\n\n` +
      `*Registrar gasto:*\nComida 350 tacos del lunch\nTransporte 80 uber\nNetflix 15.99 USD streaming\n\n` +
      `*Otros:*\nresumen → total del mes\nborrar ultimo → borra el último\nayuda → este mensaje`;
  }

  // ── Parsear gasto: Categoría monto [USD] descripción ──
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    return '🤔 No entendí. Ejemplo: *Comida 350 tacos*\nEscribí *ayuda* para ver todos los comandos.';
  }

  const cats = await getCats();
  const catInput = normalize(parts[0]);
  const cat = cats.find(c =>
    normalize(c.name).startsWith(catInput) ||
    normalize(c.id) === catInput
  );

  const amt = parseFloat(parts[1]);

  if (!cat || isNaN(amt) || amt <= 0) {
    const catNames = cats.map(c => c.name).join(', ');
    return `🤔 No reconocí la categoría *"${parts[0]}"*.\n\nCategorías válidas:\n${catNames}\n\nEjemplo: *Comida 350 tacos*`;
  }

  let moneda = 'MXN';
  let descStart = 2;
  if (parts[2] && parts[2].toUpperCase() === 'USD') {
    moneda = 'USD';
    descStart = 3;
  }

  const desc = parts.slice(descStart).join(' ') || 'sin descripción';

  // Guardar en Firebase
  const gasto = {
    fecha: today(),
    quien,
    cat: cat.id,
    moneda,
    monto: amt,
    desc,
    origen: 'whatsapp',
  };

  await db.collection('gastos').add(gasto);

  const tc = parseFloat(process.env.TC || '17.5');
  const mxnDisplay = moneda === 'USD'
    ? ` (≈ ${fmtMXN(amt * tc)} MXN)`
    : '';

  return `✅ *Registrado*\n${cat.emoji} ${cat.name}: ${moneda === 'MXN' ? fmtMXN(amt) : '$' + amt.toFixed(2) + ' USD'}${mxnDisplay}\n"${desc}"\n_Registrado por ${quien}_`;
}

// ── Webhook Twilio ──
app.post('/webhook', async (req, res) => {
  const { Body, From } = req.body;

  if (!Body || !From) {
    return res.status(400).send('Missing Body or From');
  }

  console.log(`Message from ${From}: ${Body}`);

  try {
    const reply = await parseMessage(Body, From);

    // Respuesta en formato TwiML
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${reply}</Message>
</Response>`;

    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('Error processing message:', err);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>❌ Hubo un error. Intentá de nuevo.</Message>
</Response>`;
    res.type('text/xml').send(twiml);
  }
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Casa Finanzas WhatsApp Bot' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot corriendo en puerto ${PORT}`);
});
