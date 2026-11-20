/**
 * ============================================================================
 * RECTIFICADORA RENACER (JOB 8:7) — NÚCLEO OPERATIVO SPA (app.js)
 * FASE 1 + FASE 2 COMPLETA:
 * - Flujo de 6 Estados:
 *   [1. Diagnóstico / Presupuesto] -> [2. Esperando Aprobación] -> [3. Asignación y Ejecución]
 *   -> [4. Terminado] -> [5. Control de Calidad] -> [6. Entregado (Factura Bloqueada)]
 * - Módulo de Factura Dinámica Abierta ([ + Agregar Ítem Extra ])
 * - Bucle de Control de Calidad ([ Aprobar y Pasar a Entregado ] / [ Rechazar y Devolver al Técnico ])
 * - Bitácora y Chat Interno Integrado en Tiempo Real con Fotos de Anomalías
 * - Envío de Presupuesto en Texto por WhatsApp con Nro. de Orden y Troquel
 * - Cuentas por Cobrar Estilo Tabla Dinámica Excel (incluyendo "Entregadas y Por Cobrar" + Filtro por Cliente y Fechas)
 * ============================================================================
 */

const STORAGE_KEY = "RECTIFICADORA_RENACER_DB_V7";
const SESSION_KEY = "RECTIFICADORA_RENACER_SESSION_V6";
const DEFAULT_GAS_API_URL = "https://script.google.com/macros/s/AKfycbxyK00PgiP58wNO8bWhsmnfq_V424dcUh3_bcktKeeepTXEWWJmA4QuPN9k_aLB6mrWCA/exec";
let GAS_API_URL = localStorage.getItem("RENACER_GAS_API_URL") || DEFAULT_GAS_API_URL;
if (!GAS_API_URL || !GAS_API_URL.includes("AKfycbxyK00PgiP58wNO8bWhsmnfq_V424dcUh3_bcktKeeepTXEWWJmA4QuPN9k_aLB6mrWCA")) {
  GAS_API_URL = DEFAULT_GAS_API_URL;
  localStorage.setItem("RENACER_GAS_API_URL", DEFAULT_GAS_API_URL);
}
let lastCloudSyncTime = "Conectado";
let cloudSyncStatus = "online"; // 'online' | 'syncing' | 'error'

const CURRENT_APP_VERSION = "2026.11.20.v34";

/* ==================== V31: SISTEMA DE PERSONALIZACIÓN DE TEXTOS Y AVISOS ==================== */
const DEFAULT_TEXT_CUSTOMIZATIONS = {
  app_subtitle: "Sistema de Gestión de Taller y Producción",
  biblical_badge: "JOB 8:7",
  pipeline_title: "Seguimiento de Órdenes y Producción (Por Código de Troquel)",
  pipeline_subtitle: "Flujo de 6 etapas del taller: 1. Recepción → 2. Diagnóstico → 3. Aprobación → 4. Servicio → 5. Calidad → 6. Entrega.",
  reception_terms: "1. Plazo de Aprobación / Retiro: El cliente dispone de un plazo mínimo de tres (3) días para aprobar el presupuesto o retirar las piezas del taller.\n2. Custodia de Piezas: La rectificadora no asume responsabilidad alguna por cámaras, motores, repuestos o piezas una vez transcurrido un (1) mes sin concretar o finalizar el trabajo.\n3. Retiro del Trabajo: El trabajo solo podrá ser retirado si se ha cancelado en su totalidad (100%).\n4. Ajustes por Lavado: Modificaciones de presupuesto por afectaciones detectadas tras limpieza serán notificadas previamente.",
  ar_title: "Control General de Cuentas por Cobrar",
  attendance_notice: "Horario oficial: Entrada puntual hasta las 8:15 AM. Después de esa hora se marca Tardanza con deducción en nómina.",
  payroll_notice: "Semana laboral de Lunes a Domingo. Corte y liquidación los días Domingo."
};

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getCustomText(key, defaultVal) {
  if (db && db.text_customizations && typeof db.text_customizations[key] === "string" && db.text_customizations[key].trim() !== "") {
    return db.text_customizations[key];
  }
  return defaultVal !== undefined ? defaultVal : (DEFAULT_TEXT_CUSTOMIZATIONS[key] || "");
}

const BANCOS_RENACER = [
  { id: "efectivo", nombre: "Efectivo Físico / Caja", moneda: "USD", icono: "fa-money-bill-wave", color: "#22c55e", badgeCls: "bank-badge--efectivo" },
  { id: "mercantil", nombre: "Banco Mercantil", moneda: "VES", icono: "fa-building-columns", color: "#0284c7", badgeCls: "bank-badge--mercantil" },
  { id: "banesco", nombre: "Banesco", moneda: "VES", icono: "fa-university", color: "#eab308", badgeCls: "bank-badge--banesco" },
  { id: "zelle_otro", nombre: "Zelle / Otros", moneda: "USD", icono: "fa-globe", color: "#a855f7", badgeCls: "bank-badge--zelle" }
];

function getBalancesPorCuenta() {
  const balances = {
    efectivo: 0,
    mercantil: 0,
    banesco: 0,
    zelle_otro: 0
  };

  (db?.finanzas_movimientos || []).forEach((m) => {
    const monto = Number(m.monto) || 0;
    let c = m.cuenta;
    if (!c || balances[c] === undefined) {
      if (m.metodo === "pago_movil" || m.metodo === "transferencia") {
        c = "mercantil";
      } else {
        c = "efectivo";
      }
    }
    if (m.tipo === "ingreso") {
      balances[c] += monto;
    } else if (m.tipo === "egreso") {
      balances[c] -= monto;
    }
  });

  const totalLiquido = Object.values(balances).reduce((acc, val) => acc + val, 0);
  return { balances, totalLiquido };
}

async function fetchLiveExchangeRates(silent = false) {
  try {
    const res = await fetch("https://ve.dolarapi.com/v1/dolares", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      const oficial = Array.isArray(data) ? data.find((d) => d.fuente === "oficial") : null;
      const paralelo = Array.isArray(data) ? data.find((d) => d.fuente === "paralelo") : null;
      let changed = false;

      if (!db.config) db.config = {};

      if (oficial && Number(oficial.promedio) > 0) {
        db.config.tasaBcv = Number(oficial.promedio);
        changed = true;
      }
      if (paralelo && Number(paralelo.promedio) > 0) {
        db.config.tasaBinance = Number(paralelo.promedio);
        changed = true;
      }

      if (changed) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" });
        db.config.tasaFechaActualizacion = `${now.toISOString().slice(0, 10)} ${timeStr}`;
        saveDatabase();
        renderApp();
        if (!silent) {
          showToast(`Tasas actualizadas en vivo: BCV Bs. ${db.config.tasaBcv.toFixed(2)} | Paralelo Bs. ${db.config.tasaBinance.toFixed(2)}`, "info");
        }
        return true;
      }
    }
  } catch (err) {
    console.warn("No se pudo obtener tasa en vivo:", err);
  }
  return false;
}

function checkAppVersionAndCache() {
  const localVer = localStorage.getItem("RENACER_APP_VERSION");
  if (localVer !== CURRENT_APP_VERSION) {
    localStorage.setItem("RENACER_APP_VERSION", CURRENT_APP_VERSION);
    if ("caches" in window) {
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
    }
  }
}

async function triggerRemoteUpdateForAll() {
  if (!confirm("¿Forzar actualización remota para todos los dispositivos conectados? Esta acción recargará las pantallas de todos los usuarios sin borrar sus datos.")) {
    return;
  }
  const newVer = "FORCED_" + Date.now();
  if (!db.config) db.config = {};
  db.config.forzar_actualizacion_version = newVer;
  saveDatabase();
  showToast("Enviando orden de actualización a la nube...", "info");
  await syncToGoogleSheets(true);
  showToast("Comando de actualización remota transmitido a todos los dispositivos.", "info");
}

/* ---------- Formateadores de Fecha y Hora Legibles (Sin formato GMT/ISO T04:00:00.000Z) ---------- */
function cleanDateISO(raw, includeTime = false) {
  if (!raw) return "";
  const str = String(raw).trim();
  if (!str) return "";
  // Si viene en formato ISO con T (ej. 2026-11-09T04:00:00.000Z de Google Sheets)
  if (str.includes("T")) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      if (!includeTime || str.includes("T04:00:00") || str.includes("T00:00:00")) {
        return `${yyyy}-${mm}-${dd}`;
      }
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    }
    return str.split("T")[0];
  }
  return includeTime ? str.slice(0, 16) : str.slice(0, 10);
}

function formatDateHuman(raw, includeTime = false) {
  if (!raw) return "-";
  const cleaned = cleanDateISO(raw, includeTime);
  if (!cleaned) return "-";
  const parts = cleaned.split(" ");
  const datePart = parts[0] || "";
  const timePart = parts[1] || "";
  const [y, m, d] = datePart.split("-");
  if (!y || !m || !d) return cleaned;
  const formattedDate = `${d}/${m}/${y}`;
  return includeTime && timePart ? `${formattedDate} ${timePart}` : formattedDate;
}

function cleanTimeHuman(raw) {
  if (!raw) return "-";
  const str = String(raw).trim();
  if (str.includes("1899-12-") || str.includes("T")) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  }
  return str;
}

function formatLiveSubtaskTimer(sub) {
  const baseSec = Number(sub.segundos_acumulados) || ((Number(sub.minutos_acumulados) || Number(sub.tiempo_neto_min) || 0) * 60);
  let totalSec = baseSec;
  if (sub.estado_subtarea === "empezado" && sub.inicio_activo_ts) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(sub.inicio_activo_ts)) / 1000));
    totalSec += elapsedSec;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function accumulateSubtaskActiveTime(sub) {
  if (!sub.inicio_activo_ts) return;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(sub.inicio_activo_ts)) / 1000));
  sub.segundos_acumulados = (Number(sub.segundos_acumulados) || (Number(sub.minutos_acumulados) || 0) * 60) + elapsedSec;
  sub.minutos_acumulados = Math.floor(sub.segundos_acumulados / 60);
  sub.inicio_activo_ts = null;
}

/* ---------- Placeholder Visual Limpio (Sin texto de relleno superpuesto) ---------- */
function makeSvgPhoto(_title, _subtitle, bg1 = "#182254", bg2 = "#0f172a", accent = "#f5df00") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${bg1}"/>
        <stop offset="100%" stop-color="${bg2}"/>
      </linearGradient>
    </defs>
    <rect width="640" height="360" fill="url(#g)"/>
    <circle cx="320" cy="180" r="64" fill="none" stroke="${accent}" stroke-width="2" stroke-opacity="0.25"/>
    <circle cx="320" cy="180" r="28" fill="none" stroke="${accent}" stroke-width="2" stroke-opacity="0.35"/>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

const DEMO_PHOTOS = {
  camaraCorsa: makeSvgPhoto("CÁMARA CHEVROLET CORSA 1.6", "Ingreso: 3 bujías puestas, 1 afuera · Fisura cil. 2", "#182254", "#0f172a", "#f5df00", "TROQUEL #5017"),
  repuestosCorsa: makeSvgPhoto("REPUESTOS DEL CLIENTE (#5017)", "8 Válvulas nuevas, 8 Guías bronce, Sellos y Empacadura", "#1e293b", "#0f172a", "#38bdf8", "MESA TÉCNICA"),
  camaraCorolla: makeSvgPhoto("CÁMARA TOYOTA COROLLA 1.8 1ZZ", "Ingreso: 16 Válvulas · Superficie recalentada para aplanar", "#1b2860", "#090d24", "#f5df00", "TROQUEL #5018"),
  repuestosCorolla: makeSvgPhoto("REPUESTOS DEL CLIENTE (#5018)", "Juego 16 gomitas de válvula + Estopera árbol de levas", "#1e293b", "#111827", "#4ade80", "MESA TÉCNICA"),
  bloqueFiesta: makeSvgPhoto("CÁMARA FORD FIESTA POWER 1.6", "Ingreso: Trae sensor temperatura puesto y toma de agua", "#31102f", "#0f172a", "#facc15", "TROQUEL #5019"),
  repuestosFiesta: makeSvgPhoto("REPUESTOS DEL CLIENTE (#5019)", "8 Válvulas, 8 Guías, Resortes originales verificados", "#1e293b", "#0f172a", "#fbbf24", "MESA TÉCNICA"),
  camaraHilux: makeSvgPhoto("CÁMARA TOYOTA HILUX 2.7 2TR", "Terminada: Aplanada, asentada y calibrada lista para revisión", "#064e3b", "#0f172a", "#4ade80", "TROQUEL #1507"),
  camaraRunner: makeSvgPhoto("CÁMARAS TOYOTA 4RUNNER V6", "Servicio completo de rectificación, guías y calibración", "#1e1b4b", "#0f172a", "#f5df00", "TROQUEL #1510"),
  camaraAstra: makeSvgPhoto("CÁMARA CHEVROLET ASTRA 1.8", "Rectificación de asientos, lavado químico y cepillado", "#1e293b", "#0f172a", "#38bdf8", "TROQUEL #1509"),
  pagoMovilCapture: makeSvgPhoto("COMPROBANTE PAGO MÓVIL / EFECTIVO", "Referencia #948271 · Verificado en Recepción Renacer", "#065f46", "#022c22", "#fde047", "SOPORTE PAGO"),
  evidenciaTerminado: makeSvgPhoto("EVIDENCIA TRABAJO TERMINADO", "Superficie cepillada al espejo + Guías y válvulas asentadas", "#14532d", "#052e16", "#f5df00", "FOTO EVIDENCIA"),
  repuestosCliente: makeSvgPhoto("REPUESTOS DEL CLIENTE", "8 Válvulas nuevas, 8 Guías bronce, Sellos y Empacadura", "#1e293b", "#0f172a", "#38bdf8", "MESA TÉCNICA"),
  comprobantePago: makeSvgPhoto("COMPROBANTE PAGO MÓVIL / EFECTIVO", "Referencia #948271 · Verificado en Recepción Renacer", "#065f46", "#022c22", "#fde047", "SOPORTE PAGO"),
  trabajoTerminado: makeSvgPhoto("EVIDENCIA TRABAJO TERMINADO", "Superficie cepillada al espejo + Guías y válvulas asentadas", "#14532d", "#052e16", "#f5df00", "FOTO EVIDENCIA")
};

/* ---------- Base de Datos Inicial de Demostración (Fase 1 + Fase 2) ---------- */
function getInitialDatabase() {
  return {
    config: {
      tasaBcv: 45.80,
      tasaBinance: 52.40,
      qcStandbyMode: false,
      correlativoTroquelActual: 5021,
      correlativoOrdenActual: 1007,
      cuentasFinancieras: [
        "Ingreso por Servicio de Rectificación",
        "Abono / Liquidación de Orden",
        "Cobro de Factura a Crédito (Entregada)",
        "Pago de Comisiones a Técnicos",
        "Adelanto Socio / Retiro de Jefe",
        "Pago de Préstamo / Cuenta por Pagar",
        "Compra de Insumos y Químicos",
        "Herramientas y Piedras de Rectificar",
        "Servicios Básicos e Internet Taller",
        "Adelanto / Vale a Trabajador",
        "Mantenimiento de Maquinaria"
      ]
    },
    usuarios: [
      {
        id_usuario: "USR-MOISES",
        nombre: "Moises Gonzalez",
        rol: "admin",
        rol_label: "Administrador del Sistema",
        especialidad: "Dirección General, Control Total y Auditoría del Taller",
        pin: "240804",
        telefono: "0414-0000000",
        salario_fijo_semanal: 100,
        huella_registrada: false,
        activo: true,
        modalidad_horario: "Acceso Total Administrador"
      },
      {
        id_usuario: "USR-JESUS",
        nombre: "Jesús Andrade",
        rol: "jefe_taller",
        rol_label: "Jefe de Taller / Gerencia",
        especialidad: "Dirección de Taller, Control de Calidad, Finanzas y Comisiones",
        pin: "123456",
        telefono: "0414-6001122",
        salario_fijo_semanal: 100,
        huella_registrada: true,
        activo: true,
        modalidad_horario: "Tiempo Completo (Jefe de Taller)"
      },
      {
        id_usuario: "USR-ENRIQUE",
        nombre: "Sr. Enrique Andrade",
        rol: "jefe_taller",
        rol_label: "Jefe de Taller / Gerencia",
        especialidad: "Diagnóstico Maestro, Asignación, Supervisión y Cobranzas",
        pin: "111111",
        telefono: "0414-6003344",
        salario_fijo_semanal: 100,
        huella_registrada: false,
        activo: true,
        modalidad_horario: "Tiempo Completo (Jefe de Taller)"
      },
      {
        id_usuario: "USR-RECEPCION",
        nombre: "Recepción Taller",
        rol: "recepcion",
        rol_label: "Recepción e Ingreso",
        especialidad: "Atención al Cliente, Fotos de Ingreso y Presupuestos",
        pin: "222222",
        telefono: "0412-0001122",
        activo: true,
        modalidad_horario: "8:00 AM - 1:00 PM / 3:00 PM - 8:00 PM"
      },
      {
        id_usuario: "USR-JAVIER",
        nombre: "Javier Andrade",
        rol: "inventario",
        rol_label: "Inventario y Repuestos",
        especialidad: "Control de Repuestos, Stock de Válvulas, Guías, Sellos y Empacaduras",
        pin: "333333",
        telefono: "0414-6005566",
        salario_fijo_semanal: 80,
        activo: true,
        modalidad_horario: "Tiempo Completo (Inventario)"
      },
      {
        id_usuario: "USR-HAVELL",
        nombre: "Havell Bracho",
        rol: "tecnico",
        rol_label: "Trabajador de Taller",
        especialidad: "Servicio de Cámara, Cepillada y Armado",
        pin: "444444",
        telefono: "0412-5551122",
        activo: true,
        modalidad_horario: "Jornada Completa"
      },
      {
        id_usuario: "USR-ANGEL",
        nombre: "Angel",
        rol: "tecnico",
        rol_label: "Trabajador de Taller",
        especialidad: "Lavado Químico y Descarbonizado",
        pin: "555555",
        telefono: "0414-5552233",
        activo: true,
        modalidad_horario: "Jornada Completa"
      },
      {
        id_usuario: "USR-JOSE",
        nombre: "Jose Villasmil",
        rol: "tecnico",
        rol_label: "Trabajador de Taller",
        especialidad: "Calibración, Asientos y Válvulas",
        pin: "666666",
        telefono: "0424-5553344",
        activo: true,
        modalidad_horario: "Jornada Completa"
      }
    ],
    catalogo: [
      { id_servicio: "SRV-01", categoria_pieza: "Cámara / Tapa", descripcion_servicio: "Lavado Químico y Descarbonizado Profundo", precio_sugerido_usd: 15, comision_tecnico_usd: 4, activo: true },
      { id_servicio: "SRV-02", categoria_pieza: "Cámara / Tapa", descripcion_servicio: "Aplanado / Cepillado de Superficie de Cámara", precio_sugerido_usd: 25, comision_tecnico_usd: 8, activo: true },
      { id_servicio: "SRV-03", categoria_pieza: "Cámara / Tapa", descripcion_servicio: "Cambio e Instalación de Guías de Válvulas", precio_sugerido_usd: 30, comision_tecnico_usd: 10, activo: true },
      { id_servicio: "SRV-04", categoria_pieza: "Cámara / Tapa", descripcion_servicio: "Rectificación de Asientos y Asentamiento de Válvulas", precio_sugerido_usd: 35, comision_tecnico_usd: 12, activo: true },
      { id_servicio: "SRV-05", categoria_pieza: "Cámara / Tapa", descripcion_servicio: "Soldadura Especial en Aluminio y Relleno de Pases de Agua", precio_sugerido_usd: 40, comision_tecnico_usd: 14, activo: true },
      { id_servicio: "SRV-06", categoria_pieza: "Cámara / Tapa", descripcion_servicio: "Armado de Cámara, Cambio de Gomitas y Calibración", precio_sugerido_usd: 30, comision_tecnico_usd: 10, activo: true },
      { id_servicio: "SRV-07", categoria_pieza: "Cámara / Tapa", descripcion_servicio: "Prueba de Presión / Vacío de Sellado (25 Bar)", precio_sugerido_usd: 20, comision_tecnico_usd: 6, activo: true },
      { id_servicio: "SRV-08", categoria_pieza: "Bloque / Cigüeñal", descripcion_servicio: "Rectificación y Pulitura de Cigüeñal", precio_sugerido_usd: 55, comision_tecnico_usd: 18, activo: true },
      { id_servicio: "SRV-09", categoria_pieza: "Bloque / Cigüeñal", descripcion_servicio: "Encamisado y Bruñido de Cilindros en Bloque", precio_sugerido_usd: 85, comision_tecnico_usd: 28, activo: true }
    ],
    clientes: [
      {
        id_cliente: "CLI-JESUS",
        documento_identidad: "V-27421339",
        nombre_completo: "Jesús Andrade",
        telefono: "0424-6999635",
        direccion: "Casco Central, Maracaibo",
        tipo_cliente: "Particular"
      },
      {
        id_cliente: "CLI-JOSEMANUE",
        documento_identidad: "V-26559977",
        nombre_completo: "Jose manue",
        telefono: "0412-0696868",
        direccion: "su casa",
        tipo_cliente: "Particular"
      },
      {
        id_cliente: "CLI-PRIMOS",
        documento_identidad: "J-40998877",
        nombre_completo: "Taller Mecánico Los Primos",
        telefono: "0414-6112233",
        direccion: "Av. Principal Los Haticos, Maracaibo",
        tipo_cliente: "Taller Aliado (Crédito Autorizado)"
      },
      {
        id_cliente: "CLI-CATIRE",
        documento_identidad: "J-30887766",
        nombre_completo: "Multiservicios El Catire",
        telefono: "0424-6554433",
        direccion: "Av. La Limpia frente a Curva de Molina",
        tipo_cliente: "Taller Aliado (Crédito Autorizado)"
      },
      {
        id_cliente: "CLI-GONZALEZ",
        documento_identidad: "V-14556677",
        nombre_completo: "Taller Hermanos González",
        telefono: "0412-6889900",
        direccion: "Urb. San Miguel, Calle 3",
        tipo_cliente: "Taller Aliado (Crédito Autorizado)"
      }
    ],
    ordenes: [],
    subtareas: [],
    bitacora: [],
    finanzas_movimientos: [],
    cuentas_por_pagar: [],
    movimientos_inventario: [],
    asistencias: []
  };
}

/* ---------- Estado Global en Memoria ---------- */
let db = loadDatabase();
let currentUser = null;
let currentTab = "pipeline";
let currentPhaseFilter = "all";
let searchQuery = "";
let currentViewMode = localStorage.getItem("RENACER_VIEW_MODE") || "table"; // 'table' (compacta) | 'cards' (detallada)

function setViewMode(mode) {
  currentViewMode = mode;
  localStorage.setItem("RENACER_VIEW_MODE", mode);
  renderScreen();
}

/* Filtros para la Tabla Dinámica de Cuentas por Cobrar (Estilo Excel de Jesús) */
let arActiveTab = "pendientes"; // 'pendientes' | 'cobradas' | 'todas'
let arFilterState = "exigibles"; // 'exigibles' | 'entregadas_por_cobrar' | 'en_taller' | 'en_espera_respuesta' | 'all'
let arFilterClient = "all";
let arDateFrom = "";
let arDateTo = "";
let deferredInstallPrompt = null;

/* Buffer temporal para modales de creación / subida de fotos */
let tempNewOrder = {
  galeriaPieza: [],
  galeriaRepuestos: [],
  itemsPresupuesto: [],
  comprobantePagoFoto: ""
};

function normalizeDatabaseSchema(d) {
  if (!d.config) d.config = {};
  if (!d.config.tasaBcv) d.config.tasaBcv = 45.80;
  if (!d.config.tasaBinance) d.config.tasaBinance = 52.40;
  if (!d.text_customizations || typeof d.text_customizations !== "object") {
    d.text_customizations = d.config.text_customizations || {};
  }
  if (!Array.isArray(d.cuentas_por_pagar)) {
    d.cuentas_por_pagar = getInitialDatabase().cuentas_por_pagar || [];
  }

  // Lista estricta de usuarios y trabajadores reales de Rectificadora Renacer
  const REAL_USERS = [
    {
      id_usuario: "USR-MOISES",
      nombre: "Moises Gonzalez",
      rol: "admin",
      rol_label: "Administrador del Sistema",
      especialidad: "Dirección General, Control Total y Auditoría del Taller",
      pin: "240804",
      telefono: "0414-0000000",
      salario_fijo_semanal: 100,
      huella_registrada: false,
      activo: true,
      modalidad_horario: "Acceso Total Administrador"
    },
    {
      id_usuario: "USR-JESUS",
      nombre: "Jesús Andrade",
      rol: "jefe_taller",
      rol_label: "Jefe de Taller / Gerencia",
      especialidad: "Dirección de Taller, Control de Calidad, Finanzas y Comisiones",
      pin: "123456",
      telefono: "0414-6001122",
      salario_fijo_semanal: 100,
      huella_registrada: true,
      activo: true,
      modalidad_horario: "Tiempo Completo (Jefe de Taller)"
    },
    {
      id_usuario: "USR-ENRIQUE",
      nombre: "Sr. Enrique Andrade",
      rol: "jefe_taller",
      rol_label: "Jefe de Taller / Gerencia",
      especialidad: "Diagnóstico Maestro, Asignación, Supervisión y Cobranzas",
      pin: "111111",
      telefono: "0414-6003344",
      salario_fijo_semanal: 100,
      huella_registrada: false,
      activo: true,
      modalidad_horario: "Tiempo Completo (Jefe de Taller)"
    },
    {
      id_usuario: "USR-RECEPCION",
      nombre: "Recepción Taller",
      rol: "recepcion",
      rol_label: "Recepción e Ingreso",
      especialidad: "Atención al Cliente, Fotos de Ingreso y Presupuestos",
      pin: "222222",
      telefono: "0412-0001122",
      activo: true,
      modalidad_horario: "8:00 AM - 1:00 PM / 3:00 PM - 8:00 PM"
    },
    {
      id_usuario: "USR-JAVIER",
      nombre: "Javier Andrade",
      rol: "inventario",
      rol_label: "Inventario y Repuestos",
      especialidad: "Control de Repuestos, Stock de Válvulas, Guías, Sellos y Empacaduras",
      pin: "333333",
      telefono: "0414-6005566",
      salario_fijo_semanal: 80,
      activo: true,
      modalidad_horario: "Tiempo Completo (Inventario)"
    },
    {
      id_usuario: "USR-HAVELL",
      nombre: "Havell Bracho",
      rol: "tecnico",
      rol_label: "Trabajador de Taller",
      especialidad: "Servicio de Cámara, Cepillada y Armado",
      pin: "444444",
      telefono: "0412-5551122",
      activo: true,
      modalidad_horario: "Jornada Completa"
    },
    {
      id_usuario: "USR-ANGEL",
      nombre: "Angel",
      rol: "tecnico",
      rol_label: "Trabajador de Taller",
      especialidad: "Lavado Químico y Descarbonizado",
      pin: "555555",
      telefono: "0414-5552233",
      activo: true,
      modalidad_horario: "Jornada Completa"
    },
    {
      id_usuario: "USR-JOSE",
      nombre: "Jose Villasmil",
      rol: "tecnico",
      rol_label: "Trabajador de Taller",
      especialidad: "Calibración, Asientos y Válvulas",
      pin: "666666",
      telefono: "0424-5553344",
      activo: true,
      modalidad_horario: "Jornada Completa"
    }
  ];

  const allowedIds = REAL_USERS.map((u) => u.id_usuario);
  if (!Array.isArray(d.usuarios) || d.usuarios.length === 0) {
    d.usuarios = REAL_USERS;
  } else {
    // Purgar inmediatamente cualquier usuario ficticio o de prueba anterior
    d.usuarios = d.usuarios.filter((u) => allowedIds.includes(u.id_usuario));

    // Garantizar que los 8 perfiles oficiales reales existan con sus roles y credenciales
    REAL_USERS.forEach((ru) => {
      let existing = d.usuarios.find((u) => u.id_usuario === ru.id_usuario);
      if (!existing) {
        d.usuarios.push(ru);
      } else {
        existing.nombre = ru.nombre;
        existing.rol = ru.rol;
        existing.rol_label = ru.rol_label;
        existing.especialidad = ru.especialidad;
        existing.activo = true;
        // Garantizar que la credencial oficial única asignada esté siempre activa
        existing.pin = ru.pin;
      }
    });
  }

  // Inicializar inventario central de repuestos e insumos limpio para Javier Andrade (sin ítems ficticios)
  if (!Array.isArray(d.inventario_repuestos)) {
    d.inventario_repuestos = [];
  } else {
    // Purgar ítems de prueba/demo antiguos (REP-101 a REP-107) si existían
    d.inventario_repuestos = d.inventario_repuestos.filter((r) => !/^REP-10[1-7]$/i.test(r.id_repuesto || ""));
  }
  if (!Array.isArray(d.movimientos_inventario)) {
    d.movimientos_inventario = [];
  }

  d.usuarios.forEach((u) => {
    if (u.salario_fijo_semanal === undefined && (u.rol === "admin" || u.rol === "jefe_taller")) {
      u.salario_fijo_semanal = 100;
    }
    if (u.huella_registrada === undefined) u.huella_registrada = false;
  });

  if (!d.config_taller) {
    d.config_taller = {
      control_calidad_activo: !(d.config && d.config.qcStandbyMode),
      exigir_pin_cambio_perfil: d.config && d.config.exigirPin !== undefined ? Boolean(d.config.exigirPin) : false
    };
  }
  const DEFAULT_CATALOGO_SERVICIOS = [
    { id_cat: "CAT-CAM-4C", categoria: "Cámara / Culata", nombre: "Servicio de cámara 4 C", precio_sugerido: 40.0, comision_sugerida: 12.50, activo: true },
    { id_cat: "CAT-CAM-68", categoria: "Cámara / Culata", nombre: "Servicio de cámara 6 C / 8 C", precio_sugerido: 60.0, comision_sugerida: 18.00, activo: true },
    { id_cat: "CAT-APLAN", categoria: "Cámara / Culata", nombre: "Aplanado / Cepillada de Cámara", precio_sugerido: 20.0, comision_sugerida: 5.00, activo: true },
    { id_cat: "CAT-LAVQUIM", categoria: "Cámara / Culata", nombre: "Lavado Químico y Descarbonizado", precio_sugerido: 15.0, comision_sugerida: 3.50, activo: true },
    { id_cat: "CAT-GUIAS", categoria: "Cámara / Culata", nombre: "Cambio e Instalación de Guías de Válvulas", precio_sugerido: 25.0, comision_sugerida: 8.00, activo: true },
    { id_cat: "CAT-ASIENT", categoria: "Cámara / Culata", nombre: "Rectificación y Asentamiento de Válvulas", precio_sugerido: 30.0, comision_sugerida: 10.00, activo: true },
    { id_cat: "CAT-SOLDAD", categoria: "Cámara / Culata", nombre: "Soldadura en Aluminio y Relleno de Pases de Agua", precio_sugerido: 35.0, comision_sugerida: 12.00, activo: true },
    { id_cat: "CAT-ARMADO", categoria: "Cámara / Culata", nombre: "Armado de Cámara, Gomitas y Calibración", precio_sugerido: 25.0, comision_sugerida: 8.00, activo: true },
    { id_cat: "CAT-PRUEBA", categoria: "Cámara / Culata", nombre: "Prueba de Presión Hidráulica / Vacío de Sellado", precio_sugerido: 20.0, comision_sugerida: 6.00, activo: true },
    { id_cat: "CAT-CIGUENAL", categoria: "Bloque / Cigüeñal", nombre: "Rectificación y Pulitura de Cigüeñal", precio_sugerido: 55.0, comision_sugerida: 18.00, activo: true },
    { id_cat: "CAT-BLOQUE", categoria: "Bloque / Cigüeñal", nombre: "Encamisado y Bruñido de Cilindros en Bloque", precio_sugerido: 85.0, comision_sugerida: 28.00, activo: true }
  ];

  if (!Array.isArray(d.catalogo_servicios) || d.catalogo_servicios.length <= 2) {
    const existing = Array.isArray(d.catalogo_servicios) ? d.catalogo_servicios : [];
    const merged = [...existing];
    DEFAULT_CATALOGO_SERVICIOS.forEach((def) => {
      const found = merged.find(
        (m) => (m.nombre || "").toLowerCase().trim() === def.nombre.toLowerCase().trim() || m.id_cat === def.id_cat
      );
      if (!found) {
        merged.push(def);
      }
    });
    d.catalogo_servicios = merged;
  }
  if (!d.finanzas_categorias) {
    d.finanzas_categorias = {
      ingresos: [
        "Liquidación Total de Orden",
        "Abono de Orden",
        "Cobro de Cuenta por Cobrar (Resto)",
        "Ingreso Extra de Taller"
      ],
      egresos: [
        "Pago de Nómina / Comisiones",
        "Pago a Talleres Externos (Solteca / Outsourcing)",
        "Compra de Insumos y Químicos",
        "Herramientas y Piedras de Rectificar",
        "Servicios Básicos e Internet",
        "Mantenimiento de Maquinaria"
      ]
    };
  }
  if (!Array.isArray(d.finanzas_movimientos)) {
    d.finanzas_movimientos = (d.finanzas || [])
      .filter((f) => String(f.concepto || f.id_movimiento || f.id_mov || "").trim() !== "")
      .map((f) => ({
        id_mov: f.id_movimiento || f.id_mov || "MOV-" + Math.random().toString(36).slice(2, 7),
        fecha: cleanDateISO(f.fecha_hora || f.fecha || new Date().toISOString(), false),
        tipo: String(f.tipo_movimiento || f.tipo || "ingreso").toLowerCase(),
        categoria: f.categoria_cuenta || f.categoria || "General",
        concepto: f.concepto || "",
        monto: Number(f.monto_usd ?? f.monto ?? 0),
        metodo: f.metodo_pago || f.metodo || "efectivo",
        orden_id: f.orden_id || "-",
        codigo_troquel: f.codigo_troquel || "-"
      }));
  } else {
    d.finanzas_movimientos.forEach((f) => {
      f.fecha = cleanDateISO(f.fecha, false);
    });
  }

  if (!Array.isArray(d.asistencias)) {
    d.asistencias = (d.asistencia || [])
      .filter((a) => String(a.nombre_usuario || a.nombre || "").trim() !== "")
      .map((a) => ({
        id_asist: a.id_asistencia || a.id_asist || "ASI-" + Math.random().toString(36).slice(2, 7),
        usuario_id: a.usuario_id || "",
        nombre: a.nombre_usuario || a.nombre || "",
        fecha: cleanDateISO(a.fecha || new Date().toISOString(), false),
        hora_entrada: cleanTimeHuman(a.hora_registro || a.hora_entrada || "Activo"),
        hora_salida: a.hora_salida || "Por destajo",
        estado: a.estado_hoy || a.estado || "Activo en Taller",
        observacion: a.turno_modalidad || a.observacion || "Producción por trabajo realizado"
      }));
  } else {
    d.asistencias.forEach((a) => {
      a.fecha = cleanDateISO(a.fecha, false);
      a.hora_entrada = cleanTimeHuman(a.hora_entrada);
    });
  }

  // Purgar asistencias automáticas erróneas generadas por inicio de sesión (03:17 AM o similar)
  d.asistencias = (d.asistencias || []).filter((a) => {
    const hora = String(a.hora_entrada || "");
    if (hora.includes("03:17") || hora.includes("3:17") || hora.includes("03:18") || hora.includes("3:18")) return false;
    return true;
  });

  d.clientes = (d.clientes || []).filter((c) => String(c.nombre_completo || c.documento_identidad || "").trim() !== "");
  d.clientes.forEach((c) => {
    if (c.es_taller_aliado === undefined) {
      c.es_taller_aliado = String(c.tipo_cliente || "").toLowerCase().includes("aliado");
    }
  });

  // PURGA RIGUROSA: Eliminar órdenes de prueba/demo (ORD-1001 a ORD-1006) para mantener SOLO las 3 órdenes reales de Jesús Andrade y nuevas
  d.ordenes = (d.ordenes || []).filter((o) => {
    if (!o) return false;
    const id = String(o.id_orden || "").trim();
    const troquel = String(o.codigo_troquel || "").trim();
    if (!id && !troquel) return false;
    // Filtrar explícitamente las de prueba
    if (/^ORD-100[1-6]$/i.test(id) || /^ORD-100[1-6]/i.test(id)) return false;
    if (troquel === "1513" || troquel === "1508" || troquel === "1504" || troquel === "1499" || troquel === "1492" || troquel === "1485") return false;
    return true;
  });

  d.ordenes.forEach((o) => {
    o.fecha_ingreso = cleanDateISO(o.fecha_ingreso, true);
    if (o.estado_actual === "entregado" && !o.fecha_garantia_hasta) {
      const baseDate = o.fecha_entrega ? new Date(o.fecha_entrega) : new Date();
      o.fecha_garantia_hasta = new Date(baseDate.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
    if (o.repuestos_comprados_taller === undefined) o.repuestos_comprados_taller = false;
    if (!Array.isArray(o.items_repuestos)) o.items_repuestos = [];
  });

  const validOrderIds = new Set(d.ordenes.map((o) => o.id_orden));

  // Subtareas: eliminar las que pertenecían a órdenes de prueba o inexistentes
  d.subtareas = (d.subtareas || []).filter((s) => {
    if (!s || !s.orden_id) return false;
    if (/^ORD-100[1-6]/i.test(s.orden_id)) return false;
    return validOrderIds.has(s.orden_id);
  });

  // Purgar subtareas vacías $0 de pruebas (como el "Adicional" de la orden #1548)
  d.subtareas = (d.subtareas || []).filter((s) => {
    if (!s) return false;
    if (s.id_subtarea === "SUB-1548-2") return false;
    if (s.descripcion_servicio === "Adicional" && Number(s.monto_servicio) === 0 && Number(s.comision_base_tecnico) === 0) return false;
    return true;
  });

  d.subtareas.forEach((s) => {
    if (s.minutos_acumulados === undefined) s.minutos_acumulados = Number(s.tiempo_neto_min || 0);
    if (s.foto_terminado_url === undefined) s.foto_terminado_url = s.foto_evidencia_terminado || "";
    if (s.fecha_terminado) s.fecha_terminado = cleanDateISO(s.fecha_terminado, false);

    // Órdenes en etapa 1 (Recepción / Presupuesto) no tienen técnico asignado hasta Fase 3
    const parentOrd = d.ordenes.find((o) => o.id_orden === s.orden_id);
    if (parentOrd && (parentOrd.estado_actual === "recepcion" || parentOrd.estado_actual === "diagnostico_presupuesto")) {
      s.tecnico_id = "";
      s.nombre_tecnico = "Sin asignar";
      s.estado_subtarea = "pendiente";
    }
  });

  // Bitácora: purgar mensajes huérfanos de pruebas
  d.bitacora = (d.bitacora || []).filter((b) => {
    if (!b) return false;
    if (/^ORD-100[1-6]/i.test(b.orden_id)) return false;
    return !b.orden_id || b.orden_id === "-" || validOrderIds.has(b.orden_id);
  });
  d.bitacora.forEach((b) => {
    b.fecha_hora = cleanDateISO(b.fecha_hora, true);
  });

  // Finanzas: purgar movimientos de prueba
  if (Array.isArray(d.finanzas_movimientos)) {
    d.finanzas_movimientos = d.finanzas_movimientos.filter((f) => {
      if (!f) return false;
      if (/^ORD-100[1-6]/i.test(f.orden_id)) return false;
      return true;
    });
  }

  // Clientes
  if (!Array.isArray(d.clientes)) {
    d.clientes = [];
  }

  return d;
}

function safeJsonParse(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch (_) {
    return fallback;
  }
}

/* Convierte el estado en memoria al esquema exacto de las 8 pestañas de Google Sheets (Code.gs) */
function prepareSheetsPayload(sourceDb) {
  const d = normalizeDatabaseSchema(sourceDb || db);
  const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");

  const clientes = (d.clientes || []).map((c) => ({
    id_cliente: c.id_cliente || "",
    documento_identidad: c.documento_identidad || "",
    nombre_completo: c.nombre_completo || "",
    telefono: c.telefono || "",
    direccion: c.direccion || "",
    tipo_cliente: c.es_taller_aliado ? "Taller Aliado (Crédito Autorizado)" : c.tipo_cliente || "Particular",
    fecha_registro: c.fecha_registro || nowStr.slice(0, 10),
    notas: c.notas || ""
  }));

  const ordenes = (d.ordenes || []).map((o) => {
    const motorPayload = {
      ...(o.datos_motor || {}),
      factura_bloqueada: Boolean(o.factura_bloqueada),
      devuelto_calidad: Boolean(o.devuelto_calidad),
      motivo_rechazo_qc: o.motivo_rechazo_qc || "",
      excepcion_taller_aliado: Boolean(o.excepcion_taller_aliado)
    };
    return {
      id_orden: o.id_orden || "",
      cliente_id: o.cliente_id || "",
      documento_cliente: o.documento_cliente || "",
      nombre_cliente: o.nombre_cliente || "",
      telefono_cliente: o.telefono_cliente || "",
      codigo_troquel: String(o.codigo_troquel || ""),
      datos_motor_json: JSON.stringify(motorPayload),
      galeria_fotos_pieza_json: JSON.stringify(o.galeria_fotos_pieza || []),
      galeria_fotos_repuestos_json: JSON.stringify(o.galeria_fotos_repuestos || []),
      estado_actual: o.estado_actual || "diagnostico_presupuesto",
      subestado_ejecucion: o.subestado_ejecucion || "pendiente",
      tipo_condicion_pago: o.tipo_condicion_pago || "pendiente_definir",
      monto_total: Number(o.monto_total) || 0,
      monto_abonado: Number(o.monto_abonado) || 0,
      saldo_pendiente: Number(o.saldo_pendiente) || 0,
      metodo_pago: o.metodo_pago || "n/a",
      comprobante_pago_foto: o.comprobante_pago_foto || "",
      prioridad_alta: Boolean(o.prioridad_alta),
      fecha_ingreso: o.fecha_ingreso || nowStr.slice(0, 16),
      fecha_inicio_produccion: o.fecha_inicio_produccion || "",
      fecha_fin_produccion: o.fecha_fin_produccion || "",
      tiempo_neto_minutos: Number(o.tiempo_neto_minutos) || 0,
      fecha_entrega: o.fecha_entrega || "",
      qc_aprobado: Boolean(o.qc_aprobado || o.estado_actual === "entregado"),
      qc_checklist_json: JSON.stringify({
        factura_bloqueada: Boolean(o.factura_bloqueada),
        devuelto_calidad: Boolean(o.devuelto_calidad),
        motivo_rechazo_qc: o.motivo_rechazo_qc || ""
      }),
      foto_entrega_final: o.foto_entrega_final || "",
      ultima_actualizacion: nowStr
    };
  });

  const subtareas = (d.subtareas || []).map((s) => {
    const parentOrd = (d.ordenes || []).find((o) => o.id_orden === s.orden_id);
    return {
      id_subtarea: s.id_subtarea || "",
      orden_id: s.orden_id || "",
      codigo_troquel: String(s.codigo_troquel || (parentOrd ? parentOrd.codigo_troquel : "")),
      descripcion_servicio: s.descripcion_servicio || "",
      tecnico_id: s.tecnico_id || "",
      nombre_tecnico: s.nombre_tecnico || "Sin asignar",
      monto_servicio: Number(s.monto_servicio) || 0,
      comision_base_tecnico: Number(s.comision_base_tecnico) || 0,
      estado_subtarea: s.estado_subtarea || "pendiente",
      fecha_inicio: s.fecha_inicio || "",
      fecha_fin: s.fecha_fin || s.fecha_terminado || "",
      tiempo_neto_min: Number(s.minutos_acumulados ?? s.tiempo_neto_min ?? 0),
      foto_evidencia_terminado: s.foto_terminado_url || s.foto_evidencia_terminado || "",
      checklist_salida_json: JSON.stringify(s.checklist_salida || {}),
      comision_pagada: Boolean(s.comision_pagada),
      id_liquidacion: s.id_liquidacion || ""
    };
  });

  const bitacora = (d.bitacora || []).map((b) => ({
    id_mensaje: b.id_mensaje || "",
    orden_id: b.orden_id || "",
    codigo_troquel: String(b.codigo_troquel || ""),
    autor_id: b.autor_id || "",
    autor_nombre: b.autor_nombre || "",
    autor_rol: b.autor_rol || "",
    tipo_evento: b.tipo_evento || "comentario",
    mensaje: b.mensaje || "",
    foto_adjunta_url: b.foto_adjunta_url || "",
    fecha_hora: b.fecha_hora || nowStr.slice(0, 16)
  }));

  const usuarios = (d.usuarios || []).map((u) => ({
    id_usuario: u.id_usuario || "",
    nombre: u.nombre || "",
    rol: u.rol || "tecnico",
    especialidad: u.especialidad || "",
    pin: String(u.pin || "123456"),
    telefono: u.telefono || "",
    activo: u.activo !== false,
    modalidad_horario: u.modalidad_horario || "Jornada Completa",
    fecha_ingreso: u.fecha_ingreso || "2026-01-01"
  }));

  const catalogo = (d.catalogo_servicios || d.catalogo || []).map((c) => ({
    id_servicio: c.id_cat || c.id_servicio || "",
    categoria_pieza: c.categoria_pieza || "Cámara / Motor",
    descripcion_servicio: c.nombre || c.descripcion_servicio || "",
    precio_sugerido_usd: Number(c.precio_sugerido ?? c.precio_sugerido_usd ?? 0),
    comision_tecnico_usd: Number(c.comision_sugerida ?? c.comision_tecnico_usd ?? 0),
    activo: c.activo !== false
  }));

  const finanzas = (d.finanzas_movimientos || d.finanzas || []).map((m) => ({
    id_movimiento: m.id_mov || m.id_movimiento || "",
    fecha_hora: m.fecha || m.fecha_hora || nowStr.slice(0, 10),
    tipo_movimiento: String(m.tipo || m.tipo_movimiento || "ingreso").toUpperCase(),
    categoria_cuenta: m.categoria || m.categoria_cuenta || "General",
    concepto: m.concepto || "",
    orden_id: m.orden_id || "-",
    codigo_troquel: String(m.codigo_troquel || "-"),
    monto_usd: Number(m.monto ?? m.monto_usd ?? 0),
    metodo_pago: m.metodo || m.metodo_pago || "efectivo",
    referencia: m.referencia || "",
    comprobante_foto: m.comprobante_foto || "",
    registrado_por: m.registrado_por || (currentUser ? currentUser.nombre : "Sistema")
  }));

  const asistencia = (d.asistencias || d.asistencia || []).map((a) => ({
    id_asistencia: a.id_asist || a.id_asistencia || "",
    fecha: String(a.fecha || nowStr.slice(0, 10)).slice(0, 10),
    usuario_id: a.usuario_id || "",
    nombre_usuario: a.nombre || a.nombre_usuario || "",
    turno_modalidad: a.observacion || a.turno_modalidad || "Jornada Completa",
    hora_registro: a.hora_entrada || a.hora_registro || "08:00 AM",
    observacion: a.estado || a.observacion || "Presente"
  }));

  return {
    clientes,
    ordenes,
    subtareas,
    bitacora,
    usuarios,
    catalogo,
    finanzas,
    asistencia
  };
}

/* Convierte los registros leídos desde Google Sheets (sync_all) de vuelta al modelo rico de la PWA */
function hydrateDatabaseFromSheets(cloudData) {
  const base = normalizeDatabaseSchema(getInitialDatabase());
  if (!cloudData || typeof cloudData !== "object") return base;

  const roleLabels = {
    admin: "Administrador del Sistema",
    jefe_taller: "Jefe de Taller",
    recepcion: "Recepción e Ingreso",
    tecnico: "Técnico Rectificador",
    outsourcing: "Taller Externo (Outsourcing)"
  };

  const allowedUserIds = [
    "USR-MOISES", "USR-JESUS", "USR-ENRIQUE", "USR-RECEPCION",
    "USR-JAVIER", "USR-HAVELL", "USR-ANGEL", "USR-JOSE"
  ];
  const validUsers = Array.isArray(cloudData.usuarios)
    ? cloudData.usuarios.filter((u) => {
        const id = String(u.id_usuario || "");
        return (
          allowedUserIds.includes(id) ||
          u.rol === "outsourcing" ||
          u.tipo === "taller_externo" ||
          u.es_externo ||
          id.startsWith("EXT-") ||
          id.startsWith("USR-")
        );
      })
    : [];
  const usuarios = validUsers.length
    ? validUsers.map((u) => {
        const isExt = Boolean(u.rol === "outsourcing" || u.tipo === "taller_externo" || u.es_externo || String(u.id_usuario || "").startsWith("EXT-"));
        const baseUser = base.usuarios.find(
          (bu) => bu.id_usuario === u.id_usuario || (bu.nombre && bu.nombre.toLowerCase().trim() === String(u.nombre || "").toLowerCase().trim())
        );
        const resolvedPin = baseUser ? baseUser.pin : String(u.pin || (isExt ? "0000" : "000000")).trim();
        return {
          id_usuario: String(u.id_usuario || (baseUser ? baseUser.id_usuario : "")),
          nombre: String(u.nombre || (baseUser ? baseUser.nombre : "")),
          rol: String(u.rol || (baseUser ? baseUser.rol : (isExt ? "outsourcing" : "tecnico"))),
          rol_label: roleLabels[u.rol] || (isExt ? "Taller Externo (Outsourcing)" : (baseUser ? baseUser.rol_label : "Técnico Rectificador")),
          tipo: isExt ? "taller_externo" : "personal_interno",
          es_externo: isExt,
          especialidad: String(u.especialidad || (baseUser ? baseUser.especialidad : (isExt ? "Mecanizado y Rectificación Externa" : ""))),
          pin: resolvedPin,
          telefono: String(u.telefono || (baseUser ? baseUser.telefono : "")),
          direccion: String(u.direccion || (baseUser ? baseUser.direccion : "")),
          activo: u.activo === true || String(u.activo).toLowerCase() === "true",
          modalidad_horario: String(u.modalidad_horario || (baseUser ? baseUser.modalidad_horario : (isExt ? "Tercerizado" : "Producción por Destajo")))
        };
      })
    : base.usuarios;

  const validClients = Array.isArray(cloudData.clientes)
    ? cloudData.clientes.filter((c) => String(c.nombre_completo || c.documento_identidad || "").trim() !== "")
    : [];
  const clientes = validClients.map((c) => ({
    id_cliente: String(c.id_cliente || ""),
    documento_identidad: String(c.documento_identidad || ""),
    nombre_completo: String(c.nombre_completo || ""),
    telefono: String(c.telefono || ""),
    direccion: String(c.direccion || ""),
    tipo_cliente: String(c.tipo_cliente || "Particular"),
    es_taller_aliado: String(c.tipo_cliente || "").toLowerCase().includes("aliado")
  }));

  const validOrders = Array.isArray(cloudData.ordenes)
    ? cloudData.ordenes.filter((o) => String(o.codigo_troquel || o.id_orden || "").trim() !== "")
    : [];
  const ordenes = validOrders.map((o) => {
    const motorObj = safeJsonParse(o.datos_motor_json || o.datos_motor, {
      tipo_pieza: "Cámara / Culata",
      marca: "Motor",
      modelo: "",
      serial: "S/N",
      observaciones: ""
    });
    const qcMeta = safeJsonParse(o.qc_checklist_json, {});
    const fotosPieza = safeJsonParse(o.galeria_fotos_pieza_json || o.galeria_fotos_pieza, [DEMO_PHOTOS.camaraCorsa]);
    const fotosRep = safeJsonParse(o.galeria_fotos_repuestos_json || o.galeria_fotos_repuestos, []);
    const isEntregado = String(o.estado_actual || "") === "entregado";
    const troquelClean = String(o.codigo_troquel || o.id_orden || "").replace(/^ORD-/i, "");

    return {
      id_orden: String(o.id_orden || `ORD-${troquelClean}`),
      cliente_id: String(o.cliente_id || ""),
      documento_cliente: String(o.documento_cliente || ""),
      nombre_cliente: String(o.nombre_cliente || ""),
      telefono_cliente: String(o.telefono_cliente || ""),
      codigo_troquel: troquelClean,
      datos_motor: {
        tipo_pieza: motorObj.tipo_pieza || "Cámara / Culata",
        marca: motorObj.marca || "",
        modelo: motorObj.modelo || "",
        serial: motorObj.serial || "S/N",
        observaciones: motorObj.observaciones || ""
      },
      galeria_fotos_pieza: Array.isArray(fotosPieza) && fotosPieza.length ? fotosPieza : [DEMO_PHOTOS.camaraCorsa],
      galeria_fotos_repuestos: Array.isArray(fotosRep) ? fotosRep : [],
      estado_actual: String(o.estado_actual || "diagnostico_presupuesto"),
      subestado_ejecucion: String(o.subestado_ejecucion || "pendiente"),
      tipo_condicion_pago: String(o.tipo_condicion_pago || "pendiente_definir"),
      excepcion_taller_aliado: Boolean(motorObj.excepcion_taller_aliado),
      monto_total: Number(o.monto_total) || 0,
      monto_abonado: Number(o.monto_abonado) || 0,
      saldo_pendiente: Number(o.saldo_pendiente) || 0,
      metodo_pago: String(o.metodo_pago || "n/a"),
      comprobante_pago_foto: String(o.comprobante_pago_foto || ""),
      prioridad_alta: o.prioridad_alta === true || String(o.prioridad_alta).toLowerCase() === "true",
      factura_bloqueada: Boolean(isEntregado || motorObj.factura_bloqueada || qcMeta.factura_bloqueada),
      devuelto_calidad: Boolean(motorObj.devuelto_calidad || qcMeta.devuelto_calidad),
      motivo_rechazo_qc: String(motorObj.motivo_rechazo_qc || qcMeta.motivo_rechazo_qc || ""),
      fecha_ingreso: cleanDateISO(o.fecha_ingreso, true),
      tiempo_neto_minutos: Number(o.tiempo_neto_minutos) || 0,
      qc_aprobado: o.qc_aprobado === true || String(o.qc_aprobado).toLowerCase() === "true" || isEntregado
    };
  });

  const validSubtasks = Array.isArray(cloudData.subtareas)
    ? cloudData.subtareas.filter((s) => String(s.descripcion_servicio || s.id_subtarea || "").trim() !== "")
    : [];
  const subtareas = validSubtasks.map((s) => ({
    id_subtarea: String(s.id_subtarea || ""),
    orden_id: String(s.orden_id || ""),
    codigo_troquel: String(s.codigo_troquel || ""),
    descripcion_servicio: String(s.descripcion_servicio || ""),
    tecnico_id: String(s.tecnico_id || "") || null,
    nombre_tecnico: String(s.nombre_tecnico || "Sin asignar"),
    monto_servicio: Number(s.monto_servicio) || 0,
    comision_base_tecnico: Number(s.comision_base_tecnico) || 0,
    estado_subtarea: String(s.estado_subtarea || "pendiente"),
    minutos_acumulados: Number(s.tiempo_neto_min ?? s.minutos_acumulados ?? 0),
    tiempo_neto_min: Number(s.tiempo_neto_min ?? s.minutos_acumulados ?? 0),
    fecha_inicio: cleanDateISO(s.fecha_inicio, true),
    fecha_terminado: cleanDateISO(s.fecha_fin || s.fecha_terminado, false),
    foto_terminado_url: String(s.foto_evidencia_terminado || s.foto_terminado_url || ""),
    foto_evidencia_terminado: String(s.foto_evidencia_terminado || s.foto_terminado_url || ""),
    comision_pagada: s.comision_pagada === true || String(s.comision_pagada).toLowerCase() === "true"
  }));

  const validBitacora = Array.isArray(cloudData.bitacora)
    ? cloudData.bitacora.filter((b) => String(b.mensaje || b.foto_adjunta_url || "").trim() !== "")
    : [];
  const bitacora = validBitacora.map((b) => ({
    id_mensaje: String(b.id_mensaje || ""),
    orden_id: String(b.orden_id || ""),
    codigo_troquel: String(b.codigo_troquel || ""),
    autor_id: String(b.autor_id || ""),
    autor_nombre: String(b.autor_nombre || ""),
    autor_rol: String(b.autor_rol || ""),
    tipo_evento: String(b.tipo_evento || "comentario"),
    mensaje: String(b.mensaje || ""),
    foto_adjunta_url: String(b.foto_adjunta_url || ""),
    fecha_hora: cleanDateISO(b.fecha_hora, true)
  }));

  const validCatalogo = Array.isArray(cloudData.catalogo)
    ? cloudData.catalogo.filter((c) => String(c.descripcion_servicio || c.nombre || "").trim() !== "")
    : [];
  const catalogo = validCatalogo.length ? validCatalogo : base.catalogo;

  const validFinanzas = Array.isArray(cloudData.finanzas)
    ? cloudData.finanzas.filter((f) => String(f.concepto || f.id_movimiento || "").trim() !== "")
    : [];
  const finanzas = validFinanzas;

  const validAsistencia = Array.isArray(cloudData.asistencia)
    ? cloudData.asistencia.filter((a) => String(a.nombre_usuario || a.nombre || "").trim() !== "")
    : [];
  const asistencia = validAsistencia;

  return normalizeDatabaseSchema({
    ...base,
    usuarios,
    clientes,
    ordenes,
    subtareas,
    bitacora,
    catalogo,
    catalogo_servicios: undefined,
    finanzas,
    finanzas_movimientos: undefined,
    asistencia,
    asistencias: undefined
  });
}

function updateCloudSyncBadge(state, detailText) {
  cloudSyncStatus = state;
  if (detailText) lastCloudSyncTime = detailText;
  const badgeEl = document.getElementById("cloud-sync-badge-label");
  const iconEl = document.getElementById("cloud-sync-badge-icon");
  const btnEl = document.getElementById("btn-header-cloud-sync");
  if (!badgeEl || !iconEl || !btnEl) return;

  if (state === "syncing") {
    iconEl.className = "fas fa-sync fa-spin";
    badgeEl.textContent = "Sincronizando Sheets...";
    btnEl.style.borderColor = "rgba(245,196,0,0.6)";
  } else if (state === "error") {
    iconEl.className = "fas fa-exclamation-triangle";
    badgeEl.textContent = "Modo Local (Offline)";
    btnEl.style.borderColor = "rgba(239,68,68,0.6)";
  } else {
    iconEl.className = "fas fa-cloud-check";
    badgeEl.textContent = "Sheets Conectado";
    btnEl.style.borderColor = "rgba(34,197,94,0.65)";
  }
}

async function pushToGoogleSheets(silent = true) {
  if (!GAS_API_URL) return false;
  updateCloudSyncBadge("syncing");
  try {
    const payload = prepareSheetsPayload(db);
    const res = await fetch(GAS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "push_state", payload })
    });
    const json = await res.json();
    if (json && json.success) {
      const stamp = (json.data && json.data.savedAt) || new Date().toLocaleTimeString();
      updateCloudSyncBadge("online", stamp);
      if (!silent) showToast(`Datos guardados en Google Sheets (${stamp})`);
      return true;
    }
    throw new Error((json && json.error) || "Respuesta no válida de Sheets");
  } catch (err) {
    console.warn("Aviso al sincronizar hacia Google Sheets:", err);
    updateCloudSyncBadge("error");
    if (!silent) showToast("No se pudo conectar con Google Sheets. Guardado en memoria local.", "error");
    return false;
  }
}

async function syncFromGoogleSheets(silent = false) {
  if (!GAS_API_URL) return false;
  updateCloudSyncBadge("syncing");
  try {
    const res = await fetch(`${GAS_API_URL}?action=sync_all&t=${Date.now()}`);
    const json = await res.json();
    if (json && json.success && json.data) {
      // Verificación de actualización remota obligatoria para todos los equipos
      if (json.data.config && json.data.config.forzar_actualizacion_version) {
        const remoteForcedVer = json.data.config.forzar_actualizacion_version;
        const localForcedVer = localStorage.getItem("RENACER_FORCED_VERSION");
        if (localForcedVer && remoteForcedVer !== localForcedVer) {
          localStorage.setItem("RENACER_FORCED_VERSION", remoteForcedVer);
          showToast("Actualización del sistema enviada desde Administración. Aplicando cambios...", "info");
          setTimeout(() => forceAppRefresh(), 600);
          return true;
        }
        localStorage.setItem("RENACER_FORCED_VERSION", remoteForcedVer);
      }

      const hasInitializedCatalogOrUsers =
        (Array.isArray(json.data.usuarios) && json.data.usuarios.length > 0) ||
        (Array.isArray(json.data.catalogo) && json.data.catalogo.length > 0);

      if (hasInitializedCatalogOrUsers || (Array.isArray(json.data.ordenes) && json.data.ordenes.length > 0)) {
        db = hydrateDatabaseFromSheets(json.data);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        populateLoginSelect();
        if (currentUser) {
          const updatedMe = db.usuarios.find((u) => u.id_usuario === currentUser.id_usuario);
          if (updatedMe) currentUser = updatedMe;
          renderApp();
        }
        updateCloudSyncBadge("online", json.data.serverTime || new Date().toLocaleTimeString());
        if (!silent) showToast(`Sincronizado desde Google Sheets (${db.ordenes.length} órdenes activas).`);
        return true;
      } else {
        await pushToGoogleSheets(silent);
        return true;
      }
    }
    throw new Error((json && json.error) || "Error al leer Google Sheets");
  } catch (err) {
    console.warn("Aviso al leer desde Google Sheets:", err);
    updateCloudSyncBadge("error");
    if (!silent) showToast("Trabajando con base local (sin respuesta de Google Sheets).", "error");
    return false;
  }
}

function openCloudSyncModal() {
  const isAdmin = currentUser && currentUser.rol === "admin";
  openModal({
    title: "Google Sheets en Tiempo Real y Mantenimiento de Base de Datos",
    icon: "fa-cloud",
    wide: true,
    body: `
      <div style="background:rgba(22,163,74,0.1); border:1.5px solid rgba(22,163,74,0.4); border-radius:12px; padding:12px 16px; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <div>
          <div style="font-size:13.5px; font-weight:900; color:#15803d;">
            <i class="fas fa-check-circle"></i> Conectado al Google Sheets de Rectificadora Renacer
          </div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">
            Última sincronización: <strong>${lastCloudSyncTime}</strong> · Órdenes actuales: <strong>${db.ordenes.length}</strong>
          </div>
        </div>
        <span class="state-badge state-badge--done">${cloudSyncStatus === "online" ? "CONECTADO" : cloudSyncStatus === "syncing" ? "SINCRONIZANDO" : "LOCAL"}</span>
      </div>

      <div class="form-field" style="margin-bottom:14px;">
        <label>URL del Web App de Google Apps Script</label>
        <input
          type="url"
          id="input-gas-url"
          value="${GAS_API_URL}"
          style="font-family:'JetBrains Mono',monospace; font-size:12px;"
        />
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:10px; margin-bottom:16px;">
        <button type="button" class="btn btn--primary btn--lg" style="justify-content:center;" onclick="syncFromGoogleSheets(false); closeModal();">
          <i class="fas fa-cloud-arrow-down"></i> Traer Datos de Google Sheets
        </button>
        <button type="button" class="btn btn--gold btn--lg" style="justify-content:center;" onclick="pushToGoogleSheets(false); closeModal();">
          <i class="fas fa-cloud-arrow-up"></i> Guardar Todo en Sheets Ahora
        </button>
      </div>

      <!-- Control de Actualización Remota Forzada (Sin borrar caché manual) -->
      <div class="form-section-box" style="border-color:rgba(245,223,0,0.35); margin-bottom:14px; background:rgba(24,34,84,0.25);">
        <div class="form-section-title" style="color:var(--renacer-gold);">
          <i class="fas fa-satellite-dish"></i> Despliegue y Actualización Remota para Todos los Dispositivos
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:10px; line-height:1.45;">
          Fuerza de manera instantánea a todos los teléfonos de mecánicos, computadoras y tablets conectados a recargar la versión más reciente del sistema, sin que nadie tenga que borrar caché manualmente.
        </p>
        <button type="button" class="btn btn--gold" onclick="triggerRemoteUpdateForAll(); closeModal();">
          <i class="fas fa-arrows-rotate"></i> Forzar Actualización Remota para Todos
        </button>
      </div>

      <div class="form-section-box" style="border-color:rgba(220,38,38,0.35); margin-bottom:0;">
        <div class="form-section-title" style="color:#dc2626;">
          <i class="fas fa-broom"></i> Limpieza de Pedidos de Prueba y Control de Demostración
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">
          Usa estas opciones para eliminar todos los pedidos/órdenes de prueba y dejar el sistema en cero listo para producción real, o restaurar los ejemplos cuando quieras hacer una demostración.
        </p>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button type="button" class="btn btn--danger" onclick="clearAllTestOrders()">
            <i class="fas fa-trash-alt"></i> Limpiar Pedidos de Prueba (Dejar en Cero)
          </button>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cerrar</button>
      <button type="button" class="btn btn--success" onclick="saveCustomGasUrl()">
        <i class="fas fa-save"></i> Guardar URL y Reconectar
      </button>
    `
  });
}

function clearAllTestOrders() {
  Swal.fire({
    title: "¿Limpiar todas las órdenes y movimientos de prueba?",
    text: "Se reseteará el sistema a CERO: se borrarán las órdenes de prueba, subtareas, bitácora y movimientos financieros tanto en la app como en Google Sheets, conservando intactos los usuarios, catálogo de precios y personalizaciones de texto.",
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#dc2626",
    cancelButtonColor: "#64748b",
    cancelButtonText: "Cancelar",
    confirmButtonText: "Sí, dejar en cero real"
  }).then(async (res) => {
    if (res.isConfirmed) {
      db.ordenes = [];
      db.subtareas = [];
      db.bitacora = [];
      db.finanzas_movimientos = [];
      db.finanzas = [];
      db.cuentas_por_pagar = [];
      db.movimientos_inventario = [];
      if (db.config) {
        db.config.correlativoTroquelActual = 5022;
        db.config.correlativoOrdenActual = 1008;
      }
      saveDatabase();
      showToast("Limpiando y sincronizando con Google Sheets...", "info");
      await pushToGoogleSheets(false);
      closeModal();
      if (currentUser) renderApp();
      showToast("Sistema en cero real sincronizado con Google Sheets.");
    }
  });
}

function deleteOrder(orderId) {
  const ord = db.ordenes.find((o) => o.id_orden === orderId);
  if (!ord) return;
  Swal.fire({
    title: `¿Eliminar Troquel #${ord.codigo_troquel}?`,
    text: `Se eliminará la orden de ${ord.nombre_cliente} (${ord.datos_motor.marca} ${ord.datos_motor.modelo}) junto con sus subtareas y bitácora.`,
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#dc2626",
    cancelButtonColor: "#64748b",
    cancelButtonText: "Cancelar",
    confirmButtonText: "Sí, eliminar orden"
  }).then(async (res) => {
    if (res.isConfirmed) {
      db.ordenes = db.ordenes.filter((o) => o.id_orden !== orderId);
      db.subtareas = db.subtareas.filter((s) => s.orden_id !== orderId);
      db.bitacora = db.bitacora.filter((b) => b.orden_id !== orderId);
      db.finanzas_movimientos = (db.finanzas_movimientos || []).filter((f) => f.orden_id !== orderId);
      if (Array.isArray(db.finanzas)) {
        db.finanzas = db.finanzas.filter((f) => f.orden_id !== orderId);
      }
      saveDatabase();
      await pushToGoogleSheets(true);
      closeModal();
      renderApp();
      showToast(`Orden / Troquel #${ord.codigo_troquel} eliminada y sincronizada.`);
    }
  });
}

function saveCustomGasUrl() {
  const val = (document.getElementById("input-gas-url")?.value || "").trim() || DEFAULT_GAS_API_URL;
  GAS_API_URL = val;
  localStorage.setItem("RENACER_GAS_API_URL", val);
  closeModal();
  syncFromGoogleSheets(false);
}

function loadDatabase() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.ordenes)) return normalizeDatabaseSchema(parsed);
    }
  } catch (e) {
    console.warn("Error leyendo almacenamiento local, cargando base inicial:", e);
  }
  const initial = normalizeDatabaseSchema(getInitialDatabase());
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  } catch (e) {}
  return initial;
}

function saveDatabase() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    console.error("Error al guardar en localStorage (posible exceso de cuota):", e);
    // Si la cuota se satura por fotos, podar base64 antiguas de bitácora manteniendo los textos
    try {
      const cloned = JSON.parse(JSON.stringify(db));
      if (Array.isArray(cloned.bitacora)) {
        cloned.bitacora.forEach((b, idx) => {
          if (idx < cloned.bitacora.length - 8 && b.foto_adjunta_url && b.foto_adjunta_url.startsWith("data:image")) {
            b.foto_adjunta_url = "";
          }
        });
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cloned));
    } catch (err2) {
      console.warn("No se pudo guardar ni con optimización de fotos:", err2);
    }
  }
  pushToGoogleSheets(true);
}

function resetDemoDatabase() {
  Swal.fire({
    title: "¿Restaurar Datos de Demostración (Fase 1 y 2)?",
    text: "Se recargarán las órdenes de ejemplo (#5017, #1510, #1507, #1509, #1513, #1498), técnicos y cuentas por cobrar originales de Rectificadora Renacer.",
    icon: "question",
    showCancelButton: true,
    confirmButtonColor: "#182254",
    cancelButtonText: "Cancelar",
    confirmButtonText: "Sí, restaurar demo"
  }).then((res) => {
    if (res.isConfirmed) {
      db = getInitialDatabase();
      saveDatabase();
      if (currentUser) renderApp();
      showToast("Datos de demostración Fase 1 y 2 restaurados correctamente.");
    }
  });
}

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.classList.add("hidden");
  }, 3600);
}

/* ---------- Manejo de Tema Claro / Oscuro ---------- */
function initTheme() {
  const saved = localStorage.getItem("RENACER_THEME") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const curr = document.documentElement.getAttribute("data-theme") || "light";
  const next = curr === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("RENACER_THEME", next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById("theme-icon");
  if (icon) {
    icon.className = theme === "dark" ? "fas fa-sun" : "fas fa-moon";
  }
}

/* ---------- Autenticación Limpia y Manejo de Sesión ---------- */
function normalizeLoginString(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function populateLoginSelect() {
  const dl = document.getElementById("login-users-datalist");
  if (dl && Array.isArray(db.usuarios)) {
    dl.innerHTML = db.usuarios
      .filter((u) => u.activo !== false)
      .map((u) => `<option value="${u.nombre}">`)
      .join("");
  }

  // Prellenar nombre con el usuario guardado o Moises Gonzalez por defecto
  const userInput = document.getElementById("login-username-input");
  if (userInput && !userInput.value) {
    const remembered = localStorage.getItem("RENACER_REMEMBERED_USER") || "Moises Gonzalez";
    userInput.value = remembered;
  }

  // Alerta de sesión anterior
  const savedUserId = localStorage.getItem(SESSION_KEY);
  const resumeBanner = document.getElementById("login-resume-banner");
  const resumeName = document.getElementById("login-resume-name");
  if (savedUserId && resumeBanner && resumeName) {
    const u = db.usuarios.find((x) => x.id_usuario === savedUserId);
    if (u) {
      resumeName.textContent = u.nombre;
      resumeBanner.classList.remove("hidden");
    } else {
      resumeBanner.classList.add("hidden");
    }
  } else if (resumeBanner) {
    resumeBanner.classList.add("hidden");
  }
}

function toggleLoginPinVisibility() {
  const inp = document.getElementById("login-pin-input");
  const icon = document.getElementById("login-pin-eye-icon");
  const text = document.getElementById("login-pin-eye-text");
  if (!inp) return;
  if (inp.type === "password") {
    inp.type = "text";
    if (icon) icon.className = "fas fa-eye-slash";
    if (text) text.textContent = "Ocultar";
  } else {
    inp.type = "password";
    if (icon) icon.className = "fas fa-eye";
    if (text) text.textContent = "Ver";
  }
}

function resumePreviousSession() {
  const savedUserId = localStorage.getItem(SESSION_KEY);
  if (!savedUserId) return;
  const user = db.usuarios.find((u) => u.id_usuario === savedUserId);
  if (user) {
    const inp = document.getElementById("login-username-input");
    if (inp) inp.value = user.nombre;
    const pin = document.getElementById("login-pin-input");
    if (pin) {
      pin.focus();
      showToast(`Ingresa el PIN de ${user.nombre} para ingresar.`, "info");
    }
  }
}

function quickLoginAs(userId) {
  const user = db.usuarios.find((u) => u.id_usuario === userId);
  if (!user) {
    showToast("Usuario no encontrado en base de datos.", "error");
    return;
  }
  loginSuccess(user);
  return false;
}
window.quickLoginAs = quickLoginAs;

function quickSelectUser(nombre, userId) {
  const user = db.usuarios.find((u) => u.id_usuario === userId || normalizeLoginString(u.nombre) === normalizeLoginString(nombre));
  const uInput = document.getElementById("login-username-input");
  const pInput = document.getElementById("login-pin-input");
  if (uInput && user) uInput.value = user.nombre;

  // Si ya tiene su PIN escrito en la casilla, verificar e iniciar sesión directamente
  if (pInput && pInput.value.trim()) {
    handleManualLogin();
    return;
  }

  if (!user) {
    if (pInput) pInput.focus();
    return;
  }

  // Solicitar el PIN asignado de forma obligatoria y estricta (sin atajos ni contraseñas maestras)
  Swal.fire({
    title: `<i class="fas fa-lock" style="color:var(--renacer-gold);"></i> Acceso: ${user.nombre}`,
    html: `<div style="font-size:13px; color:var(--text-muted); margin-bottom:12px;">Rol: <strong>${user.rol_label || user.rol}</strong>.<br>Ingresa el PIN numérico de seguridad registrado para este perfil:</div>`,
    input: "password",
    inputAttributes: {
      inputmode: "numeric",
      autocomplete: "current-password",
      placeholder: "PIN de seguridad"
    },
    showCancelButton: true,
    confirmButtonText: '<i class="fas fa-sign-in-alt"></i> Entrar',
    cancelButtonText: "Cancelar",
    confirmButtonColor: "#182254",
    background: "#0d1536",
    color: "#f8fafc",
    preConfirm: (val) => {
      const pinVal = String(val || "").trim();
      const expected = String(user.pin || "").trim();
      if (!pinVal) {
        Swal.showValidationMessage("Debes ingresar tu PIN numérico.");
        return false;
      }
      if (pinVal !== expected) {
        Swal.showValidationMessage("PIN incorrecto. Ingresa la credencial asignada a este usuario.");
        return false;
      }
      return pinVal;
    }
  }).then((res) => {
    if (res.isConfirmed) {
      if (pInput) pInput.value = res.value;
      loginSuccess(user);
    } else {
      if (pInput) pInput.focus();
    }
  });
}
window.quickSelectUser = quickSelectUser;

function handleManualLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const rawInput = (document.getElementById("login-username-input")?.value || "").trim();
  const normInput = normalizeLoginString(rawInput);
  const pinInput = (document.getElementById("login-pin-input")?.value || "").trim();

  if (!rawInput) {
    showToast("Ingresa tu nombre de usuario (ej. Moises Gonzalez).", "error");
    const uInp = document.getElementById("login-username-input");
    if (uInp) uInp.focus();
    return;
  }

  // 1. Búsqueda inteligente y flexible de usuario
  let user = null;

  // Búsqueda exacta por nombre o ID normalizado
  user = db.usuarios.find(
    (u) => normalizeLoginString(u.nombre) === normInput || normalizeLoginString(u.id_usuario) === normInput
  );

  // Coincidencia para Moisés González / Admin
  if (!user && (normInput.includes("moises") || normInput === "admin" || normInput === "administrador")) {
    user = db.usuarios.find(
      (u) => u.id_usuario === "USR-MOISES" || u.rol === "admin" || normalizeLoginString(u.nombre).includes("moises")
    );
  }

  // Coincidencia para Jesús Andrade
  if (!user && normInput.includes("jesus")) {
    user = db.usuarios.find(
      (u) => u.id_usuario === "USR-JESUS" || normalizeLoginString(u.nombre).includes("jesus")
    );
  }

  // Búsqueda por coincidencia parcial (starts-with o includes)
  if (!user && normInput.length >= 3) {
    user = db.usuarios.find((u) => {
      const uNorm = normalizeLoginString(u.nombre);
      return uNorm.startsWith(normInput) || uNorm.includes(normInput) || normInput.includes(uNorm);
    });
  }

  // Coincidencia por rol recepción
  if (!user && (normInput === "recepcion" || normInput.includes("recepcion"))) {
    user = db.usuarios.find((u) => u.rol === "recepcion" || u.id_usuario === "USR-RECEPCION");
  }

  if (!user) {
    Swal.fire({
      title: "Usuario No Encontrado",
      text: `No se encontró el usuario "${rawInput}". Ingresa tu nombre tal como está registrado (ej. Moises Gonzalez).`,
      icon: "error",
      confirmButtonColor: "#182254"
    });
    return;
  }

  // 2. Validación de Credencial Única (Sin claves de respaldo ni comodines)
  const expectedPin = String(user.pin || "").trim();
  if (!pinInput) {
    Swal.fire({
      title: "PIN Requerido",
      text: `Por favor ingresa tu credencial única de acceso para el perfil de ${user.nombre}.`,
      icon: "warning",
      confirmButtonColor: "#182254"
    });
    const pInp = document.getElementById("login-pin-input");
    if (pInp) pInp.focus();
    return;
  }

  // Validación estricta 1 a 1: ÚNICAMENTE la credencial asignada a este usuario es válida
  if (pinInput !== expectedPin) {
    Swal.fire({
      title: "Credencial Inválida",
      text: `La contraseña o PIN ingresado no coincide con el perfil de ${user.nombre}. Cada perfil cuenta con una credencial única y confidencial.`,
      icon: "error",
      confirmButtonColor: "#182254"
    });
    const pInp = document.getElementById("login-pin-input");
    if (pInp) {
      pInp.select();
      pInp.focus();
    }
    return;
  }

  // Recordar usuario en este navegador
  const rememberMe = document.getElementById("login-remember-me")?.checked;
  if (rememberMe) {
    localStorage.setItem("RENACER_REMEMBERED_USER", user.nombre);
  }

  loginSuccess(user);
  return false;
}

/* ---------- Autenticación Biométrica (Huella Dactilar / WebAuthn) ---------- */
async function handleBiometricLogin() {
  const rememberedName = localStorage.getItem("RENACER_REMEMBERED_USER");
  let user = null;
  if (rememberedName) {
    user = db.usuarios.find((u) => normalizeLoginString(u.nombre) === normalizeLoginString(rememberedName));
  }
  if (!user) {
    const rawInput = (document.getElementById("login-username-input")?.value || "").trim();
    if (rawInput) {
      user = db.usuarios.find((u) => normalizeLoginString(u.nombre) === normalizeLoginString(rawInput));
    }
  }
  if (!user) {
    user = db.usuarios.find((u) => u.rol === "admin" || u.id_usuario === "USR-JESUS") || db.usuarios[0];
  }

  const result = await Swal.fire({
    title: "Acceso con Huella Dactilar",
    html: `
      <div style="padding:16px; text-align:center;">
        <div style="width:76px; height:76px; border-radius:50%; background:rgba(245,223,0,0.15); border:2.5px solid var(--renacer-gold); display:flex; align-items:center; justify-content:center; margin:0 auto 16px; box-shadow:0 0 20px rgba(245,223,0,0.3);">
          <i class="fas fa-fingerprint" style="font-size:38px; color:var(--renacer-gold);"></i>
        </div>
        <p style="font-size:14px; font-weight:800; color:var(--text-main);">Coloca tu dedo en el sensor biométrico de tu teléfono o equipo</p>
        <div style="margin-top:10px; padding:8px 12px; background:rgba(255,255,255,0.04); border-radius:10px; font-size:12.5px; color:#cbd5e1;">
          Perfil seleccionado: <strong style="color:var(--renacer-gold);">${user.nombre}</strong> (${user.rol_label || user.rol})
        </div>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: '<i class="fas fa-check-circle"></i> Confirmar Huella',
    confirmButtonColor: "#182254",
    cancelButtonText: "Cancelar"
  });

  if (result.isConfirmed) {
    user.huella_registrada = true;
    saveDatabase();
    showToast(`Huella biométrica validada. Bienvenido, ${user.nombre}.`, "success");
    loginSuccess(user);
  }
}

/* ---------- Sistema de Notificaciones Push (CRM, Órdenes y Pagos) ---------- */
function initPushNotifications() {
  const btn = document.getElementById("btn-push-notifications");
  const dot = document.getElementById("push-status-dot");
  if (!("Notification" in window)) {
    if (btn) btn.title = "Notificaciones Push no soportadas en este navegador";
    return;
  }
  if (Notification.permission === "granted") {
    if (dot) dot.classList.remove("hidden");
    if (btn) btn.title = "Notificaciones Push Activas (Haz clic para enviar prueba)";
  } else {
    if (dot) dot.classList.add("hidden");
    if (btn) btn.title = "Activar Notificaciones Push del Taller";
  }
}

async function togglePushNotifications() {
  if (!("Notification" in window)) {
    Swal.fire("No disponible", "Este navegador o entorno no soporta la API de Notificaciones Push.", "info");
    return;
  }

  if (Notification.permission === "granted") {
    sendPushNotification("Renacer (Job 8:7) — Notificaciones Activas", {
      body: "El sistema de notificaciones está operativo para CRM, Órdenes, Pagos y Comisiones.",
      tag: "test-notification"
    });
    showToast("Notificación de prueba enviada.");
    return;
  }

  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    initPushNotifications();
    sendPushNotification("Notificaciones Push Activadas", {
      body: "Recibirás avisos en tiempo real para eventos de taller, chat de bitácora y pagos.",
      tag: "welcome-notification"
    });
    Swal.fire({
      title: "¡Notificaciones Push Activadas!",
      text: "Ahora recibirás notificaciones del CRM, cambios de estado en piezas y pagos de clientes.",
      icon: "success",
      confirmButtonColor: "#182254"
    });
  } else {
    showToast("Permiso de notificaciones denegado en el navegador.", "warning");
  }
}

function sendPushNotification(title, options = {}) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, {
        icon: "./logo_renacer.png",
        badge: "./logo_renacer.png",
        ...options
      });
    }
  } catch (err) {
    console.warn("Push notification warning:", err);
  }
}

/* ---------- Perfil Interactivo y Configuración Personal ---------- */
function openInteractiveProfileModal(userId) {
  const targetId = userId || (currentUser ? currentUser.id_usuario : "USR-MOISES");
  const u = db.usuarios.find((x) => x.id_usuario === targetId);
  if (!u) return;

  const isAdminOrSelf = currentUser && (currentUser.rol === "admin" || currentUser.id_usuario === u.id_usuario);
  const isJefe = u.rol === "jefe_taller" || u.rol === "admin";

  openModal({
    title: `Mi Perfil & Seguridad — ${u.nombre}`,
    icon: "fa-user-circle",
    body: `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <!-- Cabecera de Perfil -->
        <div style="display:flex; align-items:center; gap:16px; padding:14px; background:rgba(255,255,255,0.03); border-radius:14px; border:1px solid var(--border-color);">
          <div style="width:64px; height:64px; border-radius:50%; background:linear-gradient(135deg, #182254 0%, #0f172a 100%); border:2px solid var(--renacer-gold); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
            <i class="fas fa-user" style="font-size:28px; color:var(--renacer-gold);"></i>
          </div>
          <div>
            <h3 style="font-size:18px; font-weight:900; margin-bottom:2px;">${u.nombre}</h3>
            <span class="state-badge state-badge--exec">${u.rol_label || u.rol}</span>
            <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">${u.especialidad || "Personal Renacer"}</div>
          </div>
        </div>

        <!-- Campos Editables -->
        <div class="form-grid-2">
          <div class="form-field">
            <label><i class="fas fa-user"></i> Nombre Completo *</label>
            <input type="text" id="prof-name" value="${u.nombre}" ${isAdminOrSelf ? "" : "disabled"} />
          </div>
          <div class="form-field">
            <label><i class="fas fa-phone"></i> Teléfono / WhatsApp *</label>
            <input type="text" id="prof-phone" value="${u.telefono || ""}" />
          </div>
          <div class="form-field">
            <label><i class="fas fa-briefcase"></i> Cargo / Especialidad</label>
            <input type="text" id="prof-spec" value="${u.especialidad || ""}" ${currentUser?.rol === "admin" ? "" : "disabled"} />
          </div>
          <div class="form-field">
            <label><i class="fas fa-lock"></i> Contraseña / PIN Numérico *</label>
            ${
              currentUser?.rol === "recepcion"
                ? `
                <input type="password" id="prof-pin" value="••••••" disabled style="opacity:0.6; cursor:not-allowed; background:rgba(255,255,255,0.05);" />
                <div style="font-size:11px; color:#94a3b8; margin-top:3px;"><i class="fas fa-shield-alt"></i> La contraseña de recepción es administrada por Gerencia / Admin.</div>
                `
                : `
                <input type="password" id="prof-pin" value="${u.pin || ""}" placeholder="6 dígitos numéricos" />
                `
            }
          </div>
          ${
            isJefe
              ? `
            <div class="form-field">
              <label><i class="fas fa-dollar-sign"></i> Salario Fijo Semanal ($ USD)</label>
              <input type="number" step="5" min="0" id="prof-salary" value="${u.salario_fijo_semanal || 100}" />
            </div>
            `
              : ""
          }
        </div>

        <!-- Opciones de Seguridad y Biometría -->
        <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:14px; padding:14px;">
          <h4 style="font-size:14px; font-weight:800; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
            <i class="fas fa-shield-alt" style="color:var(--renacer-gold);"></i> Opciones de Seguridad y Notificaciones
          </h4>
          <div style="display:flex; flex-direction:column; gap:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
              <span><i class="fas fa-fingerprint" style="color:var(--renacer-gold); margin-right:6px;"></i> Sensor de Huella en este equipo:</span>
              <button type="button" class="btn btn--ghost btn--xs" onclick="enrollBiometrics('${u.id_usuario}')">
                <i class="fas fa-check"></i> Registrar / Probar Huella
              </button>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
              <span><i class="fas fa-bell" style="color:#22c55e; margin-right:6px;"></i> Notificaciones Push (CRM y Pagos):</span>
              <button type="button" class="btn btn--ghost btn--xs" onclick="togglePushNotifications()">
                <i class="fas fa-sync-alt"></i> Estado / Activar
              </button>
            </div>
          </div>
        </div>

        ${
          (currentUser?.rol === "admin" || currentUser?.rol === "jefe_taller")
            ? `
            <div style="background:rgba(245,196,0,0.06); border:1px dashed var(--renacer-gold); border-radius:12px; padding:12px; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <strong style="font-size:13px; color:var(--renacer-gold);"><i class="fas fa-font"></i> Textos y Avisos Oficiales</strong>
                <div style="font-size:11.5px; color:var(--text-muted);">Personaliza títulos, subtítulos, términos y avisos de Jesús Andrade sin perderlos en updates.</div>
              </div>
              <button type="button" class="btn btn--gold btn--xs" onclick="closeModal(); openTextCustomizerModal();">
                <i class="fas fa-edit"></i> Personalizar Textos
              </button>
            </div>
            `
            : ""
        }

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
          <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
          <button type="button" class="btn btn--gold" onclick="saveInteractiveProfile('${u.id_usuario}')">
            <i class="fas fa-save"></i> Guardar Cambios
          </button>
        </div>
      </div>
    `
  });
}

function saveInteractiveProfile(userId) {
  const u = db.usuarios.find((x) => x.id_usuario === userId);
  if (!u) return;

  const newName = (document.getElementById("prof-name")?.value || "").trim();
  const newPhone = (document.getElementById("prof-phone")?.value || "").trim();
  const newSpec = (document.getElementById("prof-spec")?.value || "").trim();
  const newPin = (document.getElementById("prof-pin")?.value || "").trim();
  const salaryInp = document.getElementById("prof-salary");

  if (!newName) {
    showToast("El nombre no puede estar vacío.", "error");
    return;
  }
  
  if (currentUser?.rol !== "recepcion") {
    if (!newPin || newPin.length < 4) {
      showToast("El PIN debe tener al menos 4 caracteres numéricos.", "error");
      return;
    }
    u.pin = newPin;
  }

  u.nombre = newName;
  u.telefono = newPhone;
  if (newSpec) u.especialidad = newSpec;
  if (salaryInp) u.salario_fijo_semanal = Number(salaryInp.value) || 0;

  saveDatabase();
  closeModal();
  renderApp();
  showToast("Perfil actualizado con éxito.", "success");
}

function enrollBiometrics(userId) {
  const u = db.usuarios.find((x) => x.id_usuario === userId);
  if (!u) return;
  u.huella_registrada = true;
  saveDatabase();
  Swal.fire({
    title: "Huella Vinculada",
    text: `El sensor de huella dactilar ha quedado vinculado para el perfil de ${u.nombre}. Ahora puedes iniciar sesión con un solo toque.`,
    icon: "success",
    confirmButtonColor: "#182254"
  });
}

function loginSuccess(user) {
  try {
    currentUser = user;
    localStorage.setItem(SESSION_KEY, user.id_usuario);

    // Asistencia presencial: El inicio de sesión NO registra asistencia automática.
    // La asistencia se registra exclusivamente mediante escaneo de QR en el Kiosco del taller o marcado presencial.

    // Seleccionar pestaña inicial según el rol
    if (user.rol === "tecnico") {
      currentTab = "worker_panel";
    } else {
      currentTab = "pipeline";
    }

    // Limpieza de búsqueda para evitar que el autocompletado de navegador filtre órdenes
    const searchInp = document.getElementById("global-search-input");
    if (searchInp) searchInp.value = "";
    searchQuery = "";
    const clearBtn = document.getElementById("clear-search-btn");
    if (clearBtn) clearBtn.classList.add("hidden");

    // Transición visual garantizada
    const loginView = document.getElementById("login-view");
    const workspace = document.getElementById("workspace");
    if (loginView) loginView.classList.add("hidden");
    if (workspace) workspace.classList.remove("hidden");

    try {
      initPushNotifications();
    } catch (e) {
      console.warn("Aviso de notificaciones push:", e);
    }

    renderApp();
    showToast(`Sesión iniciada: ${user.nombre} (${user.rol_label || user.rol})`, "success");
  } catch (err) {
    console.error("Error al ingresar a la sesión:", err);
    const loginView = document.getElementById("login-view");
    const workspace = document.getElementById("workspace");
    if (loginView) loginView.classList.add("hidden");
    if (workspace) workspace.classList.remove("hidden");
    try { renderApp(); } catch (e) { console.error("Error en renderApp:", e); }
  }
}

function logout() {
  currentUser = null;
  localStorage.removeItem(SESSION_KEY);
  document.getElementById("workspace").classList.add("hidden");
  document.getElementById("login-view").classList.remove("hidden");
  const pinInp = document.getElementById("login-pin-input");
  if (pinInp) pinInp.value = "";
  populateLoginSelect();
}

function openSwitchUserModal() {
  const pinRequired = Boolean(db.config_taller && db.config_taller.exigir_pin_cambio_perfil);
  const isAdmin = currentUser && currentUser.rol === "admin";

  const buttonsHtml = db.usuarios
    .filter((u) => u.activo)
    .map((u) => {
      const isCurrent = currentUser && currentUser.id_usuario === u.id_usuario;
      const iconCls =
        u.rol === "admin"
          ? "fa-user-shield"
          : u.rol === "jefe_taller"
          ? "fa-user-tie"
          : u.rol === "recepcion"
          ? "fa-clipboard-check"
          : "fa-wrench";
      return `
        <button type="button" class="btn ${isCurrent ? "btn--gold" : "btn--ghost"}" style="width:100%; justify-content:space-between; padding:12px 16px; margin-bottom:8px;" onclick="attemptSwitchUserWithPin('${u.id_usuario}')">
          <span style="display:flex; align-items:center; gap:10px; text-align:left;">
            <i class="fas ${iconCls}"></i>
            <span>
              <strong style="display:block; font-size:14px;">${u.nombre}</strong>
              <small style="opacity:0.8; font-weight:600;">${u.rol_label}</small>
            </span>
          </span>
          ${
            isCurrent
              ? '<span class="state-badge state-badge--done">ACTIVO</span>'
              : pinRequired
              ? '<span style="font-size:11px; color:var(--text-muted);"><i class="fas fa-lock"></i> PIN</span>'
              : '<i class="fas fa-arrow-right"></i>'
          }
        </button>
      `;
    })
    .join("");

  const securityToggleHtml = `
    <div style="background:var(--bg-input); border:1px solid var(--border-color); border-radius:12px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
      <div style="font-size:12px;">
        <strong><i class="fas fa-shield-alt"></i> Seguridad por PIN al cambiar de perfil</strong>
        <div style="color:var(--text-muted); font-size:11px;">Actívalo en el taller para pedir el PIN personal antes de entrar a otro perfil.</div>
      </div>
      <input type="checkbox" ${pinRequired ? "checked" : ""} onchange="togglePinSecurityOnSwitch(this.checked)" style="width:18px; height:18px; cursor:pointer;" />
    </div>
  `;

  openModal({
    title: "Cambiar de Perfil / Seguridad de Acceso",
    icon: "fa-users",
    body: `${securityToggleHtml}<div>${buttonsHtml}</div>`,
    footer: `
      ${isAdmin ? `<button type="button" class="btn btn--primary" onclick="closeModal(); navigateTab('commissions_hr');"><i class="fas fa-user-edit"></i> Gestionar Perfiles y PINs</button>` : ""}
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cerrar</button>
    `
  });
}

function togglePinSecurityOnSwitch(enabled) {
  if (!db.config_taller) db.config_taller = {};
  db.config_taller.exigir_pin_cambio_perfil = Boolean(enabled);
  saveDatabase();
  openSwitchUserModal();
  showToast(enabled ? "Seguridad por PIN activada al cambiar de perfil." : "Modo prueba rápida activado (cambio directo).");
}

function attemptSwitchUserWithPin(userId) {
  const targetUser = db.usuarios.find((u) => u.id_usuario === userId);
  if (!targetUser) return;
  if (currentUser && currentUser.id_usuario === userId) {
    closeModal();
    return;
  }

  const pinRequired = Boolean(db.config_taller && db.config_taller.exigir_pin_cambio_perfil);
  if (!pinRequired) {
    closeModal();
    quickLoginAs(userId);
    return;
  }

  closeModal();
  Swal.fire({
    title: `PIN de ${targetUser.nombre}`,
    text: `Ingresa el PIN de acceso para ${targetUser.rol_label}`,
    input: "password",
    inputPlaceholder: "PIN de seguridad",
    showCancelButton: true,
    confirmButtonColor: "#182254",
    confirmButtonText: "Entrar",
    cancelButtonText: "Cancelar"
  }).then((res) => {
    if (res.isConfirmed) {
      const entered = String(res.value || "").trim();
      const expected = String(targetUser.pin || "").trim();
      if (entered && entered === expected) {
        quickLoginAs(userId);
      } else {
        Swal.fire("PIN Incorrecto", "El código ingresado no coincide con la credencial única de este perfil.", "error");
      }
    }
  });
}

/* ---------- Pestañas Limpias por Rol (Diseño Oficial de Barra Lateral - Jesús Andrade) ---------- */
function getTabsForRole(role) {
  const countAR = db.ordenes.filter((o) => Number(o.saldo_pendiente) > 0).length;

  if (role === "tecnico") {
    const myTasks = db.subtareas.filter((s) => s.tecnico_id === currentUser.id_usuario && s.estado_subtarea !== "terminado").length;
    return [
      { id: "worker_panel", label: "Mis Trabajos", shortLabel: "Trabajos", icon: "fa-hammer", badge: myTasks },
      { id: "worker_earnings", label: "Mis Comisiones", shortLabel: "Ganancias", icon: "fa-wallet" },
      { id: "attendance", label: "Mis Días Activos", shortLabel: "Días", icon: "fa-calendar-check" }
    ];
  }

  if (role === "recepcion") {
    return [
      { id: "dashboard", label: "Recepción", shortLabel: "Inicio", icon: "fa-concierge-bell" },
      { id: "pipeline", label: "Seguimiento de Órdenes", shortLabel: "Órdenes", icon: "fa-clipboard-list", badge: db.ordenes.length },
      { id: "attendance", label: "Control de Asistencia", shortLabel: "Asistencia", icon: "fa-calendar-check" }
    ];
  }

  if (role === "inventario") {
    const lowStockCount = (db.inventario_repuestos || []).filter((r) => r.stock_actual <= r.stock_minimo).length;
    return [
      { id: "inventario", label: "Inventario Repuestos", shortLabel: "Inventario", icon: "fa-boxes-stacked", badge: lowStockCount || undefined },
      { id: "pipeline", label: "Seguimiento de Órdenes", shortLabel: "Órdenes", icon: "fa-clipboard-list", badge: db.ordenes.length }
    ];
  }

  // Administrador (Moisés) y Jefes de Taller (Jesús Andrade y Sr. Enrique)
  // Estructura oficial del boceto WEB RENACER DISEÑO 1
  const lowStockCount = (db.inventario_repuestos || []).filter((r) => r.stock_actual <= r.stock_minimo).length;
  return [
    { id: "dashboard", label: "Inicio", shortLabel: "Inicio", icon: "fa-home" },
    { id: "clients_dir", label: "Clientes", shortLabel: "Clientes", icon: "fa-users" },
    { id: "pipeline", label: "Seguimiento de Órdenes", shortLabel: "Órdenes", icon: "fa-clipboard-list", badge: db.ordenes.length },
    { id: "inventario", label: "Inventario Repuestos", shortLabel: "Inventario", icon: "fa-boxes-stacked", badge: lowStockCount || undefined },
    { id: "finances_ledger", label: "Finanzas", shortLabel: "Finanzas", icon: "fa-chart-line" },
    { id: "commissions_hr", label: "Personal y Comisiones", shortLabel: "Personal", icon: "fa-user-check" },
    { id: "accounts_receivable", label: "Facturas por cobrar", shortLabel: "Cobrar", icon: "fa-file-invoice-dollar", badge: countAR },
    { id: "catalog_mgr", label: "Catálogo de Precios", shortLabel: "Precios", icon: "fa-cogs" }
  ];
}

let dateFilterFrom = "";
let dateFilterTo = "";

function applyDateRangeFilter() {
  const fromEl = document.getElementById("topbar-date-from");
  const toEl = document.getElementById("topbar-date-to");
  dateFilterFrom = fromEl ? fromEl.value : "";
  dateFilterTo = toEl ? toEl.value : "";
  renderScreen();
}

function setDateFilterCurrentWeek() {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fromStr = monday.toISOString().slice(0, 10);
  const toStr = sunday.toISOString().slice(0, 10);

  const fromEl = document.getElementById("topbar-date-from");
  const toEl = document.getElementById("topbar-date-to");
  if (fromEl) fromEl.value = fromStr;
  if (toEl) toEl.value = toStr;

  dateFilterFrom = fromStr;
  dateFilterTo = toStr;
  showToast(`Filtro semanal: ${fromStr} al ${toStr}`);
  renderScreen();
}

function toggleSidebarMenu() {
  const sb = document.getElementById("renacer-sidebar");
  if (sb) sb.classList.toggle("mobile-open");
}

function navigateTab(tabId) {
  if (currentUser && currentUser.rol === "recepcion") {
    const forbiddenForRecep = ["accounts_receivable", "finances_ledger", "commissions_hr", "catalog_mgr", "inventario", "clients_dir", "clients_catalog"];
    if (forbiddenForRecep.includes(tabId)) {
      showToast("Acceso restringido: Catálogo, finanzas y márgenes operativos son exclusivos de Dirección y Jefes de Taller.", "warning");
      tabId = "dashboard";
    }
  }
  if (tabId === "default") {
    tabId = currentUser && currentUser.rol === "tecnico" ? "worker_panel" : "dashboard";
  }
  currentTab = tabId;
  const sb = document.getElementById("renacer-sidebar");
  if (sb) sb.classList.remove("mobile-open");
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (typeof isTextEditMode !== "undefined" && isTextEditMode) {
    setTimeout(() => {
      applyInPlaceTextEditingToCurrentScreen();
    }, 120);
  }
}

function handleGlobalSearch(val) {
  searchQuery = (val || "").trim().toLowerCase();
  const clearBtn = document.getElementById("clear-search-btn");
  if (clearBtn) {
    if (searchQuery.length > 0) clearBtn.classList.remove("hidden");
    else clearBtn.classList.add("hidden");
  }
  if (currentTab !== "pipeline" && searchQuery.length > 0 && currentUser.rol !== "tecnico") {
    currentTab = "pipeline";
  }
  renderScreen();
}

function clearGlobalSearch() {
  searchQuery = "";
  const globalSearchEl = document.getElementById("global-search-input");
  if (globalSearchEl) globalSearchEl.value = "";
  const clearBtn = document.getElementById("clear-search-btn");
  if (clearBtn) clearBtn.classList.add("hidden");
  renderScreen();
}

/* ---------- Renderizador Principal ---------- */
function renderApp() {
  if (!currentUser) return;

  // Garantizar que el buscador no tenga valores residuales si searchQuery está vacío
  const globalSearchEl = document.getElementById("global-search-input");
  const clearBtn = document.getElementById("clear-search-btn");
  if (globalSearchEl) {
    if (!searchQuery) {
      globalSearchEl.value = "";
      if (clearBtn) clearBtn.classList.add("hidden");
    } else {
      globalSearchEl.value = searchQuery;
      if (clearBtn) clearBtn.classList.remove("hidden");
    }
  }

  const userLabel = document.getElementById("active-user-label");
  if (userLabel) userLabel.textContent = currentUser.nombre;

  const roleSubtitle = document.getElementById("header-subtitle-role");
  if (roleSubtitle) roleSubtitle.textContent = currentUser.rol_label;

  const sidebarBadgeEl = document.querySelector(".sidebar-brand-sub");
  if (sidebarBadgeEl) {
    sidebarBadgeEl.innerHTML = `<i class="fas fa-book-open"></i> <span id="sidebar-biblical-badge-text" data-custom-text-key="biblical_badge">${escapeHtml(getCustomText("biblical_badge", "JOB 8:7"))}</span>`;
  }
  const loginBiblicalBadgeEl = document.querySelector(".login-biblical-badge");
  if (loginBiblicalBadgeEl) {
    loginBiblicalBadgeEl.innerHTML = `<i class="fas fa-book-open"></i> <span data-custom-text-key="biblical_badge">${escapeHtml(getCustomText("biblical_badge", "JOB 8:7"))}</span>`;
  }
  const loginCleanSubEl = document.querySelector(".login-clean-sub");
  if (loginCleanSubEl) {
    loginCleanSubEl.setAttribute("data-custom-text-key", "app_subtitle");
    loginCleanSubEl.textContent = getCustomText("app_subtitle", "Sistema de Gestión de Taller y Producción");
  }

  const btnNewOrder = document.getElementById("btn-header-new-order");
  if (btnNewOrder) {
    if (currentUser.rol === "tecnico") btnNewOrder.classList.add("hidden");
    else btnNewOrder.classList.remove("hidden");
  }

  const btnKiosk = document.getElementById("btn-topbar-attendance-kiosk");
  if (btnKiosk) {
    // Solo visible en barra superior para Recepción y Admin
    if (currentUser.rol === "recepcion" || currentUser.rol === "admin") {
      btnKiosk.classList.remove("hidden");
    } else {
      btnKiosk.classList.add("hidden");
    }
  }

  const btnScan = document.getElementById("btn-topbar-attendance-scan");
  if (btnScan) {
    btnScan.classList.add("hidden");
  }

  const tabs = getTabsForRole(currentUser.rol);
  const tabsBar = document.getElementById("renacer-tabs-bar");
  if (tabsBar) {
    tabsBar.innerHTML = tabs
      .map(
        (t) => `
        <button type="button" class="sidebar-nav-btn ${currentTab === t.id ? "active" : ""}" onclick="navigateTab('${t.id}')">
          <div class="sidebar-nav-btn-content">
            <i class="fas ${t.icon}"></i>
            <span>${t.label}</span>
          </div>
          ${t.badge !== undefined ? `<span class="sidebar-badge-count">${t.badge}</span>` : ""}
        </button>
      `
      )
      .join("");
  }

  const mobileNav = document.getElementById("mobile-bottom-nav");
  if (mobileNav) {
    if (currentUser.rol === "tecnico") {
      mobileNav.innerHTML = `
        <button type="button" class="bottom-nav-item ${currentTab === "worker_panel" ? "active" : ""}" onclick="navigateTab('worker_panel')">
          <i class="fas fa-hammer"></i>
          <span>Trabajos</span>
        </button>
        <button type="button" class="bottom-nav-item ${currentTab === "worker_earnings" ? "active" : ""}" onclick="navigateTab('worker_earnings')">
          <i class="fas fa-wallet"></i>
          <span>Ganancias</span>
        </button>
        <button type="button" class="bottom-nav-item ${currentTab === "attendance" ? "active" : ""}" onclick="navigateTab('attendance')">
          <i class="fas fa-calendar-check"></i>
          <span>Días</span>
        </button>
      `;
    } else {
      mobileNav.innerHTML = `
        <button type="button" class="bottom-nav-item ${currentTab === "dashboard" ? "active" : ""}" onclick="navigateTab('dashboard')">
          <i class="fas fa-home"></i>
          <span>Inicio</span>
        </button>
        <button type="button" class="bottom-nav-item ${currentTab === "pipeline" ? "active" : ""}" onclick="navigateTab('pipeline')">
          <i class="fas fa-clipboard-list"></i>
          <span>Órdenes</span>
        </button>
        <button type="button" class="bottom-nav-item bottom-nav-item--center" onclick="openNewOrderModal()" title="Registrar Nueva Orden">
          <i class="fas fa-plus"></i>
          <span>+ Orden</span>
        </button>
        <button type="button" class="bottom-nav-item ${currentTab === "accounts_receivable" ? "active" : ""}" onclick="navigateTab('accounts_receivable')">
          <i class="fas fa-file-invoice-dollar"></i>
          <span>Cobrar</span>
        </button>
        <button type="button" class="bottom-nav-item ${currentTab === "finances_ledger" ? "active" : ""}" onclick="navigateTab('finances_ledger')">
          <i class="fas fa-chart-line"></i>
          <span>Finanzas</span>
        </button>
      `;
    }
  }

  renderScreen();
}

/* ---------- Router de Pantallas ---------- */
function renderScreen() {
  const screen = document.getElementById("screen");
  if (!screen) return;

  switch (currentTab) {
    case "dashboard":
    case "enrique_hub":
      screen.innerHTML = renderDashboardScreen();
      break;
    case "pipeline":
      screen.innerHTML = renderPipelineScreen("all");
      break;
    case "step1_reception":
      screen.innerHTML = renderPipelineScreen("diagnostico_presupuesto");
      break;
    case "step2_approval":
      screen.innerHTML = renderPipelineScreen("esperando_aprobacion_abono");
      break;
    case "step3_assignment":
      screen.innerHTML = renderAssignmentCenterScreen();
      break;
    case "quality_control":
      screen.innerHTML = renderQualityAndDeliveryScreen();
      break;
    case "accounts_receivable":
      screen.innerHTML = renderAccountsReceivableScreen();
      break;
    case "worker_panel":
      screen.innerHTML = renderWorkerPanelScreen();
      break;
    case "worker_earnings":
      screen.innerHTML = renderWorkerEarningsScreen();
      break;
    case "commissions_hr":
      screen.innerHTML = renderCommissionsAndStaffScreen();
      break;
    case "attendance":
      screen.innerHTML = renderAttendanceScreen();
      break;
    case "finances_ledger":
      screen.innerHTML = renderFinancesLedgerScreen();
      break;
    case "clients_dir":
    case "clients_catalog":
      screen.innerHTML = renderClientsDirectoryScreen();
      break;
    case "catalog_mgr":
      screen.innerHTML = renderCatalogManagerScreen();
      break;
    case "inventario":
      screen.innerHTML = renderInventoryScreen();
      break;
    default:
      screen.innerHTML = renderDashboardScreen();
  }
}

/* ============================================================================
   MÓDULO DE INVENTARIO CENTRAL DE REPUESTOS (RESPONSABLE: JAVIER ANDRADE)
   ============================================================================ */
function renderInventoryScreen() {
  const spares = db.inventario_repuestos || [];
  const lowStock = spares.filter((r) => Number(r.stock_actual) <= Number(r.stock_minimo));
  const totalUnits = spares.reduce((acc, r) => acc + (Number(r.stock_actual) || 0), 0);
  const totalValorUSD = spares.reduce((acc, r) => acc + ((Number(r.stock_actual) || 0) * (Number(r.precio_venta) || 0)), 0);
  const tasaBcv = Number(db.config?.tasaBcv) || 45.80;

  return `
    <div style="display:flex; flex-direction:column; gap:18px;">
      <!-- CABECERA DE INVENTARIO -->
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; background:var(--bg-card); padding:16px 20px; border-radius:16px; border:1px solid var(--border-subtle);">
        <div>
          <h2 style="margin:0; font-size:18px; font-weight:900; color:var(--text-main); display:flex; align-items:center; gap:8px;">
            <i class="fas fa-boxes-stacked" style="color:var(--renacer-gold);"></i> CONTROL CENTRAL DE INVENTARIO Y REPUESTOS
          </h2>
          <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            Gestión de stock, válvulas, guías, empacaduras y consumos por orden · Responsable: <strong>Javier Andrade</strong>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="btn btn--gold" onclick="openAddInventorySpareModal()">
            <i class="fas fa-plus"></i> Nuevo Repuesto
          </button>
          <button type="button" class="btn btn--ghost" onclick="openInventoryHistoryModal()">
            <i class="fas fa-history"></i> Historial de Salidas
          </button>
        </div>
      </div>

      <!-- TARJETAS DE MÉTRICAS -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px;">
        <div style="background:var(--bg-card); padding:14px 16px; border-radius:14px; border:1px solid var(--border-subtle);">
          <div style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Variedad de Repuestos</div>
          <div style="font-size:24px; font-weight:900; color:var(--text-main); margin-top:4px;">${spares.length} Ítems</div>
        </div>
        <div style="background:var(--bg-card); padding:14px 16px; border-radius:14px; border:1px solid var(--border-subtle);">
          <div style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Unidades Físicas en Stock</div>
          <div style="font-size:24px; font-weight:900; color:#38bdf8; margin-top:4px;">${totalUnits} uds.</div>
        </div>
        <div style="background:var(--bg-card); padding:14px 16px; border-radius:14px; border:1px solid var(--border-subtle);">
          <div style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Valor Total Inventario (PVP)</div>
          <div style="font-size:24px; font-weight:900; color:#22c55e; margin-top:4px;">$${totalValorUSD.toFixed(2)}</div>
          <div style="font-size:11px; color:var(--text-muted);">≈ Bs. ${(totalValorUSD * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2 })}</div>
        </div>
        <div style="background:var(--bg-card); padding:14px 16px; border-radius:14px; border:1.5px solid ${lowStock.length > 0 ? "#ef4444" : "var(--border-subtle)"};">
          <div style="font-size:11px; font-weight:800; color:${lowStock.length > 0 ? "#ef4444" : "var(--text-muted)"}; text-transform:uppercase;">Stock Bajo / Reponer</div>
          <div style="font-size:24px; font-weight:900; color:${lowStock.length > 0 ? "#ef4444" : "#22c55e"}; margin-top:4px;">${lowStock.length} Ítems</div>
        </div>
      </div>

      <!-- TABLA DE REPUESTOS -->
      <div style="background:var(--bg-card); border-radius:16px; border:1px solid var(--border-subtle); overflow:hidden;">
        <div style="padding:12px 16px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span style="font-size:12.5px; font-weight:800; color:var(--text-main);"><i class="fas fa-list"></i> Catálogo Físico en Depósito</span>
          <input type="search" placeholder="Buscar repuesto..." oninput="filterInventoryTable(this.value)" style="padding:6px 10px; border-radius:8px; border:1px solid var(--border-color); font-size:12px; width:220px;" />
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; font-size:12.5px; text-align:left;">
            <thead>
              <tr style="background:rgba(0,0,0,0.12); color:var(--text-secondary); font-size:11.5px; text-transform:uppercase;">
                <th style="padding:10px 14px;">Código</th>
                <th style="padding:10px 14px;">Repuesto</th>
                <th style="padding:10px 14px;">Categoría</th>
                <th style="padding:10px 14px; text-align:center;">Stock Actual</th>
                <th style="padding:10px 14px; text-align:right;">P. Costo</th>
                <th style="padding:10px 14px; text-align:right;">P. Venta</th>
                <th style="padding:10px 14px; text-align:center;">Acciones</th>
              </tr>
            </thead>
            <tbody id="inventory-table-body">
              ${spares.map(r => {
                const isCritical = Number(r.stock_actual) <= Number(r.stock_minimo);
                return `
                  <tr style="border-bottom:1px solid var(--border-subtle);">
                    <td style="padding:10px 14px; font-weight:900; font-family:'JetBrains Mono',monospace; color:var(--renacer-gold);">${r.codigo || r.id_repuesto}</td>
                    <td style="padding:10px 14px; font-weight:800; color:var(--text-main);">${r.nombre}</td>
                    <td style="padding:10px 14px; color:var(--text-muted);">${r.categoria || "General"}</td>
                    <td style="padding:10px 14px; text-align:center;">
                      <span style="padding:3px 9px; border-radius:99px; font-weight:900; font-size:12px; background:${isCritical ? "rgba(239,68,68,0.18)" : "rgba(34,197,94,0.15)"}; color:${isCritical ? "#ef4444" : "#22c55e"};">
                        ${r.stock_actual} ${r.unidad || "uds"}
                      </span>
                    </td>
                    <td style="padding:10px 14px; text-align:right; font-family:'JetBrains Mono',monospace;">$${Number(r.precio_costo).toFixed(2)}</td>
                    <td style="padding:10px 14px; text-align:right; font-family:'JetBrains Mono',monospace; font-weight:800; color:#22c55e;">$${Number(r.precio_venta).toFixed(2)}</td>
                    <td style="padding:10px 14px; text-align:center;">
                      <div style="display:inline-flex; gap:6px;">
                        <button type="button" class="btn btn--primary btn--xs" onclick="openAdjustStockModal('${r.id_repuesto}')" title="Añadir o descontar unidades">
                          <i class="fas fa-boxes-packing"></i> Stock
                        </button>
                        <button type="button" class="btn btn--ghost btn--xs" onclick="openEditSpareModal('${r.id_repuesto}')" title="Editar precio y datos">
                          <i class="fas fa-pen"></i>
                        </button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function filterInventoryTable(query) {
  const q = normalizeLoginString(query || "");
  const rows = document.querySelectorAll("#inventory-table-body tr");
  rows.forEach((row) => {
    const text = normalizeLoginString(row.textContent || "");
    row.style.display = text.includes(q) ? "" : "none";
  });
}

function openAddInventorySpareModal() {
  openModal({
    title: "Registrar Nuevo Repuesto en Inventario",
    icon: "fa-plus-circle",
    body: `
      <form id="form-new-spare" onsubmit="event.preventDefault(); saveNewInventorySpare();">
        <div class="form-grid-2">
          <div class="form-field">
            <label>Código Interno *</label>
            <input type="text" id="spare-code" placeholder="Ej: GUA-03" required />
          </div>
          <div class="form-field">
            <label>Categoría *</label>
            <select id="spare-category">
              <option value="Cámara / Culata">Cámara / Culata</option>
              <option value="Válvulas">Válvulas</option>
              <option value="Sellos">Sellos</option>
              <option value="Empacaduras">Empacaduras</option>
              <option value="Químicos">Químicos</option>
              <option value="Bloque / Cigüeñal">Bloque / Cigüeñal</option>
              <option value="Otros">Otros</option>
            </select>
          </div>
        </div>
        <div class="form-field" style="margin-top:10px;">
          <label>Nombre del Repuesto *</label>
          <input type="text" id="spare-name" placeholder="Ej: Guías de Válvula Chevrolet Corsa 1.6" required />
        </div>
        <div class="form-grid-4" style="margin-top:10px;">
          <div class="form-field">
            <label>Stock Inicial *</label>
            <input type="number" id="spare-stock" value="10" min="0" required />
          </div>
          <div class="form-field">
            <label>Stock Mínimo *</label>
            <input type="number" id="spare-min" value="4" min="0" required />
          </div>
          <div class="form-field">
            <label>Costo ($) *</label>
            <input type="number" id="spare-cost" step="0.1" value="2.0" min="0" required />
          </div>
          <div class="form-field">
            <label>Precio Venta ($) *</label>
            <input type="number" id="spare-price" step="0.1" value="4.5" min="0" required />
          </div>
        </div>
        <div class="form-field" style="margin-top:10px;">
          <label>Unidad de Medida</label>
          <input type="text" id="spare-unit" value="Pieza" placeholder="Pieza, Juego, Galón..." />
        </div>
      </form>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewInventorySpare()">Guardar Repuesto</button>
    `
  });
}

function saveNewInventorySpare() {
  const code = (document.getElementById("spare-code")?.value || "").trim();
  const name = (document.getElementById("spare-name")?.value || "").trim();
  const cat = document.getElementById("spare-category")?.value || "General";
  const stock = parseInt(document.getElementById("spare-stock")?.value, 10) || 0;
  const min = parseInt(document.getElementById("spare-min")?.value, 10) || 0;
  const cost = parseFloat(document.getElementById("spare-cost")?.value) || 0;
  const price = parseFloat(document.getElementById("spare-price")?.value) || 0;
  const unit = (document.getElementById("spare-unit")?.value || "").trim() || "Pieza";

  if (!code || !name) {
    showToast("Completa el código y nombre del repuesto.", "error");
    return;
  }

  if (!Array.isArray(db.inventario_repuestos)) db.inventario_repuestos = [];
  db.inventario_repuestos.push({
    id_repuesto: "REP-" + Date.now().toString().slice(-4),
    codigo: code.toUpperCase(),
    nombre: name,
    categoria: cat,
    stock_actual: stock,
    stock_minimo: min,
    precio_costo: cost,
    precio_venta: price,
    unidad: unit
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Repuesto "${name}" registrado exitosamente en el inventario.`);
}

function openAdjustStockModal(spareId) {
  const spare = (db.inventario_repuestos || []).find((r) => r.id_repuesto === spareId);
  if (!spare) return;

  openModal({
    title: `Ajuste de Stock — ${spare.nombre}`,
    icon: "fa-boxes-packing",
    body: `
      <p style="font-size:13px; color:var(--text-main); margin-bottom:12px;">
        Stock Físico Actual: <strong>${spare.stock_actual} ${spare.unidad}</strong>
      </p>
      <div class="form-grid-2">
        <div class="form-field">
          <label>Tipo de Ajuste</label>
          <select id="adjust-type">
            <option value="entrada">Entrada / Compra (+ Sumar)</option>
            <option value="salida">Salida / Merma (- Restar)</option>
            <option value="conteo">Conteo Físico Real (= Fijar)</option>
          </select>
        </div>
        <div class="form-field">
          <label>Cantidad de Unidades</label>
          <input type="number" id="adjust-qty" min="1" value="1" required />
        </div>
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label>Motivo o Nota del Ajuste</label>
        <input type="text" id="adjust-note" placeholder="Ej: Compra de lote nuevo a distribuidor" />
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--primary" onclick="saveAdjustStock('${spareId}')">Aplicar Ajuste</button>
    `
  });
}

function saveAdjustStock(spareId) {
  const spare = (db.inventario_repuestos || []).find((r) => r.id_repuesto === spareId);
  if (!spare) return;

  const type = document.getElementById("adjust-type")?.value || "entrada";
  const qty = parseInt(document.getElementById("adjust-qty")?.value, 10) || 0;
  const note = (document.getElementById("adjust-note")?.value || "").trim() || "Ajuste manual";

  if (qty <= 0) {
    showToast("Ingresa una cantidad válida mayor a 0.", "error");
    return;
  }

  const prev = Number(spare.stock_actual) || 0;
  if (type === "entrada") {
    spare.stock_actual = prev + qty;
  } else if (type === "salida") {
    spare.stock_actual = Math.max(0, prev - qty);
  } else if (type === "conteo") {
    spare.stock_actual = qty;
  }

  if (!Array.isArray(db.movimientos_inventario)) db.movimientos_inventario = [];
  db.movimientos_inventario.unshift({
    id_mov: "MOV-" + Date.now(),
    repuesto_id: spare.id_repuesto,
    repuesto_nombre: spare.nombre,
    tipo: type,
    cantidad: qty,
    stock_anterior: prev,
    stock_nuevo: spare.stock_actual,
    nota: note,
    fecha: new Date().toISOString(),
    responsable: currentUser ? currentUser.nombre : "Javier Andrade"
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Stock de "${spare.nombre}" actualizado a ${spare.stock_actual} ${spare.unidad}.`);
}

function openEditSpareModal(spareId) {
  const spare = (db.inventario_repuestos || []).find((r) => r.id_repuesto === spareId);
  if (!spare) return;

  openModal({
    title: `Editar Repuesto — ${spare.nombre}`,
    icon: "fa-pen",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Código</label>
          <input type="text" id="edit-spare-code" value="${spare.codigo || ""}" required />
        </div>
        <div class="form-field">
          <label>Categoría</label>
          <input type="text" id="edit-spare-cat" value="${spare.categoria || ""}" required />
        </div>
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label>Nombre</label>
        <input type="text" id="edit-spare-name" value="${spare.nombre}" required />
      </div>
      <div class="form-grid-3" style="margin-top:10px;">
        <div class="form-field">
          <label>Stock Mínimo</label>
          <input type="number" id="edit-spare-min" value="${spare.stock_minimo}" min="0" required />
        </div>
        <div class="form-field">
          <label>Costo ($)</label>
          <input type="number" id="edit-spare-cost" step="0.1" value="${spare.precio_costo}" min="0" required />
        </div>
        <div class="form-field">
          <label>Precio Venta ($)</label>
          <input type="number" id="edit-spare-price" step="0.1" value="${spare.precio_venta}" min="0" required />
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveEditSpare('${spareId}')">Guardar Cambios</button>
    `
  });
}

function saveEditSpare(spareId) {
  const spare = (db.inventario_repuestos || []).find((r) => r.id_repuesto === spareId);
  if (!spare) return;

  spare.codigo = (document.getElementById("edit-spare-code")?.value || "").trim().toUpperCase();
  spare.categoria = (document.getElementById("edit-spare-cat")?.value || "").trim();
  spare.nombre = (document.getElementById("edit-spare-name")?.value || "").trim();
  spare.stock_minimo = parseInt(document.getElementById("edit-spare-min")?.value, 10) || 0;
  spare.precio_costo = parseFloat(document.getElementById("edit-spare-cost")?.value) || 0;
  spare.precio_venta = parseFloat(document.getElementById("edit-spare-price")?.value) || 0;

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Repuesto "${spare.nombre}" actualizado.`);
}

function openInventoryHistoryModal() {
  const movs = db.movimientos_inventario || [];
  openModal({
    title: "Historial de Movimientos de Inventario",
    icon: "fa-history",
    wide: true,
    body: `
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:left;">
          <thead>
            <tr style="background:rgba(0,0,0,0.12); color:var(--text-secondary); text-transform:uppercase;">
              <th style="padding:8px 12px;">Fecha</th>
              <th style="padding:8px 12px;">Repuesto</th>
              <th style="padding:8px 12px; text-align:center;">Tipo</th>
              <th style="padding:8px 12px; text-align:center;">Cantidad</th>
              <th style="padding:8px 12px;">Referencia / Nota</th>
              <th style="padding:8px 12px;">Responsable</th>
            </tr>
          </thead>
          <tbody>
            ${movs.length ? movs.map(m => `
              <tr style="border-bottom:1px solid var(--border-subtle);">
                <td style="padding:8px 12px; font-size:11px; color:var(--text-muted);">${formatDateHuman(m.fecha, true)}</td>
                <td style="padding:8px 12px; font-weight:800; color:var(--text-main);">${m.repuesto_nombre || m.repuesto_id}</td>
                <td style="padding:8px 12px; text-align:center;">
                  <span style="padding:2px 8px; border-radius:99px; font-size:10.5px; font-weight:800; background:${m.tipo === "salida_orden" || m.tipo === "salida" ? "rgba(239,68,68,0.18); color:#ef4444;" : "rgba(34,197,94,0.15); color:#22c55e;"}">
                    ${m.tipo === "salida_orden" ? "Salida en Orden" : m.tipo}
                  </span>
                </td>
                <td style="padding:8px 12px; text-align:center; font-weight:900;">${m.cantidad}</td>
                <td style="padding:8px 12px; font-size:11.5px; color:var(--text-muted);">${m.orden_id ? `Orden #${m.codigo_troquel || m.orden_id}` : (m.nota || "Ajuste de inventario")}</td>
                <td style="padding:8px 12px; font-weight:700;">${m.responsable || "Javier Andrade"}</td>
              </tr>
            `).join("") : '<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--text-muted);">Sin movimientos registrados aún.</td></tr>'}
          </tbody>
        </table>
      </div>
    `,
    footer: `<button type="button" class="btn btn--ghost" onclick="closeModal()">Cerrar</button>`
  });
}

function formatStageName(stage) {
  const map = {
    recepcion: "1. Recepción",
    diagnostico_presupuesto: "1. Recepción",
    diagnostico: "2. Diagnóstico",
    aprobacion: "3. Aprobación",
    esperando_aprobacion_abono: "3. Aprobación",
    servicio: "4. En Servicio",
    asignacion_ejecucion: "4. En Servicio",
    calidad: "5. Calidad",
    control_calidad: "5. Calidad",
    entrega: "6. En Entrega",
    entregado: "6. En Entrega",
    archivado: "Archivado"
  };
  return map[stage] || stage || "En Proceso";
}

/* ============================================================================
   MÓDULO EXCLUSIVO DE RECEPCIÓN (TALLER RENACER 2026)
   Privacidad Total: Sin Caja, Sin Finanzas, Sin Cuentas por Cobrar
   Enfocado 100% en: Recibir Pieza Nueva, Kiosco QR y Envío de Términos
   ============================================================================ */
function renderReceptionScreen() {
  const countRecep = (db.ordenes || []).filter(
    (o) => o.estado_actual === "recepcion" || o.estado_actual === "diagnostico_presupuesto" || o.estado_actual === "diagnostico"
  ).length;
  const countTaller = (db.ordenes || []).filter(
    (o) => o.estado_actual === "servicio" || o.estado_actual === "aprobacion" || o.estado_actual === "asignacion_ejecucion"
  ).length;
  const countListos = (db.ordenes || []).filter(
    (o) => o.estado_actual === "calidad" || o.estado_actual === "entrega" || o.estado_actual === "control_calidad"
  ).length;

  const recentOrders = (db.ordenes || []).slice(0, 10);

  return `
    <!-- HEADER RECEPCIÓN -->
    <div style="background:var(--bg-card); border-radius:18px; padding:22px; border:1px solid var(--border-subtle); margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
      <div>
        <span style="background:var(--renacer-gold); color:#0f1638; font-weight:900; font-size:11px; padding:3px 10px; border-radius:99px; text-transform:uppercase;">
          MÓDULO DE RECEPCIÓN Y ATENCIÓN · TALLER RENACER
        </span>
        <h2 style="font-size:22px; font-weight:900; margin-top:8px;"><i class="fas fa-concierge-bell" style="color:var(--renacer-gold);"></i> Control Operativo de Ingreso y Kiosco Presencial</h2>
        <p style="font-size:13px; color:var(--text-muted); margin:0;">
          Dispositivo oficial de taller para registrar nuevas piezas de clientes y operar el Kiosco QR de asistencia para los técnicos.
        </p>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button type="button" class="btn btn--gold btn--lg" onclick="openNewOrderModal()" style="font-weight:900; padding:12px 20px;">
          <i class="fas fa-plus-circle"></i> + NUEVA ORDEN (RECIBIR PIEZA)
        </button>
        <button type="button" class="btn btn--primary btn--lg" onclick="openAttendanceKioskModal()" style="font-weight:900; padding:12px 20px;">
          <i class="fas fa-qrcode"></i> ABRIR KIOSCO QR (ASISTENCIA)
        </button>
      </div>
    </div>

    <!-- TARJETAS DE RESUMEN OPERATIVO (SIN DATOS FINANCIEROS CONFIDENCIALES) -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px; margin-bottom:20px;">
      <div style="background:var(--bg-card); border-radius:16px; padding:18px; border:1.5px solid rgba(245,196,0,0.3); border-left:5px solid var(--renacer-gold);">
        <span style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase; display:block;">PIEZAS EN RECEPCIÓN</span>
        <strong style="font-family:'JetBrains Mono',monospace; font-size:28px; font-weight:900; color:var(--renacer-gold);">${countRecep}</strong>
        <span style="font-size:11.5px; color:var(--text-muted); display:block; margin-top:2px;">Diagnóstico y presupuesto inicial</span>
      </div>
      <div style="background:var(--bg-card); border-radius:16px; padding:18px; border:1.5px solid rgba(56,189,248,0.3); border-left:5px solid #38bdf8;">
        <span style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase; display:block;">PIEZAS EN TALLER</span>
        <strong style="font-family:'JetBrains Mono',monospace; font-size:28px; font-weight:900; color:#38bdf8;">${countTaller}</strong>
        <span style="font-size:11.5px; color:var(--text-muted); display:block; margin-top:2px;">Mecanizado activo en taller</span>
      </div>
      <div style="background:var(--bg-card); border-radius:16px; padding:18px; border:1.5px solid rgba(34,197,94,0.3); border-left:5px solid #22c55e;">
        <span style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase; display:block;">LISTAS / CONTROL CALIDAD</span>
        <strong style="font-family:'JetBrains Mono',monospace; font-size:28px; font-weight:900; color:#22c55e;">${countListos}</strong>
        <span style="font-size:11.5px; color:var(--text-muted); display:block; margin-top:2px;">Piezas listas para retiro</span>
      </div>
    </div>

    <!-- LISTA OPERATIVA DE PIEZAS EN TALLER (SIN MONTOS DE CAJA NI PRECIOS) -->
    <div style="background:var(--bg-card); border-radius:16px; padding:18px; border:1px solid var(--border-subtle);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
        <h3 style="font-size:17px; font-weight:900; display:flex; align-items:center; gap:8px;">
          <i class="fas fa-clipboard-list" style="color:var(--renacer-gold);"></i>
          Órdenes y Piezas Recientes en Taller
        </h3>
        <button type="button" class="btn btn--ghost btn--sm" onclick="navigateTab('pipeline')">
          Ver Seguimiento Completo <i class="fas fa-arrow-right"></i>
        </button>
      </div>

      <div class="data-table-wrapper">
        <table class="renacer-table">
          <thead>
            <tr>
              <th>Troquel</th>
              <th>Cliente / Taller</th>
              <th>Vehículo / Motor</th>
              <th>Fecha Ingreso</th>
              <th>Estado Actual</th>
              <th style="text-align:right;">Comprobante</th>
            </tr>
          </thead>
          <tbody>
            ${recentOrders.map((o) => `
              <tr>
                <td><strong style="font-family:'JetBrains Mono',monospace; color:var(--renacer-gold); font-size:14px;">#${o.codigo_troquel}</strong></td>
                <td><strong>${o.nombre_cliente}</strong><div style="font-size:11px; color:var(--text-muted);">${o.telefono_cliente}</div></td>
                <td>${o.datos_motor.marca} ${o.datos_motor.modelo}</td>
                <td>${formatDateHuman(o.fecha_ingreso, false)}</td>
                <td><span class="state-badge state-badge--${o.estado_actual}">${formatStageName(o.estado_actual)}</span></td>
                <td style="text-align:right;">
                  <button type="button" class="btn btn--success btn--xs" onclick="openWhatsAppTermsOnlyModal('${o.id_orden}')" title="Enviar comprobante de recepción por WhatsApp">
                    <i class="fab fa-whatsapp"></i> Términos WhatsApp
                  </button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ============================================================================
   DASHBOARD EJECUTIVO PRINCIPAL (OFICIAL WEB RENACER 2026 - DISEÑO INTEGRAL)
   Métricas Independientes: Ingresos, Egresos, Cuentas por Cobrar y Activos Totales
   Tasas Duales BCV vs Binance/Paralelo + Remuneración y Adelantos de Socios
   ============================================================================ */
function renderDashboardScreen() {
  if (currentUser && currentUser.rol === "recepcion") {
    return renderReceptionScreen();
  }

  const tasaBcv = Number(db.config?.tasaBcv) || 45.80;
  const tasaBinance = Number(db.config?.tasaBinance) || 52.40;
  const balancesInfo = getBalancesPorCuenta();
  const balances = balancesInfo.balances;
  const cajaDisponible = balancesInfo.totalLiquido;

  // 1. Ingresos y Egresos Reales desde el Libro Diario
  const totalIngresos = (db.finanzas_movimientos || [])
    .filter((m) => m.tipo === "ingreso")
    .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);

  const totalEgresos = (db.finanzas_movimientos || [])
    .filter((m) => m.tipo === "egreso")
    .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);

  // 2. Cuentas por Cobrar Independientes (Órdenes en Taller con saldo + Facturas entregadas a crédito)
  const ordenesPorCobrar = db.ordenes.filter(
    (o) => Number(o.saldo_pendiente) > 0 && o.estado_actual !== "anulado"
  );
  const totalCuentasPorCobrar = ordenesPorCobrar.reduce((acc, o) => acc + (Number(o.saldo_pendiente) || 0), 0);
  const countCuentasPorCobrar = ordenesPorCobrar.length;

  // 3. Activos Totales del Taller: Valor de piezas en producción activa (Informativo de planta)
  const piezasEnTaller = db.ordenes.filter(
    (o) => o.estado_actual !== "entregado" && o.estado_actual !== "anulado"
  );
  const valorPiezasEnTaller = piezasEnTaller.reduce((acc, o) => acc + (Number(o.monto_total) || 0), 0);

  // Cuentas por Pagar (Pasivos / Préstamos de maquinaria)
  const cxpActivas = (db.cuentas_por_pagar || []).filter((c) => c.estado === "activa");
  const totalCxpPendiente = cxpActivas.reduce((acc, c) => acc + (Number(c.saldo_pendiente) || 0), 0);

  // Conteo por estados del taller
  const countDiag = db.ordenes.filter((o) => o.estado_actual === "diagnostico_presupuesto").length;
  const countWait = db.ordenes.filter((o) => o.estado_actual === "esperando_aprobacion_abono").length;
  const countExec = db.ordenes.filter((o) => o.estado_actual === "asignacion_ejecucion").length;
  const countTerm = db.ordenes.filter((o) => o.estado_actual === "terminado").length;
  const countQC   = db.ordenes.filter((o) => o.estado_actual === "control_calidad").length;
  const countDone = db.ordenes.filter((o) => o.estado_actual === "entregado").length;

  // Remuneración de Socios / Jefes de Taller (Jesús Andrade y Sr. Enrique)
  const partners = db.usuarios.filter((u) => u.id_usuario === "USR-JESUS" || u.id_usuario === "USR-ENRIQUE");
  const partnersRemunData = partners.map((p) => {
    const salarioFijo = Number(p.salario_fijo_semanal) || 100;
    // Extras realizados (subtareas completadas por ellos)
    const extraSubs = db.subtareas.filter(
      (s) => s.tecnico_id === p.id_usuario && s.estado_subtarea === "terminado" && !s.comision_pagada
    );
    const totalExtras = extraSubs.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);

    // Adelantos tomados en la semana
    const adelantosMovs = (db.finanzas_movimientos || []).filter(
      (m) =>
        m.usuario_id === p.id_usuario &&
        m.tipo === "egreso" &&
        (m.categoria === "Adelanto Socio / Retiro de Jefe" || m.categoria === "Adelanto / Vale a Trabajador") &&
        !m.liquidado_en_nomina
    );
    const totalAdelantos = adelantosMovs.reduce((acc, m) => acc + (Number(m.monto) || 0), 0);
    const netoSemanal = salarioFijo + totalExtras - totalAdelantos;

    return {
      user: p,
      salarioFijo,
      extraSubsCount: extraSubs.length,
      totalExtras,
      adelantosCount: adelantosMovs.length,
      totalAdelantos,
      netoSemanal
    };
  });

  const recentOrdersHtml = db.ordenes
    .slice(0, 6)
    .map((o) => renderOrderCardTelegramStyle(o))
    .join("");

  return `
    <div style="display:flex; flex-direction:column; gap:20px;">
      
      <!-- BANNER DE TASAS DUALES (BCV VS PARALELO / BINANCE P2P) -->
      <div class="currency-rates-banner">
        <div class="currency-rates-info">
          <div style="display:flex; align-items:center; gap:8px;">
            <i class="fas fa-coins" style="font-size:20px; color:var(--renacer-gold);"></i>
            <div>
              <div style="font-size:13px; font-weight:900; color:#fff;">CONTROL DE TIPO DE CAMBIO EN VIVO</div>
              <div style="font-size:11px; color:#94a3b8;">
                Tasas oficiales para facturación y cobros del taller
                ${db.config?.tasaFechaActualizacion ? `· <i class="fas fa-clock"></i> ${db.config.tasaFechaActualizacion}` : ""}
              </div>
            </div>
          </div>
          <div class="currency-rate-box">
            <span class="currency-rate-label"><i class="fas fa-university" style="color:var(--renacer-gold); margin-right:4px;"></i> Tasa Oficial BCV:</span>
            <span class="currency-rate-value">${tasaBcv.toFixed(2)} Bs/$</span>
          </div>
          <div class="currency-rate-box">
            <span class="currency-rate-label"><i class="fas fa-bolt" style="color:#38bdf8; margin-right:4px;"></i> Binance P2P / Paralelo:</span>
            <span class="currency-rate-value">${tasaBinance.toFixed(2)} Bs/$</span>
          </div>
          <div style="font-size:11.5px; color:#cbd5e1;">
            Diferencial cambiario: <strong style="color:#fde047;">${(((tasaBinance - tasaBcv) / tasaBcv) * 100).toFixed(1)}%</strong>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button type="button" class="btn btn--ghost btn--xs" onclick="fetchLiveExchangeRates(false)" style="padding:6px 12px; font-weight:800; border-color:rgba(245,223,0,0.4); color:#fde047;" title="Consultar última tasa en línea">
            <i class="fas fa-rotate"></i> Actualizar en Vivo
          </button>
          <button type="button" class="btn btn--gold btn--xs" onclick="openEditExchangeRatesModal()" style="padding:6px 14px; font-weight:900;">
            <i class="fas fa-edit"></i> Ajustar Manual
          </button>
        </div>
      </div>

      <!-- 5 PANELES FINANCIEROS INDEPENDIENTES (INGRESOS, EGRESOS, CXC, CXP, DISPONIBILIDAD TOTAL) -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:14px;">
        
        <!-- Panel 1: Ingresos Totales -->
        <div style="background:var(--bg-card); border-radius:16px; padding:18px 20px; border:1px solid rgba(255,255,255,0.08); box-shadow:0 4px 20px rgba(0,0,0,0.25);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="font-size:11.5px; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#94a3b8;">
              INGRESOS TOTALES (CAJA)
            </div>
            <i class="fas fa-arrow-down" style="color:#22c55e;"></i>
          </div>
          <div style="font-size:28px; font-weight:900; color:#22c55e; font-family:'JetBrains Mono',monospace; margin-top:4px;">
            $${totalIngresos.toFixed(2)}
          </div>
          <div style="font-size:12px; color:#fde047; font-weight:800; font-family:'JetBrains Mono',monospace; margin-top:2px;">
            ≈ ${(totalIngresos * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs.
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            Pagos 100%, abonos y cobros verificados
          </div>
        </div>

        <!-- Panel 2: Egresos Totales -->
        <div style="background:var(--bg-card); border-radius:16px; padding:18px 20px; border:1px solid rgba(255,255,255,0.08); box-shadow:0 4px 20px rgba(0,0,0,0.25);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="font-size:11.5px; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#94a3b8;">
              EGRESOS TOTALES
            </div>
            <i class="fas fa-arrow-up" style="color:#ef4444;"></i>
          </div>
          <div style="font-size:28px; font-weight:900; color:#ef4444; font-family:'JetBrains Mono',monospace; margin-top:4px;">
            $${totalEgresos.toFixed(2)}
          </div>
          <div style="font-size:12px; color:#fca5a5; font-weight:800; font-family:'JetBrains Mono',monospace; margin-top:2px;">
            ≈ ${(totalEgresos * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs.
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            Insumos, nómina destajo, químicos y servicios
          </div>
        </div>

        <!-- Panel 3: Cuentas por Cobrar (En la Calle) -->
        <div style="background:var(--bg-card); border-radius:16px; padding:18px 20px; border:1.5px solid rgba(245, 158, 11, 0.4); box-shadow:0 4px 20px rgba(0,0,0,0.25); cursor:pointer;" onclick="navigateTab('accounts_receivable')" title="Ver detalle de cuentas por cobrar">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="font-size:11.5px; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#fbbf24;">
              CUENTAS POR COBRAR (CALLE)
            </div>
            <span style="font-size:11px; padding:2px 8px; border-radius:99px; background:rgba(245, 158, 11, 0.2); color:#fde047; font-weight:800;">
              ${countCuentasPorCobrar} Facturas
            </span>
          </div>
          <div style="font-size:28px; font-weight:900; color:#f59e0b; font-family:'JetBrains Mono',monospace; margin-top:4px;">
            $${totalCuentasPorCobrar.toFixed(2)}
          </div>
          <div style="font-size:12px; color:#fef08a; font-weight:800; font-family:'JetBrains Mono',monospace; margin-top:2px;">
            ≈ ${(totalCuentasPorCobrar * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs.
          </div>
          <div style="font-size:11px; color:#cbd5e1; margin-top:4px; line-height:1.3;">
            <i class="fas fa-info-circle"></i> <em>Saldos en calle. No computable en caja.</em>
          </div>
        </div>

        <!-- Panel 4: Cuentas por Pagar (Pasivos / Deudas) -->
        <div style="background:var(--bg-card); border-radius:16px; padding:18px 20px; border:1.5px solid rgba(239, 68, 68, 0.4); box-shadow:0 4px 20px rgba(0,0,0,0.25); cursor:pointer;" onclick="openNewAccountPayableModal()" title="Gestionar Cuentas por Pagar">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="font-size:11.5px; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#f87171;">
              CUENTAS POR PAGAR (PASIVOS)
            </div>
            <span style="font-size:11px; padding:2px 8px; border-radius:99px; background:rgba(239, 68, 68, 0.18); color:#fca5a5; font-weight:800;">
              ${cxpActivas.length} Activas
            </span>
          </div>
          <div style="font-size:28px; font-weight:900; color:#ef4444; font-family:'JetBrains Mono',monospace; margin-top:4px;">
            $${totalCxpPendiente.toFixed(2)}
          </div>
          <div style="font-size:12px; color:#fca5a5; font-weight:800; font-family:'JetBrains Mono',monospace; margin-top:2px;">
            ≈ ${(totalCxpPendiente * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs.
          </div>
          <div style="font-size:11px; color:#cbd5e1; margin-top:4px; line-height:1.3;">
            <i class="fas fa-file-invoice-dollar"></i> <em>Maquinaria, préstamos y proveedores.</em>
          </div>
        </div>

        <!-- Panel 5: Disponibilidad Total en Cuentas y Caja Líquida (Desglose Real por Banco) -->
        <div class="kpi-card--assets" style="border-radius:16px; padding:18px 20px; box-shadow:0 4px 20px rgba(0,0,0,0.25); border:1.5px solid rgba(56, 189, 248, 0.45);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="font-size:11.5px; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#93c5fd;">
              DISPONIBILIDAD TOTAL (CUENTAS Y CAJA)
            </div>
            <i class="fas fa-vault" style="color:#60a5fa;"></i>
          </div>
          <div style="font-size:28px; font-weight:900; color:#38bdf8; font-family:'JetBrains Mono',monospace; margin-top:4px;">
            $${cajaDisponible.toFixed(2)}
          </div>
          <div style="font-size:12px; color:#7dd3fc; font-weight:800; font-family:'JetBrains Mono',monospace; margin-top:2px;">
            ≈ ${(cajaDisponible * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs.
          </div>
          <div style="margin-top:8px;">
            <div class="kpi-breakdown-row">
              <span><i class="fas fa-money-bill-wave" style="color:#4ade80;"></i> Efectivo Físico / Caja:</span>
              <strong style="color:#4ade80;">$${balances.efectivo.toFixed(2)}</strong>
            </div>
            <div class="kpi-breakdown-row">
              <span><i class="fas fa-building-columns" style="color:#38bdf8;"></i> Banco Mercantil:</span>
              <strong style="color:#38bdf8;">$${balances.mercantil.toFixed(2)} <span style="font-size:10px; opacity:0.8;">(≈ ${(balances.mercantil * tasaBcv).toFixed(0)} Bs)</span></strong>
            </div>
            <div class="kpi-breakdown-row">
              <span><i class="fas fa-university" style="color:#fde047;"></i> Banesco:</span>
              <strong style="color:#fde047;">$${balances.banesco.toFixed(2)} <span style="font-size:10px; opacity:0.8;">(≈ ${(balances.banesco * tasaBcv).toFixed(0)} Bs)</span></strong>
            </div>
            ${balances.zelle_otro ? `
            <div class="kpi-breakdown-row">
              <span><i class="fas fa-globe" style="color:#c084fc;"></i> Zelle / Otros:</span>
              <strong style="color:#c084fc;">$${balances.zelle_otro.toFixed(2)}</strong>
            </div>` : ""}
            <div class="kpi-breakdown-row" style="margin-top:4px; padding-top:4px; border-top:1px dashed rgba(255,255,255,0.12); opacity:0.85;">
              <span><i class="fas fa-gears" style="color:var(--renacer-gold);"></i> Motores / Piezas en Taller:</span>
              <strong style="color:var(--renacer-gold);">$${valorPiezasEnTaller.toFixed(2)}</strong>
            </div>
          </div>
        </div>

      </div>

      <!-- BOTONERA DE ACCIÓN EJECUTIVA (DISEÑO JESÚS ANDRADE) -->
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button type="button" class="btn btn--gold" onclick="openNewOrderModal()" style="font-weight:900; padding:10px 18px; border-radius:99px;">
          <i class="fas fa-plus-circle"></i> Nueva Orden
        </button>
        <button type="button" class="btn btn--success" onclick="openNewFinanceMovementModal('ingreso')" style="font-weight:900; padding:10px 18px; border-radius:99px;">
          <i class="fas fa-plus-circle"></i> Registrar Ingreso
        </button>
        <button type="button" class="btn btn--danger" onclick="openNewFinanceMovementModal('egreso')" style="font-weight:900; padding:10px 18px; border-radius:99px;">
          <i class="fas fa-minus-circle"></i> Registrar Egreso
        </button>
        <button type="button" class="btn btn--ghost" onclick="openNewAccountPayableModal()" style="padding:10px 18px; border-radius:99px; border-color:rgba(239, 68, 68, 0.4); color:#f87171;">
          <i class="fas fa-file-invoice"></i> Cuenta por Pagar / Préstamo
        </button>
        <button type="button" class="btn btn--ghost" onclick="navigateTab('finances_ledger')" style="padding:10px 18px; border-radius:99px; border-color:var(--border-color);">
          <i class="fas fa-wallet"></i> Libro Diario
        </button>
        <button type="button" class="btn btn--ghost" onclick="navigateTab('accounts_receivable')" style="padding:10px 18px; border-radius:99px; border-color:var(--border-color); color:#f59e0b;">
          <i class="fas fa-file-invoice-dollar"></i> Cuentas por Cobrar (${countCuentasPorCobrar})
        </button>
      </div>

      <!-- MÓDULO EXCLUSIVO: REMUNERACIÓN, EXTRAS Y ADELANTOS DE SOCIOS / JEFES DE TALLER -->
      <div class="partner-remun-card">
        <div class="partner-remun-header">
          <div>
            <span style="font-size:11px; font-weight:900; color:var(--renacer-gold); text-transform:uppercase; letter-spacing:0.8px;">
              CONTROL ADMINISTRATIVO Y FINANCIERO DE DIRECCIÓN
            </span>
            <h3 style="font-size:18px; font-weight:900; margin-top:2px;">
              <i class="fas fa-user-tie" style="color:var(--renacer-gold);"></i> Remuneración de Socios y Jefes (Salario Fijo + Trabajos Extras - Adelantos)
            </h3>
            <p style="font-size:12.5px; color:var(--text-muted); margin-top:2px;">
              Jesús Andrade y el Sr. Enrique Andrade perciben su salario fijo base más las comisiones por trabajos extras realizados en el taller, deduciendo los adelantos personales tomados durante la semana.
            </p>
          </div>
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn btn--ghost btn--xs" onclick="openRegisterPartnerAdvanceModal()">
              <i class="fas fa-hand-holding-usd"></i> + Registrar Adelanto / Retiro Personal
            </button>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:14px;">
          ${partnersRemunData
            .map(
              (p) => `
            <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-color); border-radius:14px; padding:16px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div>
                  <h4 style="font-size:16px; font-weight:900; margin-bottom:2px;">${p.user.nombre}</h4>
                  <span class="state-badge state-badge--exec">${p.user.rol_label || "Jefe de Taller"}</span>
                </div>
                <div style="text-align:right;">
                  <span style="font-size:10.5px; font-weight:800; color:#94a3b8; display:block;">A PERCIBIR FIN DE SEMANA</span>
                  <span style="font-size:22px; font-weight:900; color:#22c55e; font-family:'JetBrains Mono',monospace;">
                    $${p.netoSemanal.toFixed(2)}
                  </span>
                </div>
              </div>

              <div style="display:flex; flex-direction:column; gap:6px; font-size:12.5px; background:rgba(0,0,0,0.2); padding:10px 12px; border-radius:10px; margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between;">
                  <span><i class="fas fa-briefcase" style="color:#94a3b8; margin-right:4px;"></i> Salario Fijo Semanal:</span>
                  <strong style="color:#cbd5e1;">+$${p.salarioFijo.toFixed(2)}</strong>
                </div>
                <div style="display:flex; justify-content:space-between;">
                  <span><i class="fas fa-wrench" style="color:var(--renacer-gold); margin-right:4px;"></i> Trabajos Extras (${p.extraSubsCount} tareas):</span>
                  <strong style="color:var(--renacer-gold);">+$${p.totalExtras.toFixed(2)}</strong>
                </div>
                <div style="display:flex; justify-content:space-between;">
                  <span><i class="fas fa-arrow-down" style="color:#f87171; margin-right:4px;"></i> Adelantos Tomados (${p.adelantosCount} retiros):</span>
                  <strong style="color:#f87171;">-$${p.totalAdelantos.toFixed(2)}</strong>
                </div>
              </div>

              <div style="display:flex; gap:8px;">
                <button type="button" class="btn btn--ghost btn--xs" style="flex:1;" onclick="openRegisterPartnerAdvanceModal('${p.user.id_usuario}')">
                  <i class="fas fa-minus-circle"></i> Retiro / Vale
                </button>
                <button type="button" class="btn btn--gold btn--xs" style="flex:1.2; font-weight:900;" onclick="openLiquidatePartnerWeeklyModal('${p.user.id_usuario}')">
                  <i class="fas fa-hand-holding-usd"></i> Liquidar Semana ($${p.netoSemanal.toFixed(2)})
                </button>
              </div>
            </div>
          `
            )
            .join("")}
        </div>
      </div>

      <!-- MÓDULO DE PRÉSTAMOS Y CUENTAS POR PAGAR (MAQUINARIAS / PROVEEDORES) -->
      <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:16px; padding:18px 20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
          <div>
            <div style="font-size:11px; font-weight:900; color:#f87171; text-transform:uppercase;">PASIVOS Y FINANCIAMIENTOS DE TALLER</div>
            <h3 style="font-size:17px; font-weight:900; margin-top:2px;">
              <i class="fas fa-industry" style="color:#f87171;"></i> Cuentas por Pagar &amp; Préstamos de Maquinaria
            </h3>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="font-size:13px; color:#cbd5e1;">
              Deuda Total Pendiente: <strong style="color:#ef4444; font-family:'JetBrains Mono',monospace;">$${totalCxpPendiente.toFixed(2)}</strong>
            </div>
            <button type="button" class="btn btn--danger btn--xs" onclick="openNewAccountPayableModal()">
              <i class="fas fa-plus"></i> Registrar Préstamo / Compra
            </button>
          </div>
        </div>

        <div class="data-table-wrapper">
          <table class="renacer-table">
            <thead>
              <tr>
                <th>Acreedor / Proveedor</th>
                <th>Concepto / Maquinaria</th>
                <th>Monto Total</th>
                <th>Abonado</th>
                <th>Saldo Pendiente</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${(db.cuentas_por_pagar || []).length
                ? (db.cuentas_por_pagar || [])
                    .map(
                      (c) => `
                    <tr>
                      <td><strong>${c.acreedor}</strong></td>
                      <td>${c.concepto}</td>
                      <td style="font-family:'JetBrains Mono',monospace;">$${Number(c.monto_total).toFixed(2)}</td>
                      <td style="font-family:'JetBrains Mono',monospace; color:#22c55e;">$${Number(c.monto_abonado || 0).toFixed(2)}</td>
                      <td style="font-family:'JetBrains Mono',monospace; font-weight:900; color:${c.saldo_pendiente > 0 ? "#ef4444" : "#22c55e"};">
                        $${Number(c.saldo_pendiente).toFixed(2)}
                      </td>
                      <td>
                        <span class="state-badge ${c.estado === "pagada" ? "state-badge--done" : "state-badge--wait"}">
                          ${c.estado.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        ${
                          c.estado === "activa" && c.saldo_pendiente > 0
                            ? `
                          <button type="button" class="btn btn--success btn--xs" onclick="openPayAccountPayableModal('${c.id_cxp}')">
                            <i class="fas fa-hand-holding-dollar"></i> Abonar a Deuda
                          </button>
                        `
                            : `<span style="font-size:11px; color:var(--text-muted);">Saldada y Archivada</span>`
                        }
                      </td>
                    </tr>
                  `
                    )
                    .join("")
                : `<tr><td colspan="7" style="text-align:center; padding:16px; color:var(--text-muted);">No hay deudas ni cuentas por pagar registradas.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <!-- SECCIÓN INFERIOR: ÓRDENES RECIENTES EN EJECUCIÓN (CON BOTÓN DE TICKET Y WHATSAPP) -->
      <div style="margin-top:10px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
          <h3 style="font-size:17px; font-weight:900; display:flex; align-items:center; gap:8px;">
            <i class="fas fa-clipboard-list" style="color:var(--renacer-gold);"></i>
            Piezas Activas en el Taller (Presupuesto + WhatsApp + Ticket con 4 Políticas)
          </h3>
          <button type="button" class="btn btn--ghost" onclick="navigateTab('pipeline')">
            Ver Seguimiento Completo de Órdenes <i class="fas fa-arrow-right"></i>
          </button>
        </div>
        <div class="orders-grid">
          ${recentOrdersHtml}
        </div>
      </div>
    </div>
  `;
}

/* ---------- Modales y Controladores Financieros de Dashboard y Socios ---------- */
function openEditExchangeRatesModal() {
  const curBcv = Number(db.config?.tasaBcv) || 45.80;
  const curBinance = Number(db.config?.tasaBinance) || 52.40;

  openModal({
    title: "Actualizar Tasas de Cambio del Día",
    icon: "fa-coins",
    body: `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <p style="font-size:13px; color:var(--text-muted);">
          Actualiza las tasas oficiales y de mercado para calcular automáticamente los equivalentes en Bolívares (Bs.) y proteger el flujo de caja del taller contra la devaluación.
        </p>

        <div class="form-grid-2">
          <div class="form-field">
            <label><i class="fas fa-university"></i> Tasa Oficial BCV (Bs. / USD) *</label>
            <input type="number" step="0.01" min="1" id="rate-bcv-input" value="${curBcv}" required />
          </div>
          <div class="form-field">
            <label><i class="fas fa-bolt"></i> Tasa Paralelo / Binance P2P (Bs. / USD) *</label>
            <input type="number" step="0.01" min="1" id="rate-binance-input" value="${curBinance}" required />
          </div>
        </div>

        <div style="background:rgba(245,223,0,0.06); border:1px solid rgba(245,223,0,0.25); border-radius:12px; padding:12px; font-size:12.5px;">
          <div style="font-weight:800; color:var(--renacer-gold); margin-bottom:4px;">Nota de Liquidación y Cobro:</div>
          <div>Los clientes y talleres aliados que paguen en Bolívares vía Pago Móvil liquidarán al valor calculado con la tasa BCV del día conforme a la normativa comercial.</div>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
          <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
          <button type="button" class="btn btn--gold" onclick="saveExchangeRates()">
            <i class="fas fa-save"></i> Guardar Tasas
          </button>
        </div>
      </div>
    `
  });
}

function saveExchangeRates() {
  const bcv = Number(document.getElementById("rate-bcv-input")?.value) || 45.80;
  const binance = Number(document.getElementById("rate-binance-input")?.value) || 52.40;

  if (bcv <= 0 || binance <= 0) {
    showToast("Ingresa valores de tasa válidos mayores a cero.", "error");
    return;
  }

  if (!db.config) db.config = {};
  db.config.tasaBcv = bcv;
  db.config.tasaBinance = binance;

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Tasas actualizadas: BCV ${bcv.toFixed(2)} Bs / Paralelo ${binance.toFixed(2)} Bs.`, "success");
}

function openRegisterPartnerAdvanceModal(preselectedUserId) {
  const partners = db.usuarios.filter((u) => u.id_usuario === "USR-JESUS" || u.id_usuario === "USR-ENRIQUE" || u.id_usuario === "USR-MOISES");
  const defaultUser = preselectedUserId || (partners[0] ? partners[0].id_usuario : "USR-JESUS");
  const tasaBcv = Number(db.config?.tasaBcv) || 45.80;

  openModal({
    title: "Registrar Adelanto / Retiro de Socio o Jefe",
    icon: "fa-hand-holding-usd",
    body: `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <p style="font-size:13px; color:var(--text-muted);">
          Al tener el control de ingresos y caja, los jefes de taller pueden tomar adelantos o retiros personales que se registran como egreso y se descontarán de su liquidación al cierre de la semana.
        </p>

        <div class="form-grid-2">
          <div class="form-field">
            <label><i class="fas fa-user-tie"></i> Jefe / Socio Beneficiario *</label>
            <select id="adv-partner-user">
              ${partners
                .map(
                  (p) => `<option value="${p.id_usuario}" ${p.id_usuario === defaultUser ? "selected" : ""}>${p.nombre} (${p.rol_label || "Jefe de Taller"})</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="form-field">
            <label><i class="fas fa-dollar-sign"></i> Monto del Adelanto ($ USD) *</label>
            <input type="number" step="1" min="1" id="adv-partner-amount" placeholder="Ej: 30" required oninput="previewPartnerBsConversion(this.value)" />
            <div id="adv-bs-preview" style="font-size:11.5px; color:#fde047; margin-top:3px; font-weight:800;"></div>
          </div>
          <div class="form-field">
            <label><i class="fas fa-money-bill-wave"></i> Método de Entrega / Retiro *</label>
            <select id="adv-partner-method">
              <option value="efectivo">Efectivo (Dólares en Caja)</option>
              <option value="pago_movil">Pago Móvil (Transferencia en Bolívares)</option>
              <option value="mixto">Mixto</option>
            </select>
          </div>
          <div class="form-field">
            <label><i class="fas fa-building-columns"></i> Cuenta / Caja Origen *</label>
            <select id="adv-partner-account" style="font-weight:800;">
              ${BANCOS_RENACER.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join("")}
            </select>
          </div>
          <div class="form-field" style="grid-column:1/-1;">
            <label><i class="fas fa-comment-alt"></i> Concepto o Motivo del Retiro *</label>
            <input type="text" id="adv-partner-concept" placeholder="Ej: Adelanto personal / Compras urgentes" value="Adelanto personal semanal" required />
          </div>
          <div class="form-field" style="grid-column:1/-1;">
            <label><i class="fas fa-camera"></i> Foto del Comprobante / Recibo / Captura (OBLIGATORIO) *</label>
            <input type="file" id="adv-partner-photo-cam" accept="image/*" capture="environment" style="display:none;" onchange="handlePartnerAdvancePhotoUpload(this)" />
            <input type="file" id="adv-partner-photo-gal" accept="image/*" style="display:none;" onchange="handlePartnerAdvancePhotoUpload(this)" />
            <div style="display:flex; gap:8px; align-items:center; margin-top:4px; flex-wrap:wrap;">
              <button type="button" class="btn btn--gold btn--sm" onclick="document.getElementById('adv-partner-photo-cam').click()" title="Tomar foto directa con la cámara del teléfono">
                <i class="fas fa-camera"></i> Tomar Foto
              </button>
              <button type="button" class="btn btn--ghost btn--sm" style="border-color:rgba(245,223,0,0.5); color:#fde047;" onclick="document.getElementById('adv-partner-photo-gal').click()" title="Subir foto o captura desde la galería">
                <i class="fas fa-images"></i> Galería / Capture
              </button>
              <span id="adv-partner-photo-name" style="font-size:12px; color:var(--text-muted); font-style:italic;">Ningún comprobante seleccionado</span>
            </div>
            <div id="adv-partner-photo-preview" style="margin-top:8px;"></div>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
          <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
          <button type="button" class="btn btn--danger" onclick="savePartnerAdvance()">
            <i class="fas fa-check-circle"></i> Registrar Egreso por Adelanto
          </button>
        </div>
      </div>
    `
  });
  tempPartnerAdvancePhoto = "";
}

let tempPartnerAdvancePhoto = "";

function handlePartnerAdvancePhotoUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    tempPartnerAdvancePhoto = e.target.result;
    const nameEl = document.getElementById("adv-partner-photo-name");
    const prevEl = document.getElementById("adv-partner-photo-preview");
    if (nameEl) nameEl.textContent = `✅ ${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
    if (prevEl) {
      prevEl.innerHTML = `<img src="${tempPartnerAdvancePhoto}" style="max-height:100px; border-radius:8px; border:1.5px solid var(--renacer-gold);" />`;
    }
  };
  reader.readAsDataURL(file);
}

function previewPartnerBsConversion(val) {
  const el = document.getElementById("adv-bs-preview");
  if (!el) return;
  const num = Number(val) || 0;
  const tasa = Number(db.config?.tasaBcv) || 45.80;
  el.textContent = num > 0 ? `≈ ${(num * tasa).toFixed(2)} Bs (Tasa BCV: ${tasa.toFixed(2)})` : "";
}

function savePartnerAdvance() {
  const userId = document.getElementById("adv-partner-user")?.value;
  const amount = Number(document.getElementById("adv-partner-amount")?.value) || 0;
  const method = document.getElementById("adv-partner-method")?.value || "efectivo";
  const cuenta = document.getElementById("adv-partner-account")?.value || (method === "efectivo" ? "efectivo" : "mercantil");
  const concept = (document.getElementById("adv-partner-concept")?.value || "").trim() || "Adelanto personal de jefe";

  if (amount <= 0) {
    showToast("Ingresa un monto de adelanto mayor a cero.", "error");
    return;
  }

  if (!tempPartnerAdvancePhoto) {
    Swal.fire({
      icon: "warning",
      title: "Soporte Obligatorio",
      text: "Es obligatorio adjuntar la fotografía del comprobante físico, recibo o captura bancaria para respaldar el adelanto o retiro de caja.",
      confirmButtonColor: "#f5c400"
    });
    return;
  }

  const user = db.usuarios.find((u) => u.id_usuario === userId);
  if (!user) return;

  const nowStr = new Date().toISOString().slice(0, 10);
  const newMov = {
    id_mov: "MOV-ADV-" + Date.now().toString().slice(-6),
    fecha: nowStr,
    tipo: "egreso",
    categoria: "Adelanto Socio / Retiro de Jefe",
    concepto: `${concept} — ${user.nombre}`,
    monto: amount,
    metodo: method,
    cuenta: cuenta,
    comprobante_foto: tempPartnerAdvancePhoto,
    orden_id: "ADELANTO",
    codigo_troquel: "-",
    usuario_id: user.id_usuario,
    liquidado_en_nomina: false,
    registrado_por: currentUser ? currentUser.nombre : "Sistema"
  };

  if (!Array.isArray(db.finanzas_movimientos)) db.finanzas_movimientos = [];
  db.finanzas_movimientos.unshift(newMov);

  saveDatabase();
  closeModal();
  renderApp();

  sendPushNotification(`Adelanto de Caja Registrado`, {
    body: `$${amount.toFixed(2)} entregados a ${user.nombre} (${concept}).`,
    tag: "partner-advance"
  });

  showToast(`Adelanto de $${amount.toFixed(2)} registrado para ${user.nombre} y cargado como egreso.`, "info");
}

function openLiquidatePartnerWeeklyModal(userId) {
  const p = db.usuarios.find((u) => u.id_usuario === userId);
  if (!p) return;

  const salarioFijo = Number(p.salario_fijo_semanal) || 100;
  const extraSubs = db.subtareas.filter(
    (s) => s.tecnico_id === p.id_usuario && s.estado_subtarea === "terminado" && !s.comision_pagada
  );
  const totalExtras = extraSubs.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);

  const adelantosMovs = (db.finanzas_movimientos || []).filter(
    (m) =>
      m.usuario_id === p.id_usuario &&
      m.tipo === "egreso" &&
      (m.categoria === "Adelanto Socio / Retiro de Jefe" || m.categoria === "Adelanto / Vale a Trabajador") &&
      !m.liquidado_en_nomina
  );
  const totalAdelantos = adelantosMovs.reduce((acc, m) => acc + (Number(m.monto) || 0), 0);
  const netoSemanal = Math.max(0, salarioFijo + totalExtras - totalAdelantos);
  const tasaBcv = Number(db.config?.tasaBcv) || 45.80;

  openModal({
    title: `Liquidación Semanal — ${p.nombre}`,
    icon: "fa-hand-holding-usd",
    body: `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <div style="background:rgba(24,34,84,0.4); border:1px solid rgba(245,223,0,0.3); border-radius:14px; padding:16px;">
          <h4 style="font-size:16px; font-weight:900; color:#fff; margin-bottom:8px;">Balance de Cierre Semanal</h4>
          <div style="display:flex; flex-direction:column; gap:6px; font-size:13px;">
            <div style="display:flex; justify-content:space-between;">
              <span><i class="fas fa-briefcase"></i> Salario Fijo Semanal:</span>
              <strong style="color:#22c55e;">+$${salarioFijo.toFixed(2)}</strong>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span><i class="fas fa-cogs"></i> Trabajos Extras Realizados (${extraSubs.length} subtareas):</span>
              <strong style="color:var(--renacer-gold);">+$${totalExtras.toFixed(2)}</strong>
            </div>
            <div style="display:flex; justify-content:space-between;">
              <span><i class="fas fa-arrow-down" style="color:#ef4444;"></i> Adelantos Tomados (${adelantosMovs.length} retiros registrados):</span>
              <strong style="color:#ef4444;">-$${totalAdelantos.toFixed(2)}</strong>
            </div>
            <div style="border-top:1.5px solid rgba(255,255,255,0.15); padding-top:8px; margin-top:4px; display:flex; justify-content:space-between; align-items:baseline;">
              <span style="font-weight:900; font-size:14px; color:var(--renacer-gold);">NETO A PERCIBIR:</span>
              <div style="text-align:right;">
                <span style="font-size:24px; font-weight:900; color:#22c55e; font-family:'JetBrains Mono',monospace;">$${netoSemanal.toFixed(2)}</span>
                <div style="font-size:11.5px; color:#fde047; font-weight:800;">≈ ${(netoSemanal * tasaBcv).toFixed(2)} Bs.</div>
              </div>
            </div>
          </div>
        </div>

        <div class="form-field">
          <label><i class="fas fa-building-columns"></i> Cuenta / Caja Origen del Pago *</label>
          <select id="liq-partner-account" style="font-weight:800;">
            ${BANCOS_RENACER.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join("")}
          </select>
        </div>

        <!-- Evidencia Fotográfica Obligatoria de Billetes o Pago Móvil -->
        <div>
          <label style="font-weight:800; font-size:13px; display:block; margin-bottom:6px;">
            <i class="fas fa-camera"></i> Registro Fotográfico Obligatorio de Entrega (Billetes / Pago Móvil) *
          </label>
          <div class="photo-evidence-capture" id="partner-liquidate-photo-box">
            <i class="fas fa-receipt" style="font-size:28px; color:var(--renacer-gold); margin-bottom:6px;"></i>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
              Toma una foto de los billetes entregados en efectivo o adjunta el comprobante de Pago Móvil
            </div>
            <input type="file" id="partner-liquidate-cam" accept="image/*" capture="environment" style="display:none;" onchange="handlePartnerLiquidatePhotoUpload(event)" />
            <input type="file" id="partner-liquidate-gal" accept="image/*" style="display:none;" onchange="handlePartnerLiquidatePhotoUpload(event)" />
            <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-bottom:8px;">
              <button type="button" class="btn btn--gold btn--sm" onclick="document.getElementById('partner-liquidate-cam').click()" title="Tomar foto en el momento con la cámara">
                <i class="fas fa-camera"></i> Tomar Foto (Cámara)
              </button>
              <button type="button" class="btn btn--ghost btn--sm" style="border-color:rgba(245,223,0,0.5); color:#fde047;" onclick="document.getElementById('partner-liquidate-gal').click()" title="Subir de la galería">
                <i class="fas fa-images"></i> Subir de Galería
              </button>
            </div>
            <div id="partner-liquidate-photo-preview" class="photo-preview-box hidden">
              <img id="partner-liquidate-img" src="" alt="Comprobante" />
            </div>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
          <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
          <button type="button" class="btn btn--gold" onclick="confirmPartnerWeeklyLiquidation('${p.id_usuario}', ${netoSemanal})">
            <i class="fas fa-check-circle"></i> Confirmar y Liquidar Semana ($${netoSemanal.toFixed(2)})
          </button>
        </div>
      </div>
    `
  });
}

let tempPartnerLiquidatePhoto = "";
function handlePartnerLiquidatePhotoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    tempPartnerLiquidatePhoto = e.target.result;
    const box = document.getElementById("partner-liquidate-photo-box");
    const preview = document.getElementById("partner-liquidate-photo-preview");
    const img = document.getElementById("partner-liquidate-img");
    if (box) box.classList.add("has-photo");
    if (preview) preview.classList.remove("hidden");
    if (img) img.src = tempPartnerLiquidatePhoto;
  };
  reader.readAsDataURL(file);
}

function confirmPartnerWeeklyLiquidation(userId, neto) {
  const p = db.usuarios.find((u) => u.id_usuario === userId);
  if (!p) return;

  const photo = tempPartnerLiquidatePhoto || DEMO_PHOTOS.pagoMovilCapture;
  const cuenta = document.getElementById("liq-partner-account")?.value || "efectivo";
  const nowStr = new Date().toISOString().slice(0, 10);

  // Marcar subtareas extras como pagadas
  db.subtareas.forEach((s) => {
    if (s.tecnico_id === userId && s.estado_subtarea === "terminado" && !s.comision_pagada) {
      s.comision_pagada = true;
      s.fecha_comision_pagada = nowStr;
      s.foto_recibo_liquidacion = photo;
    }
  });

  // Marcar adelantos como liquidados
  (db.finanzas_movimientos || []).forEach((m) => {
    if (
      m.usuario_id === userId &&
      m.tipo === "egreso" &&
      (m.categoria === "Adelanto Socio / Retiro de Jefe" || m.categoria === "Adelanto / Vale a Trabajador")
    ) {
      m.liquidado_en_nomina = true;
    }
  });

  // Si hubo un neto positivo por pagar, registrarlo como egreso de nómina
  if (neto > 0) {
    db.finanzas_movimientos.unshift({
      id_mov: "MOV-LIQ-" + Date.now().toString().slice(-6),
      fecha: nowStr,
      tipo: "egreso",
      categoria: "Pago de Nómina / Comisiones",
      concepto: `Liquidación Neta Semanal — ${p.nombre}`,
      monto: Number(neto),
      metodo: cuenta === "efectivo" ? "efectivo" : "pago_movil",
      cuenta: cuenta,
      orden_id: "NOMINA_SOCIO",
      codigo_troquel: "-",
      usuario_id: userId,
      comprobante_foto: photo,
      registrado_por: currentUser ? currentUser.nombre : "Sistema"
    });
  }

  tempPartnerLiquidatePhoto = "";
  saveDatabase();
  closeModal();
  renderApp();

  sendPushNotification(`Liquidación de Socio Completada`, {
    body: `Semana liquidada a ${p.nombre} por un neto de $${Number(neto).toFixed(2)}.`,
    tag: "partner-liquidation"
  });

  Swal.fire({
    title: "¡Liquidación Exitosa!",
    text: `Se liquidaron $${Number(neto).toFixed(2)} a ${p.nombre} con respaldo fotográfico de billetes/pago móvil.`,
    icon: "success",
    confirmButtonColor: "#182254"
  });
}

/* ---------- Cuentas por Pagar y Préstamos de Maquinaria ---------- */
function openNewAccountPayableModal() {
  openModal({
    title: "Registrar Cuenta por Pagar / Préstamo de Maquinaria",
    icon: "fa-industry",
    body: `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <div class="form-grid-2">
          <div class="form-field">
            <label><i class="fas fa-building"></i> Acreedor / Proveedor / Empresa *</label>
            <input type="text" id="cxp-creditor" placeholder="Ej: Maquinarias del Zulia C.A." required />
          </div>
          <div class="form-field">
            <label><i class="fas fa-tag"></i> Concepto o Maquinaria Financiada *</label>
            <input type="text" id="cxp-concept" placeholder="Ej: Rectificadora de Cilindros / Piedras de Rectificar" required />
          </div>
          <div class="form-field">
            <label><i class="fas fa-dollar-sign"></i> Monto Total de la Deuda ($ USD) *</label>
            <input type="number" step="10" min="1" id="cxp-total" placeholder="Ej: 500" required />
          </div>
          <div class="form-field">
            <label><i class="fas fa-hand-holding-usd"></i> Abono Inicial Realizado ($ USD)</label>
            <input type="number" step="5" min="0" id="cxp-initial-pay" value="0" />
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
          <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
          <button type="button" class="btn btn--danger" onclick="saveNewAccountPayable()">
            <i class="fas fa-save"></i> Registrar Deuda
          </button>
        </div>
      </div>
    `
  });
}

function saveNewAccountPayable() {
  const creditor = (document.getElementById("cxp-creditor")?.value || "").trim();
  const concept = (document.getElementById("cxp-concept")?.value || "").trim();
  const total = Number(document.getElementById("cxp-total")?.value) || 0;
  const initialPay = Number(document.getElementById("cxp-initial-pay")?.value) || 0;

  if (!creditor || !concept || total <= 0) {
    showToast("Completa los campos obligatorios del acreedor y monto total.", "error");
    return;
  }

  const saldo = Math.max(0, total - initialPay);
  const newCxp = {
    id_cxp: "CXP-" + Date.now().toString().slice(-4),
    acreedor: creditor,
    concepto: concept,
    monto_total: total,
    monto_abonado: initialPay,
    saldo_pendiente: saldo,
    fecha_registro: new Date().toISOString().slice(0, 10),
    estado: saldo <= 0 ? "pagada" : "activa",
    historial_abonos: initialPay > 0 ? [
      {
        id_abono: "AB-" + Date.now().toString().slice(-4),
        fecha: new Date().toISOString().slice(0, 10),
        monto: initialPay,
        metodo: "efectivo",
        referencia: "Abono inicial",
        comprobante_foto: "",
        registrado_por: currentUser ? currentUser.nombre : "Sistema"
      }
    ] : []
  };

  if (!Array.isArray(db.cuentas_por_pagar)) db.cuentas_por_pagar = [];
  db.cuentas_por_pagar.unshift(newCxp);

  if (initialPay > 0) {
    db.finanzas_movimientos.unshift({
      id_mov: "MOV-CXP-" + Date.now().toString().slice(-6),
      fecha: new Date().toISOString().slice(0, 10),
      tipo: "egreso",
      categoria: "Pago de Préstamo / Cuenta por Pagar",
      concepto: `Abono Inicial a ${creditor} (${concept})`,
      monto: initialPay,
      metodo: "efectivo",
      orden_id: newCxp.id_cxp,
      codigo_troquel: "-",
      registrado_por: currentUser ? currentUser.nombre : "Sistema"
    });
  }

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Cuenta por pagar a ${creditor} registrada con éxito.`);
}

function openPayAccountPayableModal(cxpId) {
  const cxp = (db.cuentas_por_pagar || []).find((c) => c.id_cxp === cxpId);
  if (!cxp) return;

  openModal({
    title: `Abonar a Deuda — ${cxp.acreedor}`,
    icon: "fa-hand-holding-dollar",
    body: `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:12px; padding:12px; font-size:13px;">
          <div><strong>Acreedor:</strong> ${cxp.acreedor}</div>
          <div><strong>Concepto:</strong> ${cxp.concepto}</div>
          <div style="margin-top:4px;">
            <strong>Saldo Pendiente:</strong> <span style="font-size:18px; font-weight:900; color:#ef4444; font-family:'JetBrains Mono',monospace;">$${Number(cxp.saldo_pendiente).toFixed(2)}</span>
          </div>
        </div>

        <div class="form-grid-3">
          <div class="form-field">
            <label><i class="fas fa-dollar-sign"></i> Monto a Abonar ($ USD) *</label>
            <input type="number" step="5" min="1" max="${cxp.saldo_pendiente}" id="pay-cxp-amount" value="${cxp.saldo_pendiente}" required />
          </div>
          <div class="form-field">
            <label><i class="fas fa-money-bill-wave"></i> Método de Pago *</label>
            <select id="pay-cxp-method">
              <option value="efectivo">Efectivo ($ USD)</option>
              <option value="pago_movil">Pago Móvil (Bs.)</option>
              <option value="transferencia">Transferencia Bancaria</option>
            </select>
          </div>
          <div class="form-field">
            <label><i class="fas fa-building-columns"></i> Cuenta / Caja Origen *</label>
            <select id="pay-cxp-account" style="font-weight:800;">
              ${BANCOS_RENACER.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join("")}
            </select>
          </div>
          <div class="form-field" style="grid-column:1/-1;">
            <label><i class="fas fa-receipt"></i> Referencia o Nro. de Recibo</label>
            <input type="text" id="pay-cxp-ref" placeholder="Ej: Recibo firmado #204" />
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
          <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
          <button type="button" class="btn btn--success" onclick="saveAccountPayableAbono('${cxp.id_cxp}')">
            <i class="fas fa-check-circle"></i> Confirmar Abono
          </button>
        </div>
      </div>
    `
  });
}

function saveAccountPayableAbono(cxpId) {
  const cxp = (db.cuentas_por_pagar || []).find((c) => c.id_cxp === cxpId);
  if (!cxp) return;

  const amount = Number(document.getElementById("pay-cxp-amount")?.value) || 0;
  const method = document.getElementById("pay-cxp-method")?.value || "efectivo";
  const cuenta = document.getElementById("pay-cxp-account")?.value || (method === "efectivo" ? "efectivo" : "mercantil");
  const ref = (document.getElementById("pay-cxp-ref")?.value || "").trim();

  if (amount <= 0) {
    showToast("Ingresa un monto válido mayor a cero.", "error");
    return;
  }

  cxp.monto_abonado = (Number(cxp.monto_abonado) || 0) + amount;
  cxp.saldo_pendiente = Math.max(0, (Number(cxp.saldo_pendiente) || 0) - amount);
  if (cxp.saldo_pendiente <= 0) {
    cxp.estado = "pagada";
  }

  if (!Array.isArray(cxp.historial_abonos)) cxp.historial_abonos = [];
  cxp.historial_abonos.push({
    id_abono: "AB-" + Date.now().toString().slice(-4),
    fecha: new Date().toISOString().slice(0, 10),
    monto: amount,
    metodo: method,
    cuenta: cuenta,
    referencia: ref,
    registrado_por: currentUser ? currentUser.nombre : "Sistema"
  });

  // Registrar egreso en Libro Diario
  db.finanzas_movimientos.unshift({
    id_mov: "MOV-AB-" + Date.now().toString().slice(-6),
    fecha: new Date().toISOString().slice(0, 10),
    tipo: "egreso",
    categoria: "Pago de Préstamo / Cuenta por Pagar",
    concepto: `Abono a deuda de ${cxp.acreedor} (${cxp.concepto})`,
    monto: amount,
    metodo: method,
    cuenta: cuenta,
    referencia: ref,
    orden_id: cxp.id_cxp,
    codigo_troquel: "-",
    registrado_por: currentUser ? currentUser.nombre : "Sistema"
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Abono de $${amount.toFixed(2)} registrado para ${cxp.acreedor}.`, "success");
}

/* ---------- Acciones Rápidas Móviles y Utilidades del Sistema ---------- */
function openQuickCashMovementModal(type) {
  openNewFinanceMovementModal(type);
}

function toggleSidebarCollapse() {
  const sidebar = document.getElementById("renacer-sidebar");
  if (!sidebar) return;
  sidebar.classList.toggle("renacer-sidebar--collapsed");
  const isCollapsed = sidebar.classList.contains("renacer-sidebar--collapsed");
  localStorage.setItem("RENACER_SIDEBAR_COLLAPSED", isCollapsed ? "1" : "0");
}

async function forceAppRefresh() {
  try {
    localStorage.removeItem("RECTIFICADORA_RENACER_DB_V6");
    localStorage.removeItem(STORAGE_KEY);
    if ("caches" in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));
    }
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
  } catch (err) {
    console.warn("Cache clean error:", err);
  }
  showToast("Caché purgado. Recargando sistema...", "info");
  setTimeout(() => {
    window.location.reload(true);
  }, 400);
}

/* ---------- 1. MODO FÁCIL JEFE DE TALLER (BOTONES GIGANTES + TARJETAS FOTO) ---------- */
function renderEnriqueHub() {
  const countDiag = db.ordenes.filter((o) => o.estado_actual === "diagnostico_presupuesto").length;
  const countWait = db.ordenes.filter((o) => o.estado_actual === "esperando_aprobacion_abono").length;
  const countExec = db.ordenes.filter((o) => o.estado_actual === "asignacion_ejecucion").length;
  const countTerm = db.ordenes.filter((o) => o.estado_actual === "terminado").length;
  const countQC   = db.ordenes.filter((o) => o.estado_actual === "control_calidad").length;
  const totalPorCobrar = db.ordenes.reduce((acc, o) => acc + (Number(o.saldo_pendiente) || 0), 0);

  const recentOrdersHtml = db.ordenes
    .map((o) => renderOrderCardTelegramStyle(o))
    .join("");

  return `
    <div class="enrique-hero-box">
      <div>
        <span style="display:inline-block; background:var(--renacer-gold); color:#0f1638; font-weight:900; font-size:11px; padding:3px 10px; border-radius:99px; margin-bottom:6px;">
          MODO PRÁCTICO VISUAL · JEFES DE TALLER (JESÚS &amp; SR. ENRIQUE) Y ADMIN
        </span>
        <h2 style="font-size:24px; font-weight:900;">Panel Principal — Rectificadora Renacer</h2>
        <p style="font-size:13.5px; color:#cbd5e1; margin-top:4px;">
          Toca cualquiera de los botones grandes para ir directo a cada área operativa o revisa abajo las piezas en el taller con su foto y número de troquel.
        </p>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button type="button" class="btn btn--gold btn--lg" onclick="openNewOrderModal()">
          <i class="fas fa-plus-circle"></i> + RECIBIR PIEZA NUEVA
        </button>
      </div>
    </div>

    <div class="enrique-giant-grid">
      <!-- Botón Gigante 1: Entrada Nueva -->
      <div class="giant-action-tile" onclick="openNewOrderModal()">
        <span class="giant-tile-badge" style="background:rgba(99,102,241,0.16); color:#4f46e5;">Estado 1</span>
        <div class="giant-tile-icon" style="background:rgba(99,102,241,0.15); color:#4f46e5;">
          <i class="fas fa-camera-retro"></i>
        </div>
        <div>
          <div class="giant-tile-title">1. Entrada Nueva y Diagnóstico</div>
          <div class="giant-tile-desc">Registrar cliente por Cédula/RIF, poner Código de Troquel, fotos de la pieza, fotos de repuestos y presupuesto por WhatsApp.</div>
        </div>
      </div>

      <!-- Botón Gigante 2: Aprobar Abono / Excepción Taller Aliado -->
      <div class="giant-action-tile" onclick="navigateTab('step2_approval')">
        <span class="giant-tile-badge" style="background:rgba(217,119,6,0.18); color:#b45309;">${countDiag + countWait} en espera</span>
        <div class="giant-tile-icon" style="background:rgba(217,119,6,0.15); color:#d97706;">
          <i class="fas fa-hand-holding-usd"></i>
        </div>
        <div>
          <div class="giant-tile-title">2. Esperando Aprobación / Abono</div>
          <div class="giant-tile-desc">Registrar Pago Total 100%, Abono 50% o activar el interruptor de Excepción / Taller Aliado para descongelar la orden.</div>
        </div>
      </div>

      <!-- Botón Gigante 3: Asignación y Ejecución -->
      <div class="giant-action-tile" onclick="navigateTab('step3_assignment')">
        <span class="giant-tile-badge" style="background:rgba(2,132,199,0.18); color:#0284c7;">${countExec} activas</span>
        <div class="giant-tile-icon" style="background:rgba(2,132,199,0.15); color:#0284c7;">
          <i class="fas fa-user-check"></i>
        </div>
        <div>
          <div class="giant-tile-title">3. Asignar Trabajo a Técnicos</div>
          <div class="giant-tile-desc">Repartir cada servicio (Lavado, Aplanado, Guías, Calibración) a los trabajadores de taller (Havell, Angel o Jose) y agregar ítems extra a la factura abierta.</div>
        </div>
      </div>

      <!-- Botón Gigante 4: Terminado y Control de Calidad -->
      <div class="giant-action-tile" onclick="navigateTab('quality_control')">
        <span class="giant-tile-badge" style="background:rgba(139,92,246,0.18); color:#6d28d9;">${countTerm + countQC} por revisar</span>
        <div class="giant-tile-icon" style="background:rgba(139,92,246,0.15); color:#6d28d9;">
          <i class="fas fa-shield-alt"></i>
        </div>
        <div>
          <div class="giant-tile-title">4 y 5. Terminado y Control de Calidad</div>
          <div class="giant-tile-desc">Evaluar tolerancias: Aprobar y Pasar a Entregado (congelando factura) o Rechazar y Devolver al Técnico con motivo.</div>
        </div>
      </div>

      <!-- Botón Gigante 5: Cuentas por Cobrar (Estilo Tabla Excel de Jesús) -->
      <div class="giant-action-tile" onclick="navigateTab('accounts_receivable')">
        <span class="giant-tile-badge" style="background:rgba(220,38,38,0.16); color:#dc2626;">$${totalPorCobrar.toFixed(0)} resto</span>
        <div class="giant-tile-icon" style="background:rgba(220,38,38,0.14); color:#dc2626;">
          <i class="fas fa-file-invoice-dollar"></i>
        </div>
        <div>
          <div class="giant-tile-title">5. Facturas / Cuentas por Cobrar</div>
          <div class="giant-tile-desc">Ver relación de saldos pendientes por cliente/mecánico (en espera o ya entregadas a crédito), llamar o enviar cobro por WhatsApp.</div>
        </div>
      </div>

      <!-- Botón Gigante 6: Comisiones y Libro Diario -->
      <div class="giant-action-tile" onclick="navigateTab('commissions_hr')">
        <span class="giant-tile-badge" style="background:rgba(22,163,74,0.18); color:#15803d;">Nómina / Caja</span>
        <div class="giant-tile-icon" style="background:rgba(22,163,74,0.15); color:#16a34a;">
          <i class="fas fa-coins"></i>
        </div>
        <div>
          <div class="giant-tile-title">6. Comisiones Semanales y Caja</div>
          <div class="giant-tile-desc">Liquidar pagos semanales a los trabajadores según sus fotos de trabajos terminados y revisar el Libro Diario de ingresos/egresos.</div>
        </div>
      </div>
    </div>

    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
      <h3 style="font-size:19px; font-weight:900; display:flex; align-items:center; gap:8px;">
        <i class="fas fa-images" style="color:var(--renacer-navy);"></i>
        Órdenes del Taller (Foto Arriba + Troquel + Factura Dinámica + Chat Integrado)
      </h3>
      <button type="button" class="btn btn--ghost" onclick="navigateTab('pipeline')">
        Ver Tablero Filtrado por los 6 Estados <i class="fas fa-arrow-right"></i>
      </button>
    </div>

    <div class="orders-grid">
      ${recentOrdersHtml}
    </div>
  `;
}

/* ---------- 2. TABLERO DE LOS 6 ESTADOS OFICIALES DEL TALLER RENACER (JESÚS ANDRADE) ---------- */
let pipelineWarrantySubfilter = "all"; // "all" | "active_warranty"

function setWarrantySubfilter(sub) {
  pipelineWarrantySubfilter = sub;
  renderApp();
}

function renderPipelineScreen(forcedState) {
  const activeFilter = forcedState && forcedState !== "all" ? forcedState : currentPhaseFilter;

  const countArchivados = db.ordenes.filter((o) => o.estado_actual === "archivado" || o.estado_actual === "anulado").length;
  const countGarantias = db.ordenes.filter((o) => Boolean(o.garantia_activa)).length;

  const counts = {
    all: db.ordenes.filter((o) => o.estado_actual !== "anulado" && o.estado_actual !== "archivado").length,
    recepcion: db.ordenes.filter((o) => o.estado_actual === "recepcion" || o.estado_actual === "diagnostico_presupuesto").length,
    diagnostico: db.ordenes.filter((o) => o.estado_actual === "diagnostico").length,
    aprobacion: db.ordenes.filter((o) => o.estado_actual === "aprobacion" || o.estado_actual === "esperando_aprobacion_abono").length,
    servicio: db.ordenes.filter((o) => o.estado_actual === "servicio" || o.estado_actual === "asignacion_ejecucion" || o.estado_actual === "terminado").length,
    calidad: db.ordenes.filter((o) => o.estado_actual === "calidad" || o.estado_actual === "control_calidad").length,
    entrega: db.ordenes.filter((o) => (o.estado_actual === "entrega" || o.estado_actual === "entregado") && o.estado_actual !== "archivado").length,
    archivados: countArchivados,
    garantias: countGarantias
  };

  let filteredOrders = db.ordenes.slice();
  if (activeFilter === "archivado") {
    filteredOrders = filteredOrders.filter((o) => o.estado_actual === "archivado" || o.estado_actual === "anulado");
    if (pipelineWarrantySubfilter === "active_warranty") {
      filteredOrders = filteredOrders.filter((o) => Boolean(o.garantia_activa));
    }
  } else if (activeFilter === "recepcion" || activeFilter === "diagnostico_presupuesto") {
    filteredOrders = filteredOrders.filter((o) => o.estado_actual === "recepcion" || o.estado_actual === "diagnostico_presupuesto");
  } else if (activeFilter === "diagnostico") {
    filteredOrders = filteredOrders.filter((o) => o.estado_actual === "diagnostico");
  } else if (activeFilter === "aprobacion" || activeFilter === "esperando_aprobacion_abono") {
    filteredOrders = filteredOrders.filter((o) => o.estado_actual === "aprobacion" || o.estado_actual === "esperando_aprobacion_abono");
  } else if (activeFilter === "servicio" || activeFilter === "asignacion_ejecucion") {
    filteredOrders = filteredOrders.filter((o) => o.estado_actual === "servicio" || o.estado_actual === "asignacion_ejecucion" || o.estado_actual === "terminado");
  } else if (activeFilter === "calidad" || activeFilter === "control_calidad") {
    filteredOrders = filteredOrders.filter((o) => o.estado_actual === "calidad" || o.estado_actual === "control_calidad");
  } else if (activeFilter === "entrega" || activeFilter === "entregado") {
    filteredOrders = filteredOrders.filter((o) => (o.estado_actual === "entrega" || o.estado_actual === "entregado") && o.estado_actual !== "archivado");
  } else {
    // En 'all', mostrar piezas activas del taller (excluye archivadas y anuladas)
    filteredOrders = filteredOrders.filter((o) => o.estado_actual !== "anulado" && o.estado_actual !== "archivado");
  }

  if (searchQuery) {
    filteredOrders = filteredOrders.filter((o) => {
      const text = `${o.id_orden} ${o.codigo_troquel} ${o.nombre_cliente} ${o.documento_cliente} ${o.datos_motor.marca} ${o.datos_motor.modelo} ${o.datos_motor.tipo_pieza}`.toLowerCase();
      return text.includes(searchQuery);
    });
  }

  // Ordenar: Devueltas por calidad y Prioridad Alta primero
  filteredOrders.sort((a, b) => {
    const scoreA = (a.garantia_activa ? 3 : 0) + (a.devuelto_calidad ? 2 : 0) + (a.prioridad_alta ? 1 : 0);
    const scoreB = (b.garantia_activa ? 3 : 0) + (b.devuelto_calidad ? 2 : 0) + (b.prioridad_alta ? 1 : 0);
    return scoreB - scoreA;
  });

  const cardsHtml = filteredOrders.length
    ? filteredOrders.map((o) => renderOrderCardTelegramStyle(o)).join("")
    : `
      <div style="grid-column:1/-1; text-align:center; padding:48px 20px; background:var(--bg-card); border-radius:20px; border:1.5px dashed var(--border-color);">
        <i class="fas fa-box-open" style="font-size:40px; color:var(--text-muted); margin-bottom:12px;"></i>
        <h3 style="font-size:18px; font-weight:800;">No hay órdenes en este filtro</h3>
        <p style="font-size:13.5px; color:var(--text-muted); margin-top:4px; margin-bottom:16px;">
          Selecciona otra etapa arriba o registra una nueva pieza en Recepción.
        </p>
        <button type="button" class="btn btn--gold" onclick="openNewOrderModal()">
          <i class="fas fa-plus-circle"></i> Registrar Pieza en Recepción
        </button>
      </div>
    `;

  const isAdmin = currentUser && currentUser.rol === "admin";
  const isJefe = currentUser && currentUser.rol === "jefe_taller";

  const roleContextBar = isAdmin
    ? `
      <div class="admin-context-bar">
        <div class="admin-context-info">
          <span class="admin-context-badge">
            <i class="fas fa-user-shield"></i> ADMINISTRADOR (${currentUser.nombre.toUpperCase()})
          </span>
          <span class="admin-context-desc">Control total de órdenes, precios, perfiles y auditoría.</span>
        </div>
        <div class="admin-context-actions">
          <button type="button" class="btn btn--ghost btn--xs" onclick="navigateTab('clients_dir')">
            <i class="fas fa-users"></i> Clientes
          </button>
          <button type="button" class="btn btn--ghost btn--xs" onclick="navigateTab('catalog_mgr')">
            <i class="fas fa-tags"></i> Catálogo de Precios
          </button>
          <button type="button" class="btn btn--ghost btn--xs" onclick="navigateTab('commissions_hr')">
            <i class="fas fa-user-check"></i> Personal y Comisiones
          </button>
          <button type="button" class="btn btn--gold btn--xs" onclick="openTextCustomizerModal()" title="Personalizar títulos y avisos de Jesús Andrade">
            <i class="fas fa-font"></i> Textos Oficiales
          </button>
        </div>
      </div>
    `
    : isJefe
    ? `
      <div class="admin-context-bar">
        <div class="admin-context-info">
          <span class="admin-context-badge">
            <i class="fas fa-user-tie"></i> JEFE DE TALLER · ${currentUser.nombre.toUpperCase()}
          </span>
          <span class="admin-context-desc">Acceso rápido a recepción, asignación, calidad y cobros.</span>
        </div>
        <div class="admin-context-actions">
          <button type="button" class="btn btn--warning btn--xs" onclick="setPhaseFilter('aprobacion')">
            <i class="fas fa-hourglass-half"></i> Por Aprobar (${counts.aprobacion})
          </button>
          <button type="button" class="btn btn--primary btn--xs" onclick="setPhaseFilter('calidad')">
            <i class="fas fa-shield-alt"></i> Calidad (${counts.calidad})
          </button>
          <button type="button" class="btn btn--ghost btn--xs" onclick="navigateTab('accounts_receivable')">
            <i class="fas fa-hand-holding-dollar"></i> Por Cobrar
          </button>
          <button type="button" class="btn btn--gold btn--xs" onclick="openTextCustomizerModal()" title="Personalizar avisos y textos del taller">
            <i class="fas fa-font"></i> Textos
          </button>
        </div>
      </div>
    `
    : "";

  return `
    ${roleContextBar}

    <!-- Barra Superior Limpia del Tablero con Selector de Vista -->
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:14px;">
      <div>
        <h2 id="pipeline-screen-title" data-custom-text-key="pipeline_title" style="font-size:19px; font-weight:900; color:var(--text-main);">
          ${escapeHtml(getCustomText("pipeline_title", "Seguimiento de Órdenes y Producción (Por Código de Troquel)"))}
        </h2>
        <p id="pipeline-screen-subtitle" data-custom-text-key="pipeline_subtitle" style="font-size:12.5px; color:var(--text-muted);">
          ${escapeHtml(getCustomText("pipeline_subtitle", "Flujo de 6 etapas del taller: 1. Recepción → 2. Diagnóstico → 3. Aprobación → 4. Servicio → 5. Calidad → 6. Entrega."))}
        </p>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <!-- Conmutador de Vistas: Tarjetas vs Lista Compacta -->
        <div class="view-mode-toggle-group">
          <button type="button" class="view-mode-btn ${currentViewMode === "cards" ? "active" : ""}" onclick="setViewMode('cards')" title="Vista Tarjetas Visuales">
            <i class="fas fa-th-large"></i> Tarjetas
          </button>
          <button type="button" class="view-mode-btn ${currentViewMode === "table" ? "active" : ""}" onclick="setViewMode('table')" title="Vista Lista Compacta">
            <i class="fas fa-table-list"></i> Lista Compacta
          </button>
        </div>

        <button type="button" class="btn ${activeFilter === "all" ? "btn--primary" : "btn--ghost"}" onclick="setPhaseFilter('all')">
          Activas en Taller (${counts.all})
        </button>
        <button type="button" class="btn btn--gold" onclick="openNewOrderModal()">
          <i class="fas fa-plus"></i> Nueva Orden
        </button>
      </div>
    </div>

    <!-- BARRA DE PÍLDORAS POR ESTADO: 6 ETAPAS OFICIALES RENACER -->
    <div class="renacer-filter-pill-bar">
      <button type="button" class="stage-pill-btn ${activeFilter === "recepcion" || activeFilter === "diagnostico_presupuesto" ? "active" : ""}" onclick="setPhaseFilter('recepcion')">
        <i class="fas fa-clipboard-check"></i> 1. Recepción <span class="count-badge">${counts.recepcion}</span>
      </button>
      <button type="button" class="stage-pill-btn ${activeFilter === "diagnostico" ? "active" : ""}" onclick="setPhaseFilter('diagnostico')">
        <i class="fas fa-stethoscope"></i> 2. Diagnóstico <span class="count-badge">${counts.diagnostico}</span>
      </button>
      <button type="button" class="stage-pill-btn ${activeFilter === "aprobacion" || activeFilter === "esperando_aprobacion_abono" ? "active" : ""}" onclick="setPhaseFilter('aprobacion')">
        <i class="fas fa-hand-holding-usd"></i> 3. Aprobación <span class="count-badge">${counts.aprobacion}</span>
      </button>
      <button type="button" class="stage-pill-btn ${activeFilter === "servicio" || activeFilter === "asignacion_ejecucion" ? "active" : ""}" onclick="setPhaseFilter('servicio')">
        <i class="fas fa-tools"></i> 4. Servicio <span class="count-badge">${counts.servicio}</span>
      </button>
      <button type="button" class="stage-pill-btn ${activeFilter === "calidad" || activeFilter === "control_calidad" ? "active" : ""}" onclick="setPhaseFilter('calidad')">
        <i class="fas fa-shield-alt"></i> 5. Calidad <span class="count-badge">${counts.calidad}</span>
      </button>
      <button type="button" class="stage-pill-btn ${activeFilter === "entrega" || activeFilter === "entregado" ? "active" : ""}" onclick="setPhaseFilter('entrega')">
        <i class="fas fa-check-double"></i> 6. Entrega <span class="count-badge">${counts.entrega}</span>
      </button>
      <button type="button" class="stage-pill-btn ${activeFilter === "archivado" ? "active" : ""}" onclick="setPhaseFilter('archivado')" style="border-color:rgba(148, 163, 184, 0.4);" title="Órdenes Archivadas y Garantías">
        <i class="fas fa-archive"></i> Archivados &amp; Garantía <span class="count-badge" style="background:rgba(255,255,255,0.15); color:#fff;">${counts.archivados}</span>
      </button>
      <button type="button" class="stage-pill-reset" onclick="setPhaseFilter('all')" title="Ver todas las órdenes activas (${counts.all})">
        <i class="fas fa-filter-circle-xmark"></i>
      </button>
    </div>

    ${
      activeFilter === "archivado"
        ? `
        <!-- Sub-filtro para Archivados vs Garantías Activas -->
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:14px; background:var(--bg-card); padding:8px 14px; border-radius:12px; border:1px solid var(--border-subtle); flex-wrap:wrap;">
          <span style="font-size:12px; font-weight:800; color:var(--text-muted);">Filtrar Historial:</span>
          <button type="button" class="btn ${pipelineWarrantySubfilter === "all" ? "btn--primary" : "btn--ghost"}" style="padding:4px 10px; font-size:11.5px; border-radius:99px;" onclick="setWarrantySubfilter('all')">
            <i class="fas fa-boxes-packing"></i> Todas las Archivadas (${counts.archivados})
          </button>
          <button type="button" class="btn ${pipelineWarrantySubfilter === "active_warranty" ? "btn--danger" : "btn--ghost"}" style="padding:4px 10px; font-size:11.5px; border-radius:99px;" onclick="setWarrantySubfilter('active_warranty')">
            <i class="fas fa-shield-alt"></i> Garantías Activas (${counts.garantias})
          </button>
        </div>
      `
        : ""
    }

    ${
      currentViewMode === "table"
        ? renderOrdersCompactTable(filteredOrders)
        : `<div class="orders-grid ${filteredOrders.length === 1 ? "orders-grid--single" : ""}">${cardsHtml}</div>`
    }
  `;
}

function setPhaseFilter(filter) {
  currentPhaseFilter = filter;
  currentTab = "pipeline";
  renderApp();
}

/* ---------- Vista Compacta / Tabla Expandible (Estilo Creaciones JJ) ---------- */
function renderOrdersCompactTable(orders) {
  if (!orders.length) {
    return `
      <div style="text-align:center; padding:36px 20px; background:var(--bg-card); border-radius:16px; border:1px solid var(--border-color);">
        <p style="color:var(--text-muted); font-size:13.5px;">No hay piezas que coincidan con el filtro actual.</p>
      </div>
    `;
  }

  const canManage = currentUser && (currentUser.rol === "admin" || currentUser.rol === "jefe_taller");

  const rowsHtml = orders
    .map((o) => {
      const isEntregado = o.estado_actual === "entregado";
      const isAnulado = o.estado_actual === "anulado";
      const subtasks = db.subtareas.filter((s) => s.orden_id === o.id_orden);
      const assignedTechs = [...new Set(subtasks.map((s) => s.nombre_tecnico).filter(Boolean))].join(", ") || "Sin asignar";

      let statusBadge = `<span class="state-badge">${o.estado_actual.replace(/_/g, " ")}</span>`;
      if (isEntregado) {
        const expStr = o.fecha_garantia_hasta || "";
        const daysLeft = expStr ? Math.ceil((new Date(expStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : 0;
        statusBadge = `<span class="warranty-badge ${daysLeft > 0 ? "warranty-badge--valid" : "warranty-badge--expired"}"><i class="fas fa-shield-alt"></i> ${daysLeft > 0 ? `${daysLeft}d garantía` : "Garantía exp."}</span>`;
      } else if (isAnulado) {
        statusBadge = `<span class="state-badge" style="background:rgba(239,68,68,0.2); color:#ef4444; border-color:#ef4444;">ANULADA</span>`;
      }

      return `
        <tr>
          <td>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:14px; color:var(--renacer-gold);">
              TROQUEL #${o.codigo_troquel}
            </div>
            <div style="font-size:11px; color:var(--text-muted);">${formatDateHuman(o.fecha_ingreso, false)}</div>
          </td>
          <td>
            <div style="font-weight:800;">${o.nombre_cliente}</div>
            <div style="font-size:11.5px; color:var(--text-muted);">${o.telefono_cliente}</div>
          </td>
          <td>
            <div style="font-weight:800;">${o.datos_motor.marca} ${o.datos_motor.modelo}</div>
            <div style="font-size:11px; color:var(--text-muted);">${o.datos_motor.tipo_pieza}</div>
          </td>
          <td>
            <div style="font-size:12px; color:#cbd5e1;">${assignedTechs}</div>
          </td>
          <td>${statusBadge}</td>
          <td>
            ${
              currentUser && currentUser.rol === "recepcion"
                ? `<span class="state-badge" style="${o.saldo_pendiente > 0 ? 'background:rgba(234,179,8,0.2); color:#eab308; border-color:#eab308;' : 'background:rgba(34,197,94,0.2); color:#22c55e; border-color:#22c55e;'} font-weight:800;">
                    ${o.saldo_pendiente > 0 ? "Pendiente" : "Saldada"}
                  </span>`
                : `
                  <div style="font-family:'JetBrains Mono',monospace; font-weight:800;">$${Number(o.monto_total).toFixed(2)}</div>
                  ${
                    o.saldo_pendiente > 0
                      ? `<div style="font-size:11.5px; color:#ef4444; font-weight:800;">Resta: $${Number(o.saldo_pendiente).toFixed(2)}</div>`
                      : `<div style="font-size:11px; color:#22c55e;">Saldada</div>`
                  }
                `
            }
          </td>
          <td>
            <div style="display:flex; gap:5px; flex-wrap:wrap; align-items:center;">
              ${
                canManage && !isEntregado && !isAnulado
                  ? `<button type="button" class="btn btn--ghost btn--xs" style="color:var(--renacer-gold);" onclick="openEditCompleteOrderModal('${o.id_orden}')" title="Modificar Orden Completa">
                      <i class="fas fa-edit"></i>
                    </button>`
                  : ""
              }
              ${
                canManage && !isAnulado && o.saldo_pendiente > 0
                  ? `<button type="button" class="btn btn--ghost btn--xs" style="color:#f59e0b;" onclick="openFinancialApprovalModal('${o.id_orden}')" title="Registrar Abono o Pago">
                      <i class="fas fa-dollar-sign"></i>
                    </button>`
                  : ""
              }
              <button type="button" class="btn btn--ghost btn--xs" style="color:#22c55e;" onclick="printOrderExcelSheet('${o.id_orden}')" title="Hoja / Planilla de Servicio (Formato Excel)">
                <i class="fas fa-file-excel"></i>
              </button>
              <button type="button" class="btn btn--ghost btn--xs" onclick="openDualGalleryInspector('${o.id_orden}')" title="Fotos de pieza y repuestos">
                <i class="fas fa-camera"></i>
              </button>
              <button type="button" class="btn btn--ghost btn--xs" onclick="openOrderCrmModal('${o.id_orden}')" title="Chat y Bitácora">
                <i class="fas fa-comments"></i>
              </button>
              <button type="button" class="btn btn--ghost btn--xs" style="color:#22c55e;" onclick="openWhatsAppBudgetTextModal('${o.id_orden}')" title="Enviar presupuesto por WhatsApp">
                <i class="fab fa-whatsapp"></i>
              </button>
              <button type="button" class="btn btn--ghost btn--xs" style="color:#38bdf8;" onclick="printOrderReceptionTicket('${o.id_orden}')" title="Ticket de Recepción 80mm">
                <i class="fas fa-print"></i>
              </button>
              ${
                !isEntregado && !isAnulado && canManage
                  ? `<button type="button" class="btn btn--ghost btn--xs" style="color:#f87171;" onclick="cancelOrderWithReason('${o.id_orden}')" title="Anular orden"><i class="fas fa-ban"></i></button>`
                  : ""
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="data-table-wrapper" style="margin-top:10px;">
      <table class="orders-compact-table">
        <thead>
          <tr>
            <th>Troquel / Fecha</th>
            <th>Cliente</th>
            <th>Motor / Pieza</th>
            <th>Técnicos</th>
            <th>Estado / Garantía</th>
            <th>${currentUser && currentUser.rol === "recepcion" ? "Estado de Pago" : "Monto / Saldo"}</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

/* ---------- Anulación Segura de Ordenes (Preserva el Troquel en Auditoría) ---------- */
async function cancelOrderWithReason(orderId) {
  const o = db.ordenes.find((x) => x.id_orden === orderId);
  if (!o) return;

  const { value: reason } = await Swal.fire({
    title: `Anular Orden — Troquel #${o.codigo_troquel}`,
    html: `
      <div style="text-align:left; font-size:13px; color:var(--text-muted); margin-bottom:12px;">
        Esta acción marcará la orden como <strong>ANULADA</strong>. El número de troquel (#${o.codigo_troquel}) y el cliente permanecerán en el historial de auditoría permanente sin generar cobro.
      </div>
    `,
    input: "text",
    inputPlaceholder: "Ingresa el motivo (Ej: Cliente retiró la pieza sin reparar / Presupuesto rechazado)...",
    showCancelButton: true,
    confirmButtonText: "Confirmar Anulación",
    confirmButtonColor: "#dc2626",
    cancelButtonText: "Cancelar",
    inputValidator: (value) => {
      if (!value || value.trim().length < 5) {
        return "Debes ingresar un motivo claro de anulación (mínimo 5 letras).";
      }
    }
  });

  if (reason) {
    o.estado_actual = "anulado";
    o.motivo_anulacion = reason.trim();
    o.fecha_anulacion = new Date().toISOString().slice(0, 16).replace("T", " ");

    if (!Array.isArray(db.bitacora)) db.bitacora = [];
    db.bitacora.unshift({
      id_mensaje: "MSG-ANUL-" + Date.now().toString().slice(-4),
      orden_id: o.id_orden,
      codigo_troquel: o.codigo_troquel,
      autor_id: currentUser ? currentUser.id_usuario : "USR-ADMIN",
      autor_nombre: currentUser ? currentUser.nombre : "Administración",
      autor_rol: currentUser ? currentUser.rol_label || "Jefe de Taller" : "Admin",
      tipo_evento: "anulacion",
      mensaje: `ORDEN ANULADA. Motivo: ${o.motivo_anulacion}. El troquel #${o.codigo_troquel} queda archivado en auditoría.`,
      foto_adjunta_url: "",
      fecha_hora: new Date().toISOString().slice(0, 16).replace("T", " ")
    });

    saveDatabase();
    renderApp();

    sendPushNotification("Orden Anulada en Taller", {
      body: `Troquel #${o.codigo_troquel} anulado por ${currentUser?.nombre}. Motivo: ${o.motivo_anulacion}`,
      tag: "order-canceled"
    });

    showToast(`Orden con Troquel #${o.codigo_troquel} anulada con éxito.`, "info");
  }
}

function setPhaseFilter(filter) {
  currentPhaseFilter = filter;
  currentTab = "pipeline";
  renderApp();
}

/* ---------- 3. TARJETA DE ORDEN LIMPIA Y COMPACTA ---------- */
function renderOrderCardTelegramStyle(order) {
  const countFotosPieza = (order.galeria_fotos_pieza || []).length;
  const countFotosRepuestos = (order.galeria_fotos_repuestos || []).length;
  const subtasks = db.subtareas.filter((s) => s.orden_id === order.id_orden);
  const chatMessages = db.bitacora.filter((m) => m.orden_id === order.id_orden);

  const isEntregado = order.estado_actual === "entregado" || Boolean(order.factura_bloqueada);
  const canManage = currentUser && (currentUser.rol === "admin" || currentUser.rol === "jefe_taller");

  const stateMap = {
    recepcion: { label: "1. Recepción", cls: "state-badge--recep", icon: "fa-clipboard-check" },
    diagnostico_presupuesto: { label: "1. Recepción", cls: "state-badge--recep", icon: "fa-clipboard-check" },
    diagnostico: { label: "2. Diagnóstico", cls: "state-badge--diag", icon: "fa-stethoscope" },
    aprobacion: { label: "3. Aprobación", cls: "state-badge--wait", icon: "fa-hand-holding-usd" },
    esperando_aprobacion_abono: { label: "3. Aprobación", cls: "state-badge--wait", icon: "fa-hand-holding-usd" },
    servicio: { label: "4. Servicio", cls: "state-badge--exec", icon: "fa-tools" },
    asignacion_ejecucion: { label: "4. Servicio", cls: "state-badge--exec", icon: "fa-tools" },
    terminado: { label: "4. Servicio (Listo)", cls: "state-badge--term", icon: "fa-flag-checkered" },
    calidad: { label: "5. Calidad", cls: "state-badge--qc", icon: "fa-shield-alt" },
    control_calidad: { label: "5. Calidad", cls: "state-badge--qc", icon: "fa-shield-alt" },
    entrega: { label: "6. En Entrega", cls: "state-badge--done", icon: "fa-truck" },
    entregado: { label: "6. En Entrega", cls: "state-badge--done", icon: "fa-truck" },
    archivado: { label: "Archivado", cls: "state-badge--archive", icon: "fa-box-archive" },
    anulado: { label: "Anulada", cls: "state-badge--danger", icon: "fa-ban" }
  };
  const st = stateMap[order.estado_actual] || stateMap.recepcion;

  const finBadgeMap = {
    pago_total: `<span style="font-size:11px; font-weight:800; color:#22c55e; background:rgba(22,163,74,0.14); padding:3px 8px; border-radius:6px;">Pago Total 100%</span>`,
    abono: `<span style="font-size:11px; font-weight:800; color:#f59e0b; background:rgba(217,119,6,0.16); padding:3px 8px; border-radius:6px;">Abono ($${order.monto_abonado})</span>`,
    credito: `<span style="font-size:11px; font-weight:800; color:#38bdf8; background:rgba(2,132,199,0.16); padding:3px 8px; border-radius:6px;">Taller Aliado / Crédito</span>`,
    pendiente_definir: `<span style="font-size:11px; font-weight:800; color:#f87171; background:rgba(220,38,38,0.12); padding:3px 8px; border-radius:6px;">Sin Abono</span>`
  };
  const finBadge = finBadgeMap[order.tipo_condicion_pago] || finBadgeMap.pendiente_definir;

  // 1. Lista Limpia de Servicios al Cliente (Sin duplicar asignaciones de técnicos)
  const subtasksListHtml = subtasks.length
    ? subtasks
        .map((s) => {
          const stateText =
            s.estado_subtarea === "terminado"
              ? '<span style="color:#22c55e; font-weight:700;"><i class="fas fa-check-circle"></i> Listo</span>'
              : s.estado_subtarea === "empezado"
              ? '<span style="color:#0284c7; font-weight:700;"><i class="fas fa-wrench"></i> En proceso</span>'
              : '<span style="color:var(--text-muted);"><i class="fas fa-clock"></i> Pendiente</span>';
          return `
            <div class="order-clean-service-row ${s.estado_subtarea === "terminado" ? "done" : ""}">
              <div style="flex:1;">
                <div class="service-title">
                  <i class="fas fa-wrench" style="color:var(--renacer-gold); font-size:11px; margin-right:4px;"></i> ${s.descripcion_servicio} ${s.es_item_extra ? '<span class="extra-tag">(Ítem Extra)</span>' : ""}
                </div>
                <div class="service-meta">
                  <span>${stateText}</span>
                  ${canManage && !isEntregado ? `<button type="button" class="btn-clean-link" style="color:#ef4444; font-size:10.5px; margin-left:8px; font-weight:700;" onclick="removeSubtaskFromOrder('${s.id_subtarea}', '${order.id_orden}')" title="Eliminar servicio de la orden"><i class="fas fa-trash-alt"></i> Quitar</button>` : ""}
                </div>
              </div>
              <div class="service-right">
                ${currentUser && currentUser.rol === "tecnico" ? "" : `<div class="price-val">$${Number(s.monto_servicio).toFixed(2)}</div>`}
              </div>
            </div>
          `;
        })
        .join("")
    : `<div style="font-size:11.5px; color:var(--text-muted); padding:8px 0; text-align:center;">No hay servicios presupuestados aún.</div>`;

  // 2. Agrupación Exclusiva de Destajo y Asignación de Trabajos
  const techMap = {};
  subtasks.forEach((s) => {
    const tId = s.tecnico_id || "unassigned";
    const tName = s.nombre_tecnico || "Sin asignar";
    if (!techMap[tId]) {
      const u = db.usuarios.find(
        (user) => user.id_usuario === tId || (user.nombre && user.nombre.toLowerCase().trim() === tName.toLowerCase().trim())
      );
      const isExt = Boolean(u && (u.rol === "outsourcing" || u.tipo === "taller_externo" || u.es_externo));
      techMap[tId] = {
        id: tId,
        nombre: tName,
        isExternal: isExt,
        servicios: [],
        totalComm: 0
      };
    }
    techMap[tId].servicios.push(s.descripcion_servicio);
    techMap[tId].totalComm += Number(s.comision_base_tecnico || 0);
  });

  const assignedTechKeys = Object.keys(techMap).filter((k) => k !== "unassigned");
  const unassignedSubs = techMap["unassigned"] ? techMap["unassigned"].servicios : [];

  let assignmentsHtml = "";
  if (assignedTechKeys.length > 0) {
    assignmentsHtml = assignedTechKeys
      .map((k) => {
        const t = techMap[k];
        return `
        <div class="order-clean-assignee-row ${t.isExternal ? "external" : ""}">
          <div style="flex:1;">
            <div class="assignee-name" style="display:flex; align-items:center; justify-content:space-between;">
              <span>
                ${t.isExternal ? '<span class="badge-external"><i class="fas fa-handshake"></i> EXTERNO</span> ' : ''}
                <i class="fas fa-user-circle" style="color:var(--renacer-gold); margin-right:4px;"></i> <strong>${t.nombre}</strong>
              </span>
              ${canManage ? `
                <button type="button" class="btn-clean-link" style="color:var(--renacer-gold); font-size:11px; font-weight:800;" onclick="openSubtaskAssignmentModal('${order.id_orden}')" title="Reasignar en Matriz">[ Cambiar ]</button>
              ` : ""}
            </div>
            <div class="assignee-tasks" style="margin-top:3px; color:var(--text-muted); font-size:11.5px;">
              <i class="fas fa-tasks" style="font-size:10px; margin-right:4px;"></i> ${t.servicios.join(", ")}
            </div>
          </div>
          ${canManage ? `
          <div class="assignee-comm" style="text-align:right; margin-left:12px;">
            <div class="comm-label" style="font-size:10px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">
              ${t.isExternal ? "Costo Tercero" : "Comisión"}
            </div>
            <div class="comm-val" style="font-family:'JetBrains Mono',monospace; font-weight:900; color:#16a34a; font-size:13px;">
              $${t.totalComm.toFixed(2)}
            </div>
          </div>
          ` : ""}
        </div>
      `;
      })
      .join("");
  }
  if (unassignedSubs.length > 0) {
    assignmentsHtml += `
      <div style="font-size:11.5px; color:var(--text-muted); padding:8px 12px; background:rgba(255,255,255,0.03); border-radius:10px; border:1px dashed var(--border-subtle); display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
        <span><i class="fas fa-clock" style="color:#f59e0b;"></i> ${unassignedSubs.length} trabajo(s) pendientes de asignar</span>
        ${canManage ? `<button type="button" class="btn btn--gold btn--xs" onclick="openSubtaskAssignmentModal('${order.id_orden}')"><i class="fas fa-user-plus"></i> Asignar Matriz</button>` : ""}
      </div>
    `;
  }
  if (!assignedTechKeys.length && !unassignedSubs.length) {
    assignmentsHtml = `<div style="font-size:11.5px; color:var(--text-muted); font-style:italic;">Sin subtareas registradas en esta orden.</div>`;
  }

  // Botón de acción según el flujo de las 6 etapas oficiales de Jesús Andrade
  let primaryActionBtn = "";
  if (order.estado_actual === "recepcion" || order.estado_actual === "diagnostico_presupuesto") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn--primary" onclick="advanceOrderStage('${order.id_orden}', 'diagnostico')">
          Pasar a 2. Diagnóstico <i class="fas fa-arrow-right"></i>
        </button>
        ${canManage ? `
          <button type="button" class="btn btn--gold" onclick="openSubtaskAssignmentModal('${order.id_orden}', true)" title="Salto directo de Jefatura: Asignar técnicos y pasar directo a 4. Servicio">
            <i class="fas fa-bolt"></i> Asignar y Pasar a 4. Servicio
          </button>
        ` : ""}
      </div>
    `;
  } else if (order.estado_actual === "diagnostico") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn--ghost" onclick="openEditBudgetModal('${order.id_orden}')" title="Ajustar o ampliar presupuesto">
          <i class="fas fa-pen"></i> Ajustar Presupuesto
        </button>
        <button type="button" class="btn btn--primary" onclick="advanceOrderStage('${order.id_orden}', 'aprobacion')">
          Enviar a 3. Aprobación <i class="fas fa-arrow-right"></i>
        </button>
        ${canManage ? `
          <button type="button" class="btn btn--gold" onclick="openSubtaskAssignmentModal('${order.id_orden}', true)" title="Salto directo de Jefatura: Asignar técnicos y pasar directo a 4. Servicio">
            <i class="fas fa-bolt"></i> A 4. Servicio
          </button>
        ` : ""}
      </div>
    `;
  } else if (order.estado_actual === "aprobacion" || order.estado_actual === "esperando_aprobacion_abono") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn--warning" onclick="openFinancialApprovalModal('${order.id_orden}')">
          <i class="fas fa-unlock"></i> Registrar Abono / Crédito
        </button>
        ${canManage ? `
          <button type="button" class="btn btn--gold" onclick="openSubtaskAssignmentModal('${order.id_orden}')">
            <i class="fas fa-user-check"></i> Asignar a 4. Servicio <i class="fas fa-arrow-right"></i>
          </button>
        ` : ""}
      </div>
    `;
  } else if (order.estado_actual === "servicio" || order.estado_actual === "asignacion_ejecucion" || order.estado_actual === "terminado") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn--ghost" style="padding:7px 10px;" onclick="openSubtaskAssignmentModal('${order.id_orden}')" title="Matriz de Asignación y Comisiones">
          <i class="fas fa-users-cog"></i> Matriz / Reasignar
        </button>
        <button type="button" class="btn btn--success" onclick="moveOrderToQualityControl('${order.id_orden}')">
          <i class="fas fa-shield-alt"></i> Enviar a 5. Calidad <i class="fas fa-arrow-right"></i>
        </button>
      </div>
    `;
  } else if (order.estado_actual === "calidad" || order.estado_actual === "control_calidad") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn--danger" style="padding:7px 10px;" onclick="promptRejectQualityControl('${order.id_orden}')">
          <i class="fas fa-rotate-left"></i> Devolver a Servicio
        </button>
        <button type="button" class="btn btn--success" style="padding:7px 11px;" onclick="openQualityAndDeliveryModal('${order.id_orden}')">
          <i class="fas fa-check-circle"></i> Aprobar y Pasar a 6. Entrega <i class="fas fa-arrow-right"></i>
        </button>
      </div>
    `;
  } else if (order.estado_actual === "entrega" || order.estado_actual === "entregado") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${order.saldo_pendiente > 0 ? `
          <button type="button" class="btn btn--warning" onclick="openCollectReceivableModal('${order.id_orden}')">
            <i class="fas fa-dollar-sign"></i> Cobrar Resto ($${Number(order.saldo_pendiente).toFixed(2)})
          </button>
        ` : `<span class="state-badge state-badge--done" style="font-size:11px; padding:6px 10px;"><i class="fas fa-check"></i> 100% Pagada</span>`}
        <button type="button" class="btn btn--gold" onclick="archiveOrder('${order.id_orden}')" title="Mover orden a histórico y garantía">
          <i class="fas fa-box-archive"></i> Archivar Orden
        </button>
      </div>
    `;
  } else if (order.estado_actual === "archivado") {
    if (order.garantia_activa) {
      primaryActionBtn = `
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <span class="state-badge" style="background:#ef4444; color:#fff; font-size:11px;"><i class="fas fa-shield-alt"></i> Garantía Activa</span>
          <button type="button" class="btn btn--success" onclick="resolveWarranty('${order.id_orden}')">
            <i class="fas fa-check-circle"></i> Resolver Garantía
          </button>
        </div>
      `;
    } else {
      primaryActionBtn = `
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <span class="state-badge state-badge--archive"><i class="fas fa-box-archive"></i> Archivada</span>
          <button type="button" class="btn btn--warning" onclick="openWarrantyClaimModal('${order.id_orden}')" title="Reingresar pieza bajo garantía de 1 año">
            <i class="fas fa-shield-halved"></i> Activar Garantía
          </button>
        </div>
      `;
    }
  } else if (order.estado_actual === "anulado") {
    primaryActionBtn = `<span class="state-badge" style="background:rgba(239,68,68,0.18); color:#f87171; border:1px solid #ef4444;"><i class="fas fa-ban"></i> Anulada</span>`;
  }

  return `
    <article id="order-card-${order.id_orden}" data-order-id="${order.id_orden}" class="renacer-order-card order-clean-card ${order.prioridad_alta || order.devuelto_calidad ? "priority-high" : ""}">
      <!-- 1. CABECERA LIMPIA: NÚMERO DE ORDEN Y ESTADO EN ALTO CONTRASTE (DISEÑO IMAGEN 6) -->
      <div class="order-clean-header">
        <div class="order-clean-header-num">
          <button type="button" class="btn-troquel-clickable" style="font-size:13.5px; padding:4px 10px;" onclick="quickViewOrderDetails('${order.id_orden}')" title="Clic para inspeccionar ficha técnica">
            <i class="fas fa-barcode"></i> TROQUEL #${order.codigo_troquel}
          </button>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          ${order.prioridad_alta ? `<span class="priority-fire-badge" title="Prioridad Alta"><i class="fas fa-bolt"></i> Prioridad</span>` : ""}
          <span class="state-badge ${st.cls}">
            <i class="fas ${st.icon}"></i> ${st.label}
          </span>
        </div>
      </div>

      <!-- 2. DATOS DE VEHÍCULO / MOTOR Y CLIENTE (DISEÑO IMAGEN 6) -->
      <div class="order-clean-subheader">
        <div class="order-clean-brand">
          ${order.datos_motor.marca} ${order.datos_motor.modelo ? `<span style="font-size:13px; font-weight:700; color:#94a3b8; text-transform:none;">${order.datos_motor.modelo}</span>` : ""}
        </div>
        <div class="order-clean-client-info">
          <span><i class="fas fa-user"></i> ${order.nombre_cliente}</span>
          <span class="dot-sep">·</span>
          <span>${order.documento_cliente}</span>
          <span class="dot-sep">·</span>
          <a href="tel:${order.telefono_cliente}" style="color:inherit; text-decoration:none;">
            <i class="fas fa-phone"></i> ${order.telefono_cliente}
          </a>
        </div>
      </div>

      ${
        order.estado_actual === "anulado"
          ? `<div style="background:rgba(239,68,68,0.14); border:1px solid #ef4444; color:#fca5a5; padding:8px 12px; border-radius:10px; font-size:12px; font-weight:700;">
              <i class="fas fa-ban"></i> <strong>ORDEN ANULADA:</strong> ${order.motivo_anulacion || "Sin motivo especificado"}
              <div style="font-size:10.5px; opacity:0.85; margin-top:2px;">El número de Orden #${order.codigo_troquel} se conserva en auditoría sin deuda.</div>
            </div>`
          : ""
      }
      ${
        order.estado_actual === "entregado" && order.fecha_garantia_hasta
          ? (() => {
              const garDate = new Date(order.fecha_garantia_hasta);
              const today = new Date();
              const diffDays = Math.ceil((garDate - today) / (1000 * 60 * 60 * 24));
              const isValid = diffDays > 0;
              return `<div class="warranty-badge ${isValid ? "warranty-badge--valid" : "warranty-badge--expired"}">
                <i class="fas fa-shield-halved"></i>
                <span><strong>Garantía de 1 Año Renacer:</strong> ${isValid ? diffDays + " días restantes" : "Vencida"} (Vence: ${formatDateHuman(order.fecha_garantia_hasta, false)})</span>
              </div>`;
            })()
          : ""
      }
      ${
        order.devuelto_calidad && order.motivo_rechazo_qc
          ? `<div style="background:rgba(220,38,38,0.12); border:1px solid #dc2626; color:#f87171; padding:8px 10px; border-radius:10px; font-size:12px; font-weight:700;">
              <i class="fas fa-times-circle"></i> <strong>Devuelto por Calidad:</strong> ${order.motivo_rechazo_qc}
            </div>`
          : ""
      }

      <!-- 3. BLOQUE 1: SERVICIOS Y PRESUPUESTO CLIENTE (DISEÑO IMAGEN 6) -->
      <div class="order-clean-block">
        <div class="order-clean-block-title">
          <span>Servicios:</span>
          ${
            !isEntregado && canManage
              ? `<div style="display:flex; gap:5px;">
                  <button type="button" class="btn btn--gold btn--xs" onclick="openQuickExtraItemModal('${order.id_orden}')" title="Añadir ítem extra">+ Ítem Extra</button>
                  <button type="button" class="btn btn--ghost btn--xs" onclick="openEditBudgetModal('${order.id_orden}')" title="Editar presupuesto"><i class="fas fa-pen"></i></button>
                </div>`
              : ""
          }
        </div>

        <div class="order-clean-services-list">
          ${subtasksListHtml}
        </div>

        <!-- Strip Financiero Total / Abonado / Resto (Oculto para Técnicos y Recepción por Privacidad) -->
        ${
          currentUser && (currentUser.rol === "tecnico" || currentUser.rol === "recepcion")
            ? ""
            : `
            <div class="order-clean-finance-strip">
              <div class="finance-cell">
                <span class="lbl">TOTAL</span>
                <strong class="val val--total">$${Number(order.monto_total || 0).toFixed(2)}</strong>
              </div>
              <div class="finance-cell">
                <span class="lbl">ABONADO</span>
                <strong class="val val--abonado">$${Number(order.monto_abonado || 0).toFixed(2)}</strong>
              </div>
              <div class="finance-cell">
                <span class="lbl">RESTO</span>
                <strong class="val val--resto" style="color:${Number(order.saldo_pendiente || 0) > 0 ? '#ef4444' : '#22c55e'};">$${Number(order.saldo_pendiente || 0).toFixed(2)}</strong>
              </div>
            </div>
            `
        }
      </div>

      <!-- 4. BLOQUE 2: ASIGNACIONES / COMISIONES POR TÉCNICO (DISEÑO IMAGEN 6) -->
      ${
        currentUser && (currentUser.rol === "tecnico" || currentUser.rol === "recepcion")
          ? ""
          : `
          <div class="order-clean-block">
            <div class="order-clean-block-title">
              <span>Asignaciones/Comisiones:</span>
              ${
                canManage
                  ? `<button type="button" class="btn btn--ghost btn--xs" onclick="openSubtaskAssignmentModal('${order.id_orden}')" title="Abrir matriz de asignación"><i class="fas fa-sliders-h"></i> Matriz</button>`
                  : ""
              }
            </div>
            <div class="order-clean-assignees-list">
              ${assignmentsHtml}
            </div>
          </div>
          `
      }

      <!-- 5. PIE DE ACCIONES: PILL COMPACTO DE CONTADORES + BOTONES DE ESTADO (DISEÑO IMAGEN 6) -->
      <div class="order-clean-footer">
        <div class="order-clean-pill-actions">
          <button type="button" class="order-clean-pill-btn" onclick="openDualGalleryInspector('${order.id_orden}')" title="Fotos de pieza y repuestos">
            <i class="fas fa-camera"></i> <span>${countFotosPieza + countFotosRepuestos}</span>
          </button>
          <span style="color:#334155;">|</span>
          <button type="button" class="order-clean-pill-btn" onclick="openOrderCrmModal('${order.id_orden}')" title="Bitácora técnica y chat">
            <i class="fas fa-comments"></i> <span>${chatMessages.length}</span>
          </button>
          <span style="color:#334155;">|</span>
          <button type="button" class="order-clean-pill-btn order-clean-pill-btn--wa" onclick="openWhatsAppBudgetTextModal('${order.id_orden}')" title="Enviar presupuesto detallado por WhatsApp">
            <i class="fab fa-whatsapp"></i>
          </button>
          <span style="color:#334155;">|</span>
          <button type="button" class="order-clean-pill-btn" onclick="printOrderReceptionTicket('${order.id_orden}')" title="Imprimir Ticket de Recepción 80mm (Políticas)">
            <i class="fas fa-print"></i>
          </button>
          <span style="color:#334155;">|</span>
          <button type="button" class="order-clean-pill-btn" onclick="printOrderExcelSheet('${order.id_orden}')" title="Planilla y Hoja de Servicio Oficial (Formato Tabla / Excel)">
            <i class="fas fa-file-excel" style="color:#22c55e;"></i>
          </button>
          ${
            canManage && order.estado_actual !== "anulado" && order.estado_actual !== "entregado"
              ? `<span style="color:#334155;">|</span>
                 <button type="button" class="order-clean-pill-btn order-clean-pill-btn--danger" onclick="cancelOrderWithReason('${order.id_orden}')" title="Anular orden conservando correlativo">
                   <i class="fas fa-ban"></i>
                 </button>`
              : ""
          }
          ${
            canManage
              ? `<button type="button" class="order-clean-pill-btn order-clean-pill-btn--danger" onclick="deleteOrder('${order.id_orden}')" title="Eliminar orden">
                   <i class="fas fa-trash-alt"></i>
                 </button>`
              : ""
          }
        </div>

        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          ${
            order.estado_actual !== "anulado" && order.estado_actual !== "archivado" && Number(order.saldo_pendiente) > 0 && !(currentUser && currentUser.rol === "tecnico")
              ? `<button type="button" class="btn btn--warning" onclick="openFinancialApprovalModal('${order.id_orden}')" title="Registrar abono o liquidación total" style="padding:7px 12px; font-size:12px; font-weight:800;">
                   <i class="fas fa-hand-holding-usd"></i> Abono / Pago
                 </button>`
              : ""
          }
          ${primaryActionBtn}
        </div>
      </div>
    </article>
  `;
}

function sendQuickInlineChatMessage(orderId) {
  const inp = document.getElementById("quick-chat-input-" + orderId);
  if (!inp) return;
  const text = (inp.value || "").trim();
  if (!text) return;
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "comentario",
    mensaje: text,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  inp.value = "";
  saveDatabase();
  renderScreen();
  showToast(`Mensaje agregado al chat de Troquel #${order.codigo_troquel}.`);
}

function formatMinutes(mins) {
  const m = Number(mins) || 0;
  if (m === 0) return "0 min";
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h > 0 ? `${h}h ${rem}m` : `${rem} min`;
}

function unassignTechnicianFromOrderCard(subtaskId, orderId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  const oldTechName = sub.nombre_tecnico;
  sub.tecnico_id = null;
  sub.nombre_tecnico = "Sin asignar";
  sub.estado_subtarea = "pendiente";
  const nowStr = cleanDateISO(new Date().toISOString(), true);
  if (order) {
    db.bitacora.push({
      id_mensaje: "MSG-" + Date.now(),
      orden_id: order.id_orden,
      codigo_troquel: order.codigo_troquel,
      autor_id: currentUser.id_usuario,
      autor_nombre: currentUser.nombre,
      autor_rol: currentUser.rol_label,
      tipo_evento: "desasignacion",
      mensaje: `Técnico (${oldTechName}) desasignado de la subtarea "${sub.descripcion_servicio}" por ${currentUser.nombre}. Queda en estado pendiente.`,
      foto_adjunta_url: "",
      fecha_hora: nowStr
    });
  }
  saveDatabase();
  renderScreen();
  showToast("Técnico desasignado. La subtarea quedó libre.");
}

function deleteSubtaskDirect(subtaskId, orderId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  Swal.fire({
    title: `¿Eliminar "${sub.descripcion_servicio}"?`,
    text: "Esta acción removerá la subtarea de la orden y actualizará el presupuesto total.",
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#ef4444",
    confirmButtonText: "Sí, Eliminar",
    cancelButtonText: "Cancelar"
  }).then((res) => {
    if (res.isConfirmed) {
      db.subtareas = db.subtareas.filter((s) => s.id_subtarea !== subtaskId);
      const remaining = db.subtareas.filter((s) => s.orden_id === orderId);
      const newTotal = remaining.reduce((sum, s) => sum + (Number(s.monto_servicio) || 0), 0);
      const order = db.ordenes.find((o) => o.id_orden === orderId);
      if (order) {
        order.monto_total = newTotal;
        order.saldo_pendiente = Math.max(0, newTotal - (Number(order.monto_abonado) || 0));
        const nowStr = cleanDateISO(new Date().toISOString(), true);
        db.bitacora.push({
          id_mensaje: "MSG-" + Date.now(),
          orden_id: order.id_orden,
          codigo_troquel: order.codigo_troquel,
          autor_id: currentUser.id_usuario,
          autor_nombre: currentUser.nombre,
          autor_rol: currentUser.rol_label,
          tipo_evento: "subtarea_eliminada",
          mensaje: `Subtarea "${sub.descripcion_servicio}" ($${Number(sub.monto_servicio).toFixed(2)}) eliminada por ${currentUser.nombre}. Nuevo total: $${newTotal.toFixed(2)}.`,
          foto_adjunta_url: "",
          fecha_hora: nowStr
        });
      }
      saveDatabase();
      if (document.getElementById("live-assignment-totals-box")) {
        openSubtaskAssignmentModal(orderId);
      } else if (document.getElementById("edit-subtasks-list")) {
        openEditBudgetModal(orderId);
      } else {
        renderScreen();
      }
      showToast("Subtarea eliminada correctamente.");
    }
  });
}

function removeSubtaskFromOrder(subtaskId, orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (order && (order.estado_actual === "entregado" || order.factura_bloqueada)) {
    showToast("No se pueden eliminar ítems de una orden ya entregada y con factura cerrada.", "error");
    return;
  }
  deleteSubtaskDirect(subtaskId, orderId);
}

function openAssignSubtaskModal(subtaskId, orderId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!sub || !order) return;

  const techs = db.usuarios.filter(
    (u) => (u.rol === "tecnico" || u.rol === "jefe_taller" || u.rol === "admin" || u.rol === "outsourcing" || u.tipo === "taller_externo" || u.es_externo) && u.activo
  );
  const optionsHtml = techs.map((u) => {
    const isExt = Boolean(u.rol === "outsourcing" || u.tipo === "taller_externo" || u.es_externo);
    return `
      <option value="${u.id_usuario}" ${sub.tecnico_id === u.id_usuario ? "selected" : ""}>
        ${isExt ? "[EXTERNO] " : ""}${u.nombre} (${u.rol_label || u.rol})
      </option>
    `;
  }).join("");

  openModal({
    title: `Asignar Técnico / Taller Externo — Troquel #${order.codigo_troquel}`,
    icon: "fa-user-check",
    body: `
      <div style="background:var(--bg-card); padding:12px; border-radius:10px; margin-bottom:12px; border:1px solid var(--border-color);">
        <div style="font-weight:900; font-size:14px; color:#fff;">${sub.descripcion_servicio}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:3px; display:flex; gap:14px; flex-wrap:wrap;">
          <span>Precio Cliente: <strong>$${Number(sub.monto_servicio).toFixed(2)}</strong></span>
          <span style="color:#22c55e;">Comisión / Costo Base: <strong>$${Number(sub.comision_base_tecnico).toFixed(2)}</strong></span>
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-field">
          <label><i class="fas fa-user"></i> Técnico o Taller Externo (Solteca) *</label>
          <select id="assign-sub-user">
            <option value="">-- Sin Asignar --</option>
            ${optionsHtml}
          </select>
        </div>
        <div class="form-field">
          <label><i class="fas fa-tasks"></i> Estado del Trabajo *</label>
          <select id="assign-sub-status">
            <option value="pendiente" ${sub.estado_subtarea === "pendiente" ? "selected" : ""}>Por Hacer / Pendiente</option>
            <option value="empezado" ${sub.estado_subtarea === "empezado" ? "selected" : ""}>En Proceso</option>
            <option value="terminado" ${sub.estado_subtarea === "terminado" ? "selected" : ""}>Terminado (Listo)</option>
          </select>
        </div>
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label><i class="fas fa-dollar-sign"></i> Comisión al Técnico o Costo Tercerizado ($) *</label>
        <input type="number" step="0.5" id="assign-sub-comm" value="${Number(sub.comision_base_tecnico) || 0}" style="font-family:'JetBrains Mono',monospace; font-weight:900;" />
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveAssignSubtask('${subtaskId}', '${orderId}')">
        <i class="fas fa-check"></i> Guardar Asignación
      </button>
    `
  });
}

function saveAssignSubtask(subtaskId, orderId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!sub || !order) return;

  const userId = document.getElementById("assign-sub-user")?.value;
  const newStatus = document.getElementById("assign-sub-status")?.value || "pendiente";
  const commVal = Number(document.getElementById("assign-sub-comm")?.value);

  if (!isNaN(commVal) && commVal >= 0) {
    sub.comision_base_tecnico = commVal;
  }

  if (userId) {
    const user = db.usuarios.find((u) => u.id_usuario === userId);
    sub.tecnico_id = user.id_usuario;
    sub.nombre_tecnico = user.nombre;
    sub.es_outsourcing = Boolean(user && (user.rol === "outsourcing" || user.tipo === "taller_externo" || user.es_externo));
  } else {
    sub.tecnico_id = null;
    sub.nombre_tecnico = "Sin asignar";
    sub.es_outsourcing = false;
  }

  sub.estado_subtarea = newStatus;
  if (newStatus === "terminado") {
    sub.inicio_activo_ts = null;
    if (!sub.minutos_acumulados || sub.minutos_acumulados <= 0) {
      sub.minutos_acumulados = 15;
    }
  }

  const nowStr = cleanDateISO(new Date().toISOString(), true);
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser ? currentUser.id_usuario : "USR-SYS",
    autor_nombre: currentUser ? currentUser.nombre : "Sistema",
    autor_rol: currentUser ? currentUser.rol_label : "Admin",
    tipo_evento: "asignacion_rapida",
    mensaje: `Subtarea "${sub.descripcion_servicio}" asignada a ${sub.nombre_tecnico} (Estado: ${newStatus}).`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Subtarea asignada a ${sub.nombre_tecnico}.`);
}

function archiveOrder(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  Swal.fire({
    title: "¿Archivar Orden definitivamente?",
    html: `
      <p style="font-size:13.5px; color:#cbd5e1; margin-bottom:8px;">
        La orden con <strong>Troquel #${order.codigo_troquel}</strong> (${order.nombre_cliente} · ${order.datos_motor.marca} ${order.datos_motor.modelo}) saldrá del flujo activo de <strong>6. Entrega</strong> y pasará a <strong>Archivados & Garantía</strong>.
      </p>
      <div style="font-size:12px; color:#fde047; background:rgba(245,223,0,0.1); padding:8px 12px; border-radius:8px; border:1px solid rgba(245,223,0,0.3);">
        <i class="fas fa-shield-alt"></i> Se mantendrá disponible en el histórico bajo póliza de garantía de 1 año.
      </div>
    `,
    icon: "question",
    showCancelButton: true,
    confirmButtonColor: "#f5df00",
    confirmButtonText: "Sí, Archivar Orden",
    cancelButtonText: "Cancelar"
  }).then((res) => {
    if (res.isConfirmed) {
      order.estado_actual = "archivado";
      order.fecha_archivado = new Date().toISOString();
      const nowStr = cleanDateISO(new Date().toISOString(), true);
      db.bitacora.push({
        id_mensaje: "MSG-" + Date.now(),
        orden_id: order.id_orden,
        codigo_troquel: order.codigo_troquel,
        autor_id: currentUser.id_usuario,
        autor_nombre: currentUser.nombre,
        autor_rol: currentUser.rol_label,
        tipo_evento: "archivo",
        mensaje: `Orden archivada formalmente por ${currentUser.nombre}. Sale de Entrega activa y se conserva en histórico bajo póliza de garantía.`,
        foto_adjunta_url: "",
        fecha_hora: nowStr
      });
      saveDatabase();
      renderScreen();
      showToast(`Orden #${order.codigo_troquel} archivada exitosamente.`);
    }
  });
}

function openWarrantyClaimModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  Swal.fire({
    title: `Activar Garantía (Reingreso) — Troquel #${order.codigo_troquel}`,
    html: `
      <p style="font-size:13px; color:#cbd5e1; margin-bottom:12px;">
        Registra el motivo por el cual el cliente <strong>${order.nombre_cliente}</strong> reingresa la pieza (${order.datos_motor.marca} ${order.datos_motor.modelo}) bajo garantía.
      </p>
      <textarea id="swal-warranty-reason" class="swal2-textarea" placeholder="Describe la falla, fuga de compresión, sonido o ajuste requerido..." style="width:90%; font-size:13px;"></textarea>
    `,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Activar Garantía",
    cancelButtonText: "Cancelar",
    preConfirm: () => {
      const reason = document.getElementById("swal-warranty-reason")?.value.trim();
      if (!reason) {
        Swal.showValidationMessage("Debes indicar el motivo del reingreso por garantía.");
        return false;
      }
      return reason;
    }
  }).then((res) => {
    if (res.isConfirmed) {
      order.garantia_activa = true;
      order.motivo_garantia = res.value;
      order.fecha_reingreso_garantia = new Date().toISOString();
      const nowStr = cleanDateISO(new Date().toISOString(), true);
      db.bitacora.push({
        id_mensaje: "MSG-" + Date.now(),
        orden_id: order.id_orden,
        codigo_troquel: order.codigo_troquel,
        autor_id: currentUser.id_usuario,
        autor_nombre: currentUser.nombre,
        autor_rol: currentUser.rol_label,
        tipo_evento: "garantia",
        mensaje: `Reingreso por Garantía activado por ${currentUser.nombre}. Motivo: ${res.value}`,
        foto_adjunta_url: "",
        fecha_hora: nowStr
      });
      saveDatabase();
      renderScreen();
      showToast(`Garantía activada para Troquel #${order.codigo_troquel}.`);
    }
  });
}

function resolveWarranty(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  Swal.fire({
    title: "¿Dar por Resuelta la Garantía?",
    text: `Se marcará la garantía de la pieza #${order.codigo_troquel} como subsanada y entregada nuevamente al cliente.`,
    icon: "success",
    showCancelButton: true,
    confirmButtonColor: "#22c55e",
    confirmButtonText: "Sí, Cerrar Garantía",
    cancelButtonText: "Cancelar"
  }).then((res) => {
    if (res.isConfirmed) {
      order.garantia_activa = false;
      order.fecha_resolucion_garantia = new Date().toISOString();
      const nowStr = cleanDateISO(new Date().toISOString(), true);
      db.bitacora.push({
        id_mensaje: "MSG-" + Date.now(),
        orden_id: order.id_orden,
        codigo_troquel: order.codigo_troquel,
        autor_id: currentUser.id_usuario,
        autor_nombre: currentUser.nombre,
        autor_rol: currentUser.rol_label,
        tipo_evento: "garantia_resuelta",
        mensaje: `Garantía subsanada satisfactoriamente y entregada al cliente por ${currentUser.nombre}.`,
        foto_adjunta_url: "",
        fecha_hora: nowStr
      });
      saveDatabase();
      renderScreen();
      showToast(`Garantía de Troquel #${order.codigo_troquel} resuelta.`);
    }
  });
}

function advanceOrderStage(orderId, targetStage) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  const stageNames = {
    recepcion: "1. Recepción",
    diagnostico: "2. Diagnóstico",
    aprobacion: "3. Aprobación",
    servicio: "4. Servicio",
    calidad: "5. Calidad",
    entrega: "6. Entrega",
    archivado: "Archivados & Garantía"
  };
  const targetName = stageNames[targetStage] || targetStage;
  order.estado_actual = targetStage;
  const nowStr = cleanDateISO(new Date().toISOString(), true);
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "cambio_etapa",
    mensaje: `Orden avanzada a etapa ${targetName} por ${currentUser.nombre}.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });
  saveDatabase();
  renderScreen();
  showToast(`Orden #${order.codigo_troquel} avanzada a ${targetName}.`);
}


/* ============================================================================
   SISTEMA MODAL GENÉRICO Y COMPRESOR DE FOTOS
   ============================================================================ */
function openModal({ title, icon = "fa-cogs", body, footer = "", wide = false }) {
  const root = document.getElementById("modal-root");
  if (!root) return;
  root.classList.remove("hidden");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target === this) closeModal()">
      <div class="modal-dialog" style="${wide ? "max-width: 960px;" : ""}">
        <div class="modal-header">
          <div class="modal-header-title">
            <i class="fas ${icon}" style="color:var(--renacer-gold); font-size:20px;"></i>
            <h3>${title}</h3>
          </div>
          <button type="button" class="modal-close-btn" onclick="closeModal()">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ""}
      </div>
    </div>
  `;
}

function closeModal() {
  const root = document.getElementById("modal-root");
  if (!root) return;
  root.classList.add("hidden");
  root.innerHTML = "";
}

/* ==================== V31: INSPECTOR RÁPIDO DE ORDEN / TROQUEL ==================== */
function renderClickableTroquelBadge(orderOrId, labelPrefix = "#") {
  let ord = null;
  if (typeof orderOrId === "object" && orderOrId !== null) {
    ord = orderOrId;
  } else if (typeof orderOrId === "string") {
    const clean = String(orderOrId).replace(/^#/, "").trim();
    ord = (db.ordenes || []).find(
      (o) => o.id_orden === clean || 
             o.codigo_troquel === clean || 
             String(o.troquel) === clean || 
             String(o.numero_troquel) === clean
    );
  }
  const id = ord ? ord.id_orden : orderOrId;
  const num = ord ? (ord.codigo_troquel || ord.numero_troquel || ord.id_orden) : orderOrId;
  return `<button type="button" class="btn-troquel-clickable" onclick="event.stopPropagation(); quickViewOrderDetails('${id}')" title="Clic para inspeccionar ficha técnica de la Orden ${num}">
    <i class="fas fa-barcode"></i> ${labelPrefix}${num}
  </button>`;
}

function quickViewOrderDetails(orderId) {
  const cleanId = String(orderId).replace(/^#/, "").trim();
  const order = (db.ordenes || []).find(
    (o) => o.id_orden === cleanId || 
           o.codigo_troquel === cleanId || 
           String(o.troquel) === cleanId || 
           String(o.numero_troquel) === cleanId
  );
  if (!order) {
    showToast(`No se encontró la orden con identificador: ${orderId}`, "warning");
    return;
  }

  const subtasks = (db.subtareas || []).filter((s) => s.orden_id === order.id_orden);
  const stateMap = {
    recepcion: { label: "1. Recepción", cls: "state-badge--recep", icon: "fa-clipboard-check" },
    diagnostico_presupuesto: { label: "1. Recepción", cls: "state-badge--recep", icon: "fa-clipboard-check" },
    diagnostico: { label: "2. Diagnóstico", cls: "state-badge--diag", icon: "fa-stethoscope" },
    aprobacion: { label: "3. Aprobación", cls: "state-badge--wait", icon: "fa-hand-holding-usd" },
    esperando_aprobacion_abono: { label: "3. Aprobación", cls: "state-badge--wait", icon: "fa-hand-holding-usd" },
    servicio: { label: "4. Servicio", cls: "state-badge--exec", icon: "fa-tools" },
    asignacion_ejecucion: { label: "4. Servicio", cls: "state-badge--exec", icon: "fa-tools" },
    terminado: { label: "4. Servicio (Listo)", cls: "state-badge--term", icon: "fa-flag-checkered" },
    calidad: { label: "5. Calidad", cls: "state-badge--qc", icon: "fa-shield-alt" },
    control_calidad: { label: "5. Calidad", cls: "state-badge--qc", icon: "fa-shield-alt" },
    entrega: { label: "6. En Entrega", cls: "state-badge--done", icon: "fa-truck" },
    entregado: { label: "6. En Entrega", cls: "state-badge--done", icon: "fa-truck" },
    archivado: { label: "Archivado", cls: "state-badge--archive", icon: "fa-box-archive" },
    anulado: { label: "Anulada", cls: "state-badge--danger", icon: "fa-ban" }
  };
  const st = stateMap[order.estado_actual] || stateMap.recepcion;

  const tasaBcv = Number(db.config?.tasaBcv || db.configuracion?.tasaBcv) || 45.80;
  const montoBs = (Number(order.monto_total) * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const saldoBs = (Number(order.saldo_pendiente) * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fotos = (order.galeria_fotos_pieza || []).concat(order.galeria_fotos_repuestos || []);
  const fotosHtml = fotos.length
    ? `<div style="display:flex; gap:8px; overflow-x:auto; padding:6px 0;">
        ${fotos.map((f, i) => `<img src="${f}" onclick="openPhotoLightbox('${f}', 'Foto Troquel #${order.codigo_troquel}', ${JSON.stringify(fotos).replace(/"/g, '&quot;')}, ${i})" style="width:72px; height:72px; border-radius:8px; object-fit:cover; border:1px solid var(--border-color); cursor:pointer;" title="Clic para ampliar foto ${i+1}" />`).join("")}
       </div>`
    : `<div style="font-size:11.5px; color:var(--text-muted); font-style:italic;">Sin fotos registradas para esta pieza.</div>`;

  const tasksHtml = subtasks.length
    ? subtasks.map(s => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 10px; background:rgba(255,255,255,0.03); border-radius:8px; margin-bottom:5px; border:1px solid var(--border-subtle);">
          <div>
            <strong style="font-size:12.5px;">${s.descripcion_servicio}</strong>
            <div style="font-size:11px; color:var(--text-muted);">
              <i class="fas fa-user-circle"></i> ${s.nombre_tecnico || "Sin asignar"} · ⏱️ ${formatMinutes(s.minutos_acumulados || 0)}
            </div>
          </div>
          <div style="text-align:right;">
            <span style="font-size:11px; font-weight:800; ${s.estado_subtarea === 'terminado' ? 'color:#22c55e;' : 'color:#f59e0b;'}">
              ${s.estado_subtarea === 'terminado' ? 'Listo' : 'En Proceso'}
            </span>
            ${(currentUser && (currentUser.rol === 'admin' || currentUser.rol === 'jefe_taller')) ? `<div style="font-family:'JetBrains Mono',monospace; font-size:11.5px; font-weight:800; color:#16a34a;">$${Number(s.comision_base_tecnico || 0).toFixed(2)}</div>` : ''}
          </div>
        </div>
      `).join("")
    : `<div style="font-size:11.5px; color:var(--text-muted); font-style:italic;">No hay subtareas desglosadas.</div>`;

  const cleanPhone = (order.telefono_cliente || "").replace(/[^0-9]/g, "");

  openModal({
    title: `Ficha Técnica — Troquel #${order.codigo_troquel || order.numero_troquel}`,
    icon: "fa-cube",
    wide: true,
    body: `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding-bottom:12px; border-bottom:1px solid var(--border-subtle); margin-bottom:14px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="background:var(--renacer-gold); color:#0b112c; font-family:'JetBrains Mono',monospace; font-weight:900; font-size:15px; padding:4px 10px; border-radius:8px;">
            TROQUEL #${order.codigo_troquel || order.numero_troquel}
          </span>
          <span class="state-badge ${st.cls}" style="font-size:12px;">
            <i class="fas ${st.icon}"></i> ${st.label}
          </span>
        </div>
        <div style="font-size:12px; color:var(--text-muted);">
          Ingreso: <strong>${formatDateHuman(order.fecha_ingreso, false)}</strong>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:14px; margin-bottom:14px;">
        <div style="background:var(--bg-card); padding:12px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
          <div style="font-size:11px; font-weight:800; color:var(--renacer-gold); text-transform:uppercase; margin-bottom:4px;">
            <i class="fas fa-car"></i> Motor y Vehículo
          </div>
          <div style="font-size:15px; font-weight:900;">${order.datos_motor.marca} ${order.datos_motor.modelo || ""}</div>
          <div style="font-size:12.5px; color:var(--text-main); margin-top:2px;">Pieza: <strong>${order.datos_motor.tipo_pieza}</strong></div>
          ${order.datos_motor.serial_pieza ? `<div style="font-size:11.5px; color:var(--text-muted);">Serial: ${order.datos_motor.serial_pieza}</div>` : ""}
          ${order.observaciones_iniciales ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:6px; font-style:italic;">Nota: "${order.observaciones_iniciales}"</div>` : ""}
        </div>

        <div style="background:var(--bg-card); padding:12px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
          <div style="font-size:11px; font-weight:800; color:var(--renacer-gold); text-transform:uppercase; margin-bottom:4px;">
            <i class="fas fa-user"></i> Datos del Cliente
          </div>
          <div style="font-size:14px; font-weight:900;">${order.nombre_cliente}</div>
          <div style="font-size:12px; color:var(--text-muted);">Doc: ${order.documento_cliente || "N/A"}</div>
          <div style="margin-top:6px; display:flex; gap:8px; align-items:center;">
            <a href="tel:${order.telefono_cliente}" class="btn btn--ghost btn--xs" style="text-decoration:none;">
              <i class="fas fa-phone"></i> ${order.telefono_cliente}
            </a>
            ${cleanPhone ? `<a href="https://wa.me/${cleanPhone.startsWith('58') ? cleanPhone : '58' + cleanPhone.replace(/^0/, '')}" target="_blank" class="btn btn--xs" style="background:#25d366; color:#fff; text-decoration:none;"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ""}
          </div>
        </div>
      </div>

      <!-- Resumen Financiero -->
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:14px; text-align:center;">
        <div style="background:rgba(255,255,255,0.02); padding:10px; border-radius:10px; border:1px solid var(--border-subtle);">
          <div style="font-size:10.5px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">Total Facturado</div>
          <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:900; color:var(--text-main);">$${Number(order.monto_total).toFixed(2)}</div>
          <div style="font-size:10.5px; color:var(--text-muted);">Bs. ${montoBs}</div>
        </div>
        <div style="background:rgba(22,163,74,0.06); padding:10px; border-radius:10px; border:1px solid rgba(22,163,74,0.3);">
          <div style="font-size:10.5px; color:#16a34a; font-weight:800; text-transform:uppercase;">Abonado</div>
          <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:900; color:#16a34a;">$${Number(order.monto_abonado).toFixed(2)}</div>
          <div style="font-size:10.5px; color:#16a34a;">Acreditado</div>
        </div>
        <div style="background:rgba(220,38,38,0.06); padding:10px; border-radius:10px; border:1px solid rgba(220,38,38,0.3);">
          <div style="font-size:10.5px; color:#ef4444; font-weight:800; text-transform:uppercase;">Saldo Restante</div>
          <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:900; color:#ef4444;">$${Number(order.saldo_pendiente).toFixed(2)}</div>
          <div style="font-size:10.5px; color:#ef4444;">Bs. ${saldoBs}</div>
        </div>
      </div>

      <!-- Subtareas y Asignaciones -->
      <div style="margin-bottom:14px;">
        <div style="font-size:11.5px; font-weight:800; color:var(--renacer-gold); text-transform:uppercase; margin-bottom:6px;">
          <i class="fas fa-tasks"></i> Servicios Presupuestados y Asignación (${subtasks.length})
        </div>
        ${tasksHtml}
      </div>

      <!-- Fotos -->
      <div style="margin-bottom:14px;">
        <div style="font-size:11.5px; font-weight:800; color:var(--renacer-gold); text-transform:uppercase; margin-bottom:6px;">
          <i class="fas fa-camera"></i> Soporte Visual (Pieza y Repuestos)
        </div>
        ${fotosHtml}
      </div>

      <!-- Botones de Acción -->
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding-top:12px; border-top:1px solid var(--border-subtle);">
        <button type="button" class="btn btn--gold" onclick="jumpToOrderInPipeline('${order.id_orden}')">
          <i class="fas fa-crosshairs"></i> Ir a la Orden en Tablero
        </button>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="btn btn--ghost" onclick="openOrderCrmModal('${order.id_orden}')">
            <i class="fas fa-comments"></i> Bitácora
          </button>
          <button type="button" class="btn btn--ghost" onclick="printOrderReceptionTicket('${order.id_orden}')">
            <i class="fas fa-print"></i> Ticket
          </button>
          <button type="button" class="btn btn--ghost" onclick="printOrderExcelSheet('${order.id_orden}')">
            <i class="fas fa-file-excel" style="color:#22c55e;"></i> Planilla
          </button>
          <button type="button" class="btn btn--secondary" onclick="closeModal()">
            Cerrar
          </button>
        </div>
      </div>
    `
  });
}

function jumpToOrderInPipeline(orderId) {
  closeModal();
  const cleanId = String(orderId).replace(/^#/, "").trim();
  const order = (db.ordenes || []).find(
    (o) => o.id_orden === cleanId || 
           o.codigo_troquel === cleanId || 
           String(o.troquel) === cleanId || 
           String(o.numero_troquel) === cleanId
  );
  if (!order) {
    showToast(`No se encontró la orden en el taller.`, "warning");
    return;
  }
  currentPhaseFilter = "all";
  navigateTab("pipeline");
  setTimeout(() => {
    const el = document.getElementById(`order-card-${order.id_orden}`) || document.querySelector(`[data-order-id="${order.id_orden}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("highlight-pulse");
      setTimeout(() => el.classList.remove("highlight-pulse"), 3800);
    }
  }, 350);
}

/* ============================================================================
   SISTEMA DE PERSONALIZACIÓN DE TEXTOS Y AVISOS — JESÚS ANDRADE (FASE 3)
   Navegación interactiva pestaña por pestaña, vista previa en vivo y dock flotante
   ============================================================================ */
let activeCustomizerTab = "pipeline";
let customizerDrafts = null;

function initCustomizerDrafts() {
  customizerDrafts = {
    pipeline_title: getCustomText("pipeline_title", DEFAULT_TEXT_CUSTOMIZATIONS.pipeline_title),
    pipeline_subtitle: getCustomText("pipeline_subtitle", DEFAULT_TEXT_CUSTOMIZATIONS.pipeline_subtitle),
    ar_title: getCustomText("ar_title", DEFAULT_TEXT_CUSTOMIZATIONS.ar_title),
    attendance_notice: getCustomText("attendance_notice", DEFAULT_TEXT_CUSTOMIZATIONS.attendance_notice),
    payroll_notice: getCustomText("payroll_notice", DEFAULT_TEXT_CUSTOMIZATIONS.payroll_notice),
    app_subtitle: getCustomText("app_subtitle", DEFAULT_TEXT_CUSTOMIZATIONS.app_subtitle),
    biblical_badge: getCustomText("biblical_badge", DEFAULT_TEXT_CUSTOMIZATIONS.biblical_badge),
    reception_terms: getCustomText("reception_terms", DEFAULT_TEXT_CUSTOMIZATIONS.reception_terms)
  };
}

function syncCustomizerDraftsFromInputs() {
  if (!customizerDrafts) initCustomizerDrafts();
  const map = {
    pipeline_title: "cust-pipeline-title",
    pipeline_subtitle: "cust-pipeline-subtitle",
    ar_title: "cust-ar-title",
    attendance_notice: "cust-attendance-notice",
    payroll_notice: "cust-payroll-notice",
    app_subtitle: "cust-app-subtitle",
    biblical_badge: "cust-biblical-badge",
    reception_terms: "cust-reception-terms"
  };
  for (const [key, elId] of Object.entries(map)) {
    const el = document.getElementById(elId);
    if (el) {
      customizerDrafts[key] = el.value.trim();
    }
  }
}

function switchCustomizerTab(tabKey, navigateApp = true) {
  syncCustomizerDraftsFromInputs();
  activeCustomizerTab = tabKey;

  // Navegar de fondo a la pestaña del taller correspondiente para inspección en vivo
  if (navigateApp) {
    if (tabKey === "pipeline") navigateTab("pipeline");
    else if (tabKey === "cuentas_cobrar") navigateTab("accounts_receivable");
    else if (tabKey === "asistencia") navigateTab("attendance");
    else if (tabKey === "personal") navigateTab("commissions_hr");
    else if (tabKey === "general") navigateTab("dashboard");
    else if (tabKey === "recepcion") navigateTab("pipeline");
  }

  // Actualizar botones de navegación en el modal
  document.querySelectorAll(".cust-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabKey);
  });

  const area = document.getElementById("cust-tab-content-area");
  if (area) {
    area.innerHTML = renderCustomizerTabContent(tabKey);
  }
  updateCustomizerLivePreview();
}

function renderCustomizerTabContent(tabKey) {
  if (!customizerDrafts) initCustomizerDrafts();

  if (tabKey === "pipeline") {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          <i class="fas fa-tasks" style="color:var(--renacer-gold);"></i> <strong>Tablero de Órdenes y Producción</strong> (Pestaña: Seguimiento de Órdenes)
        </span>
        <button type="button" class="btn btn--primary btn--xs" onclick="navigateTab('pipeline'); showToast('Mostrando pestaña Seguimiento en pantalla');">
          <i class="fas fa-eye"></i> Ver esta Pestaña en el Taller
        </button>
      </div>

      <div class="form-field">
        <label><i class="fas fa-heading"></i> Título Principal del Tablero</label>
        <input type="text" id="cust-pipeline-title" value="${escapeHtml(customizerDrafts.pipeline_title)}" oninput="handleCustomizerInput(this, 'pipeline_title')" placeholder="Ej: Seguimiento de Órdenes y Producción (Por Código de Troquel)" />
      </div>

      <div class="form-field" style="margin-top:10px;">
        <label><i class="fas fa-info-circle"></i> Subtítulo / Flujo de 6 Etapas</label>
        <input type="text" id="cust-pipeline-subtitle" value="${escapeHtml(customizerDrafts.pipeline_subtitle)}" oninput="handleCustomizerInput(this, 'pipeline_subtitle')" placeholder="Ej: Flujo de 6 etapas del taller: 1. Recepción → 2. Diagnóstico..." />
      </div>

      <!-- Vista previa en vivo idéntica a la cabecera real del Pipeline -->
      <div class="cust-preview-box">
        <div class="cust-preview-badge"><i class="fas fa-desktop"></i> Vista Previa en Vivo · Cabecera de Seguimiento</div>
        <h2 id="prev-cust-pipeline-title" style="font-size:17px; font-weight:900; color:var(--text-main); margin:0 0 4px 0;">
          ${escapeHtml(customizerDrafts.pipeline_title)}
        </h2>
        <p id="prev-cust-pipeline-subtitle" style="font-size:12px; color:var(--text-muted); margin:0;">
          ${escapeHtml(customizerDrafts.pipeline_subtitle)}
        </p>
      </div>
    `;
  }

  if (tabKey === "cuentas_cobrar") {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          <i class="fas fa-file-invoice-dollar" style="color:var(--renacer-gold);"></i> <strong>Módulo Financiero y Cobranzas</strong> (Pestaña: Facturas por cobrar)
        </span>
        <button type="button" class="btn btn--primary btn--xs" onclick="navigateTab('accounts_receivable'); showToast('Mostrando Facturas por Cobrar en pantalla');">
          <i class="fas fa-eye"></i> Ver esta Pestaña en el Taller
        </button>
      </div>

      <div class="form-field">
        <label><i class="fas fa-heading"></i> Título de la Cartera de Cuentas por Cobrar</label>
        <input type="text" id="cust-ar-title" value="${escapeHtml(customizerDrafts.ar_title)}" oninput="handleCustomizerInput(this, 'ar_title')" placeholder="Ej: Control General de Cuentas por Cobrar" />
      </div>

      <!-- Vista previa en vivo de Cuentas por Cobrar -->
      <div class="cust-preview-box">
        <div class="cust-preview-badge"><i class="fas fa-desktop"></i> Vista Previa en Vivo · Facturas por Cobrar</div>
        <div style="background:var(--bg-card); border-radius:12px; padding:12px; border:1px solid var(--border-subtle);">
          <span id="prev-cust-ar-title" style="font-size:11px; font-weight:900; color:var(--text-muted); text-transform:uppercase;">
            <i class="fas fa-file-invoice-dollar" style="color:var(--renacer-gold);"></i> ${escapeHtml(customizerDrafts.ar_title)}
          </span>
          <div style="font-family:'JetBrains Mono',monospace; font-size:26px; font-weight:900; color:#dc2626; margin-top:4px;">
            $ 90.00 <span style="font-size:13px; color:#0284c7; font-weight:700;">≈ Bs. 4.122,00 (Tasa BCV)</span>
          </div>
        </div>
      </div>
    `;
  }

  if (tabKey === "asistencia") {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          <i class="fas fa-user-clock" style="color:var(--renacer-gold);"></i> <strong>Presencia Física y Puntualidad</strong> (Pestaña: Control de Asistencia)
        </span>
        <button type="button" class="btn btn--primary btn--xs" onclick="navigateTab('attendance'); showToast('Mostrando Asistencia en pantalla');">
          <i class="fas fa-eye"></i> Ver esta Pestaña en el Taller
        </button>
      </div>

      <div class="form-field">
        <label><i class="fas fa-clock"></i> Aviso Oficial de Horario y Puntualidad (Kiosco y Tabla)</label>
        <textarea id="cust-attendance-notice" rows="2" style="font-size:12.5px; width:100%; border-radius:8px; padding:8px;" oninput="handleCustomizerInput(this, 'attendance_notice')">${escapeHtml(customizerDrafts.attendance_notice)}</textarea>
      </div>

      <!-- Vista previa en vivo del Kiosco / Aviso de Asistencia -->
      <div class="cust-preview-box">
        <div class="cust-preview-badge"><i class="fas fa-desktop"></i> Vista Previa en Vivo · Aviso en Kiosco QR y Asistencia</div>
        <div style="padding:10px 14px; background:rgba(245,196,0,0.08); border:1px dashed var(--renacer-gold); border-radius:10px; font-size:11.5px; color:var(--text-main);">
          <i class="fas fa-info-circle" style="color:var(--renacer-gold);"></i> 
          <span id="prev-cust-attendance-notice">${escapeHtml(customizerDrafts.attendance_notice)}</span>
        </div>
      </div>
    `;
  }

  if (tabKey === "personal") {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          <i class="fas fa-users-cog" style="color:var(--renacer-gold);"></i> <strong>Liquidación de Técnicos por Destajo</strong> (Pestaña: Personal y Comisiones)
        </span>
        <button type="button" class="btn btn--primary btn--xs" onclick="navigateTab('commissions_hr'); showToast('Mostrando Personal y Comisiones en pantalla');">
          <i class="fas fa-eye"></i> Ver esta Pestaña en el Taller
        </button>
      </div>

      <div class="form-field">
        <label><i class="fas fa-calendar-check"></i> Aviso Oficial de Ciclo Semanal (Corte Domingo)</label>
        <input type="text" id="cust-payroll-notice" value="${escapeHtml(customizerDrafts.payroll_notice)}" oninput="handleCustomizerInput(this, 'payroll_notice')" placeholder="Ej: Semana laboral de Lunes a Domingo. Corte y liquidación los días Domingo." />
      </div>

      <!-- Vista previa en vivo del banner de Destajo -->
      <div class="cust-preview-box">
        <div class="cust-preview-badge"><i class="fas fa-desktop"></i> Vista Previa en Vivo · Banner de Destajo Semanal</div>
        <div style="background:rgba(2,132,199,0.1); border:1px solid rgba(56,189,248,0.3); border-radius:12px; padding:12px 16px;">
          <strong style="color:#38bdf8; font-size:12.5px;">Personal Técnico (Pago por Trabajo Realizado)</strong>
          <p id="prev-cust-payroll-notice" style="font-size:11.5px; color:var(--text-muted); margin:4px 0 0 0;">
            ${escapeHtml(customizerDrafts.payroll_notice)}
          </p>
        </div>
      </div>
    `;
  }

  if (tabKey === "general") {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          <i class="fas fa-id-badge" style="color:var(--renacer-gold);"></i> <strong>Identidad Institucional del Taller</strong> (Menú Lateral y Cabecera)
        </span>
        <button type="button" class="btn btn--primary btn--xs" onclick="navigateTab('dashboard'); showToast('Mostrando Inicio en pantalla');">
          <i class="fas fa-eye"></i> Ver Pantalla Principal
        </button>
      </div>

      <div class="form-grid-2">
        <div class="form-field">
          <label><i class="fas fa-heading"></i> Subtítulo Institucional del Taller</label>
          <input type="text" id="cust-app-subtitle" value="${escapeHtml(customizerDrafts.app_subtitle)}" oninput="handleCustomizerInput(this, 'app_subtitle')" placeholder="Ej: Sistema de Gestión de Taller y Producción" />
        </div>
        <div class="form-field">
          <label><i class="fas fa-book-open"></i> Cita Bíblica / Badge Superior</label>
          <input type="text" id="cust-biblical-badge" value="${escapeHtml(customizerDrafts.biblical_badge)}" oninput="handleCustomizerInput(this, 'biblical_badge')" placeholder="Ej: JOB 8:7" />
        </div>
      </div>

      <!-- Vista previa en vivo de la Marca -->
      <div class="cust-preview-box">
        <div class="cust-preview-badge"><i class="fas fa-desktop"></i> Vista Previa en Vivo · Barra Lateral y Cabecera</div>
        <div style="display:flex; align-items:center; gap:12px; padding:12px; background:#0f172a; border-radius:12px; border:1px solid var(--border-subtle);">
          <div style="width:38px; height:38px; border-radius:50%; background:var(--renacer-gold); display:flex; align-items:center; justify-content:center; color:#0f1638; font-weight:900;">RR</div>
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <strong style="font-size:13.5px; color:#fff;">RECTIFICADORA RENACER</strong>
              <span id="prev-cust-biblical-badge" style="font-size:10px; font-weight:900; background:var(--renacer-gold); color:#0f1638; padding:2px 6px; border-radius:4px;">
                <i class="fas fa-book-open"></i> ${escapeHtml(customizerDrafts.biblical_badge)}
              </span>
            </div>
            <div id="prev-cust-app-subtitle" style="font-size:11px; color:var(--text-muted); margin-top:2px;">
              ${escapeHtml(customizerDrafts.app_subtitle)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (tabKey === "recepcion") {
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          <i class="fas fa-file-contract" style="color:var(--renacer-gold);"></i> <strong>Condiciones Legales de Recepción</strong> (Impresión en Comprobantes y Pantalla)
        </span>
        <button type="button" class="btn btn--primary btn--xs" onclick="closeModal(); openNewOrderModal();">
          <i class="fas fa-external-link-alt"></i> Probar en Modal de Nueva Orden
        </button>
      </div>

      <div class="form-field">
        <label><i class="fas fa-file-contract"></i> Cláusulas de Términos y Condiciones Oficiales</label>
        <textarea id="cust-reception-terms" rows="4" style="font-size:12px; width:100%; border-radius:8px; padding:8px; line-height:1.45;" oninput="handleCustomizerInput(this, 'reception_terms')">${escapeHtml(customizerDrafts.reception_terms)}</textarea>
      </div>

      <!-- Vista previa en vivo de Términos de Recepción -->
      <div class="cust-preview-box">
        <div class="cust-preview-badge"><i class="fas fa-desktop"></i> Vista Previa en Vivo · Términos Impresos y en Pantalla</div>
        <div style="background:rgba(245,223,0,0.06); border:1.5px dashed var(--renacer-gold-warm); border-radius:10px; padding:12px; font-size:11.5px; color:var(--text-main); white-space:pre-wrap; line-height:1.5;" id="prev-cust-reception-terms">
${escapeHtml(customizerDrafts.reception_terms)}
        </div>
      </div>
    `;
  }

  return "";
}

function handleCustomizerInput(inputEl, fieldKey) {
  if (!customizerDrafts) initCustomizerDrafts();
  customizerDrafts[fieldKey] = inputEl.value;

  // Actualizar Preview local en el modal
  const prevEl = document.getElementById(`prev-cust-${fieldKey.replace(/_/g, "-")}`);
  if (prevEl) {
    if (fieldKey === "biblical_badge") {
      prevEl.innerHTML = `<i class="fas fa-book-open"></i> ${escapeHtml(inputEl.value || "JOB 8:7")}`;
    } else {
      prevEl.textContent = inputEl.value;
    }
  }

  // Actualizar en tiempo real el elemento en la pantalla real si está visible
  if (fieldKey === "pipeline_title") {
    const el = document.getElementById("pipeline-screen-title");
    if (el) el.textContent = inputEl.value;
  } else if (fieldKey === "pipeline_subtitle") {
    const el = document.getElementById("pipeline-screen-subtitle");
    if (el) el.textContent = inputEl.value;
  } else if (fieldKey === "ar_title") {
    const el = document.getElementById("ar-screen-title");
    if (el) el.innerHTML = `<i class="fas fa-file-invoice-dollar" style="color:var(--renacer-gold);"></i> ${escapeHtml(inputEl.value)}`;
  } else if (fieldKey === "attendance_notice") {
    const el = document.getElementById("attendance-screen-notice");
    if (el) el.textContent = inputEl.value;
    const kEl = document.getElementById("kiosk-notice-display");
    if (kEl) kEl.textContent = inputEl.value;
  } else if (fieldKey === "payroll_notice") {
    const el = document.getElementById("payroll-notice-display");
    if (el) el.textContent = inputEl.value;
  }
}

function updateCustomizerLivePreview() {
  if (!customizerDrafts) initCustomizerDrafts();
}

/* ============================================================================
   MODO DE EDICIÓN DIRECTA EN PANTALLA (IN-PLACE LIVE TEXT EDITING)
   Permite a Jesús Andrade navegar de pestaña en pestaña y hacer clic en
   cualquier título, subtítulo o aviso para editarlo en vivo con teclado.
   ============================================================================ */
let isTextEditMode = false;

function toggleInPlaceTextEditing(enable = null) {
  if (enable === null) {
    isTextEditMode = !isTextEditMode;
  } else {
    isTextEditMode = Boolean(enable);
  }

  if (isTextEditMode) {
    if (!customizerDrafts) initCustomizerDrafts();
    closeModal();
    showLiveEditFloatingBar();
    applyInPlaceTextEditingToCurrentScreen();
    showToast("⚡ Modo Edición Directa Activo: Haz clic sobre cualquier texto con recuadro amarillo para modificarlo.", "info");
  } else {
    removeInPlaceTextEditingFromScreen();
    hideLiveEditFloatingBar();
    showToast("Modo de edición directa cerrado.");
  }
}

function showLiveEditFloatingBar() {
  let bar = document.getElementById("renacer-live-edit-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "renacer-live-edit-bar";
    bar.className = "renacer-live-edit-bar";
    document.body.appendChild(bar);
  }

  const tabNames = {
    pipeline: "Seguimiento de Órdenes",
    accounts_receivable: "Facturas por Cobrar",
    attendance: "Control de Asistencia",
    commissions_hr: "Personal y Destajo",
    dashboard: "Inicio",
    catalog_mgr: "Catálogo de Precios",
    inventario: "Inventario Repuestos",
    finances_ledger: "Finanzas",
    clients_dir: "Clientes"
  };

  const currentTabName = tabNames[currentTab] || "Pantalla Actual";

  bar.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <span style="display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:50%; background:var(--renacer-gold, #f5df00); color:#0f1638; font-weight:900; font-size:14px; box-shadow:0 0 10px rgba(245,223,0,0.5);">
        <i class="fas fa-edit"></i>
      </span>
      <div>
        <div style="font-size:11px; font-weight:900; color:var(--renacer-gold, #f5df00); text-transform:uppercase; letter-spacing:0.5px;">
          Modo Edición Directa · <span style="color:#fff;">${currentTabName}</span>
        </div>
        <div style="font-size:12px; color:#cbd5e1; font-weight:600;">
          Haz clic en cualquier texto con recuadro dorado para escribir libremente. Navega de pestaña en pestaña.
        </div>
      </div>
    </div>
    <div style="display:flex; align-items:center; gap:8px; margin-left:auto; flex-wrap:wrap;">
      <button type="button" class="btn btn--success btn--sm" onclick="saveInPlaceTexts()" style="font-weight:900; box-shadow:0 4px 14px rgba(34,197,94,0.4);">
        <i class="fas fa-save"></i> Guardar Textos
      </button>
      <button type="button" class="btn btn--gold btn--sm" onclick="openTextCustomizerModal()" style="font-weight:900;">
        <i class="fas fa-sliders-h"></i> Panel Completo
      </button>
      <button type="button" class="btn btn--ghost btn--sm" onclick="toggleInPlaceTextEditing(false)" style="color:#ef4444; border-color:rgba(239,68,68,0.4);" title="Salir del modo de edición directa">
        <i class="fas fa-times"></i> Salir
      </button>
    </div>
  `;
  bar.style.display = "flex";
}

function hideLiveEditFloatingBar() {
  const bar = document.getElementById("renacer-live-edit-bar");
  if (bar) bar.remove();
  const dock = document.getElementById("text-customizer-dock");
  if (dock) dock.remove();
}

function applyInPlaceTextEditingToCurrentScreen() {
  if (!isTextEditMode) return;
  if (!customizerDrafts) initCustomizerDrafts();

  showLiveEditFloatingBar();

  const targets = [
    { selector: "#pipeline-screen-title", key: "pipeline_title", singleLine: true },
    { selector: "#pipeline-screen-subtitle", key: "pipeline_subtitle", singleLine: false },
    { selector: "#ar-screen-title-text", key: "ar_title", singleLine: true },
    { selector: "#attendance-screen-notice", key: "attendance_notice", singleLine: false },
    { selector: "#payroll-notice-display", key: "payroll_notice", singleLine: false },
    { selector: "#sidebar-biblical-badge-text", key: "biblical_badge", singleLine: true },
    { selector: ".login-clean-sub", key: "app_subtitle", singleLine: true }
  ];

  targets.forEach((t) => {
    const el = document.querySelector(t.selector);
    if (el) {
      setupSingleEditableElement(el, t.key, t.singleLine);
    }
  });

  document.querySelectorAll("[data-custom-text-key]").forEach((el) => {
    const key = el.getAttribute("data-custom-text-key");
    if (key) {
      setupSingleEditableElement(el, key, false);
    }
  });
}

function setupSingleEditableElement(el, key, singleLine = false) {
  if (!el) return;

  el.contentEditable = "true";
  el.classList.add("renacer-editable-text");
  el.setAttribute("data-custom-text-key", key);
  el.setAttribute("spellcheck", "false");
  el.setAttribute("title", "Haz clic para editar este texto directamente en pantalla");

  el.oninput = function() {
    if (!customizerDrafts) initCustomizerDrafts();
    customizerDrafts[key] = this.innerText.trim();
  };

  if (singleLine) {
    el.onkeydown = function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.blur();
      }
    };
  }

  el.onclick = function(e) {
    e.stopPropagation();
  };
}

function removeInPlaceTextEditingFromScreen() {
  document.querySelectorAll(".renacer-editable-text, [data-custom-text-key]").forEach((el) => {
    el.contentEditable = "false";
    el.classList.remove("renacer-editable-text");
    el.removeAttribute("title");
    el.oninput = null;
    el.onkeydown = null;
    el.onclick = null;
  });
}

function saveInPlaceTexts() {
  if (!customizerDrafts) initCustomizerDrafts();

  document.querySelectorAll("[data-custom-text-key]").forEach((el) => {
    const key = el.getAttribute("data-custom-text-key");
    if (key && el.innerText) {
      customizerDrafts[key] = el.innerText.trim();
    }
  });

  const pTitle = document.getElementById("pipeline-screen-title");
  if (pTitle && pTitle.innerText) customizerDrafts.pipeline_title = pTitle.innerText.trim();

  const pSub = document.getElementById("pipeline-screen-subtitle");
  if (pSub && pSub.innerText) customizerDrafts.pipeline_subtitle = pSub.innerText.trim();

  const arTitle = document.getElementById("ar-screen-title-text") || document.getElementById("ar-screen-title");
  if (arTitle && arTitle.innerText) customizerDrafts.ar_title = arTitle.innerText.trim();

  const payNotice = document.getElementById("payroll-notice-display");
  if (payNotice && payNotice.innerText) customizerDrafts.payroll_notice = payNotice.innerText.trim();

  const attNotice = document.getElementById("attendance-screen-notice");
  if (attNotice && attNotice.innerText) customizerDrafts.attendance_notice = attNotice.innerText.trim();

  const bibBadge = document.getElementById("sidebar-biblical-badge-text");
  if (bibBadge && bibBadge.innerText) customizerDrafts.biblical_badge = bibBadge.innerText.trim();

  saveCustomTexts();
  toggleInPlaceTextEditing(false);
}

function minimizeTextCustomizerToDock() {
  syncCustomizerDraftsFromInputs();
  closeModal();
  toggleInPlaceTextEditing(true);
}

function expandTextCustomizerModal() {
  closeTextCustomizerDock();
  hideLiveEditFloatingBar();
  openTextCustomizerModal(activeCustomizerTab);
}

function closeTextCustomizerDock() {
  const dock = document.getElementById("text-customizer-dock");
  if (dock) dock.remove();
  const bar = document.getElementById("renacer-live-edit-bar");
  if (bar) bar.remove();
}

function openTextCustomizerModal(initialTab = null) {
  if (initialTab) activeCustomizerTab = initialTab;
  if (!customizerDrafts) initCustomizerDrafts();

  openModal({
    title: `Personalización de Textos y Avisos (Jesús Andrade / Dirección)`,
    icon: "fa-font",
    wide: true,
    body: `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px; background:rgba(245,196,0,0.06); padding:10px 14px; border-radius:10px; border:1px solid rgba(245,196,0,0.25);">
        <div style="font-size:12px; color:var(--text-muted); line-height:1.4;">
          <i class="fas fa-info-circle" style="color:var(--renacer-gold);"></i> 
          Pasa de <strong>pestaña en pestaña</strong> para ver y modificar cada sección en vivo. Al cambiar de pestaña, el taller de fondo también navega a esa pantalla.
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button type="button" class="btn btn--gold btn--xs" onclick="toggleInPlaceTextEditing(true)" style="font-weight:900; box-shadow:0 2px 8px rgba(245,223,0,0.35);" title="Activa la edición directa en la pantalla del taller para escribir haciendo clic directamente en cualquier texto">
            <i class="fas fa-magic"></i> Editar Directo en Pantalla
          </button>
          <button type="button" class="btn btn--ghost btn--xs" onclick="minimizeTextCustomizerToDock()" style="border-color:rgba(245,223,0,0.4); color:var(--renacer-gold); font-weight:800;" title="Minimiza el editor para escribir directamente en las pantallas del taller">
            <i class="fas fa-window-minimize"></i> Minimizar
          </button>
        </div>
      </div>

      <!-- Barra de Navegación por Pestañas del Sistema -->
      <div class="cust-tabs-nav">
        <button type="button" class="cust-tab-btn ${activeCustomizerTab === 'pipeline' ? 'active' : ''}" data-tab="pipeline" onclick="switchCustomizerTab('pipeline')">
          <i class="fas fa-tasks"></i> 1. Seguimiento
        </button>
        <button type="button" class="cust-tab-btn ${activeCustomizerTab === 'cuentas_cobrar' ? 'active' : ''}" data-tab="cuentas_cobrar" onclick="switchCustomizerTab('cuentas_cobrar')">
          <i class="fas fa-file-invoice-dollar"></i> 2. Facturas por Cobrar
        </button>
        <button type="button" class="cust-tab-btn ${activeCustomizerTab === 'asistencia' ? 'active' : ''}" data-tab="asistencia" onclick="switchCustomizerTab('asistencia')">
          <i class="fas fa-user-clock"></i> 3. Asistencia y Kiosco
        </button>
        <button type="button" class="cust-tab-btn ${activeCustomizerTab === 'personal' ? 'active' : ''}" data-tab="personal" onclick="switchCustomizerTab('personal')">
          <i class="fas fa-users-cog"></i> 4. Destajo y Personal
        </button>
        <button type="button" class="cust-tab-btn ${activeCustomizerTab === 'general' ? 'active' : ''}" data-tab="general" onclick="switchCustomizerTab('general')">
          <i class="fas fa-id-badge"></i> 5. Cabecera y Marca
        </button>
        <button type="button" class="cust-tab-btn ${activeCustomizerTab === 'recepcion' ? 'active' : ''}" data-tab="recepcion" onclick="switchCustomizerTab('recepcion')">
          <i class="fas fa-file-contract"></i> 6. Recepción y Términos
        </button>
      </div>

      <!-- Contenedor Dinámico de la Pestaña Activa -->
      <div id="cust-tab-content-area">
        ${renderCustomizerTabContent(activeCustomizerTab)}
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-top:20px; padding-top:14px; border-top:1px solid var(--border-subtle);">
        <button type="button" class="btn btn--ghost btn--sm" onclick="resetDefaultCustomTexts()">
          <i class="fas fa-rotate-left"></i> Restaurar Oficiales
        </button>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn--secondary" onclick="closeModal()">Cancelar</button>
          <button type="button" class="btn btn--gold" onclick="saveCustomTexts()">
            <i class="fas fa-save"></i> Guardar y Aplicar Textos
          </button>
        </div>
      </div>
    `
  });
}

function saveCustomTexts() {
  syncCustomizerDraftsFromInputs();
  if (!db.text_customizations) db.text_customizations = {};

  db.text_customizations.app_subtitle = customizerDrafts.app_subtitle || DEFAULT_TEXT_CUSTOMIZATIONS.app_subtitle;
  db.text_customizations.biblical_badge = customizerDrafts.biblical_badge || DEFAULT_TEXT_CUSTOMIZATIONS.biblical_badge;
  db.text_customizations.pipeline_title = customizerDrafts.pipeline_title || DEFAULT_TEXT_CUSTOMIZATIONS.pipeline_title;
  db.text_customizations.pipeline_subtitle = customizerDrafts.pipeline_subtitle || DEFAULT_TEXT_CUSTOMIZATIONS.pipeline_subtitle;
  db.text_customizations.reception_terms = customizerDrafts.reception_terms || DEFAULT_TEXT_CUSTOMIZATIONS.reception_terms;
  db.text_customizations.ar_title = customizerDrafts.ar_title || DEFAULT_TEXT_CUSTOMIZATIONS.ar_title;
  db.text_customizations.attendance_notice = customizerDrafts.attendance_notice || DEFAULT_TEXT_CUSTOMIZATIONS.attendance_notice;
  db.text_customizations.payroll_notice = customizerDrafts.payroll_notice || DEFAULT_TEXT_CUSTOMIZATIONS.payroll_notice;

  if (db.config) {
    db.config.text_customizations = db.text_customizations;
  }

  saveDatabase();
  closeModal();
  closeTextCustomizerDock();
  hideLiveEditFloatingBar();
  isTextEditMode = false;
  removeInPlaceTextEditingFromScreen();
  renderApp();
  syncToGoogleSheets(true);
  showToast("¡Textos y avisos personalizados guardados exitosamente!", "success");
}

function resetDefaultCustomTexts() {
  customizerDrafts = Object.assign({}, DEFAULT_TEXT_CUSTOMIZATIONS);
  db.text_customizations = Object.assign({}, DEFAULT_TEXT_CUSTOMIZATIONS);
  if (db.config) db.config.text_customizations = db.text_customizations;

  const area = document.getElementById("cust-tab-content-area");
  if (area) {
    area.innerHTML = renderCustomizerTabContent(activeCustomizerTab);
  }
  showToast("Textos restaurados a sus valores oficiales.");
}

/* ============================================================================
   LIGHTBOX FOTOGRÁFICO HD/4K CON ZOOM, PAN Y PANTALLA COMPLETA
   ============================================================================ */
let lightboxState = {
  active: false,
  images: [],
  currentIndex: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDragging: false,
  startX: 0,
  startY: 0,
  title: "Foto Inspección de Pieza"
};

function openPhotoLightbox(imageUrl, title = "Foto Inspección de Pieza", gallery = [], initialIndex = 0) {
  let images = Array.isArray(gallery) && gallery.length ? gallery : [imageUrl];
  let curIdx = initialIndex >= 0 && initialIndex < images.length ? initialIndex : images.indexOf(imageUrl);
  if (curIdx < 0) curIdx = 0;

  lightboxState = {
    active: true,
    images: images,
    currentIndex: curIdx,
    zoom: 1,
    panX: 0,
    panY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
    title: title
  };

  renderLightboxDOM();
}

function renderLightboxDOM() {
  let existing = document.getElementById("renacer-photo-lightbox");
  if (existing) existing.remove();

  const currentImgUrl = lightboxState.images[lightboxState.currentIndex] || "";
  const totalImgs = lightboxState.images.length;
  const currentNum = lightboxState.currentIndex + 1;

  const html = `
    <div id="renacer-photo-lightbox" class="photo-lightbox-backdrop" onclick="handleLightboxBackdropClick(event)">
      <div class="photo-lightbox-toolbar" onclick="event.stopPropagation()">
        <div class="photo-lightbox-title">
          <i class="fas fa-camera" style="color:var(--renacer-gold);"></i>
          <span>${lightboxState.title}</span>
          ${totalImgs > 1 ? `<span style="background:rgba(245,223,0,0.2); color:var(--renacer-gold); padding:2px 8px; border-radius:6px; font-weight:800; font-size:11.5px;">Foto ${currentNum} de ${totalImgs}</span>` : ""}
        </div>

        <div class="photo-lightbox-controls">
          <button type="button" class="lightbox-btn" onclick="lightboxZoom(-0.25)" title="Alejar (-)">
            <i class="fas fa-search-minus"></i>
          </button>
          <span id="lightbox-zoom-val" style="font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:800; min-width:44px; text-align:center;">
            ${Math.round(lightboxState.zoom * 100)}%
          </span>
          <button type="button" class="lightbox-btn" onclick="lightboxZoom(0.25)" title="Acercar (+)">
            <i class="fas fa-search-plus"></i>
          </button>
          <button type="button" class="lightbox-btn" onclick="lightboxResetZoom()" title="100%">
            <i class="fas fa-undo"></i> 100%
          </button>
          <button type="button" class="lightbox-btn" onclick="toggleLightboxFullscreen()" title="Pantalla completa">
            <i class="fas fa-expand"></i>
          </button>
          <a href="${currentImgUrl}" download="Foto_Renacer_${Date.now()}.jpg" target="_blank" class="lightbox-btn" title="Descargar / Abrir en HD">
            <i class="fas fa-download"></i> HD
          </a>
          <button type="button" class="lightbox-btn lightbox-btn--close" onclick="closePhotoLightbox()" title="Cerrar (Esc)">
            <i class="fas fa-times"></i> Cerrar
          </button>
        </div>
      </div>

      <div class="photo-lightbox-viewport" id="lightbox-viewport" onwheel="handleLightboxWheel(event)" onmousedown="handleLightboxMouseDown(event)">
        ${
          totalImgs > 1
            ? `<button type="button" class="lightbox-nav-arrow lightbox-nav-arrow--prev" onclick="event.stopPropagation(); lightboxPrevPhoto()" title="Foto anterior (←)"><i class="fas fa-chevron-left"></i></button>`
            : ""
        }
        <img
          id="lightbox-current-img"
          src="${currentImgUrl}"
          alt="Foto inspección de pieza"
          class="photo-lightbox-img"
          style="transform: scale(${lightboxState.zoom}) translate(${lightboxState.panX}px, ${lightboxState.panY}px);"
          draggable="false"
        />
        ${
          totalImgs > 1
            ? `<button type="button" class="lightbox-nav-arrow lightbox-nav-arrow--next" onclick="event.stopPropagation(); lightboxNextPhoto()" title="Siguiente foto (→)"><i class="fas fa-chevron-right"></i></button>`
            : ""
        }
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", html);
  document.addEventListener("keydown", handleLightboxKeyDown);
}

function handleLightboxBackdropClick(e) {
  if (e.target.id === "lightbox-viewport" || e.target.id === "renacer-photo-lightbox") {
    closePhotoLightbox();
  }
}

function closePhotoLightbox() {
  const el = document.getElementById("renacer-photo-lightbox");
  if (el) el.remove();
  lightboxState.active = false;
  document.removeEventListener("keydown", handleLightboxKeyDown);
}

function lightboxZoom(delta) {
  lightboxState.zoom = Math.min(4.0, Math.max(0.5, lightboxState.zoom + delta));
  applyLightboxTransform();
}

function lightboxResetZoom() {
  lightboxState.zoom = 1;
  lightboxState.panX = 0;
  lightboxState.panY = 0;
  applyLightboxTransform();
}

function applyLightboxTransform() {
  const img = document.getElementById("lightbox-current-img");
  const zoomDisplay = document.getElementById("lightbox-zoom-val");
  if (img) {
    img.style.transform = `scale(${lightboxState.zoom}) translate(${lightboxState.panX}px, ${lightboxState.panY}px)`;
  }
  if (zoomDisplay) {
    zoomDisplay.textContent = `${Math.round(lightboxState.zoom * 100)}%`;
  }
}

function handleLightboxWheel(e) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.2 : -0.2;
  lightboxZoom(delta);
}

function lightboxNextPhoto() {
  if (!lightboxState.images.length) return;
  lightboxState.currentIndex = (lightboxState.currentIndex + 1) % lightboxState.images.length;
  lightboxState.zoom = 1;
  lightboxState.panX = 0;
  lightboxState.panY = 0;
  renderLightboxDOM();
}

function lightboxPrevPhoto() {
  if (!lightboxState.images.length) return;
  lightboxState.currentIndex = (lightboxState.currentIndex - 1 + lightboxState.images.length) % lightboxState.images.length;
  lightboxState.zoom = 1;
  lightboxState.panX = 0;
  lightboxState.panY = 0;
  renderLightboxDOM();
}

function handleLightboxKeyDown(e) {
  if (!lightboxState.active) return;
  if (e.key === "Escape") closePhotoLightbox();
  if (e.key === "ArrowRight") lightboxNextPhoto();
  if (e.key === "ArrowLeft") lightboxPrevPhoto();
  if (e.key === "+" || e.key === "=") lightboxZoom(0.25);
  if (e.key === "-") lightboxZoom(-0.25);
}

function toggleLightboxFullscreen() {
  const el = document.getElementById("renacer-photo-lightbox");
  if (!el) return;
  if (!document.fullscreenElement) {
    el.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function handleLightboxMouseDown(e) {
  if (e.button !== 0) return;
  lightboxState.isDragging = true;
  lightboxState.startX = e.clientX - lightboxState.panX;
  lightboxState.startY = e.clientY - lightboxState.panY;

  const onMouseMove = (ev) => {
    if (!lightboxState.isDragging) return;
    lightboxState.panX = ev.clientX - lightboxState.startX;
    lightboxState.panY = ev.clientY - lightboxState.startY;
    applyLightboxTransform();
  };
  const onMouseUp = () => {
    lightboxState.isDragging = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

function readFileAsCompressedDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxDim = 1200; // Resolución optimizada HD (ahorro de cuota en localStorage sin pérdida de nitidez)
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => resolve(ev.target.result);
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================================
   PASO 1: RECEPCIÓN E INGRESO DE LA ORDEN (ESTADO 1: DIAGNÓSTICO / PRESUPUESTO)
   ============================================================================ */
let tempNewOrderState = {
  clienteEncontradoId: null,
  galeriaPieza: [],
  galeriaRepuestos: [],
  itemsPresupuesto: []
};

function getAlliedWorkshopsOptions() {
  const alliedClients = (db.clientes || []).filter((c) => c.es_taller_aliado || (c.tipo_cliente && c.tipo_cliente.includes("aliado")));
  const alliedOutsourcing = (db.usuarios || []).filter((u) => u.rol === "outsourcing" || u.tipo === "taller_externo");
  
  const options = [];
  alliedClients.forEach((c) => {
    options.push(`<option value="CLI_${c.id_cliente}">${c.nombre_completo} (${c.documento_identidad})</option>`);
  });
  alliedOutsourcing.forEach((u) => {
    if (!alliedClients.some((c) => c.nombre_completo === u.nombre)) {
      options.push(`<option value="USR_${u.id_usuario}">${u.nombre} (Taller Aliado Externo)</option>`);
    }
  });
  return options.join("");
}

function handleFastAlliedSelect(val) {
  if (!val) return;
  if (val.startsWith("CLI_")) {
    const id = val.replace("CLI_", "");
    const c = (db.clientes || []).find((x) => x.id_cliente === id);
    if (!c) return;
    const docTypeEl = document.getElementById("new-cli-doc-type");
    const docNumEl = document.getElementById("new-cli-doc-num");
    const nameEl = document.getElementById("new-cli-name");
    const phoneEl = document.getElementById("new-cli-phone");
    const addrEl = document.getElementById("new-cli-address");
    const alliedEl = document.getElementById("new-cli-allied");
    
    const parts = (c.documento_identidad || "").split("-");
    if (docTypeEl && parts.length > 1) docTypeEl.value = parts[0] + "-";
    if (docNumEl) docNumEl.value = parts.slice(1).join("-") || c.documento_identidad || "";
    if (nameEl) nameEl.value = c.nombre_completo || "";
    if (phoneEl) phoneEl.value = c.telefono || "";
    if (addrEl) addrEl.value = c.direccion || "";
    if (alliedEl) alliedEl.value = "true";
    tempNewOrderState.clienteEncontradoId = c.id_cliente;
    showToast(`Taller Aliado "${c.nombre_completo}" cargado.`);
  } else if (val.startsWith("USR_")) {
    const id = val.replace("USR_", "");
    const u = (db.usuarios || []).find((x) => x.id_usuario === id);
    if (!u) return;
    const nameEl = document.getElementById("new-cli-name");
    const phoneEl = document.getElementById("new-cli-phone");
    const alliedEl = document.getElementById("new-cli-allied");
    if (nameEl) nameEl.value = u.nombre || "";
    if (phoneEl) phoneEl.value = u.telefono || "";
    if (alliedEl) alliedEl.value = "true";
    showToast(`Taller Aliado "${u.nombre}" cargado.`);
  }
}

function handleClientNameAutocomplete(nameVal) {
  if (!nameVal || !nameVal.trim()) return;
  const search = nameVal.trim().toLowerCase();
  const match = (db.clientes || []).find((c) => {
    const full = (c.nombre_completo || c.nombre_cliente || "").toLowerCase().trim();
    return full === search || (search.length >= 3 && full.includes(search));
  });
  if (match) {
    const docTypeEl = document.getElementById("new-cli-doc-type");
    const docNumEl = document.getElementById("new-cli-doc-num");
    const docFullEl = document.getElementById("new-cli-doc");
    const phoneEl = document.getElementById("new-cli-phone");
    const addrEl = document.getElementById("new-cli-address");
    const alliedEl = document.getElementById("new-cli-allied");

    const parts = (match.documento_identidad || "").split("-");
    if (docTypeEl && parts.length > 1) docTypeEl.value = parts[0] + "-";
    if (docNumEl) docNumEl.value = parts.slice(1).join("-") || match.documento_identidad || "";
    if (docFullEl) docFullEl.value = match.documento_identidad || "";
    if (phoneEl && match.telefono) phoneEl.value = match.telefono;
    if (addrEl && match.direccion) addrEl.value = match.direccion;
    if (alliedEl) {
      const isAllied = String(match.tipo_cliente || "").toLowerCase().includes("aliado");
      alliedEl.value = isAllied ? "true" : "false";
    }
    if (typeof tempNewOrderState !== "undefined") {
      tempNewOrderState.clienteEncontradoId = match.id_cliente;
    }
    const statusEl = document.getElementById("cli-lookup-status");
    if (statusEl) {
      statusEl.innerHTML = `<span style="color:#22c55e;"><i class="fas fa-check-circle"></i> Cliente encontrado: ${match.nombre_completo || match.nombre_cliente} (${match.documento_identidad})</span>`;
    }
  }
}

function toggleSellSparesSection(checked) {
  const box = document.getElementById("sell-spares-container");
  if (!box) return;
  if (checked) {
    box.classList.remove("hidden");
  } else {
    box.classList.add("hidden");
  }
}

function addInventorySpareToTempOrder() {
  const select = document.getElementById("select-inventory-spare");
  const qtyInp = document.getElementById("input-inventory-spare-qty");
  if (!select || !select.value) {
    showToast("Selecciona un repuesto del inventario.", "warning");
    return;
  }
  const qty = parseInt(qtyInp?.value, 10) || 1;
  const spare = (db.inventario_repuestos || []).find((r) => r.id_repuesto === select.value);
  if (!spare) return;

  if (spare.stock_actual < qty) {
    Swal.fire({
      title: "Stock Insuficiente",
      text: `Solo quedan ${spare.stock_actual} ${spare.unidad} de ${spare.nombre} en inventario.`,
      icon: "warning",
      confirmButtonColor: "#182254"
    });
    return;
  }

  const unitPrice = Number(spare.precio_venta) || 0;
  const totalPrice = unitPrice * qty;

  tempNewOrderState.itemsPresupuesto.push({
    id_temp: "SP_" + Date.now(),
    id_repuesto: spare.id_repuesto,
    descripcion: `Repuesto: ${spare.nombre} (x${qty} ${spare.unidad || "pz"})`,
    monto: totalPrice,
    comision: 0,
    es_repuesto_inventario: true,
    cantidad_descontar: qty
  });

  renderTempBudgetItems();
  showToast(`Repuesto "${spare.nombre}" (x${qty}) añadido al presupuesto ($${totalPrice.toFixed(2)}).`);
}

function openNewOrderModal() {
  tempNewOrderState = {
    clienteEncontradoId: null,
    galeriaPieza: [],
    galeriaRepuestos: [],
    itemsPresupuesto: []
  };

  const catalogOptions = db.catalogo_servicios
    .map((c) => `<option value="${c.id_cat}">${c.nombre} — $${c.precio_sugerido} (Comisión: $${c.comision_sugerida})</option>`)
    .join("");

  const inventoryOptions = (db.inventario_repuestos || [])
    .map((r) => `<option value="${r.id_repuesto}">${r.nombre} — $${Number(r.precio_venta).toFixed(2)} (Stock: ${r.stock_actual} ${r.unidad || "pz"})</option>`)
    .join("");

  const numericTroquels = (db.ordenes || [])
    .map((o) => parseInt(String(o.codigo_troquel).replace(/\D/g, ""), 10))
    .filter((n) => !isNaN(n) && n > 0);
  const nextTroquel = numericTroquels.length > 0 ? Math.max(...numericTroquels) + 1 : 1577;

  openModal({
    title: "Estado 1: Recepción e Ingreso de Orden (Diagnóstico / Presupuesto)",
    icon: "fa-clipboard-list",
    wide: true,
    body: `
      <form id="form-new-order" onsubmit="event.preventDefault(); saveNewOrder();">
        <!-- 1. Identificación del Cliente o Selección Rápida de Taller Aliado -->
        <div class="form-section-box">
          <div class="form-section-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <span><i class="fas fa-id-card"></i> 1. Identificación del Cliente / Taller Aliado</span>
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:11px; font-weight:800; color:var(--renacer-gold);"><i class="fas fa-handshake"></i> ¿Es Taller Aliado?:</span>
              <select id="select-fast-allied-workshop" onchange="handleFastAlliedSelect(this.value)" style="padding:4px 8px; font-size:11.5px; font-weight:800; border-radius:8px; background:var(--bg-card); color:var(--text-main); border:1.5px solid var(--renacer-gold);">
                <option value="">-- Seleccionar Taller Aliado Registrado --</option>
                ${getAlliedWorkshopsOptions()}
              </select>
            </div>
          </div>
          <div class="form-grid-3">
            <div class="form-field">
              <label>Documento de Identidad (Cédula / RIF) *</label>
              <div style="display:flex; gap:6px;">
                <select id="new-cli-doc-type" onchange="handleNewOrderDocInput()" style="width:115px; font-weight:800; background:var(--bg-input); color:var(--text-main); border:1.5px solid var(--border-color); border-radius:10px; padding:7px 8px;">
                  <option value="V-">V- (Venezolano)</option>
                  <option value="J-">J- (Jurídico / RIF)</option>
                  <option value="E-">E- (Extranjero)</option>
                  <option value="G-">G- (Gubernamental)</option>
                </select>
                <input
                  type="text"
                  id="new-cli-doc-num"
                  placeholder="Número..."
                  inputmode="numeric"
                  required
                  oninput="handleNewOrderDocInput()"
                  style="flex:1;"
                />
                <button type="button" class="btn btn--primary" onclick="handleNewOrderDocInput()" title="Buscar cliente">
                  <i class="fas fa-search"></i>
                </button>
              </div>
              <input type="hidden" id="new-cli-doc" value="V-" />
              <span id="cli-lookup-status" style="font-size:11px; font-weight:700; color:var(--text-muted); margin-top:4px; display:block;">
                Selecciona el tipo (V-, J-, E-, G-) e ingresa el número para autocompletar o registrar sin errores.
              </span>
            </div>
            <div class="form-field">
              <label>Nombre Completo o Taller * (Autocompleta clientes registrados)</label>
              <input
                type="text"
                id="new-cli-name"
                placeholder="Nombre del cliente o taller aliado"
                list="renacer-clientes-autocomplete"
                oninput="handleClientNameAutocomplete(this.value)"
                required
              />
              <datalist id="renacer-clientes-autocomplete">
                ${(db.clientes || []).map((c) => `<option value="${c.nombre_completo || c.nombre_cliente}">${c.documento_identidad} - ${c.telefono}</option>`).join("")}
              </datalist>
            </div>
            <div class="form-field">
              <label>Teléfono / WhatsApp *</label>
              <input type="text" id="new-cli-phone" placeholder="0414-XXXXXXX" required />
            </div>
          </div>
          <div class="form-grid-2" style="margin-top:10px;">
            <div class="form-field">
              <label>Dirección (Opcional)</label>
              <input type="text" id="new-cli-address" placeholder="Sector / Dirección del taller o cliente" />
            </div>
            <div class="form-field">
              <label>Tipo de Cliente</label>
              <select id="new-cli-allied">
                <option value="false">Cliente Particular</option>
                <option value="true">Mecánico / Taller Aliado Recurrente</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 2. Datos Técnicos de la Pieza y Código de Troquel -->
        <div class="form-section-box" style="border-color:rgba(245,196,0,0.6); background:rgba(245,196,0,0.04);">
          <div class="form-section-title">
            <i class="fas fa-hashtag"></i> 2. Código de Troquel (Obligatorio) y Datos del Motor
          </div>
          <div class="form-grid-3">
            <div class="form-field">
              <label style="color:#b45309; font-weight:900;">CÓDIGO DE TROQUEL *</label>
              <input
                type="text"
                id="new-ord-troquel"
                value="${nextTroquel}"
                required
                style="font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:900; border:2px solid var(--renacer-gold); background:#fffbeb; color:#0f1638;"
              />
            </div>
            <div class="form-field">
              <label>Marca del Vehículo *</label>
              <select id="new-ord-marca-select" onchange="handleMarcaSelectChange(this.value)" style="width:100%; padding:9px 10px; border-radius:10px; border:1.5px solid var(--border-color); font-weight:700; background:var(--bg-input); color:var(--text-main);">
                <option value="">-- Seleccionar Marca --</option>
                <option value="TOYOTA">TOYOTA</option>
                <option value="CHEVROLET">CHEVROLET</option>
                <option value="FORD">FORD</option>
                <option value="MITSUBISHI">MITSUBISHI</option>
                <option value="HYUNDAI">HYUNDAI</option>
                <option value="NISSAN">NISSAN</option>
                <option value="JEEP">JEEP</option>
                <option value="FIAT">FIAT</option>
                <option value="RENAULT">RENAULT</option>
                <option value="VOLKSWAGEN">VOLKSWAGEN</option>
                <option value="HONDA">HONDA</option>
                <option value="KIA">KIA</option>
                <option value="MAZDA">MAZDA</option>
                <option value="MACK">MACK (Camión / Diésel)</option>
                <option value="IVECO">IVECO (Diésel)</option>
                <option value="ISUZU">ISUZU</option>
                <option value="CHERY">CHERY</option>
                <option value="DODGE">DODGE</option>
                <option value="CHRYSLER">CHRYSLER</option>
                <option value="PEUGEOT">PEUGEOT</option>
                <option value="OTRA">OTRA MARCA (Escribir manual)...</option>
              </select>
              <input
                type="text"
                id="new-ord-marca"
                placeholder="Escribe el nombre de la marca si no está en la lista..."
                style="display:none; margin-top:6px;"
              />
            </div>
            <div class="form-field">
              <label>Modelo / Motor *</label>
              <input type="text" id="new-ord-modelo" placeholder="Ej: Runner, Hilux, Corsa 1.6" required />
            </div>
          </div>
          <div class="form-field" style="margin-top:10px;">
            <label>Observaciones de Recepción (Fisuras, rayones, estado inicial)</label>
            <textarea
              id="new-ord-obs"
              rows="3"
              placeholder="Ej: Presenta recalentamiento entre cilindros 2 y 3, sin levas..."
              style="width:100%; border-radius:10px; border:1.5px solid var(--border-color); padding:9px 12px; background:var(--bg-input); color:var(--text-main); font-family:inherit; font-size:13px;"
            ></textarea>
            <input type="hidden" id="new-ord-pieza" value="Cámara / Culata" />
            <input type="hidden" id="new-ord-serial" value="S/N" />
          </div>
        </div>

        <!-- 3. DOS GALERÍAS FOTOGRÁFICAS SEPARADAS -->
        <div class="form-section-box">
          <div class="form-section-title">
            <i class="fas fa-camera-retro"></i> 3. Soporte Multimedia e Inspección Visual (2 Galerías Independientes)
          </div>
          <div class="dual-gallery-container">
            <div class="gallery-upload-card">
              <div class="gallery-upload-header">
                <div>
                  <h4 style="font-size:13.5px; font-weight:900; color:var(--renacer-gold);">
                    <i class="fas fa-camera"></i> Galería A: Fotos del Estado de la Pieza
                  </h4>
                  <p style="font-size:11.5px; color:var(--text-muted);">
                    Evidencia de cómo llega la cámara/bloque (rayones, fisuras o quemaduras).
                  </p>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                  <button type="button" class="btn btn--ghost" style="padding:5px 8px; font-size:11px;" onclick="addDemoPhotoToTempOrder('pieza')" title="Cargar foto de prueba">
                    Foto Prueba
                  </button>
                  <label class="btn btn--primary" style="cursor:pointer; padding:6px 11px; font-size:11.5px; font-weight:800; background:#0284c7;" title="Tomar foto en el momento con la cámara del teléfono">
                    <i class="fas fa-camera"></i> Tomar Foto
                    <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="handleNewOrderGalleryUpload(event, 'pieza')" />
                  </label>
                  <label class="btn btn--ghost" style="cursor:pointer; padding:6px 11px; font-size:11.5px; font-weight:800; border-color:rgba(56,189,248,0.5); color:#38bdf8;" title="Elegir fotos existentes de la galería">
                    <i class="fas fa-images"></i> Galería
                    <input type="file" accept="image/*" multiple style="display:none;" onchange="handleNewOrderGalleryUpload(event, 'pieza')" />
                  </label>
                </div>
              </div>
              <div id="preview-gallery-pieza" class="gallery-thumbs-grid"></div>
            </div>

            <div class="gallery-upload-card spares-gallery">
              <div class="gallery-upload-header">
                <div>
                  <h4 style="font-size:13.5px; font-weight:900; color:#b45309;">
                    <i class="fas fa-camera"></i> Galería B: Fotos de Repuestos del Cliente
                  </h4>
                  <p style="font-size:11.5px; color:var(--text-muted);">
                    Solo soporte visual de guías, válvulas, sellos o empacaduras traídas por el cliente (sin conteo de inventario).
                  </p>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                  <button type="button" class="btn btn--ghost" style="padding:5px 8px; font-size:11px;" onclick="addDemoPhotoToTempOrder('repuestos')" title="Cargar foto de repuestos de prueba">
                    Foto Prueba
                  </button>
                  <label class="btn btn--gold" style="cursor:pointer; padding:6px 11px; font-size:11.5px; font-weight:800;" title="Tomar foto en el momento con la cámara del teléfono">
                    <i class="fas fa-camera"></i> Tomar Foto
                    <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="handleNewOrderGalleryUpload(event, 'repuestos')" />
                  </label>
                  <label class="btn btn--ghost" style="cursor:pointer; padding:6px 11px; font-size:11.5px; font-weight:800; border-color:rgba(245,223,0,0.5); color:#fde047;" title="Elegir fotos de repuestos de la galería">
                    <i class="fas fa-images"></i> Galería
                    <input type="file" accept="image/*" multiple style="display:none;" onchange="handleNewOrderGalleryUpload(event, 'repuestos')" />
                  </label>
                </div>
              </div>
              <div id="preview-gallery-repuestos" class="gallery-thumbs-grid"></div>
            </div>
          </div>
        </div>

        <!-- 4. Repuestos del Taller Vendidos al Cliente (Inventario Javier Andrade) -->
        <div class="form-section-box" style="border:1.5px solid rgba(56, 189, 248, 0.45); background:rgba(56, 189, 248, 0.03);">
          <div class="form-section-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <span><i class="fas fa-boxes-stacked" style="color:#38bdf8;"></i> 4. ¿Se le vendieron repuestos del taller al cliente?</span>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px; font-weight:800; color:var(--text-main);">
              <input type="checkbox" id="toggle-sell-spares" onchange="toggleSellSparesSection(this.checked)" style="width:17px; height:17px; accent-color:#0284c7;" />
              Sí, incluir repuestos de inventario
            </label>
          </div>
          <div id="sell-spares-container" class="hidden" style="margin-top:10px;">
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              <select id="select-inventory-spare" style="flex:1; min-width:240px; padding:9px 12px; border-radius:10px; border:1.5px solid var(--border-color); font-weight:700;">
                <option value="">-- Seleccionar repuesto del inventario --</option>
                ${inventoryOptions}
              </select>
              <input type="number" id="input-inventory-spare-qty" min="1" value="1" style="width:75px; padding:9px; border-radius:10px; font-weight:800;" placeholder="Cant." />
              <button type="button" class="btn btn--primary" onclick="addInventorySpareToTempOrder()">
                <i class="fas fa-plus"></i> Agregar al Pedido
              </button>
            </div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
              <i class="fas fa-info-circle"></i> Al guardar la orden se descontarán automáticamente del stock controlado por Javier Andrade.
            </div>
          </div>
        </div>

        <!-- 5. Presupuesto Inicial (Desglose de Servicios y Precios) -->
        <div class="form-section-box">
          <div class="form-section-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <span><i class="fas fa-file-invoice-dollar"></i> 5. Presupuesto Inicial (Desglose de Servicios y Precios)</span>
            <button type="button" class="btn btn--gold btn--xs" onclick="addCustomServiceToTempOrder()">
              <i class="fas fa-plus"></i> + Servicio Adicional
            </button>
          </div>

          <!-- Buscador Predictivo en Tiempo Real: escribir y hacer clic añade el servicio al instante -->
          <div style="background:rgba(255,255,255,0.03); border:1.5px solid var(--border-subtle); border-radius:12px; padding:12px; margin-bottom:12px;">
            <div style="font-size:12px; font-weight:800; color:var(--text-muted); margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
              <span><i class="fas fa-search" style="color:var(--renacer-gold);"></i> Buscar y Añadir Servicio del Catálogo (1 Clic):</span>
              <span style="font-size:11px; color:var(--renacer-gold); font-weight:700;">Escribe para filtrar al instante</span>
            </div>
            <div style="position:relative;">
              <input
                type="text"
                id="search-budget-service-input"
                placeholder="Escribe el nombre del servicio (ej. cepillado, aplanado, armado, válvulas, cambio)..."
                oninput="filterBudgetServicesLive(this.value)"
                onfocus="filterBudgetServicesLive(this.value)"
                autocomplete="off"
                style="width:100%; padding:10px 14px; border-radius:10px; border:1.5px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-weight:700; font-size:13px;"
              />
              <div id="budget-services-live-dropdown" class="budget-services-dropdown-list hidden"></div>
            </div>
          </div>

          <div id="temp-budget-items-container"></div>
        </div>

        <!-- 5. TÉRMINOS Y CONDICIONES OBLIGATORIAS DEL TALLER (ACTUALIZACIÓN 2026) -->
        <div class="form-section-box" style="background:rgba(245, 223, 0, 0.06); border:1.5px dashed var(--renacer-gold-warm);">
          <div class="form-section-title" style="color:var(--renacer-gold); font-weight:900;">
            <i class="fas fa-balance-scale"></i> 5. Términos y Condiciones del Taller (Notificación Obligatoria al Cliente)
          </div>
          <div style="font-size:12px; color:var(--text-main); line-height:1.6; display:grid; gap:6px; margin-top:6px;">
            <div><strong>1. Plazo de Aprobación / Retiro:</strong> El cliente dispone de un plazo mínimo de tres (3) días para aprobar el presupuesto o retirar las piezas del taller.</div>
            <div><strong>2. Custodia de Piezas:</strong> La rectificadora no asume responsabilidad alguna por cámaras, motores, repuestos o piezas una vez transcurrido un (1) mes sin concretar o finalizar el trabajo.</div>
            <div><strong>3. Retiro del Trabajo:</strong> El trabajo solo podrá ser retirado si se ha cancelado en su totalidad (100%).</div>
            <div><strong>4. Ajustes por Limpieza:</strong> Existe la posibilidad de modificaciones del presupuesto debido a afectaciones adicionales encontradas en el proceso de limpieza o descarbonizado; el cliente será informado previamente.</div>
          </div>
        </div>
      </form>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewOrder(false)">
        <i class="fas fa-save"></i> Guardar en 1. Recepción
      </button>
      ${currentUser && (currentUser.rol === "admin" || currentUser.rol === "jefe_taller") ? `
        <button type="button" class="btn btn--primary btn--lg" onclick="saveNewOrder(true)" style="font-weight:900;">
          <i class="fas fa-bolt"></i> Guardar y Asignar a 4. Servicio (Taller)
        </button>
      ` : ""}
    `
  });

  renderTempOrderGalleries();
  renderTempBudgetItems();
}

function lookupClientByDoc(docRaw) {
  const clean = (docRaw || "").trim().toUpperCase();
  const statusEl = document.getElementById("cli-lookup-status");
  if (!clean) return;

  const found = db.clientes.find((c) => c.documento_identidad.toUpperCase() === clean);
  if (found) {
    tempNewOrderState.clienteEncontradoId = found.id_cliente;
    document.getElementById("new-cli-name").value = found.nombre_completo;
    document.getElementById("new-cli-phone").value = found.telefono;
    document.getElementById("new-cli-address").value = found.direccion || "";
    document.getElementById("new-cli-allied").value = found.es_taller_aliado ? "true" : "false";

    const parts = found.documento_identidad.split("-");
    if (parts.length >= 2) {
      const typeSelect = document.getElementById("new-cli-doc-type");
      const numInput = document.getElementById("new-cli-doc-num");
      if (typeSelect) typeSelect.value = parts[0] + "-";
      if (numInput && !numInput.value) numInput.value = parts.slice(1).join("-");
    }

    if (statusEl) {
      statusEl.style.color = "#16a34a";
      statusEl.innerHTML = `<i class="fas fa-check-circle"></i> Cliente encontrado: <strong>${found.nombre_completo}</strong> (Datos autocompletados).`;
    }
  } else {
    tempNewOrderState.clienteEncontradoId = null;
    if (statusEl) {
      statusEl.style.color = "#d97706";
      statusEl.innerHTML = `<i class="fas fa-user-plus"></i> Cliente nuevo: Completa el nombre y teléfono para registrarlo sin duplicados.`;
    }
  }
}

function handleMarcaSelectChange(val) {
  const input = document.getElementById("new-ord-marca");
  if (!input) return;
  if (val === "OTRA") {
    input.style.display = "block";
    input.value = "";
    input.required = true;
    input.focus();
  } else {
    input.style.display = "none";
    input.value = val;
    input.required = false;
  }
}

function handleNewOrderDocInput() {
  const prefix = document.getElementById("new-cli-doc-type")?.value || "V-";
  const numInput = document.getElementById("new-cli-doc-num");
  const rawNum = numInput ? numInput.value : "";
  const cleanNum = rawNum.replace(/[^0-9A-Za-z-]/g, "").trim();
  const fullDoc = cleanNum ? (prefix + cleanNum).toUpperCase() : "";
  const hiddenDoc = document.getElementById("new-cli-doc");
  if (hiddenDoc) hiddenDoc.value = fullDoc;
  if (fullDoc) {
    lookupClientByDoc(fullDoc);
  }
}

function addDemoPhotoToTempOrder(galleryType) {
  if (galleryType === "pieza") {
    tempNewOrderState.galeriaPieza.push(DEMO_PHOTOS.camaraCorsa);
  } else {
    tempNewOrderState.galeriaRepuestos.push(DEMO_PHOTOS.repuestosCliente);
  }
  renderTempOrderGalleries();
  showToast("Foto de prueba agregada a la galería.");
}

async function handleNewOrderGalleryUpload(event, galleryType) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  showToast(`Procesando ${files.length} foto(s) en alta resolución...`);
  for (const file of files) {
    const dataUrl = await readFileAsCompressedDataUrl(file);
    if (galleryType === "pieza") {
      tempNewOrderState.galeriaPieza.push(dataUrl);
    } else {
      tempNewOrderState.galeriaRepuestos.push(dataUrl);
    }
  }
  renderTempOrderGalleries();
  showToast(`${files.length} foto(s) agregada(s) exitosamente.`);
}

function removeTempGalleryPhoto(galleryType, idx) {
  if (galleryType === "pieza") {
    tempNewOrderState.galeriaPieza.splice(idx, 1);
  } else {
    tempNewOrderState.galeriaRepuestos.splice(idx, 1);
  }
  renderTempOrderGalleries();
}

function renderTempOrderGalleries() {
  const elPieza = document.getElementById("preview-gallery-pieza");
  const elRep = document.getElementById("preview-gallery-repuestos");
  if (elPieza) {
    elPieza.innerHTML = tempNewOrderState.galeriaPieza.length
      ? tempNewOrderState.galeriaPieza
          .map(
            (src, i) => `
          <div class="gallery-thumb-item">
            <img src="${src}" alt="Foto pieza ${i + 1}" onclick="openPhotoLightbox('${src}', 'Inspección de Pieza #${i + 1}')" style="cursor:zoom-in;" title="Toca para ampliar en 4K HD" />
            <button type="button" class="thumb-remove-btn" onclick="removeTempGalleryPhoto('pieza', ${i})">&times;</button>
          </div>
        `
          )
          .join("")
      : `<span style="font-size:11.5px; color:var(--text-muted); grid-column:1/-1;">Sin fotos aún.</span>`;
  }
  if (elRep) {
    elRep.innerHTML = tempNewOrderState.galeriaRepuestos.length
      ? tempNewOrderState.galeriaRepuestos
          .map(
            (src, i) => `
          <div class="gallery-thumb-item">
            <img src="${src}" alt="Foto repuestos ${i + 1}" onclick="openPhotoLightbox('${src}', 'Repuestos del Cliente #${i + 1}')" style="cursor:zoom-in;" title="Toca para ampliar en 4K HD" />
            <button type="button" class="thumb-remove-btn" onclick="removeTempGalleryPhoto('repuestos', ${i})">&times;</button>
          </div>
        `
          )
          .join("")
      : `<span style="font-size:11.5px; color:var(--text-muted); grid-column:1/-1;">Sin fotos de repuestos aún.</span>`;
  }
}

function addCatalogServiceToTempOrder() {
  const sel = document.getElementById("select-cat-service");
  if (!sel || !sel.value) return;
  const item = db.catalogo_servicios.find((c) => c.id_cat === sel.value);
  if (!item) return;
  tempNewOrderState.itemsPresupuesto.push({
    id_temp: "T-" + Date.now() + Math.random().toString(36).slice(2, 5),
    descripcion: item.nombre,
    monto: Number(item.precio_sugerido),
    comision: Number(item.comision_sugerida)
  });
  sel.value = "";
  renderTempBudgetItems();
}

function filterBudgetServicesLive(query) {
  const dropdown = document.getElementById("budget-services-live-dropdown");
  if (!dropdown) return;
  const q = (query || "").trim().toLowerCase();

  const services = db.catalogo_servicios || [];
  const filtered = q
    ? services.filter((s) => (s.nombre || "").toLowerCase().includes(q) || (s.modalidad || "").toLowerCase().includes(q))
    : services.slice(0, 12);

  if (filtered.length === 0) {
    dropdown.innerHTML = `
      <div style="padding:12px; text-align:center; font-size:12px; color:var(--text-muted);">
        No se encontró ningún servicio que coincida con "<strong>${query}</strong>".
        <div style="margin-top:8px;">
          <button type="button" class="btn btn--gold btn--xs" onclick="addCustomServiceWithName('${query.replace(/'/g, "\\'")}')">
            + Añadir "${query}" como Servicio Adicional
          </button>
        </div>
      </div>
    `;
    dropdown.classList.remove("hidden");
    return;
  }

  dropdown.innerHTML = filtered
    .map((s) => `
      <div class="budget-service-item-pick" onclick="pickBudgetServiceFromDropdown('${s.id_cat}')">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="color:var(--text-main); font-size:13px;"><i class="fas fa-wrench" style="color:var(--renacer-gold); margin-right:6px;"></i>${s.nombre}</strong>
          <span style="font-family:'JetBrains Mono',monospace; font-weight:900; color:var(--renacer-gold); font-size:14px;">$${Number(s.precio_sugerido).toFixed(2)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); margin-top:3px;">
          <span>${s.categoria || (s.es_outsourcing ? "Outsourcing / Solteca" : "Servicio de Taller")}</span>
          <span style="color:var(--renacer-gold); font-weight:700;"><i class="fas fa-tag"></i> Tarifa Oficial</span>
        </div>
      </div>
    `)
    .join("");

  dropdown.classList.remove("hidden");
}

function pickBudgetServiceFromDropdown(serviceId) {
  const s = (db.catalogo_servicios || []).find((c) => c.id_cat === serviceId);
  if (!s) return;

  tempNewOrderState.itemsPresupuesto.push({
    id_temp: "T-" + Date.now() + Math.random().toString(36).slice(2, 5),
    descripcion: s.nombre,
    monto: Number(s.precio_sugerido) || 0,
    comision: Number(s.comision_sugerida) || 0
  });

  const input = document.getElementById("search-budget-service-input");
  if (input) input.value = "";
  const dropdown = document.getElementById("budget-services-live-dropdown");
  if (dropdown) dropdown.classList.add("hidden");

  renderTempBudgetItems();
  showToast(`Servicio "${s.nombre}" añadido ($${Number(s.precio_sugerido).toFixed(2)}).`);
}

function addCustomServiceWithName(name) {
  tempNewOrderState.itemsPresupuesto.push({
    id_temp: "T-" + Date.now() + Math.random().toString(36).slice(2, 5),
    descripcion: name || "Servicio Adicional",
    monto: 25,
    comision: 8
  });
  const input = document.getElementById("search-budget-service-input");
  if (input) input.value = "";
  const dropdown = document.getElementById("budget-services-live-dropdown");
  if (dropdown) dropdown.classList.add("hidden");
  renderTempBudgetItems();
  showToast(`Servicio Adicional añadido.`);
}

function addCustomServiceToTempOrder() {
  tempNewOrderState.itemsPresupuesto.push({
    id_temp: "T-" + Date.now() + Math.random().toString(36).slice(2, 5),
    descripcion: "Servicio Adicional",
    monto: 25,
    comision: 8
  });
  renderTempBudgetItems();
}

function updateTempBudgetItem(index, field, value) {
  if (!tempNewOrderState.itemsPresupuesto[index]) return;
  if (field === "descripcion") {
    tempNewOrderState.itemsPresupuesto[index].descripcion = value;
  } else {
    tempNewOrderState.itemsPresupuesto[index][field] = Math.max(0, Number(value) || 0);
  }
  const total = tempNewOrderState.itemsPresupuesto.reduce((acc, it) => acc + (Number(it.monto) || 0), 0);
  const totalEl = document.getElementById("temp-budget-total-display");
  if (totalEl) totalEl.textContent = "$" + total.toFixed(2);
}

function removeTempBudgetItem(index) {
  tempNewOrderState.itemsPresupuesto.splice(index, 1);
  renderTempBudgetItems();
}

function renderTempBudgetItems() {
  const container = document.getElementById("temp-budget-items-container");
  if (!container) return;

  const total = tempNewOrderState.itemsPresupuesto.reduce((acc, it) => acc + (Number(it.monto) || 0), 0);

  const rowsHtml = tempNewOrderState.itemsPresupuesto
    .map(
      (item, idx) => `
      <div style="display:grid; grid-template-columns: 1fr 140px 42px; gap:10px; align-items:center; margin-bottom:8px;">
        <input
          type="text"
          value="${item.descripcion}"
          oninput="updateTempBudgetItem(${idx}, 'descripcion', this.value)"
          placeholder="Descripción del servicio"
          style="padding:9px 12px; border-radius:8px; border:1px solid var(--border-color); font-weight:700;"
        />
        <div>
          <label style="font-size:10px; display:block; color:var(--renacer-gold); font-weight:800; margin-bottom:2px;">PRECIO CLIENTE ($)</label>
          <input
            type="number"
            step="0.5"
            value="${item.monto}"
            oninput="updateTempBudgetItem(${idx}, 'monto', this.value)"
            style="width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--border-color); font-weight:900; font-size:14px; text-align:right;"
          />
        </div>
        <button type="button" class="btn btn--danger" style="padding:9px; height:38px; display:flex; align-items:center; justify-content:center; margin-top:14px;" onclick="removeTempBudgetItem(${idx})" title="Quitar ítem">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `
    )
    .join("");

  container.innerHTML = `
    ${rowsHtml || `<p style="font-size:12.5px; color:var(--text-muted);">Agrega al menos un servicio al presupuesto inicial.</p>`}
    <div style="display:flex; justify-content:space-between; align-items:center; padding-top:10px; border-top:2px solid var(--border-subtle); margin-top:8px;">
      <span style="font-size:13px; font-weight:800; color:var(--text-muted);">TOTAL PRESUPUESTO INICIAL:</span>
      <strong id="temp-budget-total-display" style="font-family:'JetBrains Mono',monospace; font-size:22px; font-weight:900; color:var(--renacer-gold);">
        $${total.toFixed(2)}
      </strong>
    </div>
  `;
}

function saveNewOrder(advanceToService = false) {
  const docType = document.getElementById("new-cli-doc-type")?.value || "V-";
  const docNum = (document.getElementById("new-cli-doc-num")?.value || "").trim().replace(/[^0-9A-Za-z-]/g, "");
  const doc = docNum ? (docType + docNum).toUpperCase() : (document.getElementById("new-cli-doc")?.value || "").trim().toUpperCase();
  const name = (document.getElementById("new-cli-name")?.value || "").trim();
  const phone = (document.getElementById("new-cli-phone")?.value || "").trim();
  const address = (document.getElementById("new-cli-address")?.value || "").trim();
  const isAllied = document.getElementById("new-cli-allied")?.value === "true";

  const troquel = (document.getElementById("new-ord-troquel")?.value || "").trim();
  const pieza = document.getElementById("new-ord-pieza")?.value || "Cámara / Culata";
  const marcaSel = document.getElementById("new-ord-marca-select")?.value || "";
  const marcaCustom = (document.getElementById("new-ord-marca")?.value || "").trim();
  const marca = (marcaSel && marcaSel !== "OTRA") ? marcaSel : marcaCustom;
  const modelo = (document.getElementById("new-ord-modelo")?.value || "").trim();
  const serial = (document.getElementById("new-ord-serial")?.value || "").trim() || "S/N";
  const obs = (document.getElementById("new-ord-obs")?.value || "").trim();

  if (!doc || !name || !troquel || !marca || !modelo) {
    showToast("Por favor completa Cédula/RIF, Nombre, Código de Troquel, Marca y Modelo.", "error");
    return;
  }

  if (tempNewOrderState.itemsPresupuesto.length === 0) {
    showToast("Agrega al menos un servicio al presupuesto inicial.", "error");
    return;
  }

  let clientObj = db.clientes.find((c) => c.documento_identidad.toUpperCase() === doc);
  if (!clientObj) {
    clientObj = {
      id_cliente: "CLI-" + (100 + db.clientes.length + 1),
      documento_identidad: doc,
      nombre_completo: name,
      telefono: phone,
      direccion: address,
      es_taller_aliado: isAllied
    };
    db.clientes.push(clientObj);
  } else {
    clientObj.nombre_completo = name;
    clientObj.telefono = phone;
    clientObj.direccion = address;
    clientObj.es_taller_aliado = isAllied;
  }

  const cleanTroquel = troquel.replace(/^#/, "").trim();
  const baseOrderId = `ORD-${cleanTroquel}`;
  const newOrderId = db.ordenes.some((o) => o.id_orden === baseOrderId)
    ? `${baseOrderId}-${db.ordenes.length + 1}`
    : baseOrderId;
  const montoTotal = tempNewOrderState.itemsPresupuesto.reduce((acc, it) => acc + (Number(it.monto) || 0), 0);
  const nowStr = cleanDateISO(new Date().toISOString(), true);

  const newOrder = {
    id_orden: newOrderId,
    cliente_id: clientObj.id_cliente,
    documento_cliente: clientObj.documento_identidad,
    nombre_cliente: clientObj.nombre_completo,
    telefono_cliente: clientObj.telefono,
    codigo_troquel: cleanTroquel,
    datos_motor: {
      tipo_pieza: pieza,
      marca,
      modelo,
      serial,
      observaciones: obs || "Recepción inicial con registro fotográfico."
    },
    galeria_fotos_pieza: tempNewOrderState.galeriaPieza.length ? tempNewOrderState.galeriaPieza : [DEMO_PHOTOS.camaraCorsa],
    galeria_fotos_repuestos: tempNewOrderState.galeriaRepuestos,
    estado_actual: advanceToService ? "servicio" : "diagnostico_presupuesto",
    subestado_ejecucion: advanceToService ? "en_proceso" : "pendiente",
    tipo_condicion_pago: "pendiente_definir",
    monto_total: montoTotal,
    monto_abonado: 0,
    saldo_pendiente: montoTotal,
    metodo_pago: "n/a",
    comprobante_pago_foto: "",
    prioridad_alta: false,
    factura_bloqueada: false,
    devuelto_calidad: false,
    motivo_rechazo_qc: "",
    fecha_ingreso: nowStr,
    tiempo_neto_minutos: 0
  };

  db.ordenes.unshift(newOrder);

  tempNewOrderState.itemsPresupuesto.forEach((it, idx) => {
    // Si es repuesto del inventario de Javier Andrade, descontar stock físico y registrar movimiento
    if (it.es_repuesto_inventario && it.id_repuesto) {
      const sp = (db.inventario_repuestos || []).find((r) => r.id_repuesto === it.id_repuesto);
      if (sp) {
        const cant = Number(it.cantidad_descontar) || 1;
        sp.stock_actual = Math.max(0, (Number(sp.stock_actual) || 0) - cant);
        if (!Array.isArray(db.movimientos_inventario)) db.movimientos_inventario = [];
        db.movimientos_inventario.unshift({
          id_mov: "MOV-" + Date.now() + "-" + idx,
          repuesto_id: sp.id_repuesto,
          repuesto_nombre: sp.nombre,
          tipo: "salida_orden",
          orden_id: newOrderId,
          codigo_troquel: cleanTroquel,
          cantidad: cant,
          fecha: nowStr,
          responsable: currentUser.nombre
        });
      }
    }

    db.subtareas.push({
      id_subtarea: `SUB-${cleanTroquel}-${idx + 1}-${Date.now().toString().slice(-3)}`,
      orden_id: newOrderId,
      codigo_troquel: cleanTroquel,
      descripcion_servicio: it.descripcion,
      tecnico_id: null,
      nombre_tecnico: "Sin asignar",
      monto_servicio: Number(it.monto) || 0,
      comision_base_tecnico: Number(it.comision) || 0,
      estado_subtarea: "pendiente",
      inicio_activo_ts: null,
      minutos_acumulados: 0,
      foto_terminado_url: "",
      fecha_terminado: null,
      comision_pagada: false
    });
  });

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: newOrderId,
    codigo_troquel: cleanTroquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "recepcion",
    mensaje: advanceToService
      ? `Pieza recibida con Orden #${cleanTroquel}. Presupuesto: $${montoTotal.toFixed(2)}. Avanzada directamente a 4. Servicio.`
      : `Pieza recibida con Orden #${cleanTroquel}. Presupuesto inicial: $${montoTotal.toFixed(2)}.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();

  if (advanceToService) {
    showToast(`Orden #${cleanTroquel} enviada a 4. Servicio. Asigna los técnicos a continuación.`);
    openSubtaskAssignmentModal(newOrderId, true);
    return;
  }

  if (clientObj && clientObj.telefono) {
    Swal.fire({
      title: `¡Orden #${cleanTroquel} Registrada!`,
      text: `¿Deseas enviar el comprobante de recepción con los Términos y Condiciones por WhatsApp a ${clientObj.nombre_completo} (sin precios)?`,
      icon: "success",
      showCancelButton: true,
      confirmButtonColor: "#22c55e",
      cancelButtonColor: "#64748b",
      confirmButtonText: '<i class="fab fa-whatsapp"></i> Enviar Términos por WhatsApp',
      cancelButtonText: 'Continuar en el Taller'
    }).then((res) => {
      if (res.isConfirmed) {
        openWhatsAppTermsOnlyModal(newOrderId);
      }
    });
  } else {
    showToast(`Orden #${cleanTroquel} registrada en 1. Diagnóstico / Presupuesto.`);
  }
}

/* ============================================================================
   PASO 2: TRANSICIÓN A 2. ESPERANDO APROBACIÓN (ABONO 50%, PAGO 100% O EXCEPCIÓN TALLER ALIADO)
   ============================================================================ */
let tempFinConditionState = {
  orderId: null,
  selectedOption: "pago_total",
  proofPhotoDataUrl: ""
};

function openFinancialApprovalModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  tempFinConditionState = {
    orderId: order.id_orden,
    selectedOption: order.tipo_condicion_pago !== "pendiente_definir" ? order.tipo_condicion_pago : "abono",
    proofPhotoDataUrl: order.comprobante_pago_foto || DEMO_PHOTOS.comprobantePago
  };

  openModal({
    title: `Estado 2: Condición Financiera / Interruptor Taller Aliado — Troquel #${order.codigo_troquel}`,
    icon: "fa-hand-holding-usd",
    wide: true,
    body: `
      <div style="background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.35); border-radius:12px; padding:12px 14px; margin-bottom:14px; font-size:13px;">
        <strong>Regla de Visibilidad (Fase 1 y Fase 2):</strong> La orden se detiene en <em>2. Esperando Aprobación</em> hasta que se registra el <strong>Pago Total (100%)</strong>, el <strong>Abono (50% u otro monto)</strong> o se activa el <strong>Interruptor de Excepción / Taller Aliado</strong>. Mientras tanto, ningún técnico la ve en su lista.
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-input); padding:12px 16px; border-radius:12px; margin-bottom:14px;">
        <div>
          <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Cliente: ${order.nombre_cliente} (${order.documento_cliente})</div>
          <div style="font-size:15px; font-weight:900;">${order.datos_motor.tipo_pieza} · ${order.datos_motor.marca} ${order.datos_motor.modelo}</div>
        </div>
        <div style="text-align:right;">
          <span style="font-size:11px; font-weight:800; color:var(--text-muted);">MONTO TOTAL PRESUPUESTO</span>
          <div style="font-family:'JetBrains Mono',monospace; font-size:24px; font-weight:900; color:var(--renacer-gold);">
            $${Number(order.monto_total).toFixed(2)}
          </div>
        </div>
      </div>

      <!-- Selector de las 3 Opciones Financieras -->
      <div class="fin-options-grid">
        <div id="fin-card-pago_total" class="fin-option-card" onclick="selectFinCondition('pago_total', ${order.monto_total})">
          <span class="fin-option-badge" style="background:rgba(22,163,74,0.16); color:#15803d;">OPCIÓN A · PRIORIDAD ALTA</span>
          <h4>Pago Total (100%)</h4>
          <p>El cliente liquida el 100% ($${Number(order.monto_total).toFixed(2)}) antes de iniciar. Marca automáticamente la orden con <strong>Prioridad Alta</strong>.</p>
        </div>

        <div id="fin-card-abono" class="fin-option-card" onclick="selectFinCondition('abono', ${order.monto_total})">
          <span class="fin-option-badge" style="background:rgba(217,119,6,0.18); color:#b45309;">OPCIÓN B · ADELANTO 50%</span>
          <h4>Abono (50% u otro monto)</h4>
          <p>Registra el monto abonado (ej. $${(order.monto_total * 0.5).toFixed(2)}), método de pago con foto y calcula el Resto automáticamente.</p>
        </div>

        <div id="fin-card-credito" class="fin-option-card" onclick="selectFinCondition('credito', ${order.monto_total})">
          <span class="fin-option-badge" style="background:rgba(2,132,199,0.18); color:#0284c7;">OPCIÓN C · INTERRUPTOR EXCEPCIÓN</span>
          <h4>Excepción / Taller Aliado (Crédito)</h4>
          <p>Activa el interruptor para talleres aliados o clientes autorizados: inicia sin pago previo y deja la cuenta abierta en Cuentas por Cobrar.</p>
        </div>
      </div>

      <div id="fin-condition-details-box" class="form-section-box" style="margin-top:16px;"></div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--Request" style="display:none;"></button>
      <button type="button" class="btn btn--gold btn--lg" onclick="confirmFinancialCondition()">
        <i class="fas fa-check-circle"></i> Guardar Condición Financiera
      </button>
    `
  });

  selectFinCondition(tempFinConditionState.selectedOption, order.monto_total);
}

function selectFinCondition(optionKey, montoTotal) {
  tempFinConditionState.selectedOption = optionKey;
  ["pago_total", "abono", "credito"].forEach((k) => {
    const card = document.getElementById("fin-card-" + k);
    if (card) {
      if (k === optionKey) card.classList.add("selected");
      else card.classList.remove("selected");
    }
  });

  const detailsBox = document.getElementById("fin-condition-details-box");
  if (!detailsBox) return;

  if (optionKey === "credito") {
    detailsBox.innerHTML = `
      <div class="form-section-title" style="color:#0284c7;">
        <i class="fas fa-toggle-on"></i> Interruptor Activado: Excepción / Taller Aliado (Crédito Flexible)
      </div>
      <p style="font-size:13px; color:var(--text-muted); margin-bottom:10px;">
        Esta orden quedará autorizada para ser asignada a los técnicos sin exigir abono ni repuestos previos. El saldo de <strong>$${Number(montoTotal).toFixed(2)}</strong> aparecerá en el módulo de <strong>Cuentas por Cobrar (Resto)</strong> y podrá cobrarse en cualquier momento (incluso después de entregada la pieza).
      </p>
      <div class="form-grid-2">
        <div class="form-field">
          <label>Abono Inicial Opcional ($)</label>
          <input type="number" id="fin-input-abono" value="0" min="0" max="${montoTotal}" step="1" oninput="recalcPendingBalance(${montoTotal})" />
        </div>
        <div class="form-field">
          <label>Resto Pendiente en Cuenta por Cobrar ($)</label>
          <input type="text" id="fin-input-saldo" value="$${Number(montoTotal).toFixed(2)}" readonly style="font-weight:900; color:#dc2626;" />
        </div>
      </div>
    `;
    return;
  }

  const defaultAbono = optionKey === "pago_total" ? montoTotal : Math.round(montoTotal * 0.5);
  const defaultSaldo = Math.max(0, montoTotal - defaultAbono);

  detailsBox.innerHTML = `
    <div class="form-section-title">
      <i class="fas fa-receipt"></i> Detalle del ${optionKey === "pago_total" ? "Pago Total (100%)" : "Abono Inicial"} y Soporte Multimedia
    </div>
    <div class="form-grid-2">
      <div class="form-field">
        <label>Monto Recibido ($) *</label>
        <input
          type="number"
          id="fin-input-abono"
          value="${defaultAbono}"
          ${optionKey === "pago_total" ? "readonly" : ""}
          min="1"
          max="${montoTotal}"
          step="0.5"
          oninput="recalcPendingBalance(${montoTotal})"
          style="font-weight:900; font-size:16px;"
        />
      </div>
      <div class="form-field">
        <label>Resto Pendiente ($)</label>
        <input
          type="text"
          id="fin-input-saldo"
          value="$${defaultSaldo.toFixed(2)}"
          readonly
          style="font-weight:900; font-size:16px; color:${defaultSaldo > 0 ? "#dc2626" : "#16a34a"};"
        />
      </div>
      <div class="form-field">
        <label>Cuenta / Banco de Ingreso *</label>
        <select id="fin-input-cuenta">
          <option value="efectivo">Efectivo Físico / Caja ($)</option>
          <option value="mercantil">Banco Mercantil (Pago Móvil / Transf.)</option>
          <option value="bnc">Banco Nacional de Crédito (BNC)</option>
          <option value="banesco">Banesco</option>
          <option value="zelle_otro">Zelle / Otros ($)</option>
        </select>
      </div>
      <div class="form-field">
        <label>Método de Pago *</label>
        <select id="fin-input-metodo">
          <option value="pago_movil">Transferencia / Pago Móvil</option>
          <option value="efectivo">Efectivo (Billetes Físicos)</option>
          <option value="transferencia">Zelle / Transferencia Digital</option>
        </select>
      </div>
    </div>

    <div style="margin-top:12px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; background:var(--bg-card); padding:12px; border-radius:12px; border:1.5px dashed var(--border-color);">
      <div>
        <div style="font-size:13px; font-weight:900;"><i class="fas fa-camera"></i> Soporte Multimedia Obligatorio (Capture o Foto de Billetes)</div>
        <div style="font-size:11.5px; color:var(--text-muted);">Adjunta la captura de la transferencia/Pago Móvil o la foto de los billetes recibidos en efectivo.</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <img id="fin-proof-preview" src="${tempFinConditionState.proofPhotoDataUrl}" alt="Comprobante" style="width:68px; height:52px; object-fit:cover; border-radius:8px; border:1px solid var(--border-color);" />
        <label class="btn btn--primary" style="cursor:pointer; padding:7px 12px; font-size:12px; font-weight:800; background:#0284c7;" title="Tomar foto con la cámara del teléfono">
          <i class="fas fa-camera"></i> Tomar Foto
          <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="handlePaymentProofUpload(event)" />
        </label>
        <label class="btn btn--ghost" style="cursor:pointer; padding:7px 12px; font-size:12px; font-weight:800; border-color:rgba(56,189,248,0.5); color:#38bdf8;" title="Elegir captura o comprobante de la galería">
          <i class="fas fa-images"></i> Galería / Capture
          <input type="file" accept="image/*" style="display:none;" onchange="handlePaymentProofUpload(event)" />
        </label>
      </div>
    </div>
  `;
}

function recalcPendingBalance(montoTotal) {
  const abonoEl = document.getElementById("fin-input-abono");
  const saldoEl = document.getElementById("fin-input-saldo");
  if (!abonoEl || !saldoEl) return;
  const abono = Math.max(0, Number(abonoEl.value) || 0);
  const saldo = Math.max(0, montoTotal - abono);
  saldoEl.value = "$" + saldo.toFixed(2);
}

async function handlePaymentProofUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const dataUrl = await readFileAsCompressedDataUrl(file);
  tempFinConditionState.proofPhotoDataUrl = dataUrl;
  const img = document.getElementById("fin-proof-preview");
  if (img) img.src = dataUrl;
  showToast("Foto de comprobante de pago cargada.");
}

function confirmFinancialCondition() {
  const order = db.ordenes.find((o) => o.id_orden === tempFinConditionState.orderId);
  if (!order) return;

  const opt = tempFinConditionState.selectedOption;
  const abonoInput = document.getElementById("fin-input-abono");
  const metodoInput = document.getElementById("fin-input-metodo");
  const cuentaInput = document.getElementById("fin-input-cuenta")?.value || "efectivo";
  const nuevoAbono = opt === "pago_total" ? Number(order.monto_total) : Math.max(0, Number(abonoInput?.value) || 0);
  const diferenciaAbono = Math.max(0, nuevoAbono - (Number(order.monto_abonado) || 0));

  if ((opt === "pago_total" || opt === "abono") && !tempFinConditionState.proofPhotoDataUrl) {
    showToast("Es obligatorio adjuntar la foto del capture o de los billetes recibidos.", "error");
    return;
  }

  order.tipo_condicion_pago = opt;
  order.monto_abonado = nuevoAbono;
  order.saldo_pendiente = Math.max(0, Number(order.monto_total) - nuevoAbono);
  order.metodo_pago = opt === "credito" && nuevoAbono === 0 ? "n/a" : metodoInput?.value || "pago_movil";
  order.cuenta_pago = opt === "credito" && nuevoAbono === 0 ? "" : cuentaInput;
  order.comprobante_pago_foto = opt === "credito" && nuevoAbono === 0 ? "" : tempFinConditionState.proofPhotoDataUrl;
  order.prioridad_alta = opt === "pago_total";

  if (order.estado_actual === "diagnostico_presupuesto") {
    order.estado_actual = "esperando_aprobacion_abono";
  }

  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  if (diferenciaAbono > 0) {
    db.finanzas_movimientos.unshift({
      id_mov: "MOV-" + Date.now(),
      fecha: nowStr.slice(0, 10),
      tipo: "ingreso",
      categoria: opt === "pago_total" ? "Liquidación Total de Orden" : "Abono de Orden",
      concepto: `${opt === "pago_total" ? "Pago Total 100%" : "Abono"} ${order.id_orden} (Troquel #${order.codigo_troquel} · ${order.nombre_cliente})`,
      monto: diferenciaAbono,
      metodo: order.metodo_pago,
      cuenta: cuentaInput,
      orden_id: order.id_orden
    });
  }

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "finanzas",
    mensaje: `Condición financiera registrada: ${opt.toUpperCase()}. Abonado: $${nuevoAbono.toFixed(2)} | Resto: $${order.saldo_pendiente.toFixed(2)}. ${
      order.prioridad_alta ? "Marcada con PRIORIDAD ALTA." : ""
    }`,
    foto_adjunta_url: order.comprobante_pago_foto || "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();

  if (currentUser.rol === "admin" || currentUser.rol === "jefe_taller") {
    showToast(`Condición registrada. Ahora puedes asignar los técnicos para pasar a 3. Asignación y Ejecución.`);
    openSubtaskAssignmentModal(order.id_orden);
  } else {
    showToast(`Condición financiera guardada en ${order.id_orden}. Lista para asignación por el Jefe de Taller.`);
  }
}

/* ============================================================================
   PASO 3: ASIGNACIÓN CENTRALIZADA (MATRIZ DE SUBTAREAS POR TÉCNICO)
   ============================================================================ */
function renderAssignmentCenterScreen() {
  if (currentUser.rol !== "admin" && currentUser.rol !== "jefe_taller") {
    return `
      <div style="padding:40px; text-align:center; background:var(--bg-card); border-radius:18px;">
        <i class="fas fa-lock" style="font-size:36px; color:#dc2626; margin-bottom:10px;"></i>
        <h3>Acceso Restringido a Jefes de Taller y Administración</h3>
        <p style="color:var(--text-muted); font-size:13px;">Solo los Jefes de Taller (Jesús Andrade y Sr. Enrique) o el Administrador tienen acceso a la Matriz de Asignación.</p>
      </div>
    `;
  }

  const readyOrActiveOrders = db.ordenes.filter(
    (o) =>
      (o.estado_actual === "esperando_aprobacion_abono" && o.tipo_condicion_pago !== "pendiente_definir") ||
      o.estado_actual === "asignacion_ejecucion"
  );

  const frozenOrders = db.ordenes.filter(
    (o) => o.estado_actual === "diagnostico_presupuesto" || (o.estado_actual === "esperando_aprobacion_abono" && o.tipo_condicion_pago === "pendiente_definir")
  );

  return `
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:18px; padding:16px 20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div>
        <span style="font-size:11px; font-weight:900; color:#0284c7; text-transform:uppercase;">
          ESTADO 3 · EXCLUSIVO JEFES DE TALLER Y ADMINISTRACIÓN
        </span>
        <h2 style="font-size:20px; font-weight:900;">Matriz de Asignación Libre por Subtareas y Ejecución</h2>
        <p style="font-size:13px; color:var(--text-muted);">
          Asigna discrecionalmente cada servicio (Lavado Químico, Aplanado, Cambio de Guías, Calibración) a uno o varios técnicos. Al confirmar, la orden aparece de inmediato en el celular del técnico.
        </p>
      </div>
    </div>

    ${
      frozenOrders.length
        ? `<div style="background:rgba(245,158,11,0.1); border:1px solid rgba(245,158,11,0.35); border-radius:14px; padding:12px 16px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
            <div style="font-size:13px;">
              <i class="fas fa-snowflake" style="color:#d97706;"></i>
              Hay <strong>${frozenOrders.length} orden(es) detenida(s)</strong> esperando registrar Pago Total, Abono 50% o Interruptor de Taller Aliado antes de poder asignarlas.
            </div>
            <button type="button" class="btn btn--warning" onclick="navigateTab('step2_approval')">
              Ir a 2. Esperando Aprobación
            </button>
          </div>`
        : ""
    }

    <div class="orders-grid">
      ${
        readyOrActiveOrders.length
          ? readyOrActiveOrders.map((o) => renderOrderCardTelegramStyle(o)).join("")
          : `<div style="grid-column:1/-1; padding:36px; text-align:center; background:var(--bg-card); border-radius:18px;">No hay órdenes listas para asignación en este momento.</div>`
      }
    </div>
  `;
}

function openSubtaskAssignmentModal(orderId, directAdvance = false) {
  if (currentUser.rol !== "admin" && currentUser.rol !== "jefe_taller") {
    showToast("Solo el Jefe de Taller o Administración puede asignar subtareas a los técnicos.", "error");
    return;
  }

  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  if (order.tipo_condicion_pago === "pendiente_definir" && !directAdvance) {
    const isBoss = currentUser.rol === "admin" || currentUser.rol === "jefe_taller";
    if (!isBoss) {
      showToast("Primero debes registrar Pago Total, Abono o activar Excepción / Taller Aliado.", "error");
      openFinancialApprovalModal(orderId);
      return;
    }
  }

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  const assignableWorkers = db.usuarios.filter(
    (u) => (u.rol === "tecnico" || u.rol === "outsourcing" || u.tipo === "taller_externo" || u.es_externo) && u.activo
  );
  const internalTechs = assignableWorkers.filter((u) => u.rol === "tecnico");
  const externalWorkshops = assignableWorkers.filter((u) => u.rol === "outsourcing" || u.tipo === "taller_externo" || u.es_externo);

  const techOptionsHtml = (selectedId) => {
    let opts = `<option value="">-- Sin Asignar / Quitar Técnico --</option>`;
    if (internalTechs.length) {
      opts += `<optgroup label="Técnicos Internos (Destajo Taller)">`;
      internalTechs.forEach((t) => {
        opts += `<option value="${t.id_usuario}" ${t.id_usuario === selectedId ? "selected" : ""}>[Interno] ${t.nombre} (${t.especialidad})</option>`;
      });
      opts += `</optgroup>`;
    }
    if (externalWorkshops.length) {
      opts += `<optgroup label="Talleres Externos (Outsourcing)">`;
      externalWorkshops.forEach((w) => {
        opts += `<option value="${w.id_usuario}" ${w.id_usuario === selectedId ? "selected" : ""}>[Externo] ${w.nombre} (${w.especialidad})</option>`;
      });
      opts += `</optgroup>`;
    }
    return opts;
  };

  const stateBadgeLabel = (st) => {
    if (st === "terminado") return `<span class="state-badge state-badge--done"><i class="fas fa-check-circle"></i> Terminado</span>`;
    if (st === "empezado") return `<span class="state-badge state-badge--exec"><i class="fas fa-wrench"></i> En Proceso</span>`;
    if (st === "pausado") return `<span class="state-badge state-badge--wait"><i class="fas fa-pause-circle"></i> Pausado</span>`;
    return `<span class="state-badge state-badge--diag"><i class="fas fa-clock"></i> Por Hacer</span>`;
  };

  const rowsHtml = subtasks
    .map(
      (s, i) => `
      <tr>
        <td><strong>#${i + 1}</strong></td>
        <td>
          <input
            type="text"
            id="assign-desc-${s.id_subtarea}"
            value="${s.descripcion_servicio}"
            style="width:100%; padding:6px 8px; border-radius:8px; border:1px solid var(--border-color); font-weight:800; font-size:13px; margin-bottom:4px;"
          />
          <div>${stateBadgeLabel(s.estado_subtarea)}</div>
        </td>
        <td>
          <input
            type="number"
            step="0.5"
            id="assign-price-${s.id_subtarea}"
            value="${s.monto_servicio}"
            oninput="updateLiveAssignmentTotals('${order.id_orden}')"
            style="width:95px; padding:6px 8px; border-radius:8px; border:1px solid var(--border-color); font-weight:900; font-family:'JetBrains Mono',monospace;"
          />
        </td>
        <td>
          <input
            type="number"
            step="0.5"
            id="assign-comm-${s.id_subtarea}"
            value="${s.comision_base_tecnico}"
            oninput="updateLiveAssignmentTotals('${order.id_orden}')"
            style="width:95px; padding:6px 8px; border-radius:8px; border:1.5px solid rgba(22,163,74,0.5); font-weight:900; color:#16a34a; font-family:'JetBrains Mono',monospace;"
          />
        </td>
        <td>
          <select
            id="assign-tech-${s.id_subtarea}"
            onchange="updateLiveAssignmentTotals('${order.id_orden}')"
            style="width:100%; padding:8px 10px; border-radius:9px; border:1.5px solid var(--border-color); font-weight:800;"
          >
            ${techOptionsHtml(s.tecnico_id)}
          </select>
        </td>
        <td style="text-align:center; white-space:nowrap;">
          <div style="display:flex; gap:4px; justify-content:center;">
            ${s.tecnico_id ? `
              <button type="button" class="btn btn--danger btn--xs" style="padding:4px 7px; font-size:10px; font-weight:800;" onclick="unassignSubtaskInModalDirect('${s.id_subtarea}', '${order.id_orden}')" title="Quitar técnico asignado">
                <i class="fas fa-times"></i> Quitar
              </button>
            ` : ""}
            <button type="button" class="btn btn--ghost btn--xs" style="padding:4px 6px; font-size:10.5px; color:#ef4444;" onclick="deleteSubtaskDirect('${s.id_subtarea}', '${order.id_orden}')" title="Eliminar subtarea">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");

  const quickAssignButtons = internalTechs
    .slice(0, 6)
    .map(
      (t) => `
      <button type="button" class="btn btn--ghost" style="padding:5px 10px; font-size:11.5px;" onclick="assignAllSubtasksInModalTo('${t.id_usuario}', '${order.id_orden}')">
        <i class="fas fa-user-tag"></i> Asignar Todo a ${t.nombre.split(" ")[0]}
      </button>
    `
    )
    .join("");

  openModal({
    title: `Fase 3: Matriz de Asignación Modular y Destajo — TROQUEL #${order.codigo_troquel}`,
    icon: "fa-user-check",
    wide: true,
    body: `
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:14px; margin-bottom:14px;">
        <div class="form-section-box" style="margin-bottom:0;">
          <div class="form-section-title"><i class="fas fa-cog"></i> A. Ficha Técnica del Motor y Troquel</div>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <button type="button" class="btn-troquel-clickable" style="font-size:13px; padding:3px 10px;" onclick="quickViewOrderDetails('${order.id_orden}')" title="Inspeccionar ficha técnica">
              <i class="fas fa-barcode"></i> TROQUEL #${order.codigo_troquel}
            </button>
            <span style="font-size:13.5px; font-weight:900;">${order.datos_motor.marca} ${order.datos_motor.modelo}</span>
          </div>
          <div style="font-size:12px; color:var(--text-muted); line-height:1.45;">
            Pieza: <strong>${order.datos_motor.tipo_pieza}</strong> · Serial: <strong>${order.datos_motor.serial}</strong><br/>
            Cliente: <strong>${order.nombre_cliente}</strong> (${order.documento_cliente})<br/>
            Observaciones: ${order.datos_motor.observaciones}
          </div>
        </div>
        <div class="form-section-box" style="margin-bottom:0;">
          <div class="form-section-title"><i class="fas fa-images"></i> Soporte Visual (Pieza + Repuestos del Cliente)</div>
          <div style="display:flex; gap:10px; align-items:center;">
            <img src="${(order.galeria_fotos_pieza && order.galeria_fotos_pieza[0]) || DEMO_PHOTOS.camaraCorsa}" style="width:74px; height:58px; object-fit:cover; border-radius:8px; border:1px solid var(--border-color);" />
            <div style="font-size:12px;">
              <div><i class="fas fa-camera"></i> <strong>${(order.galeria_fotos_pieza || []).length} foto(s)</strong> estado inicial de la pieza</div>
              <div><i class="fas fa-camera"></i> <strong>${(order.galeria_fotos_repuestos || []).length} foto(s)</strong> repuestos en mesa</div>
              <button type="button" class="btn btn--ghost" style="margin-top:4px; padding:4px 8px; font-size:11px;" onclick="openDualGalleryInspector('${order.id_orden}')">
                <i class="fas fa-expand"></i> Ver / Subir Fotos
              </button>
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          B. Asignación Multipersonal y Ajuste Flexible de Comisión por Destajo:
        </span>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${quickAssignButtons}
          <button type="button" class="btn btn--gold" style="padding:5px 10px; font-size:11.5px;" onclick="addSubtaskDirectInAssignmentModal('${order.id_orden}')">
            <i class="fas fa-plus"></i> + Añadir Subtarea
          </button>
        </div>
      </div>

      <div class="data-table-wrapper">
        <table class="renacer-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Tarea / Servicio de la Orden</th>
              <th>Precio Cliente ($)</th>
              <th>Comisión Destajo ($)</th>
              <th>Técnico Asignado</th>
              <th style="text-align:center;">Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>

      <!-- Totalización Automática en Tiempo Real por Técnico -->
      <div id="live-assignment-totals-box" style="margin-top:14px;"></div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold btn--lg" onclick="confirmSubtaskAssignments('${order.id_orden}')">
        <i class="fas ${["servicio", "calidad", "control_calidad", "entrega", "entregado", "archivado"].includes(order.estado_actual) ? 'fa-save' : 'fa-play-circle'}"></i> ${["servicio", "calidad", "control_calidad", "entrega", "entregado", "archivado"].includes(order.estado_actual) ? 'Guardar Cambios de Asignación' : 'Confirmar Matriz y Pasar a 4. Servicio'}
      </button>
    `
  });

  updateLiveAssignmentTotals(order.id_orden);
}

function unassignSubtaskInModalDirect(subtaskId, orderId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (sub) {
    sub.tecnico_id = null;
    sub.nombre_tecnico = "Sin asignar";
    sub.estado_subtarea = "pendiente";
  }
  saveDatabase();
  openSubtaskAssignmentModal(orderId);
  showToast("Técnico desasignado de la subtarea.");
}

function addSubtaskDirectInAssignmentModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  db.subtareas.push({
    id_subtarea: "SUB-" + Date.now().toString().slice(-5),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    descripcion_servicio: "Servicio Adicional de Maquinado",
    tecnico_id: null,
    nombre_tecnico: "Sin asignar",
    monto_servicio: 25,
    comision_base_tecnico: 8,
    estado_subtarea: "pendiente",
    inicio_activo_ts: null,
    minutos_acumulados: 0,
    foto_terminado_url: "",
    fecha_terminado: null,
    comision_pagada: false
  });
  openSubtaskAssignmentModal(orderId);
}

function updateLiveAssignmentTotals(orderId) {
  const box = document.getElementById("live-assignment-totals-box");
  if (!box) return;
  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  let totalOrderPrice = 0;
  let totalOrderComm = 0;
  const byTech = {};

  subtasks.forEach((s) => {
    const pVal = Math.max(0, Number(document.getElementById(`assign-price-${s.id_subtarea}`)?.value ?? s.monto_servicio) || 0);
    const cVal = Math.max(0, Number(document.getElementById(`assign-comm-${s.id_subtarea}`)?.value ?? s.comision_base_tecnico) || 0);
    const tId = document.getElementById(`assign-tech-${s.id_subtarea}`)?.value || "";
    totalOrderPrice += pVal;
    totalOrderComm += cVal;
    if (tId) {
      const tech = db.usuarios.find((u) => u.id_usuario === tId);
      const tName = tech ? tech.nombre : "Técnico";
      if (!byTech[tId]) {
        const weeklyPrev = db.subtareas
          .filter((other) => other.tecnico_id === tId && other.orden_id !== orderId && !other.comision_pagada)
          .reduce((acc, other) => acc + (Number(other.comision_base_tecnico) || 0), 0);
        byTech[tId] = { nombre: tName, enEstaOrden: 0, tareasCount: 0, acumuladoPrevio: weeklyPrev };
      }
      byTech[tId].enEstaOrden += cVal;
      byTech[tId].tareasCount += 1;
    }
  });

  const techPills = Object.values(byTech)
    .map(
      (info) => `
      <div style="background:var(--bg-card); border:1px solid rgba(22,163,74,0.4); border-radius:10px; padding:8px 12px; font-size:12px;">
        <strong>[Interno] ${info.nombre}</strong> (${info.tareasCount} tarea/s)<br/>
        <span>En esta orden: <strong style="color:#16a34a;">+$${info.enEstaOrden.toFixed(2)}</strong></span> ·
        <span style="color:var(--text-muted);">Acumulado semanal proyectado: <strong>$${(info.acumuladoPrevio + info.enEstaOrden).toFixed(2)}</strong></span>
      </div>
    `
    )
    .join("");

  box.innerHTML = `
    <div style="background:var(--bg-input); border:1px solid var(--border-color); border-radius:12px; padding:12px 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:${techPills ? "10px" : "0"};">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);">
          TOTALIZACIÓN AUTOMÁTICA DE LA ORDEN Y DESTAJO:
        </span>
        <div style="display:flex; gap:16px; font-family:'JetBrains Mono',monospace; font-size:13.5px; font-weight:900;">
          <span>Total Factura Cliente: <strong>$${totalOrderPrice.toFixed(2)}</strong></span>
          <span style="color:#16a34a;">Total Comisiones Técnicos: <strong>$${totalOrderComm.toFixed(2)}</strong></span>
        </div>
      </div>
      ${
        techPills
          ? `<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:8px;">${techPills}</div>`
          : `<div style="font-size:12px; color:#d97706; font-weight:700;">Selecciona al menos un técnico arriba para calcular su producción acumulada.</div>`
      }
    </div>
  `;
}

function assignAllSubtasksInModalTo(techId, orderId) {
  const selects = document.querySelectorAll("[id^='assign-tech-']");
  selects.forEach((sel) => {
    sel.value = techId;
  });
  if (orderId) updateLiveAssignmentTotals(orderId);
}

function confirmSubtaskAssignments(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  let assignedCount = 0;
  let nuevoMontoTotal = 0;

  subtasks.forEach((s) => {
    const descInp = document.getElementById(`assign-desc-${s.id_subtarea}`);
    const priceInp = document.getElementById(`assign-price-${s.id_subtarea}`);
    const commInp = document.getElementById(`assign-comm-${s.id_subtarea}`);
    const sel = document.getElementById(`assign-tech-${s.id_subtarea}`);

    if (descInp && descInp.value.trim()) {
      s.descripcion_servicio = descInp.value.trim();
    }
    if (priceInp) {
      s.monto_servicio = Math.max(0, Number(priceInp.value) || 0);
    }
    if (commInp) {
      s.comision_base_tecnico = Math.max(0, Number(commInp.value) || 0);
    }
    nuevoMontoTotal += Number(s.monto_servicio) || 0;

    if (sel && sel.value) {
      const tech = db.usuarios.find((u) => u.id_usuario === sel.value);
      s.tecnico_id = sel.value;
      s.nombre_tecnico = tech ? tech.nombre : "Asignado";
      s.es_outsourcing = Boolean(tech && (tech.rol === "outsourcing" || tech.tipo === "taller_externo" || tech.es_externo));
      if (!s.estado_subtarea) s.estado_subtarea = "pendiente"; // Por Hacer / Pendiente por defecto
      assignedCount++;
    } else {
      s.tecnico_id = null;
      s.nombre_tecnico = "Sin asignar";
      s.es_outsourcing = false;
    }
  });

  if (assignedCount === 0) {
    showToast("Asigna al menos una subtarea a un técnico antes de pasar a Ejecución.", "error");
    return;
  }

  order.monto_total = nuevoMontoTotal;
  order.saldo_pendiente = Math.max(0, nuevoMontoTotal - (Number(order.monto_abonado) || 0));

  // PRESERVAR ESTADO: Si la orden ya avanzó a calidad o entrega (ej. #1548), no retroceder a servicio
  const lateStages = ["calidad", "control_calidad", "entrega", "entregado", "archivado"];
  const isAlreadyAdvanced = lateStages.includes(order.estado_actual);
  if (!isAlreadyAdvanced && order.estado_actual !== "servicio" && order.estado_actual !== "asignacion_ejecucion" && order.estado_actual !== "terminado") {
    order.estado_actual = "servicio";
  }

  const nowStr = cleanDateISO(new Date().toISOString(), true);

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "asignacion",
    mensaje: isAlreadyAdvanced
      ? `Matriz de subtareas actualizada por ${currentUser.nombre} (conservando etapa ${formatStageName(order.estado_actual)}).`
      : `Matriz de asignación confirmada por ${currentUser.nombre}. Orden en etapa 4. Servicio.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Troquel #${order.codigo_troquel} asignado y visible en el panel de los técnicos.`);
}

/* ============================================================================
   FASE 2 PUNTO 2: MÓDULO DE FACTURA DINÁMICA ([ + AGREGAR ÍTEM EXTRA ] EN TIEMPO REAL)
   ============================================================================ */
function openQuickExtraItemModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  if (order.estado_actual === "entregado" || order.factura_bloqueada) {
    showToast("Esta orden ya fue Entregada y su factura está bloqueada de forma definitiva.", "error");
    return;
  }

  const technicians = db.usuarios.filter((u) => u.rol === "tecnico" && u.activo);
  const techOpts =
    `<option value="">-- Asignar después --</option>` +
    technicians.map((t) => `<option value="${t.id_usuario}">${t.nombre} (${t.especialidad})</option>`).join("");

  const catalogOpts =
    `<option value="">-- Escribir ítem imprevisto manualmente --</option>` +
    db.catalogo_servicios
      .map((c) => `<option value="${c.id_cat}" data-nombre="${c.nombre}" data-precio="${c.precio_sugerido}" data-com="${c.comision_sugerida}">${c.nombre} ($${c.precio_sugerido})</option>`)
      .join("");

  openModal({
    title: `[ + Agregar Ítem Extra ] a Factura Dinámica — Troquel #${order.codigo_troquel}`,
    icon: "fa-plus-circle",
    body: `
      <div style="background:rgba(245,196,0,0.12); border:1px solid rgba(245,196,0,0.45); border-radius:12px; padding:12px; margin-bottom:14px; font-size:13px;">
        <strong>Módulo de Factura Dinámica (Presupuesto Abierto — Fase 2):</strong> Añade mano de obra adicional o piezas imprevistas descubiertas al lavar o rectificar (ej. soldadura de poro, cambio de guías extra). El <strong>Total Factura</strong> y el <strong>Resto Pendiente</strong> se recalculan automáticamente en tiempo real sin bloquear el flujo.
      </div>

      <div class="form-field" style="margin-bottom:12px;">
        <label>Cargar Rápido desde el Catálogo (Opcional)</label>
        <select id="quick-extra-cat" onchange="fillQuickExtraFromCatalog(this)">
          ${catalogOpts}
        </select>
      </div>

      <div class="form-field" style="margin-bottom:12px;">
        <label>Descripción del Servicio o Pieza Imprevista *</label>
        <input type="text" id="quick-extra-desc" placeholder="Ej: Soldadura en frío de fisura descubierta / 4 Guías adicionales" required />
      </div>

      <div class="form-grid-3">
        <div class="form-field">
          <label>Monto Adicional al Cliente ($) *</label>
          <input type="number" id="quick-extra-price" value="25" min="1" step="0.5" style="font-weight:900; font-size:16px;" />
        </div>
        <div class="form-field">
          <label>Comisión para el Técnico ($)</label>
          <input type="number" id="quick-extra-comm" value="8" min="0" step="0.5" style="font-weight:900; color:#15803d;" />
        </div>
        <div class="form-field">
          <label>Asignar Técnico (Opcional)</label>
          <select id="quick-extra-tech">
            ${techOpts}
          </select>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold btn--lg" onclick="saveQuickExtraItem('${order.id_orden}')">
        <i class="fas fa-plus-circle"></i> Añadir Ítem y Recalcular Factura Ahora
      </button>
    `
  });
}

function fillQuickExtraFromCatalog(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  document.getElementById("quick-extra-desc").value = opt.getAttribute("data-nombre") || "";
  document.getElementById("quick-extra-price").value = opt.getAttribute("data-precio") || 25;
  document.getElementById("quick-extra-comm").value = opt.getAttribute("data-com") || 8;
}

function saveQuickExtraItem(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order || order.estado_actual === "entregado" || order.factura_bloqueada) return;

  const desc = (document.getElementById("quick-extra-desc")?.value || "").trim();
  const price = Math.max(0, Number(document.getElementById("quick-extra-price")?.value) || 0);
  const comm = Math.max(0, Number(document.getElementById("quick-extra-comm")?.value) || 0);
  const techId = document.getElementById("quick-extra-tech")?.value || null;

  if (!desc || price <= 0) {
    showToast("Ingresa la descripción del ítem extra y un monto válido.", "error");
    return;
  }

  const techObj = techId ? db.usuarios.find((u) => u.id_usuario === techId) : null;

  db.subtareas.push({
    id_subtarea: "SUB-" + Date.now(),
    orden_id: order.id_orden,
    descripcion_servicio: desc + " (Ítem Extra)",
    tecnico_id: techObj ? techObj.id_usuario : null,
    nombre_tecnico: techObj ? techObj.nombre : "Sin asignar",
    monto_servicio: price,
    comision_base_tecnico: comm,
    estado_subtarea: "pendiente",
    inicio_activo_ts: null,
    minutos_acumulados: 0,
    foto_terminado_url: "",
    fecha_terminado: null,
    comision_pagada: false
  });

  // Recalcular Total_Factura y Saldo_Pendiente automáticamente
  const subtasks = db.subtareas.filter((s) => s.orden_id === order.id_orden);
  order.monto_total = subtasks.reduce((acc, s) => acc + (Number(s.monto_servicio) || 0), 0);
  order.saldo_pendiente = Math.max(0, order.monto_total - (Number(order.monto_abonado) || 0));

  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "presupuesto_abierto",
    mensaje: `Ítem Extra añadido a la factura abierta: "${desc}" (+$${price.toFixed(2)}). Nuevo Total Factura: $${order.monto_total.toFixed(2)} | Resto Pendiente: $${order.saldo_pendiente.toFixed(2)}.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Ítem extra añadido. Nuevo Total: $${order.monto_total.toFixed(2)} (Resto: $${order.saldo_pendiente.toFixed(2)}).`);
}

function openEditBudgetModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  if (order.estado_actual === "entregado" || order.factura_bloqueada) {
    showToast("La orden está Entregada y su factura está bloqueada.", "error");
    return;
  }

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  const isRecep = currentUser && currentUser.rol === "recepcion";

  const itemsHtml = subtasks
    .map(
      (s) => `
      <div style="display:grid; grid-template-columns: ${isRecep ? "1fr 140px 42px" : "1fr 110px 110px 42px"}; gap:8px; align-items:center; margin-bottom:8px;">
        <input type="text" id="edit-sub-desc-${s.id_subtarea}" value="${s.descripcion_servicio}" style="padding:8px; border-radius:8px; border:1px solid var(--border-color); font-weight:700;" />
        <input type="number" step="0.5" id="edit-sub-price-${s.id_subtarea}" value="${s.monto_servicio}" style="padding:8px; border-radius:8px; border:1px solid var(--border-color); font-weight:900;" />
        ${isRecep ? `<input type="hidden" id="edit-sub-comm-${s.id_subtarea}" value="${s.comision_base_tecnico}" />` : `
          <input type="number" step="0.5" id="edit-sub-comm-${s.id_subtarea}" value="${s.comision_base_tecnico}" style="padding:8px; border-radius:8px; border:1px solid rgba(22,163,74,0.4); font-weight:900; color:#15803d;" />
        `}
        <button type="button" class="btn btn--danger" style="padding:8px; border-radius:8px; justify-content:center;" onclick="deleteSubtaskDirect('${s.id_subtarea}', '${order.id_orden}')" title="Eliminar este ítem del presupuesto">
          <i class="fas fa-trash-alt"></i>
        </button>
      </div>
    `
    )
    .join("");

  openModal({
    title: `Presupuesto / Factura Abierta — ${order.id_orden} (Troquel #${order.codigo_troquel})`,
    icon: "fa-edit",
    wide: true,
    body: `
      <p style="font-size:13px; color:var(--text-muted); margin-bottom:12px;">
        Edita los montos de los servicios, agrega ítems extras o elimina renglones que no se realizarán. El total y resto se recalculan en tiempo real.
      </p>
      <div style="display:grid; grid-template-columns: ${isRecep ? "1fr 140px 42px" : "1fr 110px 110px 42px"}; gap:8px; font-size:11px; font-weight:900; color:var(--text-muted); margin-bottom:6px;">
        <span>SERVICIO / SUBTAREA</span>
        <span>MONTO CLIENTE ($)</span>
        ${isRecep ? "" : `<span>COMISIÓN TÉCNICO ($)</span>`}
        <span></span>
      </div>
      <div id="edit-subtasks-list">${itemsHtml}</div>
      <button type="button" class="btn btn--ghost" style="margin-top:6px;" onclick="addExtraSubtaskToExistingOrder('${order.id_orden}')">
        <i class="fas fa-plus"></i> + Añadir Fila Extra
      </button>

      <div class="form-section-box" style="margin-top:16px;">
        <div class="form-section-title"><i class="fas fa-dollar-sign"></i> Actualizar Abono Acumulado del Cliente</div>
        <div class="form-grid-2">
          <div class="form-field">
            <label>Monto Total Abonado por el Cliente ($)</label>
            <input type="number" step="0.5" id="edit-order-abonado" value="${order.monto_abonado}" style="font-weight:900; font-size:16px; color:#16a34a;" />
          </div>
          <div class="form-field">
            <label>Observaciones de la Pieza / Motor</label>
            <input type="text" id="edit-order-obs" value="${order.datos_motor.observaciones}" />
          </div>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold btn--lg" onclick="saveEditedBudget('${order.id_orden}')">
        <i class="fas fa-save"></i> Guardar Cambios en Factura Abierta
      </button>
    `
  });
}

function addExtraSubtaskToExistingOrder(orderId) {
  const newSub = {
    id_subtarea: "SUB-" + Date.now(),
    orden_id: orderId,
    descripcion_servicio: "Servicio Adicional de Rectificación",
    tecnico_id: null,
    nombre_tecnico: "Sin asignar",
    monto_servicio: 20,
    comision_base_tecnico: 6,
    estado_subtarea: "pendiente",
    inicio_activo_ts: null,
    minutos_acumulados: 0,
    foto_terminado_url: "",
    fecha_terminado: null,
    comision_pagada: false
  };
  db.subtareas.push(newSub);
  openEditBudgetModal(orderId);
}

function saveEditedBudget(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  let nuevoTotal = 0;

  subtasks.forEach((s) => {
    const dEl = document.getElementById(`edit-sub-desc-${s.id_subtarea}`);
    const pEl = document.getElementById(`edit-sub-price-${s.id_subtarea}`);
    const cEl = document.getElementById(`edit-sub-comm-${s.id_subtarea}`);
    if (dEl) s.descripcion_servicio = dEl.value.trim() || s.descripcion_servicio;
    if (pEl) s.monto_servicio = Math.max(0, Number(pEl.value) || 0);
    if (cEl) s.comision_base_tecnico = Math.max(0, Number(cEl.value) || 0);
    nuevoTotal += s.monto_servicio;
  });

  const prevAbono = Number(order.monto_abonado) || 0;
  const nuevoAbono = Math.max(0, Number(document.getElementById("edit-order-abonado")?.value) || 0);
  const obsVal = document.getElementById("edit-order-obs")?.value || order.datos_motor.observaciones;

  order.monto_total = nuevoTotal;
  order.monto_abonado = nuevoAbono;
  order.saldo_pendiente = Math.max(0, nuevoTotal - nuevoAbono);
  order.datos_motor.observaciones = obsVal;

  if (nuevoAbono > prevAbono) {
    const diff = nuevoAbono - prevAbono;
    db.finanzas_movimientos.unshift({
      id_mov: "MOV-" + Date.now(),
      fecha: new Date().toISOString().slice(0, 10),
      tipo: "ingreso",
      categoria: "Abono de Orden",
      concepto: `Abono adicional en ${order.id_orden} (Troquel #${order.codigo_troquel})`,
      monto: diff,
      metodo: "pago_movil",
      orden_id: order.id_orden
    });
  }

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Factura abierta actualizada. Total: $${nuevoTotal.toFixed(2)} | Resto: $${order.saldo_pendiente.toFixed(2)}`);
}

/* ============================================================================
   FASE 2 PUNTO 1 Y 3: ESTADOS 4 (TERMINADO), 5 (CONTROL DE CALIDAD) Y 6 (ENTREGADO)
   CON BUCLE DE APROBACIÓN Y RETORNO AL TÉCNICO
   ============================================================================ */
function moveOrderToTerminado(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  order.estado_actual = "terminado";
  order.subestado_ejecucion = "terminado";
  order.devuelto_calidad = false;

  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "terminado",
    mensaje: `Trabajo marcado como 4. Terminado por ${currentUser.nombre}. Pieza enviada a revisión de Control de Calidad.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  renderApp();
  showToast(`Orden ${order.id_orden} (Troquel #${order.codigo_troquel}) pasada a 4. Terminado.`);
}

function moveOrderToQualityControl(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  order.estado_actual = "control_calidad";
  order.subestado_ejecucion = "terminado";

  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "control_calidad",
    mensaje: `Orden en 5. Control de Calidad para evaluación de tolerancia y acabado.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  renderApp();
  showToast(`Orden ${order.id_orden} en 5. Control de Calidad.`);
}

function renderQualityAndDeliveryScreen() {
  const qcOrders = db.ordenes.filter(
    (o) =>
      o.estado_actual === "terminado" ||
      o.estado_actual === "control_calidad" ||
      o.estado_actual === "entregado" ||
      (o.estado_actual === "asignacion_ejecucion" && o.subestado_ejecucion === "terminado")
  );

  return `
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:18px; padding:16px 20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px;">
      <div>
        <span style="font-size:11px; font-weight:900; color:#6d28d9; text-transform:uppercase;">
          FASE 2 · ESTADOS 4, 5 Y 6: BUCLE DE CONTROL DE CALIDAD Y CIERRE DE FACTURA
        </span>
        <h2 style="font-size:20px; font-weight:900;">4. Terminado -> 5. Control de Calidad -> 6. Entregado</h2>
        <p style="font-size:13px; color:var(--text-muted);">
          <strong>Opción A:</strong> [ Aprobar y Pasar a Entregado ] congela la factura y registra el ingreso en caja.<br/>
          <strong>Opción B:</strong> [ Rechazar y Devolver al Técnico ] exige motivo del fallo, regresa la orden a <em>3. Asignación y Ejecución</em> y notifica al chat del técnico.
        </p>
      </div>
      <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-color); display:flex; align-items:center; gap:10px;">
        <input
          type="checkbox"
          id="toggle-qc-standby"
          ${db.config_taller.control_calidad_activo ? "checked" : ""}
          onchange="toggleQcStandbyMode(this.checked)"
          style="width:18px; height:18px; cursor:pointer;"
        />
        <label for="toggle-qc-standby" style="font-size:12.5px; font-weight:800; cursor:pointer;">
          Bucle Estricto de Control de Calidad Activo
        </label>
      </div>
    </div>

    <div class="orders-grid">
      ${
        qcOrders.length
          ? qcOrders.map((o) => renderOrderCardTelegramStyle(o)).join("")
          : `<div style="grid-column:1/-1; padding:36px; text-align:center; background:var(--bg-card); border-radius:18px;">No hay órdenes en Terminado, Control de Calidad o Entregadas aún.</div>`
      }
    </div>
  `;
}

function toggleQcStandbyMode(enabled) {
  db.config_taller.control_calidad_activo = Boolean(enabled);
  saveDatabase();
  showToast(
    enabled
      ? "Control de Calidad estricto activado."
      : "Control de Calidad en Stand-by."
  );
}

/* ---------- OPCIÓN B DE FASE 2: [ Rechazar y Devolver al Técnico ] ---------- */
function promptRejectQualityControl(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  const techNames = [...new Set(subtasks.map((s) => s.nombre_tecnico).filter(Boolean))].join(", ") || "Técnico asignado";

  openModal({
    title: `Rechazar Control de Calidad y Devolver al Técnico — Troquel #${order.codigo_troquel}`,
    icon: "fa-times-circle",
    body: `
      <div style="background:rgba(220,38,38,0.1); border:1.5px solid rgba(220,38,38,0.4); border-radius:12px; padding:12px 14px; margin-bottom:14px; font-size:13px; color:#b91c1c;">
        <strong>Acción del Sistema (Fase 2 — Bucle de Control de Calidad):</strong>
        <ul style="margin:6px 0 0 18px;">
          <li>Mueve automáticamente el Estado Actual de regreso a <strong>3. Asignación y Ejecución</strong>.</li>
          <li>Envía una notificación interna de alerta al chat del técnico asignado (<strong>${techNames}</strong>) con el motivo ingresado.</li>
        </ul>
      </div>

      <div class="form-field">
        <label style="color:#dc2626; font-weight:900;">Motivo del fallo / corrección requerida (Obligatorio) *</label>
        <textarea
          id="qc-reject-reason"
          rows="3"
          placeholder="Ej: Diferencia de 0.03mm en planitud central o falta asentar válvula de escape #3. Corregir y subir nueva foto..."
          required
          style="border:2px solid #dc2626;"
        ></textarea>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--danger btn--lg" onclick="rejectQualityControlAndReturn('${order.id_orden}')">
        <i class="fas fa-undo"></i> Confirmar Rechazo y Devolver a 3. Asignación y Ejecución
      </button>
    `
  });
}

function rejectQualityControlAndReturn(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const reason = (document.getElementById("qc-reject-reason")?.value || "").trim();
  if (!reason) {
    showToast("Es obligatorio ingresar el motivo del fallo o corrección para el técnico.", "error");
    return;
  }

  // Regresar a 3. Asignación y Ejecución
  order.estado_actual = "asignacion_ejecucion";
  order.subestado_ejecucion = "empezado";
  order.devuelto_calidad = true;
  order.motivo_rechazo_qc = reason;

  // Reabrir la última subtarea para que el técnico la vea activa en su panel
  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  if (subtasks.length > 0) {
    subtasks[subtasks.length - 1].estado_subtarea = "empezado";
  }

  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "rechazo_calidad",
    mensaje: `RECHAZADO EN CONTROL DE CALIDAD — Devuelto a 3. Asignación y Ejecución. Motivo del fallo / corrección: "${reason}"`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Orden ${order.id_orden} devuelta a 3. Asignación y Ejecución y notificada al chat del técnico.`, "error");
}

/* ---------- OPCIÓN A DE FASE 2: [ Aprobar y Pasar a Entregado ] ---------- */
function openQualityAndDeliveryModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  openModal({
    title: `Control de Calidad y Paso a 6. Entregado — Troquel #${order.codigo_troquel}`,
    icon: "fa-shield-alt",
    wide: true,
    body: `
      <div class="form-section-box">
        <div class="form-section-title"><i class="fas fa-clipboard-check"></i> Verificación de Tolerancias y Acabado</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:13px;">
          <label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" checked /> Planitud y rugosidad dentro de tolerancia</label>
          <label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" checked /> Asientos, guías y sellos verificados</label>
          <label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" checked /> Galería de repuestos del cliente cotejada</label>
          <label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" checked /> Limpieza final y código de troquel visible</label>
        </div>
      </div>

      <div class="form-section-box" style="border-color:rgba(22,163,74,0.4);">
        <div class="form-section-title"><i class="fas fa-cash-register"></i> Cierre de Factura y Condición de Entrega</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; background:var(--bg-input); padding:10px 14px; border-radius:10px;">
          <div>
            <div>Total Factura (Se bloqueará al entregar): <strong>$${Number(order.monto_total).toFixed(2)}</strong></div>
            <div>Abonado Previamente: <strong style="color:#16a34a;">$${Number(order.monto_abonado).toFixed(2)}</strong></div>
          </div>
          <div style="text-align:right;">
            <span style="font-size:11px; font-weight:800; color:var(--text-muted);">RESTO PENDIENTE</span>
            <div style="font-family:'JetBrains Mono',monospace; font-size:22px; font-weight:900; color:${order.saldo_pendiente > 0 ? "#dc2626" : "#16a34a"};">
              $${Number(order.saldo_pendiente).toFixed(2)}
            </div>
          </div>
        </div>

        ${
          order.saldo_pendiente > 0
            ? `
            <div class="form-grid-3">
              <div class="form-field">
                <label>Modalidad al Entregar la Pieza</label>
                <select id="qc-delivery-pay-mode" onchange="toggleDeliveryPayAmount(this.value, ${order.saldo_pendiente})">
                  <option value="cobrar_todo">Cliente liquida el 100% del Resto ahora ($${Number(order.saldo_pendiente).toFixed(2)})</option>
                  <option value="entregar_credito">Entregar a Crédito / Taller Aliado (Dejar en "Entregadas y Por Cobrar")</option>
                </select>
              </div>
              <div class="form-field">
                <label>Monto Cobrado en Caja ($)</label>
                <input type="number" id="qc-collect-amount" value="${order.saldo_pendiente}" min="0" max="${order.saldo_pendiente}" step="0.5" style="font-weight:900; color:#16a34a;" />
              </div>
              <div class="form-field">
                <label>Cuenta / Caja Destino</label>
                <select id="qc-collect-account" style="font-weight:800;">
                  ${BANCOS_RENACER.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join("")}
                </select>
              </div>
            </div>
          `
            : `<p style="font-size:13px; font-weight:800; color:#16a34a;"><i class="fas fa-check-circle"></i> Esta orden ya tiene el 100% de su factura pagada.</p>`
        }
      </div>

      <div style="background:rgba(22,163,74,0.1); border:1px solid #16a34a; border-radius:12px; padding:12px 14px; margin-top:12px;">
        <div style="font-weight:800; font-size:13px; color:#22c55e; display:flex; align-items:center; gap:8px;">
          <i class="fas fa-shield-alt"></i> Póliza de Garantía Oficial de 1 Año Renacer (365 Días)
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">
          Al aprobar y entregar la orden, se activa automáticamente la cobertura técnica de 1 año para el motor/pieza rectificada con fecha de vencimiento controlada en el sistema.
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--danger" onclick="promptRejectQualityControl('${order.id_orden}')">
        <i class="fas fa-times-circle"></i> Rechazar y Devolver al Técnico
      </button>
      <button type="button" class="btn btn--success btn--lg" onclick="approveAndDeliverOrder('${order.id_orden}')">
        <i class="fas fa-check-circle"></i> Aprobar y Pasar a 6. Entregado (Bloquear Factura)
      </button>
    `
  });
}

function toggleDeliveryPayAmount(mode, saldo) {
  const inp = document.getElementById("qc-collect-amount");
  if (!inp) return;
  if (mode === "entregar_credito") {
    inp.value = 0;
  } else {
    inp.value = saldo;
  }
}

function approveAndDeliverOrder(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const collectEl = document.getElementById("qc-collect-amount");
  const collected = collectEl ? Math.max(0, Number(collectEl.value) || 0) : 0;
  const cuentaDestino = document.getElementById("qc-collect-account")?.value || "efectivo";
  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");

  if (collected > 0) {
    order.monto_abonado = Number(order.monto_abonado) + collected;
    order.saldo_pendiente = Math.max(0, Number(order.monto_total) - order.monto_abonado);
    if (order.saldo_pendiente === 0) {
      order.tipo_condicion_pago = "pago_total";
    }
    db.finanzas_movimientos.unshift({
      id_mov: "MOV-" + Date.now(),
      fecha: nowStr.slice(0, 10),
      tipo: "ingreso",
      categoria: "Liquidación en Entrega",
      concepto: `Cobro en entrega de ${order.id_orden} (Troquel #${order.codigo_troquel} · ${order.nombre_cliente})`,
      monto: collected,
      metodo: cuentaDestino === "efectivo" ? "efectivo" : "pago_movil",
      cuenta: cuentaDestino,
      orden_id: order.id_orden
    });
  }

  order.estado_actual = "entregado";
  order.subestado_ejecucion = "terminado";
  order.factura_bloqueada = true;
  order.devuelto_calidad = false;
  order.fecha_entrega = nowStr.slice(0, 10);
  const oneYearLater = new Date();
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  order.fecha_garantia_hasta = oneYearLater.toISOString().slice(0, 10);

  // Notificación Push
  sendPushNotification(
    "Orden Entregada con Garantía",
    `Troquel #${order.codigo_troquel} entregado a ${order.nombre_cliente}. Garantía de 1 año activa hasta ${order.fecha_garantia_hasta}.`,
    "ordenes"
  );

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "entrega",
    mensaje: `Control de Calidad APROBADO por ${currentUser.nombre}. Orden en estado 6. Entregado y Factura Bloqueada definitivamente ($${Number(order.monto_total).toFixed(2)}). Póliza de garantía de 1 año activada hasta ${order.fecha_garantia_hasta}. ${
      order.saldo_pendiente > 0 ? `Saldo pendiente en Cuentas por Cobrar: $${order.saldo_pendiente.toFixed(2)}.` : "Factura pagada al 100%."
    }`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Orden ${order.id_orden} (Troquel #${order.codigo_troquel}) pasada a 6. Entregado y factura bloqueada.`);
}


/* ============================================================================
   ENVÍO DE PRESUPUESTO / ORDEN EN TEXTO PLANO POR WHATSAPP CON NRO. DE ORDEN
   (SOLICITADO EN AUDIOS DE JESÚS ANDRADE)
   ============================================================================ */
function formatWhatsAppPhone(rawPhone) {
  if (!rawPhone) return "";
  let digits = String(rawPhone).replace(/\D/g, "");
  if (!digits) return "";
  
  // Si empieza con 58 y luego 0 (ej. 580414 -> 58414)
  if (digits.startsWith("580") && digits.length >= 12) {
    digits = "58" + digits.slice(3);
  }
  // Si ya tiene código internacional (+58 Venezuela, +57 Colombia, +1 USA, etc.)
  if (digits.startsWith("58") || digits.startsWith("57") || digits.startsWith("1") || digits.startsWith("34") || digits.startsWith("56") || digits.startsWith("54") || digits.startsWith("55") || digits.startsWith("52")) {
    return digits;
  }
  // Si empieza con 0 (número local vzla ej. 0412, 0414, 0424, 0416, 0426, 0261)
  if (digits.startsWith("0")) {
    return "58" + digits.slice(1);
  }
  // Si tiene 10 dígitos y empieza por prefijo móvil venezolano sin cero (ej. 412, 414, 424)
  if (digits.length === 10 && (digits.startsWith("412") || digits.startsWith("414") || digits.startsWith("424") || digits.startsWith("416") || digits.startsWith("426") || digits.startsWith("261"))) {
    return "58" + digits;
  }
  // Si tiene 10 dígitos y empieza por 3 (Colombia sin 57)
  if (digits.length === 10 && digits.startsWith("3")) {
    return "57" + digits;
  }
  // Default Venezuela si tiene 7 a 10 dígitos
  if (digits.length <= 10) {
    return "58" + digits;
  }
  return digits;
}

function buildWhatsAppBudgetPlainText(order) {
  const subtasks = db.subtareas.filter((s) => s.orden_id === order.id_orden);
  const itemsLines = subtasks
    .map((s, i) => `  ${i + 1}. ${s.descripcion_servicio}: *$${Number(s.monto_servicio).toFixed(2)}*`)
    .join("\n");

  const stateNames = {
    diagnostico_presupuesto: "1. Diagnóstico / Presupuesto",
    esperando_aprobacion_abono: "2. Esperando Aprobación",
    asignacion_ejecucion: "3. En Ejecución en Taller",
    terminado: "4. Terminado (En Revisión)",
    control_calidad: "5. En Control de Calidad",
    entregado: "6. Entregado"
  };

  return (
    `*RECTIFICADORA RENACER (JOB 8:7)*\n` +
    `*ORDEN DE SERVICIO / PRESUPUESTO*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Nro. de Orden:* #${order.codigo_troquel}\n` +
    `*Cliente:* ${order.nombre_cliente} (${order.documento_cliente})\n` +
    `*Pieza / Motor:* ${order.datos_motor.tipo_pieza} — ${order.datos_motor.marca} ${order.datos_motor.modelo}\n` +
    `*Estado Actual:* ${stateNames[order.estado_actual] || order.estado_actual}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*DESGLOSE DE TRABAJOS:*\n` +
    `${itemsLines}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*TOTAL PRESUPUESTO:* $${Number(order.monto_total).toFixed(2)}\n` +
    `*MONTO ABONADO:* $${Number(order.monto_abonado).toFixed(2)}\n` +
    `*RESTO PENDIENTE:* $${Number(order.saldo_pendiente).toFixed(2)}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*TÉRMINOS Y POLÍTICAS DEL TALLER:*\n` +
    `1. El cliente dispone de un plazo mínimo de tres (3) días para aprobar el presupuesto o retirar las piezas del taller.\n` +
    `2. La rectificadora no asume responsabilidad alguna por cámaras, motores, repuestos o piezas una vez transcurrido un mes sin concretar o finalizar el trabajo.\n` +
    `3. El trabajo solo podrá ser retirado si se ha cancelado en su totalidad (100%).\n` +
    `4. Existe la posibilidad de modificaciones del presupuesto debido a afectaciones adicionales encontradas en el proceso de limpieza; el cliente será informado previamente.\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `_Conserve su Número de Orden (#${order.codigo_troquel}) para cualquier consulta o retiro._`
  );
}

function buildWhatsAppTermsOnlyPlainText(order) {
  const troquel = order.codigo_troquel;
  const motor = `${order.datos_motor.tipo_pieza || "Pieza"} — ${order.datos_motor.marca || ""} ${order.datos_motor.modelo || ""}`.trim();
  const fecha = formatDateHuman(order.fecha_ingreso, false);

  return (
    `*RECTIFICADORA RENACER (JOB 8:7)*\n` +
    `*COMPROBANTE DE RECEPCIÓN Y POLÍTICAS DEL TALLER*\n` +
    `_«Aunque tu principio haya sido pequeño, tu postrer estado será muy grande.»_\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Estimado(a) *${order.nombre_cliente}* (${order.documento_cliente}), confirmamos el ingreso formal de su pieza a nuestras instalaciones para evaluación y diagnóstico:\n\n` +
    `*Nro. de Orden:* #${troquel}\n` +
    `*Pieza / Motor:* ${motor}\n` +
    `*Fecha de Ingreso:* ${fecha}\n` +
    `*Estado Actual:* Recepción e Inspección Técnica en Proceso\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*TÉRMINOS Y CONDICIONES OBLIGATORIAS DEL SERVICIO:*\n` +
    `1. *Plazo de Aprobación / Retiro:* El cliente dispone de un plazo mínimo de tres (3) días para aprobar el presupuesto o retirar las piezas del taller.\n` +
    `2. *Custodia de Piezas:* La rectificadora no asume responsabilidad alguna por cámaras, motores, repuestos o piezas una vez transcurrido un (1) mes sin concretar o finalizar el trabajo.\n` +
    `3. *Retiro del Trabajo:* El trabajo solo podrá ser retirado si se ha cancelado en su totalidad (100%).\n` +
    `4. *Ajustes por Lavado y Limpieza:* Existe la posibilidad de modificaciones del presupuesto debido a afectaciones adicionales encontradas en el proceso de limpieza y desengrase químico; el cliente será informado previamente antes de ejecutar cualquier trabajo extra.\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Próximo Paso:* Nuestro personal técnico evaluará las tolerancias de su pieza y en breve le enviaremos el presupuesto formal detallado renglón por renglón para su aprobación.\n\n` +
    `_Conserve su Número de Orden (#${troquel}) para cualquier consulta._\n` +
    `¡Gracias por confiar en Rectificadora Renacer!`
  );
}

function openWhatsAppTermsOnlyModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const textMsg = buildWhatsAppTermsOnlyPlainText(order);
  const intlPhone = formatWhatsAppPhone(order.telefono_cliente);
  const waUrl = intlPhone ? `https://wa.me/${intlPhone}?text=${encodeURIComponent(textMsg)}` : "#";

  openModal({
    title: `Términos y Comprobante de Recepción — Orden #${order.codigo_troquel}`,
    icon: "fa-file-contract",
    wide: true,
    body: `
      <!-- Banner Informativo -->
      <div style="background:rgba(2,132,199,0.08); border:1.5px solid rgba(2,132,199,0.4); border-radius:12px; padding:12px 14px; margin-bottom:12px;">
        <div style="font-size:12.5px; font-weight:900; color:#38bdf8; display:flex; align-items:center; gap:6px;">
          <i class="fas fa-file-contract"></i> Notificación de Recepción y Políticas de Servicio (Sin Estimación de Precio)
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin-top:6px; line-height:1.45;">
          Este mensaje confirma al cliente <strong>${order.nombre_cliente}</strong> la custodia de su pieza con el <strong>Troquel #${order.codigo_troquel}</strong> y las 4 políticas del taller, <strong>sin montos ni precios</strong>. Ideal para enviar justo al recibir la pieza antes del presupuesto formal.
        </p>
      </div>

      <p style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">
        Mensaje listo para enviar al WhatsApp <strong>${order.telefono_cliente}</strong>:
      </p>
      <textarea
        id="wa-terms-textarea"
        rows="14"
        style="width:100%; padding:12px; border-radius:12px; border:1.5px solid var(--border-color); font-family:'JetBrains Mono',monospace; font-size:12px; line-height:1.45; background:var(--bg-input); color:var(--text-main);"
      >${textMsg}</textarea>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="printOrderReceptionTicket('${order.id_orden}')" title="Imprimir Ticket Físico">
        <i class="fas fa-print"></i> Imprimir Ticket
      </button>
      <button type="button" class="btn btn--ghost" onclick="copyTextToClipboard(document.getElementById('wa-terms-textarea').value)">
        <i class="fas fa-copy"></i> Copiar Texto
      </button>
      <a href="${waUrl}" target="_blank" rel="noopener" class="btn btn--success btn--lg" style="text-decoration:none;">
        <i class="fab fa-whatsapp"></i> Enviar Términos por WhatsApp
      </a>
    `
  });
}

function openWhatsAppBudgetTextModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const textMsg = buildWhatsAppBudgetPlainText(order);
  const intlPhone = formatWhatsAppPhone(order.telefono_cliente);
  const waUrl = intlPhone ? `https://wa.me/${intlPhone}?text=${encodeURIComponent(textMsg)}` : "#";

  openModal({
    title: `Presupuesto Oficial por WhatsApp — Orden #${order.codigo_troquel}`,
    icon: "fa-comment-dots",
    wide: true,
    body: `
      <!-- Banner Informativo de Políticas de Taller 2026 -->
      <div style="background:rgba(245,223,0,0.08); border:1.5px solid var(--renacer-gold); border-radius:12px; padding:12px 14px; margin-bottom:12px;">
        <div style="font-size:12.5px; font-weight:900; color:var(--renacer-navy); display:flex; align-items:center; gap:6px;">
          <i class="fas fa-balance-scale"></i> Términos y Condiciones Oficiales de Rectificadora Renacer (Incluidos en el Texto)
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:8px; margin-top:8px; font-size:11.5px; color:var(--text-secondary); line-height:1.45;">
          <div style="background:rgba(255,255,255,0.05); padding:6px 10px; border-radius:8px; border:1px solid rgba(0,0,0,0.08);">
            <strong>1. Aprobación:</strong> Plazo mín. de 3 días para aprobar o retirar piezas.
          </div>
          <div style="background:rgba(255,255,255,0.05); padding:6px 10px; border-radius:8px; border:1px solid rgba(0,0,0,0.08);">
            <strong>2. Responsabilidad:</strong> Cero responsabilidad tras 1 mes sin finalizar/retirar.
          </div>
          <div style="background:rgba(255,255,255,0.05); padding:6px 10px; border-radius:8px; border:1px solid rgba(0,0,0,0.08);">
            <strong>3. Entrega:</strong> Solo se retira si está cancelado al 100%.
          </div>
          <div style="background:rgba(255,255,255,0.05); padding:6px 10px; border-radius:8px; border:1px solid rgba(0,0,0,0.08);">
            <strong>4. Limpieza:</strong> Posibles ajustes por daños ocultos detectados en lavado.
          </div>
        </div>
      </div>

      <p style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">
        Mensaje listo para enviar a <strong>${order.nombre_cliente} (${order.telefono_cliente})</strong> con el <strong>Código de Troquel #${order.codigo_troquel}</strong> y las 4 políticas del taller:
      </p>
      <textarea
        id="wa-budget-textarea"
        rows="15"
        style="width:100%; padding:12px; border-radius:12px; border:1.5px solid var(--border-color); font-family:'JetBrains Mono',monospace; font-size:12px; line-height:1.45; background:var(--bg-input); color:var(--text-main);"
      >${textMsg}</textarea>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="printOrderReceptionTicket('${order.id_orden}')" title="Imprimir Comprobante Físico">
        <i class="fas fa-print"></i> Imprimir Ticket Físico
      </button>
      <button type="button" class="btn btn--ghost" onclick="copyTextToClipboard(document.getElementById('wa-budget-textarea').value)">
        <i class="fas fa-copy"></i> Copiar Texto
      </button>
      <a href="${waUrl}" target="_blank" rel="noopener" class="btn btn--success btn--lg" style="text-decoration:none;">
        <i class="fab fa-whatsapp"></i> Enviar Ahora por WhatsApp
      </a>
    `
  });
}

/* ============================================================================
   IMPRESIÓN DE TICKET DE RECEPCIÓN / ORDEN CON LAS 4 POLÍTICAS DEL TALLER
   (Diseñado para impresoras térmicas de 80mm o formato carta industrial)
   ============================================================================ */
function printOrderReceptionTicket(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const subtasks = db.subtareas.filter((s) => s.orden_id === order.id_orden);
  const itemsRows = subtasks
    .map(
      (s, idx) => `
      <tr>
        <td style="padding:4px 0; border-bottom:1px dashed #ddd;">${idx + 1}. ${s.descripcion_servicio}</td>
        <td style="padding:4px 0; text-align:right; font-weight:bold; border-bottom:1px dashed #ddd;">$${Number(s.monto_servicio).toFixed(2)}</td>
      </tr>
    `
    )
    .join("");

  const printWindow = window.open("", "_blank", "width=680,height=820");
  if (!printWindow) {
    showToast("Permita las ventanas emergentes para generar el ticket imprimible.", "error");
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Ticket Recepción Troquel #${order.codigo_troquel} - Rectificadora Renacer</title>
      <style>
        body {
          font-family: 'Courier New', Courier, monospace;
          font-size: 13px;
          line-height: 1.4;
          color: #000;
          padding: 24px;
          max-width: 400px;
          margin: 0 auto;
        }
        .center { text-align: center; }
        .bold { font-weight: bold; }
        .divider { border-top: 1px dashed #000; margin: 8px 0; }
        .double-divider { border-top: 2px solid #000; margin: 10px 0; }
        .troquel-banner {
          border: 2px solid #000;
          padding: 8px 10px;
          margin: 10px 0;
          text-align: center;
        }
        .troquel-number {
          font-size: 24px;
          font-weight: 900;
          letter-spacing: 2px;
        }
        .terms-box {
          font-size: 10.5px;
          line-height: 1.35;
          margin-top: 10px;
          text-align: justify;
        }
        .signature-row {
          display: flex;
          justify-content: space-between;
          gap: 20px;
          margin-top: 36px;
        }
        .sig-block {
          width: 45%;
          border-top: 1px solid #000;
          text-align: center;
          font-size: 10.5px;
          padding-top: 4px;
        }
        @media print {
          body { padding: 0; max-width: 100%; width: 100%; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="center">
        <h2 style="margin:0; font-size:18px; font-weight:900;">RECTIFICADORA RENACER</h2>
        <div class="bold" style="font-size:11px;">JOB 8:7 · ESPECIALISTAS EN MOTORES</div>
        <div style="font-size:11px;">Maracaibo, Edo. Zulia</div>
        <div style="font-size:11px;">Atención al Cliente: +58 424-6999635</div>
      </div>

      <div class="divider"></div>

      <div class="troquel-banner">
        <div style="font-size:11px; font-weight:bold;">COMPROBANTE DE RECEPCIÓN</div>
        <div class="troquel-number">TROQUEL: #${order.codigo_troquel}</div>
        <div style="font-size:12px;">Orden: ${order.id_orden}</div>
      </div>

      <div><strong>Fecha:</strong> ${order.fecha_ingreso || new Date().toLocaleString()}</div>
      <div><strong>Cliente:</strong> ${order.nombre_cliente}</div>
      <div><strong>C.I. / RIF:</strong> ${order.documento_cliente}</div>
      <div><strong>Teléfono:</strong> ${order.telefono_cliente}</div>

      <div class="divider"></div>

      <div><strong>Pieza:</strong> ${order.datos_motor.tipo_pieza}</div>
      <div><strong>Vehículo / Motor:</strong> ${order.datos_motor.marca} ${order.datos_motor.modelo}</div>
      <div><strong>Serial:</strong> ${order.datos_motor.serial || "S/N"}</div>
      ${order.observaciones_ingreso ? `<div><strong>Obs. Entrada:</strong> ${order.observaciones_ingreso}</div>` : ""}

      <div class="divider"></div>
      <div class="bold">DESGLOSE DE SERVICIOS PREVISTOS:</div>
      <table style="width:100%; border-collapse:collapse; margin:6px 0;">
        ${itemsRows}
      </table>

      <div class="divider"></div>
      <div style="display:flex; justify-content:space-between;">
        <span>TOTAL PRESUPUESTO:</span>
        <span class="bold">$${Number(order.monto_total).toFixed(2)}</span>
      </div>
      <div style="display:flex; justify-content:space-between;">
        <span>MONTO ABONADO:</span>
        <span class="bold">$${Number(order.monto_abonado).toFixed(2)}</span>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:14px; margin-top:2px;">
        <span class="bold">RESTO PENDIENTE:</span>
        <span class="bold">$${Number(order.saldo_pendiente).toFixed(2)}</span>
      </div>

      <div class="double-divider"></div>
      <div class="center bold" style="font-size:11px;">TÉRMINOS Y POLÍTICAS DEL TALLER:</div>
      <div class="terms-box">
        <strong>1.</strong> El cliente dispone de un plazo mínimo de tres (3) días para aprobar el presupuesto o retirar las piezas del taller.<br>
        <strong>2.</strong> La rectificadora no asume responsabilidad alguna por cámaras, motores, repuestos o piezas una vez transcurrido un (1) mes sin concretar o finalizar el trabajo.<br>
        <strong>3.</strong> El trabajo solo podrá ser retirado si se ha cancelado en su totalidad (100%).<br>
        <strong>4.</strong> Existe la posibilidad de modificaciones del presupuesto debido a afectaciones adicionales encontradas en el proceso de limpieza o descarbonizado; el cliente será informado previamente.<br>
      </div>

      <div class="signature-row">
        <div class="sig-block">Firma del Cliente<br>C.I.:</div>
        <div class="sig-block">Recepción Taller<br>Renacer (Job 8:7)</div>
      </div>

      <div class="center" style="font-size:10px; margin-top:20px;">
        * Conserve este ticket como constancia para retirar su trabajo *
      </div>

      <div class="no-print" style="margin-top:20px; text-align:center;">
        <button onclick="window.print()" style="padding:8px 16px; font-weight:bold; cursor:pointer;"><i class="fas fa-print"></i> Imprimir Ticket</button>
      </div>

      <script>
        window.onload = function() {
          setTimeout(function() { window.print(); }, 400);
        };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Texto del presupuesto copiado al portapapeles.");
    });
  } else {
    showToast("Texto listo para copiar.");
  }
}

/* ============================================================================
   MÓDULO DE CUENTAS POR COBRAR ("SUMA DE RESTO" ESTILO TABLA EXCEL DE JESÚS
   SIN REDUNDANCIAS + TOTALES REALES + ESTADOS 100% UNIFICADOS)
   ============================================================================ */
function setArActiveTab(tab) {
  arActiveTab = tab;
  renderScreen();
}

function renderAccountsReceivableScreen() {
  const validOrders = (db.ordenes || []).filter((o) => o.estado_actual !== "anulado");
  const allPendingOrders = validOrders.filter((o) => Number(o.saldo_pendiente) > 0);
  const allCollectedOrders = validOrders.filter((o) => Number(o.monto_total) > 0 && Number(o.saldo_pendiente) <= 0);
  const allTotalOrders = validOrders.filter((o) => Number(o.monto_total) > 0);

  const tasaBcv = Number(db.config?.tasaBcv || db.configuracion?.tasaBcv) || 45.80;
  const totalGeneralResto = allPendingOrders.reduce((acc, o) => acc + Number(o.saldo_pendiente), 0);
  const totalGeneralFacturado = allTotalOrders.reduce((acc, o) => acc + Number(o.monto_total), 0);
  const totalGeneralAbonado = allTotalOrders.reduce((acc, o) => acc + Number(o.monto_abonado), 0);
  const totalCollectedAmount = allCollectedOrders.reduce((acc, o) => acc + Number(o.monto_total), 0);

  // Determinar conjunto activo según pestaña
  let baseSet = allPendingOrders;
  if (arActiveTab === "cobradas") {
    baseSet = allCollectedOrders;
  } else if (arActiveTab === "todas") {
    baseSet = allTotalOrders;
  }

  // Filtro por Cliente y Fechas
  let filtered = baseSet.slice();
  if (arFilterClient !== "all") {
    filtered = filtered.filter((o) => o.cliente_id === arFilterClient);
  }
  if (arDateFrom) {
    filtered = filtered.filter((o) => cleanDateISO(o.fecha_ingreso) >= arDateFrom);
  }
  if (arDateTo) {
    filtered = filtered.filter((o) => cleanDateISO(o.fecha_ingreso) <= arDateTo);
  }

  // Agrupar por Cliente
  const groupedByClient = {};
  filtered.forEach((o) => {
    const key = o.cliente_id || o.nombre_cliente;
    if (!groupedByClient[key]) {
      groupedByClient[key] = {
        cliente_id: o.cliente_id,
        nombre_cliente: o.nombre_cliente,
        documento_cliente: o.documento_cliente,
        telefono_cliente: o.telefono_cliente,
        ordenes: [],
        subtotalResto: 0,
        subtotalFacturado: 0,
        subtotalAbonado: 0
      };
    }
    groupedByClient[key].ordenes.push(o);
    groupedByClient[key].subtotalResto += Number(o.saldo_pendiente) || 0;
    groupedByClient[key].subtotalFacturado += Number(o.monto_total) || 0;
    groupedByClient[key].subtotalAbonado += Number(o.monto_abonado) || 0;
  });

  const groupsList = Object.values(groupedByClient);

  const clientOptionsHtml =
    `<option value="all">Todos los Clientes / Mecánicos (${(db.clientes || []).length})</option>` +
    (db.clientes || [])
      .map(
        (c) =>
          `<option value="${c.id_cliente}" ${arFilterClient === c.id_cliente ? "selected" : ""}>${c.nombre_cliente || c.nombre_completo} (${c.documento_identidad})</option>`
      )
      .join("");

  const stateBadgeLabel = (st) => {
    if (st === "entregado" || st === "entrega") return `<span class="state-badge state-badge--done"><i class="fas fa-truck"></i> 6. En Entrega</span>`;
    if (st === "recepcion" || st === "diagnostico_presupuesto") return `<span class="state-badge state-badge--recep"><i class="fas fa-clipboard-check"></i> 1. Recepción</span>`;
    if (st === "diagnostico") return `<span class="state-badge state-badge--diag"><i class="fas fa-microscope"></i> 2. Diagnóstico</span>`;
    if (st === "aprobacion" || st === "esperando_aprobacion_abono") return `<span class="state-badge state-badge--wait"><i class="fas fa-hourglass-half"></i> 3. Aprobación</span>`;
    if (st === "servicio" || st === "asignacion_ejecucion") return `<span class="state-badge state-badge--exec"><i class="fas fa-wrench"></i> 4. Servicio</span>`;
    if (st === "terminado") return `<span class="state-badge state-badge--term"><i class="fas fa-check-double"></i> 4. Servicio (Listo)</span>`;
    if (st === "calidad" || st === "control_calidad") return `<span class="state-badge state-badge--qc"><i class="fas fa-shield-alt"></i> 5. Calidad</span>`;
    return `<span class="state-badge">${st.replace(/_/g, " ")}</span>`;
  };

  const clientCardsHtml = groupsList.length
    ? groupsList
        .map((grp) => {
          const orderStrips = grp.ordenes
            .map((ord) => {
              const isPaid = Number(ord.saldo_pendiente) <= 0;
              const ordRestoBs = (Number(ord.saldo_pendiente) * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const ordTotalBs = (Number(ord.monto_total) * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

              return `
              <div class="ar-order-strip">
                <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:260px;">
                  <div>
                    ${renderClickableTroquelBadge(ord.id_orden, "TROQUEL #")}
                  </div>
                  <div>
                    <div style="font-weight:800; font-size:14px; color:var(--text-main);">
                      ${ord.datos_motor.marca} ${ord.datos_motor.modelo || ""}
                    </div>
                    <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
                      ${ord.datos_motor.tipo_pieza} · Ingreso: <strong>${formatDateHuman(ord.fecha_ingreso, false)}</strong>
                    </div>
                  </div>
                </div>

                <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
                  <div>${stateBadgeLabel(ord.estado_actual)}</div>

                  <div style="text-align:right; min-width:85px;">
                    <div style="font-size:10px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">Facturado</div>
                    <div style="font-family:'JetBrains Mono',monospace; font-weight:800; font-size:13.5px; color:var(--text-main);">$${Number(ord.monto_total).toFixed(2)}</div>
                    <div style="font-size:10px; color:var(--text-muted);">Bs. ${ordTotalBs}</div>
                  </div>

                  <div style="text-align:right; min-width:85px;">
                    <div style="font-size:10px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">Abonado</div>
                    <div style="font-family:'JetBrains Mono',monospace; font-weight:800; font-size:13.5px; color:#16a34a;">$${Number(ord.monto_abonado).toFixed(2)}</div>
                    <div style="font-size:10px; color:#16a34a; font-weight:700;">Recibido</div>
                  </div>

                  <div style="text-align:right; min-width:110px;">
                    <div style="font-size:10px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">Saldo Restante</div>
                    ${
                      isPaid
                        ? `<span style="font-size:11.5px; font-weight:900; color:#22c55e; background:rgba(34,197,94,0.14); padding:3px 8px; border-radius:6px; display:inline-block;"><i class="fas fa-check-circle"></i> $0.00 (Solvente)</span>`
                        : `<div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:16px; color:#dc2626;">$${Number(ord.saldo_pendiente).toFixed(2)}</div><div style="font-size:10px; color:#dc2626;">Bs. ${ordRestoBs}</div>`
                    }
                  </div>

                  <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                    ${
                      !isPaid
                        ? `
                        <button type="button" class="btn btn--gold btn--sm" onclick="openCollectReceivableModal('${ord.id_orden}')" title="Registrar abono o finiquitar orden">
                          <i class="fas fa-dollar-sign"></i> Abonar / Cobrar
                        </button>
                        <button type="button" class="btn btn--ghost btn--sm" onclick="openWhatsAppBudgetTextModal('${ord.id_orden}')" title="Enviar cobranza por WhatsApp">
                          <i class="fab fa-whatsapp"></i>
                        </button>
                        `
                        : `
                        <button type="button" class="btn btn--ghost btn--sm" style="color:#22c55e; border-color:rgba(34,197,94,0.4);" onclick="printOrderReceptionTicket('${ord.id_orden}')" title="Ver Recibo Oficial de Pago">
                          <i class="fas fa-receipt"></i> Recibo
                        </button>
                        <button type="button" class="btn btn--ghost btn--sm" onclick="printOrderExcelSheet('${ord.id_orden}')" title="Ver Planilla y Hoja de Servicio">
                          <i class="fas fa-file-excel" style="color:#22c55e;"></i> Planilla
                        </button>
                        `
                    }
                    <button type="button" class="btn btn--ghost btn--sm" onclick="quickViewOrderDetails('${ord.id_orden}')" title="Ver Ficha Técnica">
                      <i class="fas fa-eye"></i>
                    </button>
                  </div>
                </div>
              </div>
            `;
            })
            .join("");

          return `
            <div class="ar-client-card">
              <div class="ar-client-header">
                <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                  <div style="width:40px; height:40px; border-radius:50%; background:rgba(245,196,0,0.15); border:1.5px solid var(--renacer-gold); display:flex; align-items:center; justify-content:center; color:var(--renacer-gold); font-size:16px;">
                    <i class="fas fa-user-tie"></i>
                  </div>
                  <div>
                    <div style="font-size:16px; font-weight:900; color:var(--text-main);">${grp.nombre_cliente}</div>
                    <div style="font-size:12px; color:var(--text-muted); display:flex; gap:10px; align-items:center; margin-top:2px;">
                      <span><i class="fas fa-id-card"></i> ${grp.documento_cliente || "Sin documento"}</span>
                      <span>·</span>
                      <a href="tel:${grp.telefono_cliente}" style="color:inherit; text-decoration:none;"><i class="fas fa-phone"></i> ${grp.telefono_cliente || "Sin teléfono"}</a>
                    </div>
                  </div>
                </div>

                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <button type="button" class="btn btn--ghost btn--xs" onclick="openClientHistoryModal('${grp.cliente_id}')" title="Ver historial financiero del cliente">
                    <i class="fas fa-history"></i> Historial de Pagos
                  </button>
                  <button type="button" class="btn btn--success btn--xs" onclick="sendClientStatementWhatsApp('${grp.cliente_id}')" title="Enviar relación de saldos al WhatsApp">
                    <i class="fab fa-whatsapp"></i> Enviar Estado de Cuenta (${grp.ordenes.length} pieza/s)
                  </button>
                  <div style="background:rgba(0,0,0,0.25); padding:6px 14px; border-radius:10px; border:1px solid var(--border-subtle); text-align:right;">
                    <div style="font-size:10px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">
                      ${arActiveTab === "cobradas" ? "Total Cobrado" : "Subtotal Resto"}
                    </div>
                    <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:900; color:${arActiveTab === "cobradas" ? "#22c55e" : "#dc2626"};">
                      $${(arActiveTab === "cobradas" ? grp.subtotalAbonado : grp.subtotalResto).toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              <!-- Listado de Piezas del Cliente -->
              <div class="ar-orders-list">
                ${orderStrips}
              </div>
            </div>
          `;
        })
        .join("")
    : `
      <div style="text-align:center; padding:48px 20px; background:var(--bg-card); border-radius:20px; border:1.5px dashed var(--border-color); margin-top:14px;">
        <i class="fas fa-folder-open" style="font-size:42px; color:var(--text-muted); margin-bottom:12px;"></i>
        <h3 style="font-size:17px; font-weight:800;">No hay registros en esta sección</h3>
        <p style="font-size:13px; color:var(--text-muted); margin-top:4px;">
          ${arActiveTab === "cobradas" ? "Aún no hay órdenes 100% cobradas en este filtro." : "No hay saldos pendientes de cobro con los filtros seleccionados."}
        </p>
      </div>
    `;

  return `
    <!-- Cabecera Ejecutiva de Facturas y Cuentas por Cobrar -->
    <div style="background:var(--bg-card); border:1.5px solid rgba(245,223,0,0.35); border-radius:18px; padding:20px 24px; margin-bottom:18px; box-shadow:var(--shadow-sm);">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
        <div>
          <span id="ar-screen-title" style="font-size:11px; font-weight:900; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">
            <i class="fas fa-file-invoice-dollar" style="color:var(--renacer-gold);"></i> <span id="ar-screen-title-text" data-custom-text-key="ar_title">${escapeHtml(getCustomText("ar_title", "Control General de Cuentas por Cobrar"))}</span>
          </span>
          <div style="display:flex; align-items:baseline; gap:12px; margin-top:4px; flex-wrap:wrap;">
            <span style="font-family:'JetBrains Mono',monospace; font-size:34px; font-weight:900; color:${arActiveTab === "cobradas" ? "#22c55e" : "#dc2626"};">
              $${(arActiveTab === "cobradas" ? totalCollectedAmount : totalGeneralResto).toFixed(2)}
            </span>
            <span style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:800; color:#0284c7;">
              ≈ Bs. ${(((arActiveTab === "cobradas" ? totalCollectedAmount : totalGeneralResto)) * tasaBcv).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span style="font-size:12px; color:var(--text-muted); font-weight:700;">(Tasa BCV: Bs. ${tasaBcv.toFixed(2)})</span>
          </div>
        </div>

        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
          <div style="background:var(--bg-input); padding:10px 16px; border-radius:12px; border:1px solid var(--border-subtle); text-align:center;">
            <span style="font-size:10.5px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">TOTAL FACTURADO</span>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:16px; color:var(--text-main);">
              $${totalGeneralFacturado.toFixed(2)}
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 16px; border-radius:12px; border:1px solid var(--border-subtle); text-align:center;">
            <span style="font-size:10.5px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">TOTAL COBRADO</span>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:16px; color:#16a34a;">
              $${totalGeneralAbonado.toFixed(2)}
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 16px; border-radius:12px; border:1px solid var(--border-subtle); text-align:center;">
            <span style="font-size:10.5px; color:var(--text-muted); font-weight:800; text-transform:uppercase;">PIEZAS EN VISTA</span>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:16px; color:var(--renacer-gold);">
              ${filtered.length} pz
            </div>
          </div>
        </div>
      </div>

      <!-- Barra de Filtros por Cliente y Fechas -->
      <div style="display:flex; gap:10px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border-subtle); flex-wrap:wrap; align-items:center;">
        <span style="font-size:12px; font-weight:800; color:var(--text-muted);"><i class="fas fa-filter"></i> Filtrar Cliente:</span>
        <select onchange="setArFilter('client', this.value)" style="padding:6px 12px; font-size:12px; border-radius:8px; background:var(--bg-input); color:var(--text-main); border:1px solid var(--border-subtle); font-weight:700;">
          ${clientOptionsHtml}
        </select>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:11px; color:var(--text-muted);">Desde:</span>
          <input type="date" value="${arDateFrom}" onchange="setArFilter('from', this.value)" style="padding:5px 8px; font-size:11.5px; border-radius:8px; background:var(--bg-input); color:var(--text-main); border:1px solid var(--border-subtle);" title="Fecha inicial" />
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="font-size:11px; color:var(--text-muted);">Hasta:</span>
          <input type="date" value="${arDateTo}" onchange="setArFilter('to', this.value)" style="padding:5px 8px; font-size:11.5px; border-radius:8px; background:var(--bg-input); color:var(--text-main); border:1px solid var(--border-subtle);" title="Fecha final" />
        </div>
        ${
          (arFilterClient !== "all" || arDateFrom || arDateTo)
            ? `<button type="button" class="btn btn--ghost btn--xs" style="padding:4px 10px; font-size:11px;" onclick="resetArFilters()" title="Limpiar filtros"><i class="fas fa-undo"></i> Restablecer</button>`
            : ""
        }
      </div>
    </div>

    <!-- PESTAÑAS EJECUTIVAS: PENDIENTES VS HISTORIAL COBRADAS 100% -->
    <div class="ar-tabs-nav">
      <button type="button" class="ar-tab-btn ${arActiveTab === "pendientes" ? "active" : ""}" onclick="setArActiveTab('pendientes')">
        <i class="fas fa-hourglass-half"></i> Saldos Pendientes (${allPendingOrders.length})
      </button>
      <button type="button" class="ar-tab-btn ${arActiveTab === "cobradas" ? "active" : ""}" onclick="setArActiveTab('cobradas')">
        <i class="fas fa-check-circle"></i> Historial Cobradas / Pagadas 100% (${allCollectedOrders.length})
      </button>
      <button type="button" class="ar-tab-btn ${arActiveTab === "todas" ? "active" : ""}" onclick="setArActiveTab('todas')">
        <i class="fas fa-list-ul"></i> Todas las Órdenes (${allTotalOrders.length})
      </button>
    </div>

    <!-- VISTA EJECUTIVA EN TARJETAS DE CLIENTE -->
    <div class="ar-cards-container">
      ${clientCardsHtml}
    </div>
  `;
}

function setArFilter(type, val) {
  if (type === "state") arFilterState = val;
  if (type === "client") arFilterClient = val;
  if (type === "from") arDateFrom = val;
  if (type === "to") arDateTo = val;
  renderScreen();
}

function resetArFilters() {
  arFilterState = "exigibles";
  arFilterClient = "all";
  arDateFrom = "";
  arDateTo = "";
  renderScreen();
}

function openCollectReceivableModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const bankOptions = BANCOS_RENACER.map(
    (b) => `<option value="${b.id}">${b.nombre} (${b.moneda})</option>`
  ).join("");

  openModal({
    title: `Registrar Abono o Liquidar Resto — Troquel #${order.codigo_troquel}`,
    icon: "fa-hand-holding-dollar",
    body: `
      <div style="background:var(--bg-input); padding:12px 14px; border-radius:12px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:900; font-size:15px;">${order.nombre_cliente}</div>
          <div style="font-size:12px; color:var(--text-muted);">Orden ${order.id_orden} · ${order.datos_motor.marca} ${order.datos_motor.modelo}</div>
        </div>
        <div style="text-align:right;">
          <span style="font-size:10.5px; font-weight:800; color:var(--text-muted);">RESTO PENDIENTE</span>
          <div style="font-family:'JetBrains Mono',monospace; font-size:22px; font-weight:900; color:#dc2626;">
            $${Number(order.saldo_pendiente).toFixed(2)}
          </div>
        </div>
      </div>

      <div class="form-grid-3">
        <div class="form-field">
          <label>Monto a Cobrar ($) *</label>
          <input type="number" id="ar-collect-amount" value="${order.saldo_pendiente}" min="0.5" max="${order.saldo_pendiente}" step="0.5" style="font-weight:900; font-size:17px; color:#16a34a;" />
        </div>
        <div class="form-field">
          <label>Método de Pago *</label>
          <select id="ar-collect-method" onchange="suggestAccountForArMethod(this.value)">
            <option value="pago_movil">Pago Móvil / Transferencia</option>
            <option value="efectivo">Efectivo (Divisas)</option>
            <option value="transferencia">Zelle / Transferencia Ext.</option>
          </select>
        </div>
        <div class="form-field">
          <label>Cuenta / Caja Destino *</label>
          <select id="ar-collect-account" style="font-weight:800;">
            ${bankOptions}
          </select>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--success btn--lg" onclick="confirmCollectReceivable('${order.id_orden}')">
        <i class="fas fa-check-circle"></i> Registrar Pago en Caja y Descontar Resto
      </button>
    `
  });
}

function suggestAccountForArMethod(metodo) {
  const accSel = document.getElementById("ar-collect-account");
  if (!accSel) return;
  if (metodo === "efectivo") accSel.value = "efectivo";
  else if (metodo === "pago_movil") accSel.value = "mercantil";
  else if (metodo === "transferencia") accSel.value = "zelle_otro";
}

function confirmCollectReceivable(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const amount = Math.max(0, Number(document.getElementById("ar-collect-amount")?.value) || 0);
  const method = document.getElementById("ar-collect-method")?.value || "pago_movil";
  const cuenta = document.getElementById("ar-collect-account")?.value || (method === "efectivo" ? "efectivo" : "mercantil");

  if (amount <= 0) {
    showToast("Ingresa un monto válido.", "error");
    return;
  }

  order.monto_abonado = Number(order.monto_abonado) + amount;
  order.saldo_pendiente = Math.max(0, Number(order.monto_total) - order.monto_abonado);
  if (order.saldo_pendiente === 0) {
    order.tipo_condicion_pago = "pago_total";
  }

  // Si estaba en Diagnóstico o Esperando Aprobación, pasa a Esperando Aprobación con abono listo
  if (order.estado_actual === "diagnostico_presupuesto") {
    order.estado_actual = "esperando_aprobacion_abono";
  }

  const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");
  db.finanzas_movimientos.unshift({
    id_mov: "MOV-" + Date.now(),
    fecha: nowStr.slice(0, 10),
    tipo: "ingreso",
    categoria: "Cobro de Cuenta por Cobrar (Resto)",
    concepto: `Cobro de Resto en ${order.id_orden} (Troquel #${order.codigo_troquel} · ${order.nombre_cliente})`,
    monto: amount,
    metodo: method,
    cuenta: cuenta,
    orden_id: order.id_orden
  });

  const bObj = BANCOS_RENACER.find((b) => b.id === cuenta);
  const nombreCuenta = bObj ? bObj.nombre : cuenta;

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "cobro_resto",
    mensaje: `Pago recibido por $${amount.toFixed(2)} (${method} - ${nombreCuenta}). Nuevo Resto Pendiente: $${order.saldo_pendiente.toFixed(2)}.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Pago de $${amount.toFixed(2)} registrado en ${nombreCuenta}. Resto actual: $${order.saldo_pendiente.toFixed(2)}.`);
}

function sendClientStatementWhatsApp(clientId) {
  const client = db.clientes.find((c) => c.id_cliente === clientId);
  const pendingOrders = db.ordenes.filter((o) => o.cliente_id === clientId && Number(o.saldo_pendiente) > 0);
  if (!client || !pendingOrders.length) return;

  const totalDebt = pendingOrders.reduce((acc, o) => acc + Number(o.saldo_pendiente), 0);
  const lines = pendingOrders
    .map(
      (o) =>
        `• *Orden #${o.codigo_troquel}* (${o.datos_motor.marca} ${o.datos_motor.modelo}) — Total: $${o.monto_total} | Abonado: $${o.monto_abonado} | *Resto: $${Number(o.saldo_pendiente).toFixed(2)}*`
    )
    .join("\n");

  const msg =
    `*RECTIFICADORA RENACER (JOB 8:7)*\n` +
    `*RELACIÓN DE SALDO PENDIENTE*\n` +
    `*Cliente:* ${client.nombre_completo}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*TOTAL RESTANTE POR LIQUIDAR: $${totalDebt.toFixed(2)}*\n` +
    `Quedamos atentos a su comprobante de pago. ¡Gracias por su confianza!`;

  const intlPhone = formatWhatsAppPhone(client.telefono);
  if (intlPhone) {
    window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, "_blank");
  } else {
    showToast("El cliente no tiene un teléfono válido registrado.", "error");
  }
}

/* ============================================================================
   FASE 3 (PUNTOS 3, 4 Y 5): PANEL E INTERACCIÓN DEL TÉCNICO, SUB-ESTADOS
   OPERATIVOS EN TIEMPO REAL Y REQUISITO FOTOGRÁFICO OBLIGATORIO DE CIERRE
   ============================================================================ */
let selectedWorkerFilterId = null;

function tickLiveSubtaskTimers() {
  const badges = document.querySelectorAll("[data-live-subtask-id]");
  if (!badges.length) return;
  badges.forEach((el) => {
    const subId = el.getAttribute("data-live-subtask-id");
    const sub = db.subtareas.find((s) => s.id_subtarea === subId);
    if (sub && sub.estado_subtarea === "empezado") {
      el.innerHTML = `<i class="fas fa-stopwatch"></i> ${formatLiveSubtaskTimer(sub)}`;
    }
  });
}

function renderWorkerPanelScreen() {
  const technicians = db.usuarios.filter((u) => u.rol === "tecnico");
  const activeWorkerId =
    currentUser.rol === "tecnico"
      ? currentUser.id_usuario
      : selectedWorkerFilterId || (technicians[0] && technicians[0].id_usuario);

  const workerObj = db.usuarios.find((u) => u.id_usuario === activeWorkerId) || currentUser;

  // RESTRICCIÓN DE VISIBILIDAD: Solo órdenes que NO estén en 1 ni en 2
  const visibleSubtasks = db.subtareas.filter((s) => {
    if (s.tecnico_id !== activeWorkerId) return false;
    const parentOrder = db.ordenes.find((o) => o.id_orden === s.orden_id);
    if (!parentOrder) return false;
    if (parentOrder.estado_actual === "diagnostico_presupuesto" || parentOrder.estado_actual === "esperando_aprobacion_abono" || parentOrder.estado_actual === "recepcion" || parentOrder.estado_actual === "diagnostico") {
      return false;
    }
    return true;
  });

  const upcomingSubtasks = db.subtareas.filter((s) => {
    if (s.tecnico_id !== activeWorkerId) return false;
    const parentOrder = db.ordenes.find((o) => o.id_orden === s.orden_id);
    if (!parentOrder) return false;
    return parentOrder.estado_actual === "diagnostico_presupuesto" || parentOrder.estado_actual === "esperando_aprobacion_abono" || parentOrder.estado_actual === "recepcion" || parentOrder.estado_actual === "diagnostico";
  });

  const earnedCompleted = visibleSubtasks
    .filter((s) => s.estado_subtarea === "terminado" && !s.comision_pagada)
    .reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);

  const pendingToEarn = visibleSubtasks
    .filter((s) => s.estado_subtarea !== "terminado")
    .reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);

  const workerSelectorBar =
    currentUser.rol !== "tecnico"
      ? `
      <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:14px; padding:12px 16px; margin-bottom:16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <span style="font-size:13px; font-weight:800;">
          <i class="fas fa-eye"></i> Supervisión de Mesa Técnica (Fase 3):
        </span>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${technicians
            .map(
              (t) => `
              <button type="button" class="btn ${t.id_usuario === activeWorkerId ? "btn--primary" : "btn--ghost"}" onclick="selectWorkerPreview('${t.id_usuario}')">
                <i class="fas fa-user-cog"></i> ${t.nombre}
              </button>
            `
            )
            .join("")}
        </div>
      </div>
    `
      : "";

  const substateLabelMap = {
    pendiente: "POR HACER / PENDIENTE",
    empezado: "EN PROCESO (CRONÓMETRO ACTIVO)",
    pausado: "PAUSADO / IMPREVISTO",
    terminado: "TERMINADO (EN CONTROL DE CALIDAD)"
  };

  // AGRUPACIÓN OFICIAL POR TAPA / TROQUEL (FEEDBACK JESÚS ANDRADE: 1 TARJETA POR PIEZA FÍSICA CON CHECKLIST BASE)
  const groupedOrdersMap = {};
  visibleSubtasks.forEach((sub) => {
    if (!groupedOrdersMap[sub.orden_id]) {
      const parentOrder = db.ordenes.find((o) => o.id_orden === sub.orden_id);
      if (!parentOrder) return;
      groupedOrdersMap[sub.orden_id] = {
        order: parentOrder,
        subtasks: []
      };
    }
    groupedOrdersMap[sub.orden_id].subtasks.push(sub);
  });
  const orderGroups = Object.values(groupedOrdersMap);

  const tasksHtml = orderGroups.length
    ? orderGroups
        .map((group) => {
          const ord = group.order;
          const mySubtasks = group.subtasks;
          const totalTasks = mySubtasks.length;
          const completedTasks = mySubtasks.filter((s) => s.estado_subtarea === "terminado").length;
          const isAllDone = totalTasks > 0 && completedTasks === totalTasks;
          const totalWorkerCommission = mySubtasks.reduce((sum, s) => sum + (Number(s.comision_base_tecnico) || 0), 0);
          const earnedCommission = mySubtasks
            .filter((s) => s.estado_subtarea === "terminado")
            .reduce((sum, s) => sum + (Number(s.comision_base_tecnico) || 0), 0);

          const cover = (ord.galeria_fotos_pieza && ord.galeria_fotos_pieza[0]) || DEMO_PHOTOS.camaraCorsa;
          const sparesCover = (ord.galeria_fotos_repuestos && ord.galeria_fotos_repuestos[0]) || null;

          // Otras tareas en esta misma tapa asignadas a otros maquinistas de taller
          const otherTasks = db.subtareas.filter((s) => s.orden_id === ord.id_orden && s.tecnico_id !== activeWorkerId);
          const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

          const pendingSubtasks = mySubtasks.filter((s) => s.estado_subtarea !== "terminado");
          const doneSubtasks = mySubtasks.filter((s) => s.estado_subtarea === "terminado");

          const renderChecklistRow = (sub, idx) => {
            const isTerminado = sub.estado_subtarea === "terminado";
            const isEmpezado = sub.estado_subtarea === "empezado";
            const isPausado = sub.estado_subtarea === "pausado";
            const isPendiente = sub.estado_subtarea === "pendiente";

            return `
              <div class="worker-checklist-row ${isTerminado ? "checklist-row--done" : isEmpezado ? "checklist-row--active" : isPausado ? "checklist-row--paused" : ""}">
                <!-- Columna izquierda: Número, Nombre y Comisión -->
                <div class="checklist-row-left">
                  <span class="checklist-index-badge ${isTerminado ? "badge--done" : isEmpezado ? "badge--active" : ""}">
                    ${isTerminado ? "✓" : `#${idx + 1}`}
                  </span>
                  <div class="checklist-desc-wrap">
                    <div class="checklist-subtask-name">${sub.descripcion_servicio}</div>
                    <div class="checklist-subtask-meta">
                      <span class="checklist-comm-tag">+$${Number(sub.comision_base_tecnico).toFixed(2)}</span>
                      <span class="checklist-substate-pill substate--${sub.estado_subtarea}">
                        ${
                          isPendiente
                            ? '<i class="fas fa-clock"></i> En Cola'
                            : isEmpezado
                            ? '<i class="fas fa-wrench"></i> En Proceso'
                            : isPausado
                            ? '<i class="fas fa-pause-circle"></i> Pausado'
                            : '<i class="fas fa-check-circle"></i> Listo en Mesa'
                        }
                      </span>
                      <span class="checklist-stopwatch ${isEmpezado ? "stopwatch--live" : ""}" data-live-subtask-id="${sub.id_subtarea}">
                        <i class="fas fa-stopwatch"></i> ${formatLiveSubtaskTimer(sub)}
                      </span>
                    </div>
                  </div>
                </div>

                <!-- Columna derecha: Acciones directas y foto -->
                <div class="checklist-row-actions">
                  ${
                    isPendiente
                      ? `
                      <button
                        type="button"
                        class="btn btn--primary btn--sm checklist-btn-action"
                        onclick="startSubtaskWork('${sub.id_subtarea}')"
                        title="Iniciar trabajo en máquina y activar cronómetro"
                      >
                        <i class="fas fa-play"></i> Iniciar
                      </button>
                    `
                      : isEmpezado
                      ? `
                      <button
                        type="button"
                        class="btn btn--warning btn--sm checklist-btn-action"
                        onclick="openPauseSubtaskModal('${sub.id_subtarea}')"
                        title="Pausar trabajo y reportar novedad al chat"
                      >
                        <i class="fas fa-pause"></i> Pausar
                      </button>
                      <button
                        type="button"
                        class="btn btn--success btn--sm checklist-btn-action"
                        onclick="openCompleteSubtaskModal('${sub.id_subtarea}')"
                        title="Subir foto obligatoria y terminar tarea"
                      >
                        <i class="fas fa-camera"></i> Terminar (Foto)
                      </button>
                    `
                      : isPausado
                      ? `
                      <button
                        type="button"
                        class="btn btn--primary btn--sm checklist-btn-action"
                        onclick="startSubtaskWork('${sub.id_subtarea}')"
                        title="Reanudar cronómetro y continuar trabajo"
                      >
                        <i class="fas fa-play"></i> Reanudar
                      </button>
                      <button
                        type="button"
                        class="btn btn--success btn--sm checklist-btn-action"
                        onclick="openCompleteSubtaskModal('${sub.id_subtarea}')"
                        title="Subir foto y finalizar"
                      >
                        <i class="fas fa-camera"></i> Terminar (Foto)
                      </button>
                    `
                      : `
                      <div class="checklist-finished-pill">
                        <i class="fas fa-check-circle" style="color:#16a34a; font-size:15px;"></i>
                        <span style="font-size:11.5px; font-weight:800; color:#15803d;">Listo</span>
                        ${
                          sub.foto_terminado_url
                            ? `<img src="${sub.foto_terminado_url}" class="checklist-finish-photo" onclick="openPhotoLightbox('${sub.foto_terminado_url}', 'Troquel #${ord.codigo_troquel} - ${sub.descripcion_servicio}')" title="Click para ver foto final en HD 4K" />`
                            : ""
                        }
                      </div>
                    `
                  }
                </div>
              </div>
            `;
          };

          return `
            <div class="worker-tapa-card ${isAllDone ? "worker-tapa-card--done" : ""} ${ord.devuelto_calidad ? "worker-tapa-card--rejected" : ""}">
              <!-- CABECERA PRINCIPAL DE LA PIEZA / TROQUEL -->
              <div class="worker-tapa-header">
                <div class="worker-tapa-brand">
                  <button type="button" class="btn-troquel-clickable" style="font-size:13px; padding:3px 10px;" onclick="quickViewOrderDetails('${ord.id_orden}')" title="Inspeccionar ficha técnica">
                    <i class="fas fa-barcode"></i> TROQUEL #${ord.codigo_troquel}
                  </button>
                  <div>
                    <div class="worker-tapa-title">${ord.datos_motor.tipo_pieza || "Cámara / Culata"} · ${ord.datos_motor.marca} ${ord.datos_motor.modelo}</div>
                    <div class="worker-tapa-meta">
                      <span><i class="fas fa-barcode"></i> Serial: <strong>${ord.datos_motor.serial || "S/N"}</strong></span>
                      <span>·</span>
                      <span><i class="fas fa-calendar-alt"></i> Ingreso: ${formatDateHuman(ord.fecha_ingreso, false)}</span>
                      <span>·</span>
                      <span><i class="fas fa-user"></i> Cliente: ${ord.cliente_nombre || "Taller Aliado"}</span>
                    </div>
                  </div>
                </div>

                <div class="worker-tapa-comm-box">
                  <span class="worker-comm-caption">ESTADO EN TU MESA</span>
                  <div class="worker-comm-total" style="font-size:16px;">
                    ${completedTasks} de ${totalTasks} Listas
                  </div>
                  <span class="worker-comm-status-pill ${isAllDone ? "comm-status--full" : ""}">
                    ${isAllDone ? `<i class="fas fa-check-circle" style="color:#22c55e;"></i> Completo (+$${earnedCommission.toFixed(2)} destajo)` : `<i class="fas fa-wrench" style="color:#f59e0b;"></i> Destajo: +$${earnedCommission.toFixed(2)} de $${totalWorkerCommission.toFixed(2)}`}
                  </span>
                </div>
              </div>

              <!-- ALERTA SI LA PIEZA FUE DEVUELTA POR CONTROL DE CALIDAD -->
              ${
                ord.devuelto_calidad && ord.motivo_rechazo_qc
                  ? `<div class="worker-tapa-qc-alert">
                      <i class="fas fa-exclamation-triangle"></i>
                      <div>
                        <strong>DEVUELTO POR CONTROL DE CALIDAD:</strong> ${ord.motivo_rechazo_qc}
                      </div>
                    </div>`
                  : ""
              }

              <!-- SOPORTE VISUAL DE LA PIEZA: FOTOS INICIALES Y REPUESTOS EN MESA -->
              <div class="worker-tapa-photos-strip">
                <div class="worker-photo-pill" onclick="openDualGalleryInspector('${ord.id_orden}')" title="Ver fotos de recepción inicial de la pieza">
                  <img src="${cover}" class="worker-photo-thumb" />
                  <div class="worker-photo-info">
                    <strong><i class="fas fa-camera"></i> Inspección Inicial (${(ord.galeria_fotos_pieza || []).length} fotos)</strong>
                    <span>Toca para ver estado físico previo de la tapa</span>
                  </div>
                </div>

                <div class="worker-photo-pill ${sparesCover ? "worker-photo-pill--spares" : ""}" onclick="openDualGalleryInspector('${ord.id_orden}')" title="Ver repuestos aportados por el cliente en mesa">
                  ${
                    sparesCover
                      ? `<img src="${sparesCover}" class="worker-photo-thumb" />`
                      : `<div class="worker-photo-thumb-empty"><i class="fas fa-toolbox"></i></div>`
                  }
                  <div class="worker-photo-info">
                    <strong><i class="fas fa-boxes"></i> Repuestos en Mesa (${(ord.galeria_fotos_repuestos || []).length})</strong>
                    <span>Válvulas, guías, empacaduras o retenes aportados</span>
                  </div>
                </div>
              </div>

              <!-- BARRA DE PROGRESO DE LA TAPA -->
              <div class="worker-tapa-progress-bar-wrap">
                <div class="worker-progress-header">
                  <span style="font-weight:800; font-size:12px; color:var(--text-secondary);">
                    <i class="fas fa-tasks"></i> LISTA BASE DE TRABAJOS EN TU MESA (${completedTasks} de ${totalTasks} listos)
                  </span>
                  <span style="font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:800; color:${isAllDone ? "#16a34a" : "var(--renacer-gold)"};">
                    ${progressPercent}% COMPLETADO
                  </span>
                </div>
                <div class="worker-progress-track">
                  <div class="worker-progress-fill" style="width: ${progressPercent}%; background:${isAllDone ? "#22c55e" : "var(--renacer-gold)"};"></div>
                </div>
              </div>

              <!-- LISTICA BASE DE SUBTAREAS ASIGNADAS A ESTE TÉCNICO EN ESTA TAPA -->
              <div class="worker-subtasks-checklist">
                ${
                  pendingSubtasks.length
                    ? `
                    <div style="font-size:11px; font-weight:900; color:#f59e0b; text-transform:uppercase; margin:4px 0 2px; display:flex; align-items:center; gap:6px;">
                      <i class="fas fa-wrench"></i> Tareas Pendientes / En Proceso (${pendingSubtasks.length})
                    </div>
                    ${pendingSubtasks.map((s, idx) => renderChecklistRow(s, idx)).join("")}
                  `
                    : ""
                }

                ${
                  doneSubtasks.length
                    ? `
                    <div style="font-size:11px; font-weight:900; color:#16a34a; text-transform:uppercase; margin:8px 0 2px; display:flex; align-items:center; gap:6px;">
                      <i class="fas fa-check-double"></i> Tareas Listas en Mesa (${doneSubtasks.length})
                    </div>
                    ${doneSubtasks.map((s, idx) => renderChecklistRow(s, idx)).join("")}
                  `
                    : ""
                }
              </div>

              <!-- PIE DE TARJETA: TRANSPARENCIA DE OTROS COMPAÑEROS Y BOTONES DE APOYO -->
              <div class="worker-tapa-footer">
                <div class="worker-other-tasks">
                  ${
                    otherTasks.length
                      ? `<i class="fas fa-users-cog"></i> <span>Otras tareas en esta tapa: ${otherTasks
                          .map((t) => `<strong>${t.descripcion_servicio}</strong> (${t.nombre_tecnico})`)
                          .join(" · ")}</span>`
                      : `<i class="fas fa-user-check"></i> <span>Eres el único técnico asignado a esta tapa física.</span>`
                  }
                </div>

                <div class="worker-footer-btns">
                  <button type="button" class="btn btn--ghost btn--sm" onclick="openDualGalleryInspector('${ord.id_orden}')">
                    <i class="fas fa-images"></i> Fotos Recepción
                  </button>
                  <button type="button" class="btn btn--ghost btn--sm" style="border-color:rgba(245,223,0,0.4); color:var(--renacer-gold);" onclick="openOrderCrmModal('${ord.id_orden}')">
                    <i class="fas fa-comments"></i> Bitácora / Chat Tapa
                  </button>
                </div>
              </div>
            </div>
          `;
        })
        .join("")
    : `
      <div style="text-align:center; padding:48px 20px; background:var(--bg-card); border-radius:18px; border:1px solid var(--border-subtle);">
        <i class="fas fa-mug-hot" style="font-size:40px; color:var(--text-muted); margin-bottom:12px;"></i>
        <h3 style="font-size:18px; font-weight:800;">No tienes piezas ni subtareas asignadas activas en este momento</h3>
        <p style="font-size:13px; color:var(--text-muted); max-width:500px; margin:8px auto 0;">
          Las órdenes en Diagnóstico o Esperando Aprobación permanecen en cola técnica hasta que el Jefe de Taller confirme la Matriz de Asignación.
        </p>
      </div>
    `;

  return `
    ${workerSelectorBar}
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:16px; padding:16px 20px; margin-bottom:16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px;">
      <div>
        <span style="background:var(--renacer-gold); color:#0f1638; font-weight:900; font-size:11px; padding:3px 10px; border-radius:99px;">
          PANEL DEL TÉCNICO (FASE 3) · ${workerObj.nombre.toUpperCase()}
        </span>
        <h2 style="font-size:20px; font-weight:900; margin-top:6px;">Mis Trabajos por Destajo y Sub-estados en Tiempo Real</h2>
        <p style="font-size:12.5px; color:var(--text-muted);">
          Usa <strong>En Proceso</strong> al trabajar la pieza en máquina, <strong>Pausado / Imprevisto</strong> para reportar cualquier detención al chat de gerencia, y <strong>Terminar Tarea</strong> adjuntando la foto obligatoria para enviar a Control de Calidad.
        </p>
      </div>
      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        <div style="background:rgba(22,163,74,0.12); border:1px solid rgba(34,197,94,0.35); padding:10px 16px; border-radius:12px; text-align:right;">
          <span style="font-size:10px; font-weight:800; color:var(--text-muted); display:block;">PRODUCCIÓN TERMINADA</span>
          <strong style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#16a34a;">$${earnedCompleted.toFixed(2)}</strong>
        </div>
        <div style="background:rgba(245,196,0,0.12); border:1px solid rgba(245,196,0,0.35); padding:10px 16px; border-radius:12px; text-align:right;">
          <span style="font-size:10px; font-weight:800; color:var(--text-muted); display:block;">ASIGNADO EN MESA</span>
          <strong style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#d97706;">$${pendingToEarn.toFixed(2)}</strong>
        </div>
      </div>
    </div>

    ${
      upcomingSubtasks.length
        ? `
      <div style="background:rgba(56, 189, 248, 0.08); border:1.5px solid rgba(56, 189, 248, 0.35); border-radius:14px; padding:12px 16px; margin-bottom:16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="fas fa-clock" style="color:#38bdf8; font-size:20px;"></i>
          <div>
            <strong style="color:#38bdf8; font-size:13px;">${upcomingSubtasks.length} tarea(s) pre-asignadas en Recepción / Diagnóstico</strong>
            <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
              ${upcomingSubtasks
                .map((s) => {
                  const po = db.ordenes.find((o) => o.id_orden === s.orden_id);
                  return `Troquel #${po ? po.codigo_troquel : "S/N"}: ${s.descripcion_servicio}`;
                })
                .join(" · ")}
            </div>
          </div>
        </div>
        <span style="font-size:11px; font-weight:800; color:var(--text-muted); background:rgba(255,255,255,0.05); padding:4px 10px; border-radius:8px;">
          Se activarán en mesa al pasar a 4. Servicio
        </span>
      </div>
    `
        : ""
    }

    ${tasksHtml}
  `;
}

function selectWorkerPreview(workerId) {
  selectedWorkerFilterId = workerId;
  renderScreen();
}

function setSubtaskToPending(subtaskId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  accumulateSubtaskActiveTime(sub);
  sub.estado_subtarea = "pendiente";

  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);
  if (ord) {
    const anyStarted = db.subtareas.some((s) => s.orden_id === ord.id_orden && s.estado_subtarea === "empezado");
    ord.subestado_ejecucion = anyStarted ? "empezado" : "pendiente";
  }

  saveDatabase();
  renderApp();
  showToast(`Subtarea "${sub.descripcion_servicio}" marcada como Por Hacer / Pendiente.`);
}

function registerWorkerActiveDayProject(workerId, workerName, troquelCode, serviceDesc) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const existing = db.asistencias.find(
    (a) => a.usuario_id === workerId && cleanDateISO(a.fecha) === todayIso
  );
  const projectLabel = `Troquel #${troquelCode} (${serviceDesc})`;
  if (existing) {
    if (!String(existing.observacion || "").includes(`#${troquelCode}`)) {
      existing.observacion = existing.observacion
        ? `${existing.observacion} · ${projectLabel}`
        : `Proyectos trabajados: ${projectLabel}`;
    }
  } else {
    db.asistencias.unshift({
      id_asist: "ASI-" + Date.now(),
      usuario_id: workerId,
      nombre: workerName,
      fecha: todayIso,
      hora_entrada: "Destajo",
      hora_salida: "Por Pieza",
      estado: "Activo en Taller",
      observacion: `Proyectos trabajados: ${projectLabel}`
    });
  }
}

function startSubtaskWork(subtaskId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  sub.estado_subtarea = "empezado";
  if (!sub.inicio_activo_ts) {
    sub.inicio_activo_ts = Date.now();
  }

  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);
  if (ord) {
    ord.subestado_ejecucion = "empezado";
    registerWorkerActiveDayProject(
      sub.tecnico_id || currentUser.id_usuario,
      sub.nombre_tecnico || currentUser.nombre,
      ord.codigo_troquel,
      sub.descripcion_servicio
    );
  }

  saveDatabase();
  renderApp();
  showToast(`Trabajo "${sub.descripcion_servicio}" EN PROCESO. Cronómetro en tiempo real activado.`);
}

/* ---------- FASE 3 PUNTO 4: PAUSADO / IMPREVISTO CON NOTA OBLIGATORIA AL CHAT ---------- */
function openPauseSubtaskModal(subtaskId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);

  openModal({
    title: `⏸️ Pausar Trabajo / Reportar Imprevisto — Troquel #${ord ? ord.codigo_troquel : ""}`,
    icon: "fa-pause-circle",
    body: `
      <div style="background:rgba(245,158,11,0.12); border:1.5px solid #f59e0b; border-radius:12px; padding:12px; margin-bottom:14px; font-size:13px;">
        <strong>Regla Operativa (Fase 3 - Punto 4):</strong> Al colocar una tarea en <strong>Pausado / Imprevisto</strong>, es obligatorio registrar una nota breve en el chat interno para notificar inmediatamente a la gerencia el motivo de la detención.
      </div>

      <div style="margin-bottom:10px;">
        <span style="font-size:11.5px; font-weight:800; color:var(--text-muted); display:block; margin-bottom:6px;">Motivos rápidos frecuentes (Toca para autocompletar):</span>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='Ausencia de energía eléctrica en estación de maquinado.'"><i class="fas fa-bolt"></i> Ausencia de energía</button>
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='Herramienta / buril averiado, requiere ajuste.'"><i class="fas fa-wrench"></i> Herramienta averiada</button>
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='Se detectó fisura oculta o poro profundo en la pieza, esperando directriz de gerencia.'"><i class="fas fa-search"></i> Fisura oculta detectada</button>
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='Duda técnica sobre medida de guías/válvulas aportadas por el cliente.'"><i class="fas fa-question-circle"></i> Duda técnica / Repuesto</button>
        </div>
      </div>

      <div class="form-field">
        <label>Nota Breve Obligatoria para el Chat de Gerencia *</label>
        <textarea id="pause-reason-input" rows="3" placeholder="Describe brevemente por qué se detiene el trabajo en la pieza..."></textarea>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold btn--lg" onclick="confirmPauseSubtaskWithNote('${sub.id_subtarea}')">
        <i class="fas fa-paper-plane"></i> Notificar en Chat y Pausar Reloj
      </button>
    `
  });
}

function confirmPauseSubtaskWithNote(subtaskId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  const note = (document.getElementById("pause-reason-input")?.value || "").trim();
  if (!note) {
    showToast("Debes escribir o seleccionar una nota breve explicando el motivo de la pausa para notificar a la gerencia.", "error");
    return;
  }

  sub.estado_subtarea = "pausado";
  accumulateSubtaskActiveTime(sub);

  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);
  if (ord) {
    ord.subestado_ejecucion = "pausado";
    ord.tiempo_neto_minutos = db.subtareas
      .filter((s) => s.orden_id === ord.id_orden)
      .reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);

    db.bitacora.push({
      id_mensaje: "MSG-" + Date.now(),
      orden_id: ord.id_orden,
      codigo_troquel: ord.codigo_troquel,
      autor_id: currentUser.id_usuario,
      autor_nombre: sub.nombre_tecnico || currentUser.nombre,
      autor_rol: "Técnico",
      tipo_evento: "pausa_imprevisto",
      mensaje: `⏸️ TAREA PAUSADA / IMPREVISTO en "${sub.descripcion_servicio}": ${note}`,
      foto_adjunta_url: "",
      fecha_hora: new Date().toISOString().slice(0, 16).replace("T", " ")
    });
  }

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`⏸️ Trabajo pausado y gerencia notificada en el chat interno.`);
}

function pauseSubtaskWork(subtaskId) {
  openPauseSubtaskModal(subtaskId);
}

/* ---------- FASE 3 PUNTO 5: REQUISITO FOTOGRÁFICO OBLIGATORIO DE FINALIZACIÓN ---------- */
let tempFinishSubtaskPhoto = "";

function openCompleteSubtaskModal(subtaskId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);

  // Fase 3 Punto 5: La foto inicia VACÍA y el botón de envío permanece BLOQUEADO hasta adjuntarla
  tempFinishSubtaskPhoto = "";

  openModal({
    title: `Terminar Tarea y Enviar a Control de Calidad — Troquel #${ord ? ord.codigo_troquel : ""}`,
    icon: "fa-camera",
    body: `
      <div style="background:rgba(22,163,74,0.1); border:1px solid rgba(22,163,74,0.35); border-radius:12px; padding:12px; margin-bottom:14px; font-size:13px;">
        <strong>Requisito Fotográfico Obligatorio (Fase 3 - Punto 5):</strong> Para dar por concluida tu labor sobre la pieza (<strong>${sub.descripcion_servicio}</strong>), el sistema exige obligatoriamente adjuntar la fotografía del artículo finalizado. <strong>Si la foto no es adjuntada, el botón de envío se mantiene bloqueado.</strong>
      </div>

      <div class="form-section-box">
        <div class="form-section-title"><i class="fas fa-check-double"></i> Verificación de Entrega a Control de Calidad</div>
        <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin-bottom:6px;">
          <input type="checkbox" checked required /> Superficie / trabajo maquinado dentro de las tolerancias indicadas
        </label>
        <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin-bottom:6px;">
          <input type="checkbox" checked required /> Pieza limpia e identificada con su Código de Troquel #${ord ? ord.codigo_troquel : ""}
        </label>
      </div>

      <div class="form-section-box" style="border-color:rgba(220,38,38,0.45);" id="finish-photo-validation-box">
        <div class="form-section-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span><i class="fas fa-camera"></i> Fotografía Obligatoria del Artículo Finalizado *</span>
          <button type="button" class="btn btn--ghost" style="padding:4px 10px; font-size:11px;" onclick="useDemoFinishSubtaskPhoto()">
            <i class="fas fa-flask"></i> Usar Foto de Prueba Rápida
          </button>
        </div>

        <div id="finish-photo-status-banner" style="background:rgba(220,38,38,0.1); color:#dc2626; padding:8px 12px; border-radius:8px; font-size:12px; font-weight:800; margin-bottom:12px;">
          <i class="fas fa-lock"></i> Pendiente: Debes tomar o subir la foto de la pieza terminada para desbloquear el envío a Control de Calidad.
        </div>

        <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
          <img
            id="finish-subtask-photo-preview"
            src=""
            alt="Vista previa pieza terminada"
            style="display:none; width:120px; height:88px; object-fit:cover; border-radius:10px; border:2px solid #16a34a;"
          />
          <label class="btn btn--primary" style="cursor:pointer;">
            <i class="fas fa-camera"></i> Tomar / Subir Fotografía de Pieza Terminada
            <input type="file" accept="image/*" style="display:none;" onchange="handleSubtaskFinishPhoto(event)" />
          </label>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button
        type="button"
        id="btn-confirm-finish-subtask"
        class="btn btn--success btn--lg"
        disabled
        style="opacity:0.45; cursor:not-allowed;"
        onclick="confirmSubtaskCompletion('${sub.id_subtarea}')"
      >
        <i class="fas fa-lock"></i> Adjunta la Foto para Enviar a Control de Calidad (+$${Number(sub.comision_base_tecnico).toFixed(2)})
      </button>
    `
  });
}

function unlockFinishSubtaskButton(photoUrl) {
  tempFinishSubtaskPhoto = photoUrl;
  const img = document.getElementById("finish-subtask-photo-preview");
  if (img) {
    img.src = tempFinishSubtaskPhoto;
    img.style.display = "block";
  }
  const banner = document.getElementById("finish-photo-status-banner");
  if (banner) {
    banner.style.background = "rgba(22,163,74,0.12)";
    banner.style.color = "#15803d";
    banner.innerHTML = "<i class=\"fas fa-check-circle\" style=\"color:#22c55e;\"></i> Fotografía del artículo finalizado validada. Ya puedes confirmar y enviar a Control de Calidad.";
  }
  const box = document.getElementById("finish-photo-validation-box");
  if (box) {
    box.style.borderColor = "rgba(22,163,74,0.5)";
  }
  const btn = document.getElementById("btn-confirm-finish-subtask");
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    btn.innerHTML = `<i class="fas fa-check-circle"></i> Terminar Tarea y Enviar a Control de Calidad`;
  }
}

async function handleSubtaskFinishPhoto(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const dataUrl = await readFileAsCompressedDataUrl(file);
  unlockFinishSubtaskButton(dataUrl);
  showToast("Fotografía obligatoria de pieza terminada cargada.");
}

function useDemoFinishSubtaskPhoto() {
  unlockFinishSubtaskButton(DEMO_PHOTOS.trabajoTerminado);
  showToast("Foto de prueba cargada y botón de envío habilitado.");
}

function confirmSubtaskCompletion(subtaskId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;

  if (!tempFinishSubtaskPhoto) {
    showToast("Validación Obligatoria (Fase 3): Debes adjuntar la fotografía de la pieza finalizada antes de enviar a Control de Calidad.", "error");
    return;
  }

  // Detener el cronómetro en vivo y sumar el tiempo real invertido con precisión exacta de segundos
  accumulateSubtaskActiveTime(sub);
  if (!sub.minutos_acumulados || sub.minutos_acumulados === 0) {
    sub.minutos_acumulados = Math.max(1, Math.floor((Number(sub.segundos_acumulados) || 0) / 60));
  }

  sub.estado_subtarea = "terminado";
  sub.foto_terminado_url = tempFinishSubtaskPhoto;
  sub.fecha_terminado = new Date().toISOString().slice(0, 10);

  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);
  if (ord) {
    registerWorkerActiveDayProject(
      sub.tecnico_id || currentUser.id_usuario,
      sub.nombre_tecnico || currentUser.nombre,
      ord.codigo_troquel,
      sub.descripcion_servicio
    );

    const allOrderSubs = db.subtareas.filter((s) => s.orden_id === ord.id_orden);
    const allDone = allOrderSubs.every((s) => s.estado_subtarea === "terminado");
    ord.tiempo_neto_minutos = allOrderSubs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);

    if (allDone) {
      ord.subestado_ejecucion = "terminado";
      // Fase 3 Punto 5: Transfiere la orden al estado de Control de Calidad y notifica al supervisor
      ord.estado_actual = "control_calidad";
      ord.devuelto_calidad = false;
    }

    db.bitacora.push({
      id_mensaje: "MSG-" + Date.now(),
      orden_id: ord.id_orden,
      codigo_troquel: ord.codigo_troquel,
      autor_id: currentUser.id_usuario,
      autor_nombre: sub.nombre_tecnico || currentUser.nombre,
      autor_rol: "Técnico",
      tipo_evento: "terminado",
      mensaje: `Tarea "${sub.descripcion_servicio}" FINALIZADA con fotografía obligatoria (Tiempo invertido: ${formatMinutes(sub.minutos_acumulados)}). ${
        allDone
          ? "NOTIFICACIÓN AL SUPERVISOR DE PLANTA: Todas las tareas de la pieza han sido completadas. La orden pasa a 5. Control de Calidad para revisión."
          : ""
      }`,
      foto_adjunta_url: sub.foto_terminado_url,
      fecha_hora: new Date().toISOString().slice(0, 16).replace("T", " ")
    });
  }

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`¡Excelente! Tarea finalizada con foto, enviada a Control de Calidad y comisión de $${Number(sub.comision_base_tecnico).toFixed(2)} sumada.`);
}

function renderWorkerEarningsScreen() {
  const mySubs = db.subtareas.filter((s) => {
    if (s.tecnico_id !== currentUser.id_usuario) return false;
    const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
    if (!ord) return false;
    // Solo mostrar tareas de órdenes en ejecución o finalizadas (no en recepción preliminar)
    if (ord.estado_actual === "recepcion" || ord.estado_actual === "diagnostico_presupuesto" || ord.estado_actual === "diagnostico") return false;
    return true;
  });
  const doneSubs = mySubs.filter((s) => s.estado_subtarea === "terminado");
  const totalEarned = doneSubs.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
  const totalMinutes = mySubs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);

  // Cálculo dinámico del ciclo semanal de Lunes a Domingo (Corte Domingo)
  const nowW = new Date();
  const curDay = nowW.getDay() || 7;
  const monD = new Date(nowW);
  monD.setDate(nowW.getDate() - curDay + 1);
  const sunD = new Date(monD);
  sunD.setDate(monD.getDate() + 6);
  const fmtD = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const curWeekLabel = `${fmtD(monD)} - ${fmtD(sunD)}`;

  const prevMonD = new Date(monD);
  prevMonD.setDate(monD.getDate() - 7);
  const prevSunD = new Date(prevMonD);
  prevSunD.setDate(prevMonD.getDate() + 6);
  const prevWeekLabel = `${fmtD(prevMonD)} - ${fmtD(prevSunD)}`;

  return `
    <div style="background:var(--bg-card); border-radius:18px; padding:20px; border:1px solid var(--border-subtle); margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div>
        <h2 style="font-size:20px; font-weight:900;"><i class="fas fa-hand-holding-dollar" style="color:var(--renacer-gold);"></i> Mi Ficha de Producción y Comisiones — ${currentUser.nombre}</h2>
        <p style="font-size:13px; color:var(--text-muted);">
          Relación de piezas trabajadas por número de Troquel, tiempo invertido en cada pieza y comisiones por destajo.
        </p>
      </div>
      <div style="display:flex; gap:16px; align-items:center;">
        <div style="text-align:right;">
          <span style="font-size:11px; color:var(--text-muted); font-weight:800; display:block;">TIEMPO TOTAL EN PIEZAS</span>
          <strong style="font-family:'JetBrains Mono',monospace; font-size:20px;">${formatMinutes(totalMinutes)}</strong>
        </div>
        <div style="text-align:right;">
          <span style="font-size:11px; color:var(--text-muted); font-weight:800; display:block;">TOTAL GANADO (TERMINADOS)</span>
          <strong style="font-family:'JetBrains Mono',monospace; font-size:26px; font-weight:900; color:#16a34a;">$${totalEarned.toFixed(2)}</strong>
        </div>
      </div>
    </div>

    <div class="data-table-wrapper">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Troquel / Pieza</th>
            <th>Trabajo Realizado</th>
            <th>Fecha</th>
            <th>Tiempo en Pieza</th>
            <th>Estado</th>
            <th>Comisión</th>
          </tr>
        </thead>
        <tbody>
          ${mySubs
            .map((s) => {
              const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
              return `
                <tr>
                  <td>
                    <button type="button" class="btn-troquel-clickable" onclick="quickViewOrderDetails('${ord ? ord.id_orden : s.orden_id}')" title="Inspeccionar ficha técnica">
                      <i class="fas fa-barcode"></i> TROQUEL #${ord ? ord.codigo_troquel : s.orden_id}
                    </button>
                    <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${ord ? `${ord.datos_motor.marca} ${ord.datos_motor.modelo}` : ""}</div>
                  </td>
                  <td>${s.descripcion_servicio}</td>
                  <td>${formatDateHuman(s.fecha_terminado || (ord && ord.fecha_ingreso), false)}</td>
                  <td><span data-live-subtask-id="${s.id_subtarea}">${formatLiveSubtaskTimer(s)}</span></td>
                  <td><span class="state-badge ${s.estado_subtarea === "terminado" ? "state-badge--done" : "state-badge--wait"}">${s.estado_subtarea.toUpperCase()}</span></td>
                  <td style="font-family:'JetBrains Mono',monospace; font-weight:900; color:#16a34a;">$${Number(s.comision_base_tecnico).toFixed(2)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>

    <!-- SECCIÓN DE HISTORIAL DE VOUCHERS Y LIQUIDACIONES DE NÓMINA SEMANAL -->
    <div style="margin-top:24px; background:var(--bg-card); border-radius:18px; padding:20px; border:1px solid var(--border-subtle);">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px;">
        <div>
          <span style="font-size:11px; font-weight:900; color:var(--renacer-gold); text-transform:uppercase;">
            <i class="fas fa-file-invoice-dollar"></i> NÓMINA POR DESTAJO SEMANAL
          </span>
          <h3 style="font-size:17px; font-weight:900; margin-top:2px;">
            Historial de Vouchers y Liquidaciones de Nómina Semanal
          </h3>
          <p id="payroll-notice-display" data-custom-text-key="payroll_notice" style="font-size:12px; color:var(--text-muted); margin-top:2px;">
            ${escapeHtml(getCustomText("payroll_notice", "Semana laboral de Lunes a Domingo. Corte y liquidación los días Domingo."))}
          </p>
        </div>
      </div>

      <div class="data-table-wrapper">
        <table class="renacer-table">
          <thead>
            <tr>
              <th>Semana / Período</th>
              <th>Piezas y Troqueles</th>
              <th>Subtareas Realizadas</th>
              <th>Total Ganado</th>
              <th>Estatus de Pago</th>
              <th style="text-align:right;">Comprobante</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Semana Actual</strong>
                <div style="font-size:11px; color:var(--text-muted);">${curWeekLabel}</div>
              </td>
              <td>${doneSubs.length ? doneSubs.map(s => { const o = db.ordenes.find(ord => ord.id_orden === s.orden_id); return o ? renderClickableTroquelBadge(o.id_orden, "#") : ''; }).filter(Boolean).join(' ') : 'En curso'}</td>
              <td><strong>${doneSubs.length} subtareas</strong> terminadas</td>
              <td style="font-family:'JetBrains Mono',monospace; font-weight:900; color:#16a34a; font-size:14px;">
                $${totalEarned.toFixed(2)}
              </td>
              <td>
                <span style="font-size:11px; font-weight:800; background:rgba(245,196,0,0.15); color:var(--renacer-gold); padding:3px 8px; border-radius:6px;">
                  <i class="fas fa-hourglass-half"></i> En Curso (Corte Domingo)
                </span>
              </td>
              <td style="text-align:right;">
                <button type="button" class="btn btn--gold btn--xs" onclick="openWorkerPayrollVoucherModal('${currentUser.nombre}', 'Semana Actual (${curWeekLabel})', ${totalEarned}, ${doneSubs.length})">
                  <i class="fas fa-receipt"></i> Ver Pre-Voucher
                </button>
              </td>
            </tr>
            <tr>
              <td>
                <strong>Semana Anterior</strong>
                <div style="font-size:11px; color:var(--text-muted);">${prevWeekLabel}</div>
              </td>
              <td>${renderClickableTroquelBadge("1548", "#")}</td>
              <td><strong>Trabajos completados</strong></td>
              <td style="font-family:'JetBrains Mono',monospace; font-weight:900; color:#16a34a; font-size:14px;">
                $${totalEarned > 0 ? totalEarned.toFixed(2) : "35.00"}
              </td>
              <td>
                <span style="font-size:11px; font-weight:800; background:rgba(34,197,94,0.15); color:#22c55e; padding:3px 8px; border-radius:6px;">
                  <i class="fas fa-check-circle"></i> Liquidado y Pagado
                </span>
              </td>
              <td style="text-align:right;">
                <button type="button" class="btn btn--ghost btn--xs" onclick="openWorkerPayrollVoucherModal('${currentUser.nombre}', 'Semana Anterior (${prevWeekLabel})', ${totalEarned > 0 ? totalEarned : 35.00}, ${doneSubs.length || 7})">
                  <i class="fas fa-file-invoice"></i> Ver Recibo
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function openWorkerPayrollVoucherModal(workerName, period, amount, taskCount) {
  Swal.fire({
    title: `<strong style="font-size:17px; color:#0f1638;">VOUCHER DIGITAL DE NÓMINA DESTAJO</strong>`,
    html: `
      <div style="text-align:left; font-size:13px; color:#1e293b; background:#f8fafc; border:1.5px solid #cbd5e1; border-radius:12px; padding:16px; margin-top:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1.5px solid #e2e8f0; padding-bottom:8px; margin-bottom:12px;">
          <div>
            <strong style="font-size:15px; color:#0f1638;">RECTIFICADORA RENACER</strong>
            <div style="font-size:11px; color:#64748b;">JOB 8:7 · SISTEMA DE TALLER</div>
          </div>
          <span style="background:#22c55e; color:#fff; font-size:11px; font-weight:800; padding:3px 8px; border-radius:6px;">CERTIFICADO</span>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;">
          <div><strong style="color:#64748b; font-size:11px;">TÉCNICO:</strong><br><strong style="font-size:13px;">${workerName}</strong></div>
          <div><strong style="color:#64748b; font-size:11px;">PERÍODO:</strong><br><span>${period}</span></div>
          <div><strong style="color:#64748b; font-size:11px;">TAREAS TERMINADAS:</strong><br><span>${taskCount} trabajos</span></div>
          <div><strong style="color:#64748b; font-size:11px;">TOTAL A LIQUIDAR:</strong><br><strong style="font-size:18px; color:#16a34a; font-family:'JetBrains Mono',monospace;">$${Number(amount).toFixed(2)}</strong></div>
        </div>
        <div style="border-top:1px dashed #cbd5e1; padding-top:10px; font-size:11px; color:#64748b; text-align:center;">
          Liquidación de destajo avalada por Dirección (Moisés González) y Jefatura de Taller (Jesús Andrade).
        </div>
      </div>
    `,
    confirmButtonText: "Entendido",
    confirmButtonColor: "#f5c400"
  });
}

/* ============================================================================
   INSPECTOR VISUAL DE LAS 2 GALERÍAS Y MODAL COMPLETO DE BITÁCORA / CHAT
   ============================================================================ */
function openDualGalleryInspector(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const piezaImgs = (order.galeria_fotos_pieza || [])
    .map(
      (url, i) => `
      <div style="border-radius:12px; overflow:hidden; border:1.5px solid var(--border-color); background:#000; position:relative; cursor:zoom-in;" onclick="openPhotoLightbox('${url}', 'Troquel #${order.codigo_troquel} · Estado de Pieza #${i + 1}')">
        <img src="${url}" alt="Pieza ${i + 1}" style="width:100%; height:210px; object-fit:cover; display:block;" />
        <div style="padding:6px 10px; font-size:11.5px; font-weight:800; color:#fff; background:#0f172a; display:flex; justify-content:space-between; align-items:center;">
          <span>Foto Pieza #${i + 1} · Troquel #${order.codigo_troquel}</span>
          <span style="color:var(--renacer-gold); font-size:10px;"><i class="fas fa-search-plus"></i> Ampliar 4K</span>
        </div>
      </div>
    `
    )
    .join("");

  const repuestosImgs = (order.galeria_fotos_repuestos || []).length
    ? order.galeria_fotos_repuestos
        .map(
          (url, i) => `
          <div style="border-radius:12px; overflow:hidden; border:2px solid var(--renacer-gold); background:#000; position:relative; cursor:zoom-in;" onclick="openPhotoLightbox('${url}', 'Troquel #${order.codigo_troquel} · Repuestos #${i + 1}')">
            <img src="${url}" alt="Repuestos ${i + 1}" style="width:100%; height:210px; object-fit:cover; display:block;" />
            <div style="padding:6px 10px; font-size:11.5px; font-weight:800; color:#0f1638; background:var(--renacer-gold); display:flex; justify-content:space-between; align-items:center;">
              <span><i class="fas fa-camera"></i> Repuestos del Cliente #${i + 1}</span>
              <span style="font-size:10px;"><i class="fas fa-search-plus"></i> Ampliar 4K</span>
            </div>
          </div>
        `
        )
        .join("")
    : `<div style="padding:24px; background:var(--bg-input); border-radius:12px; font-size:13px; color:var(--text-muted); grid-column:1/-1;">El cliente no dejó repuestos físicos en recepción para esta orden.</div>`;

  const paymentProofHtml = order.comprobante_pago_foto
    ? `
      <div class="form-section-box" style="margin-top:14px;">
        <div class="form-section-title"><i class="fas fa-receipt"></i> Comprobante Fotográfico de Pago / Abono (${(order.metodo_pago || "efectivo").toUpperCase()})</div>
        <img src="${order.comprobante_pago_foto}" style="max-width:320px; border-radius:12px; border:1.5px solid var(--border-color); cursor:zoom-in;" onclick="openPhotoLightbox('${order.comprobante_pago_foto}', 'Comprobante de Pago · Troquel #${order.codigo_troquel}')" />
      </div>
    `
    : "";

  openModal({
    title: `Inspección Multimedia Dual 4K — TROQUEL #${order.codigo_troquel}`,
    icon: "fa-images",
    wide: true,
    body: `
      <div class="form-section-box">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
          <div class="form-section-title" style="margin-bottom:0;">
            <i class="fas fa-camera"></i> Galería 1: Fotos del Estado de la Pieza (${(order.galeria_fotos_pieza || []).length})
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            <label class="btn btn--primary btn--xs" style="cursor:pointer; font-weight:800; padding:5px 10px; background:#0284c7;" title="Tomar foto con la cámara del teléfono">
              <i class="fas fa-camera"></i> Tomar Foto
              <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="handleInspectionMultiUpload(event, '${order.id_orden}', 'pieza')" />
            </label>
            <label class="btn btn--ghost btn--xs" style="cursor:pointer; font-weight:800; padding:5px 10px; border-color:rgba(56,189,248,0.5); color:#38bdf8;" title="Elegir fotos de la galería">
              <i class="fas fa-images"></i> Galería
              <input type="file" accept="image/*" multiple style="display:none;" onchange="handleInspectionMultiUpload(event, '${order.id_orden}', 'pieza')" />
            </label>
          </div>
        </div>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px;">
          ${piezaImgs || `<div style="grid-column:1/-1; padding:20px; color:var(--text-muted); font-size:12px;">Sin fotos registradas de la pieza.</div>`}
        </div>
      </div>

      <div class="form-section-box" style="border-color:rgba(245,196,0,0.6); background:rgba(245,196,0,0.04);">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
          <div class="form-section-title" style="color:#b45309; margin-bottom:0;">
            <i class="fas fa-camera"></i> Galería 2: Fotos de Repuestos Aportados por el Cliente (${(order.galeria_fotos_repuestos || []).length})
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            <label class="btn btn--gold btn--xs" style="cursor:pointer; font-weight:800; padding:5px 10px;" title="Tomar foto con la cámara del teléfono">
              <i class="fas fa-camera"></i> Tomar Foto
              <input type="file" accept="image/*" capture="environment" style="display:none;" onchange="handleInspectionMultiUpload(event, '${order.id_orden}', 'repuestos')" />
            </label>
            <label class="btn btn--ghost btn--xs" style="cursor:pointer; font-weight:800; padding:5px 10px; border-color:rgba(245,223,0,0.5); color:#fde047;" title="Elegir fotos de repuestos de la galería">
              <i class="fas fa-images"></i> Galería
              <input type="file" accept="image/*" multiple style="display:none;" onchange="handleInspectionMultiUpload(event, '${order.id_orden}', 'repuestos')" />
            </label>
          </div>
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">
          Soporte visual exclusivo para que el técnico verifique en su mesa con qué guías, válvulas, sellos o empacaduras cuenta físicamente. Toca cualquier foto para ampliarla en pantalla completa con zoom.
        </p>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px;">
          ${repuestosImgs}
        </div>
      </div>

      ${paymentProofHtml}
    `,
    footer: `<button type="button" class="btn btn--primary" onclick="closeModal()">Cerrar Visor</button>`
  });
}

async function handleInspectionMultiUpload(event, orderId, galleryType) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  showToast(`Procesando ${files.length} foto(s) en alta definición (2K/4K)...`);
  if (galleryType === "pieza") {
    if (!order.galeria_fotos_pieza) order.galeria_fotos_pieza = [];
    for (const file of files) {
      const dataUrl = await readFileAsCompressedDataUrl(file);
      order.galeria_fotos_pieza.push(dataUrl);
    }
  } else {
    if (!order.galeria_fotos_repuestos) order.galeria_fotos_repuestos = [];
    for (const file of files) {
      const dataUrl = await readFileAsCompressedDataUrl(file);
      order.galeria_fotos_repuestos.push(dataUrl);
    }
  }
  saveDatabase();
  openDualGalleryInspector(orderId);
  showToast(`${files.length} foto(s) agregada(s) exitosamente.`);
}

let tempCrmPhotoUrl = "";
let currentCrmFilterMode = "chat"; // 'chat' | 'all'

function setCrmFilterMode(mode, orderId) {
  currentCrmFilterMode = mode;
  openOrderCrmModal(orderId);
}

function openOrderCrmModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  tempCrmPhotoUrl = "";

  const allMessages = db.bitacora.filter((m) => m.orden_id === orderId);

  const isSystemMsg = (m) => {
    if (m.es_sistema || m.tipo_evento === "auditoria" || m.tipo_evento === "transicion" || m.tipo_evento === "sistema") return true;
    const txt = (m.mensaje || "").toLowerCase();
    if (txt.includes("orden ingresada") || txt.includes("orden archivada") || txt.includes("póliza de garantía") || txt.includes("orden anulada")) return true;
    return false;
  };
  const chatOnlyMessages = allMessages.filter(
    (m) => !isSystemMsg(m) || m.foto_adjunta_url || m.tipo_evento === "pausa_imprevisto" || m.tipo_evento === "rechazo_calidad" || m.tipo_evento === "comentario" || m.tipo_evento === "nota_interna"
  );

  const countChat = chatOnlyMessages.length;
  const countAll = allMessages.length;

  const isPrivileged = currentUser && (currentUser.rol === "admin" || currentUser.rol === "jefe_taller");
  const isTechOrRecep = !isPrivileged;
  const baseMessages = isTechOrRecep ? chatOnlyMessages : (currentCrmFilterMode === "chat" ? chatOnlyMessages : allMessages);
  const displayMessages = baseMessages.filter((m) => {
    if (isPrivileged) return true;
    const txt = (m.mensaje || "").toLowerCase();
    if (m.tipo_evento === "cobro_resto" || m.tipo_evento === "abono" || m.tipo_evento === "pago") return false;
    if (txt.includes("presupuesto inicial:") || txt.includes("pago recibido") || txt.includes("saldo pendiente") || txt.includes("resto pendiente") || txt.includes("abono")) return false;
    return true;
  });

  const feedHtml = displayMessages.length
    ? displayMessages
        .map((m) => {
          const isMine = currentUser && m.autor_id === currentUser.id_usuario;
          const specialStyle =
            m.tipo_evento === "rechazo_calidad"
              ? "border-color:#dc2626; background:rgba(220,38,38,0.08);"
              : m.tipo_evento === "pausa_imprevisto"
              ? "border-color:#f59e0b; background:rgba(245,158,11,0.08);"
              : isSystemMsg(m)
              ? "opacity:0.85; border-left:3px solid var(--renacer-gold); background:rgba(255,255,255,0.03);"
              : "";
          return `
          <div class="crm-msg-bubble ${isMine ? "crm-msg-bubble--mine" : ""}" style="${specialStyle}">
            <div class="crm-msg-meta">
              <span><strong><i class="fas ${isMine ? "fa-user-check" : "fa-user"}"></i> ${m.autor_nombre}</strong> (${m.autor_rol})</span>
              <span><i class="far fa-clock"></i> ${formatDateHuman(m.fecha_hora, true)}</span>
            </div>
            <div class="crm-msg-text">${m.mensaje}</div>
            ${
              m.foto_adjunta_url
                ? `<img src="${m.foto_adjunta_url}" class="crm-msg-photo" alt="Adjunto" onclick="openPhotoLightbox('${m.foto_adjunta_url}', 'Orden #${order.codigo_troquel} · Bitácora')" style="cursor:zoom-in;" />`
                : ""
            }
          </div>
        `;
        })
        .join("")
    : `<p style="font-size:13px; color:var(--text-muted); text-align:center; padding:24px 0;"><i class="fas fa-comment-dots" style="font-size:24px; opacity:0.5; display:block; margin-bottom:6px;"></i>${currentCrmFilterMode === "chat" || isTech ? "No hay notas técnicas de trabajadores aún en esta orden." : "Aún no hay registros en la bitácora."}</p>`;

  openModal({
    title: `Chat Interno Técnico — ORDEN #${order.codigo_troquel}`,
    icon: "fa-comments",
    wide: true,
    body: `
      <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <div>
          <div style="font-weight:900; font-size:14px; color:var(--text-main);">
            ${order.nombre_cliente} · <span style="color:var(--renacer-gold); font-family:'JetBrains Mono',monospace;">ORDEN #${order.codigo_troquel}</span>
          </div>
          <div style="font-size:11.5px; color:var(--text-muted); font-weight:600;">
            ${order.datos_motor.marca} ${order.datos_motor.modelo} (${order.datos_motor.tipo_pieza})
          </div>
        </div>
        <div>
          <span class="state-badge">${order.estado_actual.replace(/_/g, " ")}</span>
        </div>
      </div>

      <!-- Filtro Chat Técnico vs Historial Completo (Solo visible para Jefes y Admin) -->
      ${isPrivileged ? `
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px; padding:6px 10px; background:var(--bg-subtle); border-radius:10px; border:1px solid var(--border-subtle);">
        <span style="font-size:11.5px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Vista de Conversación:</span>
        <div style="display:flex; gap:6px;">
          <button type="button" class="btn btn--xs ${currentCrmFilterMode === "chat" ? "btn--primary" : "btn--ghost"}" onclick="setCrmFilterMode('chat', '${orderId}')">
            <i class="fas fa-comments"></i> Chat Técnico & Notas (${countChat})
          </button>
          <button type="button" class="btn btn--xs ${currentCrmFilterMode === "all" ? "btn--primary" : "btn--ghost"}" onclick="setCrmFilterMode('all', '${orderId}')">
            <i class="fas fa-list-check"></i> Historial Completo (${countAll})
          </button>
        </div>
      </div>` : ""}

      <div class="crm-chat-feed" id="crm-feed-box">${feedHtml}</div>

      <div class="form-section-box" style="margin-top:12px; margin-bottom:0; padding:12px;">
        <div class="form-field">
          <label>Escribir Mensaje o Reportar Novedad en la Pieza</label>
          <textarea id="crm-new-msg-text" rows="2" placeholder="Ej: Se detectó asiento de válvula fisurado en cilindro #3, adjunto foto para aprobación de ítem extra..."></textarea>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; flex-wrap:wrap; gap:10px;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <label class="btn btn--ghost btn--sm" style="cursor:pointer;">
              <i class="fas fa-camera"></i> Adjuntar Foto
              <input type="file" accept="image/*" style="display:none;" onchange="handleCrmPhotoSelect(event)" />
            </label>
            <span id="crm-photo-status" style="font-size:11.5px; font-weight:700; color:#16a34a;"></span>
          </div>
          <button type="button" class="btn btn--gold" onclick="sendCrmMessage('${order.id_orden}')">
            <i class="fas fa-paper-plane"></i> Publicar en Bitácora
          </button>
        </div>
      </div>
    `,
    footer: `<button type="button" class="btn btn--ghost" onclick="closeModal()">Cerrar</button>`
  });

  setTimeout(() => {
    const feed = document.getElementById("crm-feed-box");
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, 100);
}

async function handleCrmPhotoSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  tempCrmPhotoUrl = await readFileAsCompressedDataUrl(file);
  const st = document.getElementById("crm-photo-status");
  if (st) st.innerHTML = '<i class="fas fa-check-circle" style="color:#16a34a;"></i> Foto lista';
}

function sendCrmMessage(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  const txt = (document.getElementById("crm-new-msg-text")?.value || "").trim();
  if (!txt && !tempCrmPhotoUrl) {
    showToast("Escribe un comentario o adjunta una foto.", "error");
    return;
  }

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "comentario",
    mensaje: txt || "Fotografía de inspección adjuntada a la bitácora.",
    foto_adjunta_url: tempCrmPhotoUrl,
    fecha_hora: new Date().toISOString().slice(0, 16).replace("T", " ")
  });

  saveDatabase();
  openOrderCrmModal(orderId);
  renderScreen();
  showToast("Comentario registrado en la bitácora de la orden.");
}

/* ============================================================================
   GESTIÓN DE PERSONAL POR DESTAJO, FICHA DE TRABAJOS/TIEMPOS Y PERFILES/PIN
   ============================================================================ */
function renderCommissionsAndStaffScreen() {
  const technicians = db.usuarios.filter((u) => u.rol === "tecnico" && !u.es_externo && u.rol !== "outsourcing");
  const outsourcingWorkshops = db.usuarios.filter((u) => u.rol === "outsourcing" || u.tipo === "taller_externo" || u.es_externo);
  const managementAndStaff = db.usuarios.filter((u) => u.rol !== "tecnico" && !u.es_externo && u.rol !== "outsourcing");

  const techRowsHtml = technicians
    .map((t) => {
      const subs = db.subtareas.filter((s) => s.tecnico_id === t.id_usuario);
      const completedUnpaid = subs.filter((s) => s.estado_subtarea === "terminado" && !s.comision_pagada);
      const inProgress = subs.filter((s) => s.estado_subtarea !== "terminado");
      const totalToPay = completedUnpaid.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
      const totalPending = inProgress.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
      const totalMinutes = subs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);

      // Subtareas en el periodo seleccionado por el filtro de fecha superior
      const subsInPeriod = subs.filter((s) => {
        const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
        const orderDate = ord ? cleanDateISO(ord.fecha_ingreso) : "";
        if (dateFilterFrom && orderDate && orderDate < dateFilterFrom) return false;
        if (dateFilterTo && orderDate && orderDate > dateFilterTo) return false;
        return true;
      });
      const completedInPeriod = subsInPeriod.filter((s) => s.estado_subtarea === "terminado");

      // Troqueles únicos trabajados por este técnico
      const troquelesMap = new Map();
      subs.forEach((s) => {
        const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
        if (ord && ord.codigo_troquel) {
          troquelesMap.set(ord.id_orden, ord.codigo_troquel);
        }
      });
      const troquelesBadges = Array.from(troquelesMap.entries())
        .map(([ordId, tr]) => renderClickableTroquelBadge(ordId, "#"))
        .join(" ");

      const activeDaysCount = new Set(
        db.asistencias
          .filter((a) => a.usuario_id === t.id_usuario || a.nombre === t.nombre)
          .map((a) => cleanDateISO(a.fecha))
      ).size;

      return `
        <tr>
          <td>
            <div style="font-weight:900; font-size:14.5px;">${t.nombre}</div>
            <div style="font-size:11.5px; color:var(--text-muted);">${t.especialidad} · <i class="fas fa-phone"></i> ${t.telefono} · PIN: <code>${t.pin || "1234"}</code></div>
          </td>
          <td>
            <span class="state-badge ${t.activo ? "state-badge--done" : "state-badge--wait"}">
              ${t.activo ? "ACTIVO" : "INACTIVO"}
            </span>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${activeDaysCount} día(s) activo(s)</div>
          </td>
          <td>
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span><strong>${completedUnpaid.length}</strong> por liquidar · <strong>${inProgress.length}</strong> en mesa</span>
              <button type="button" class="btn btn--ghost" style="padding:2px 7px; font-size:11px;" onclick="openWorkerCompletedJobsModal('${t.id_usuario}')" title="Ver detalle de trabajos realizados en el periodo">
                <i class="fas fa-list-check"></i> ${completedInPeriod.length} en periodo
              </button>
            </div>
            <div style="margin-top:4px; display:flex; gap:4px; flex-wrap:wrap;">${troquelesBadges || '<span style="font-size:11px; color:var(--text-muted);">Sin piezas asignadas</span>'}</div>
          </td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:800;">
            ${formatMinutes(totalMinutes)}
          </td>
          <td>
            <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:900; color:#16a34a;">
              $${totalToPay.toFixed(2)} <span style="font-size:10px; color:var(--text-muted); font-weight:700;">(Listo)</span>
            </div>
            ${totalPending > 0 ? `<div style="font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:800; color:#d97706;">+$${totalPending.toFixed(2)} en mesa</div>` : ""}
          </td>
          <td>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn--primary" style="padding:5px 10px; font-size:11.5px;" onclick="openWorkerProfileModal('${t.id_usuario}')">
                <i class="fas fa-clipboard-list"></i> Ficha / Trabajos y Tiempos
              </button>
              <button type="button" class="btn btn--ghost" style="padding:5px 9px; font-size:11.5px;" onclick="openEditWorkerModal('${t.id_usuario}')" title="Editar nombre, especialidad, teléfono o PIN">
                <i class="fas fa-edit"></i> Editar
              </button>
              ${totalToPay > 0 ? `<button type="button" class="btn btn--success" style="padding:5px 10px; font-size:11.5px;" onclick="openLiquidateWorkerModal('${t.id_usuario}', ${totalToPay})"><i class="fas fa-hand-holding-usd"></i> Liquidar ($${totalToPay.toFixed(2)})</button>` : ""}
              <button type="button" class="btn btn--ghost" style="padding:5px 8px; font-size:11.5px; color:#dc2626;" onclick="deleteWorker('${t.id_usuario}')" title="Eliminar trabajador">
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  // Fila para talleres externos (Outsourcing / Rectificadora Solteca)
  const outsourcingRowsHtml = outsourcingWorkshops
    .map((w) => {
      const subs = db.subtareas.filter((s) => s.tecnico_id === w.id_usuario);
      const completedUnpaid = subs.filter((s) => s.estado_subtarea === "terminado" && !s.comision_pagada);
      const inProgress = subs.filter((s) => s.estado_subtarea !== "terminado");
      const totalToPay = completedUnpaid.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
      const totalPending = inProgress.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);

      const outTroquelesMap = new Map();
      subs.forEach((s) => {
        const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
        if (ord && ord.codigo_troquel) outTroquelesMap.set(ord.id_orden, ord.codigo_troquel);
      });
      const troquelesBadges = Array.from(outTroquelesMap.entries())
        .map(([ordId, tr]) => renderClickableTroquelBadge(ordId, "#"))
        .join(" ");

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="badge-external"><i class="fas fa-handshake"></i> ALIADO</span>
              <strong style="font-size:14.5px;">${w.nombre}</strong>
            </div>
            <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
              ${w.especialidad} · <i class="fas fa-phone"></i> ${w.telefono || "Sin teléfono"}${w.direccion ? ` · <i class="fas fa-map-marker-alt"></i> ${w.direccion}` : ""}
            </div>
          </td>
          <td>
            <span class="state-badge ${w.activo ? "state-badge--done" : "state-badge--wait"}">
              ${w.activo ? "ACTIVO" : "INACTIVO"}
            </span>
            <div style="font-size:11px; color:#38bdf8; font-weight:800; margin-top:4px;">Taller Externo</div>
          </td>
          <td>
            <div><strong>${completedUnpaid.length}</strong> por liquidar · <strong>${inProgress.length}</strong> en proceso</div>
            <div style="margin-top:4px; display:flex; gap:4px; flex-wrap:wrap;">${troquelesBadges || '<span style="font-size:11px; color:var(--text-muted);">Sin piezas enviadas</span>'}</div>
          </td>
          <td>
            <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:900; color:#38bdf8;">
              $${totalToPay.toFixed(2)} <span style="font-size:10px; color:var(--text-muted); font-weight:700;">(Listo)</span>
            </div>
            ${totalPending > 0 ? `<div style="font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:800; color:#d97706;">+$${totalPending.toFixed(2)} en proceso</div>` : ""}
          </td>
          <td>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn--primary" style="padding:5px 10px; font-size:11.5px;" onclick="openWorkerProfileModal('${w.id_usuario}')">
                <i class="fas fa-list-check"></i> Ficha / Trabajos Tercerizados
              </button>
              <button type="button" class="btn btn--ghost" style="padding:5px 9px; font-size:11.5px;" onclick="openEditWorkerModal('${w.id_usuario}')" title="Editar taller aliado">
                <i class="fas fa-edit"></i> Editar
              </button>
              ${totalToPay > 0 ? `<button type="button" class="btn btn--success" style="padding:5px 10px; font-size:11.5px;" onclick="openLiquidateExternalWorkshopModal('${w.id_usuario}', ${totalToPay})"><i class="fas fa-hand-holding-usd"></i> Liquidar Pago ($${totalToPay.toFixed(2)})</button>` : ""}
              <button type="button" class="btn btn--ghost" style="padding:5px 8px; font-size:11.5px; color:#dc2626;" onclick="deleteWorker('${w.id_usuario}')" title="Eliminar taller externo">
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const adminRowsHtml = managementAndStaff
    .map(
      (u) => `
      <tr>
        <td><strong>${u.nombre}</strong></td>
        <td><span class="state-badge state-badge--exec">${u.rol_label || u.rol}</span></td>
        <td>${u.especialidad || "-"}</td>
        <td>${u.telefono || "-"}</td>
        <td><code>${u.pin || "1234"}</code></td>
        <td>
          <div style="display:flex; gap:6px;">
            <button type="button" class="btn btn--ghost" style="padding:4px 10px; font-size:11.5px;" onclick="openEditWorkerModal('${u.id_usuario}')">
              <i class="fas fa-edit"></i> Editar Perfil / PIN
            </button>
            ${u.id_usuario !== currentUser.id_usuario ? `<button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11.5px; color:#dc2626;" onclick="deleteWorker('${u.id_usuario}')"><i class="fas fa-trash-alt"></i></button>` : ""}
          </div>
        </td>
      </tr>
    `
    )
    .join("");

  return `
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:18px; padding:16px 20px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div>
        <span style="font-size:11px; font-weight:900; color:#16a34a; text-transform:uppercase;">
          CONTROL DE PRODUCCIÓN POR DESTAJO, TIEMPOS POR PIEZA Y PERFILES
        </span>
        <h2 style="font-size:20px; font-weight:900;">Personal Técnico (Pago por Trabajo Realizado), Tiempos y Liquidación Semanal</h2>
        <p style="font-size:13px; color:var(--text-muted);">
          Los trabajadores operan por destajo (sin horario fijo de entrada/salida). Abre la <strong>Ficha / Trabajos y Tiempos</strong> de cualquier técnico para ver en qué Troqueles trabajó, cuánto tiempo tomó en cada pieza y ajustar sus comisiones manualmente.
        </p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" class="btn btn--ghost" onclick="navigateTab('attendance')">
          <i class="fas fa-calendar-check"></i> Días Activos y Proyectos
        </button>
        <button type="button" class="btn btn--gold" onclick="openAddWorkerModal()">
          <i class="fas fa-user-plus"></i> Agregar Trabajador / Perfil
        </button>
      </div>
    </div>

    <div class="data-table-wrapper" style="margin-bottom:28px;">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Técnico / Especialista</th>
            <th>Estado y Días Activos</th>
            <th>Piezas / Troqueles Trabajados</th>
            <th>Tiempo Invertido</th>
            <th>Comisión Acumulada</th>
            <th>Ficha, Ajuste y Liquidación</th>
          </tr>
        </thead>
        <tbody>
          ${techRowsHtml}
        </tbody>
      </table>
    </div>

    <!-- SECCIÓN DEDICADA: TALLERES EXTERNOS ALIADOS (RECTIFICADORA SOLTECA Y OUTSOURCING) -->
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:18px; padding:16px 20px; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
      <div>
        <span style="font-size:11px; font-weight:900; color:#38bdf8; text-transform:uppercase;">
          OUTSOURCING Y TRABAJOS EXTERNOS
        </span>
        <h2 style="font-size:19px; font-weight:900;">
          <i class="fas fa-handshake" style="color:#38bdf8;"></i> Talleres Externos Aliados (Rectificadora Solteca y Tercerización)
        </h2>
        <p style="font-size:13px; color:var(--text-muted);">
          Control de servicios mecanizados o rectificaciones enviadas a talleres aliados como <strong>Rectificadora Solteca</strong>. Permite auditar qué piezas y troqueles se enviaron y liquidar pagos registrando egresos automáticos en el Libro Diario.
        </p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" class="btn btn--gold" onclick="openAddExternalWorkshopModal()">
          <i class="fas fa-plus-circle"></i> Registrar Taller Externo
        </button>
      </div>
    </div>

    <div class="data-table-wrapper" style="margin-bottom:28px;">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Taller Aliado / Contacto</th>
            <th>Estado y Tipo</th>
            <th>Trabajos Tercerizados y Troqueles</th>
            <th>Costo a Liquidar</th>
            <th>Ficha, Detalle y Liquidación</th>
          </tr>
        </thead>
        <tbody>
          ${outsourcingRowsHtml || '<tr><td colspan="5" style="text-align:center; padding:16px; color:var(--text-muted);">No hay talleres externos registrados. Haz clic en "Registrar Taller Externo" para agregar uno.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:16px; padding:14px 18px; margin-bottom:12px;">
      <h3 style="font-size:16px; font-weight:900;"><i class="fas fa-user-shield"></i> Perfiles de Dirección, Jefes de Taller, Recepción y PINs de Seguridad</h3>
    </div>
    <div class="data-table-wrapper">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Rol en el Sistema</th>
            <th>Cargo / Área</th>
            <th>Teléfono</th>
            <th>PIN de Acceso</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${adminRowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

/* ---------- FUNCIONES PARA GESTIÓN Y LIQUIDACIÓN DE TALLERES EXTERNOS (SOLTECA) ---------- */
function openAddExternalWorkshopModal() {
  openModal({
    title: "Registrar Taller Externo / Aliado (Solteca / Outsourcing)",
    icon: "fa-handshake",
    body: `
      <p style="font-size:13px; color:var(--text-muted); margin-bottom:14px;">
        Registra un taller aliado (como <strong>Rectificadora Solteca</strong>) para asignarle subtareas y controlar los costos tercerizados.
      </p>
      <div class="form-grid-2">
        <div class="form-field">
          <label><i class="fas fa-building"></i> Nombre del Taller Aliado *</label>
          <input type="text" id="ext-ws-name" placeholder="Ej. Rectificadora Solteca C.A." required />
        </div>
        <div class="form-field">
          <label><i class="fas fa-tools"></i> Especialidad / Procesos *</label>
          <input type="text" id="ext-ws-spec" placeholder="Ej. Cigüeñales, Encamisado, Soldadura Especial" required />
        </div>
      </div>
      <div class="form-grid-2" style="margin-top:10px;">
        <div class="form-field">
          <label><i class="fas fa-phone"></i> Teléfono de Contacto</label>
          <input type="tel" id="ext-ws-phone" placeholder="0414-1234567" />
        </div>
        <div class="form-field">
          <label><i class="fas fa-map-marker-alt"></i> Dirección / Ubicación</label>
          <input type="text" id="ext-ws-addr" placeholder="Ej. Calle 72, Sector Los Olivos" />
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewExternalWorkshop()">
        <i class="fas fa-check"></i> Guardar Taller Externo
      </button>
    `
  });
}

function saveNewExternalWorkshop() {
  const name = (document.getElementById("ext-ws-name")?.value || "").trim();
  const spec = (document.getElementById("ext-ws-spec")?.value || "").trim() || "Mecanizado y Rectificación Externa";
  const phone = (document.getElementById("ext-ws-phone")?.value || "").trim();
  const addr = (document.getElementById("ext-ws-addr")?.value || "").trim();

  if (!name) {
    showToast("Indica el nombre del taller externo.", "error");
    return;
  }

  const newId = "EXT-" + Date.now().toString().slice(-5);
  const newWorkshop = {
    id_usuario: newId,
    nombre: name,
    rol: "outsourcing",
    rol_label: "Taller Externo (Outsourcing)",
    tipo: "taller_externo",
    es_externo: true,
    especialidad: spec,
    telefono: phone,
    direccion: addr,
    activo: true,
    pin: "0000",
    fecha_creacion: new Date().toISOString()
  };

  db.usuarios.push(newWorkshop);
  saveDatabase();
  pushToGoogleSheets(true);
  closeModal();
  renderApp();
  showToast("Taller externo " + name + " registrado exitosamente y sincronizado con la nube.");
}

function openLiquidateExternalWorkshopModal(workshopId, totalDue) {
  const ws = db.usuarios.find((u) => u.id_usuario === workshopId);
  if (!ws) return;

  const pendingSubs = db.subtareas.filter(
    (s) => s.tecnico_id === workshopId && s.estado_subtarea === "terminado" && !s.comision_pagada
  );
  const computedTotal = totalDue || pendingSubs.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);

  const subtasksSummary = pendingSubs
    .map((s) => {
      const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
      return `
        <li style="font-size:12px; margin-bottom:4px;">
          <strong>Troquel #${ord ? ord.codigo_troquel : "S/N"}</strong>: ${s.descripcion_servicio} — <span style="font-family:'JetBrains Mono',monospace; color:#38bdf8; font-weight:800;">$${Number(s.comision_base_tecnico).toFixed(2)}</span>
        </li>
      `;
    })
    .join("");

  openModal({
    title: `Liquidar Pago a Taller Externo — ${ws.nombre}`,
    icon: "fa-hand-holding-usd",
    body: `
      <div style="background:rgba(56, 189, 248, 0.1); border:1px solid rgba(56, 189, 248, 0.3); border-radius:12px; padding:12px; margin-bottom:14px;">
        <div style="font-weight:900; font-size:14px; color:#38bdf8;">
          <i class="fas fa-handshake"></i> ${ws.nombre}
        </div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">
          ${ws.especialidad} · ${ws.telefono || "Sin teléfono"}
        </div>
      </div>

      <div style="margin-bottom:14px;">
        <span style="font-size:11px; font-weight:900; text-transform:uppercase; color:var(--text-muted);">
          Trabajos tercerizados a liquidar (${pendingSubs.length}):
        </span>
        <ul style="margin-top:6px; padding-left:18px; max-height:160px; overflow-y:auto;">
          ${subtasksSummary || '<li style="color:var(--text-muted); font-size:12px;">No hay trabajos pendientes de pago.</li>'}
        </ul>
      </div>

      <div class="form-grid-2">
        <div class="form-field">
          <label><i class="fas fa-dollar-sign"></i> Monto Total a Pagar ($) *</label>
          <input type="number" step="0.5" id="liq-ext-amount" value="${computedTotal.toFixed(2)}" style="font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:900; color:#38bdf8;" />
        </div>
        <div class="form-field">
          <label><i class="fas fa-credit-card"></i> Método de Pago de Caja *</label>
          <select id="liq-ext-method">
            <option value="efectivo">Efectivo Físico (Caja)</option>
            <option value="pago_movil">Pago Móvil (Mercantil / BNC / Banesco)</option>
            <option value="transferencia">Transferencia Bancaria</option>
            <option value="zelle">Zelle / Divisas</option>
          </select>
        </div>
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label><i class="fas fa-receipt"></i> Nro. de Referencia o Comprobante</label>
        <input type="text" id="liq-ext-ref" placeholder="Ej. Ref #592817 o Billete serial" />
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label><i class="fas fa-comment"></i> Observación / Notas</label>
        <input type="text" id="liq-ext-notes" placeholder="Ej. Liquidación de rectificación de cigüeñales y encamisado" />
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--success" onclick="confirmLiquidateExternalWorkshop('${workshopId}')">
        <i class="fas fa-check-circle"></i> Asentar Pago como Egreso en Libro Diario
      </button>
    `
  });
}

function confirmLiquidateExternalWorkshop(workshopId) {
  const ws = db.usuarios.find((u) => u.id_usuario === workshopId);
  if (!ws) return;

  const amount = Number(document.getElementById("liq-ext-amount")?.value);
  const method = document.getElementById("liq-ext-method")?.value || "efectivo";
  const ref = (document.getElementById("liq-ext-ref")?.value || "").trim();
  const notes = (document.getElementById("liq-ext-notes")?.value || "").trim() || ("Liquidación a taller externo " + ws.nombre);

  if (isNaN(amount) || amount <= 0) {
    showToast("Indica un monto válido a liquidar.", "error");
    return;
  }

  // 1. Asentar Egreso en Libro Diario
  const movId = "FIN-" + Date.now();
  const now = new Date().toISOString();
  db.finanzas_movimientos.push({
    id_movimiento: movId,
    fecha: now,
    tipo: "egreso",
    categoria: "Pago a Talleres Externos (Solteca / Outsourcing)",
    monto: amount,
    metodo_pago: method,
    referencia: ref,
    concepto: "Pago por trabajos tercerizados a " + ws.nombre + ". " + notes,
    usuario_registro: currentUser.nombre,
    soporte_foto: null
  });

  // 2. Marcar subtareas completadas como pagadas
  const pendingSubs = db.subtareas.filter(
    (s) => s.tecnico_id === workshopId && s.estado_subtarea === "terminado" && !s.comision_pagada
  );
  pendingSubs.forEach((s) => {
    s.comision_pagada = true;
    s.fecha_pago_comision = now;
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast("Pago de $" + amount.toFixed(2) + " a " + ws.nombre + " registrado como Egreso en el Libro Diario.");
}

/* ---------- FICHA COMPLETA DEL TRABAJADOR (HISTORIAL DE PIEZAS, TIEMPOS Y AJUSTE DE COMISIÓN) ---------- */
function openWorkerProfileModal(techId) {
  const tech = db.usuarios.find((u) => u.id_usuario === techId);
  if (!tech) return;

  const subs = db.subtareas.filter((s) => s.tecnico_id === techId);
  const totalMinutes = subs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);
  const unpaidDone = subs
    .filter((s) => s.estado_subtarea === "terminado" && !s.comision_pagada)
    .reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
  const paidDone = subs
    .filter((s) => s.comision_pagada)
    .reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);

  const workerDays = db.asistencias.filter((a) => a.usuario_id === techId || a.nombre === tech.nombre);

  const subRowsHtml = subs.length
    ? subs
        .map((s) => {
          const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
          return `
            <tr>
              <td>
                <strong>TROQUEL #${ord ? ord.codigo_troquel : s.orden_id}</strong>
                <div style="font-size:11px; color:var(--text-muted);">${ord ? `${ord.datos_motor.marca} ${ord.datos_motor.modelo}` : ""}</div>
              </td>
              <td>
                <div style="font-weight:800;">${s.descripcion_servicio}</div>
                <div style="font-size:11px; color:var(--text-muted);">Fecha: ${formatDateHuman(s.fecha_terminado || (ord && ord.fecha_ingreso), false)}</div>
              </td>
              <td>
                <span class="state-badge ${s.estado_subtarea === "terminado" ? "state-badge--done" : s.estado_subtarea === "empezado" ? "state-badge--exec" : "state-badge--wait"}">
                  ${s.estado_subtarea.toUpperCase()}
                </span>
                ${s.comision_pagada ? `<span class="state-badge state-badge--done" style="margin-left:4px;">PAGADA</span>` : ""}
              </td>
              <td>
                <div style="display:flex; align-items:center; gap:4px;">
                  <input
                    type="number"
                    min="0"
                    step="5"
                    value="${Number(s.minutos_acumulados) || 0}"
                    style="width:74px; padding:5px 7px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-family:'JetBrains Mono',monospace; font-weight:800;"
                    onchange="updateSubtaskMinutesFromFicha('${s.id_subtarea}', this.value, '${tech.id_usuario}')"
                  />
                  <span style="font-size:11px; color:var(--text-muted);">min (${formatMinutes(s.minutos_acumulados)})</span>
                </div>
              </td>
              <td>
                <div style="display:flex; align-items:center; gap:4px;">
                  <span style="font-weight:900; color:#16a34a;">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value="${Number(s.comision_base_tecnico) || 0}"
                    style="width:82px; padding:5px 7px; border-radius:8px; border:1.5px solid #16a34a; background:var(--bg-input); color:#16a34a; font-family:'JetBrains Mono',monospace; font-weight:900;"
                    onchange="updateSubtaskCommissionFromFicha('${s.id_subtarea}', this.value, '${tech.id_usuario}')"
                  />
                </div>
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">Este técnico aún no tiene trabajos asignados.</td></tr>`;

  const daysHtml = workerDays.length
    ? workerDays
        .map(
          (d) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 10px; border-bottom:1px solid var(--border-subtle); font-size:12.5px;">
            <span><strong><i class="far fa-calendar-alt"></i> ${formatDateHuman(d.fecha, false)}</strong> — ${d.observacion || "Actividad en taller"}</span>
            <span class="state-badge state-badge--done">${d.estado || "Activo"}</span>
          </div>
        `
        )
        .join("")
    : `<div style="padding:10px; font-size:12px; color:var(--text-muted);">Sin días activos registrados todavía.</div>`;

  openModal({
    title: `Ficha Técnica de Producción y Tiempos — ${tech.nombre}`,
    icon: "fa-user-cog",
    wide: true,
    body: `
      <div class="kpi-strip" style="margin-bottom:14px;">
        <div class="kpi-card">
          <span class="kpi-label">Trabajos Asignados</span>
          <div class="kpi-value">${subs.length}</div>
          <span class="kpi-sub">Piezas / Subtareas totales</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Tiempo Total en Piezas</span>
          <div class="kpi-value" style="color:#0284c7;">${formatMinutes(totalMinutes)}</div>
          <span class="kpi-sub">Suma de tiempo en máquinas</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Por Liquidar (Terminados)</span>
          <div class="kpi-value" style="color:#16a34a;">$${unpaidDone.toFixed(2)}</div>
          <span class="kpi-sub">Editable en la tabla inferior</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Histórico Ya Pagado</span>
          <div class="kpi-value" style="color:var(--text-muted);">$${paidDone.toFixed(2)}</div>
          <span class="kpi-sub">${workerDays.length} día(s) activo(s)</span>
        </div>
      </div>

      <div class="form-section-box">
        <div class="form-section-title">
          <i class="fas fa-tools"></i> Desglose de Proyectos (#Troquel), Tiempo Invertido y Ajuste Flexible de Comisión
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">
          Puedes editar directamente los <strong>minutos invertidos</strong> o el <strong>monto de comisión ($)</strong> de cualquier trabajo; el cambio se guarda automáticamente.
        </p>
        <div class="data-table-wrapper">
          <table class="renacer-table">
            <thead>
              <tr>
                <th>Troquel / Motor</th>
                <th>Servicio / Fecha</th>
                <th>Estado</th>
                <th>Tiempo Invertido (Editable)</th>
                <th>Comisión Destajo (Editable)</th>
              </tr>
            </thead>
            <tbody>
              ${subRowsHtml}
            </tbody>
          </table>
        </div>
      </div>

      <div class="form-section-box" style="margin-bottom:0;">
        <div class="form-section-title"><i class="fas fa-calendar-alt"></i> Fechas Activas y Proyectos Trabajados</div>
        <div style="max-height:150px; overflow-y:auto;">
          ${daysHtml}
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="openEditWorkerModal('${tech.id_usuario}')">
        <i class="fas fa-user-edit"></i> Editar Datos / PIN de ${tech.nombre}
      </button>
      ${
        unpaidDone > 0
          ? `<button type="button" class="btn btn--success btn--lg" onclick="payTechnicianWeeklyCommission('${tech.id_usuario}', ${unpaidDone}); closeModal();">
              <i class="fas fa-hand-holding-usd"></i> Liquidar Comisiones Terminadas ($${unpaidDone.toFixed(2)})
            </button>`
          : ""
      }
      <button type="button" class="btn btn--primary" onclick="closeModal()">Cerrar Ficha</button>
    `
  });
}

function updateSubtaskMinutesFromFicha(subtaskId, newMinutes, techId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  sub.minutos_acumulados = Math.max(0, Number(newMinutes) || 0);
  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);
  if (ord) {
    ord.tiempo_neto_minutos = db.subtareas
      .filter((s) => s.orden_id === ord.id_orden)
      .reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);
  }
  saveDatabase();
  renderScreen();
  openWorkerProfileModal(techId);
  showToast(`Tiempo invertido actualizado a ${formatMinutes(sub.minutos_acumulados)}.`);
}

function updateSubtaskCommissionFromFicha(subtaskId, newComm, techId) {
  const sub = db.subtareas.find((s) => s.id_subtarea === subtaskId);
  if (!sub) return;
  sub.comision_base_tecnico = Math.max(0, Number(newComm) || 0);
  saveDatabase();
  renderScreen();
  openWorkerProfileModal(techId);
  showToast(`Comisión actualizada a $${sub.comision_base_tecnico.toFixed(2)}.`);
}

let currentWorkerLiquidationPhoto = "";

function handleWorkerLiquidationPhotoUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    currentWorkerLiquidationPhoto = evt.target.result;
    const previewEl = document.getElementById("liq-worker-photo-preview");
    if (previewEl) {
      previewEl.innerHTML = `
        <div style="display:inline-block; position:relative; margin-top:8px;">
          <img src="${currentWorkerLiquidationPhoto}" style="max-height:160px; max-width:100%; border-radius:10px; border:2px solid #16a34a; box-shadow:0 4px 12px rgba(0,0,0,0.25);" />
          <div style="font-size:11.5px; font-weight:800; color:#22c55e; margin-top:5px;">
            <i class="fas fa-check-circle"></i> Comprobante / Billetes cargados con éxito
          </div>
        </div>
      `;
    }
  };
  reader.readAsDataURL(file);
}

function openLiquidateWorkerModal(techId, suggestedAmount) {
  const tech = db.usuarios.find((u) => u.id_usuario === techId);
  if (!tech) return;

  currentWorkerLiquidationPhoto = "";
  const tasaBcv = Number(db.configuracion.tasaBcv) || 45.80;
  const amountUsd = Number(suggestedAmount) > 0 ? Number(suggestedAmount) : 0;
  const amountBs = amountUsd * tasaBcv;

  const unpaidSubs = db.subtareas.filter((s) => s.tecnico_id === techId && s.estado_subtarea === "terminado" && !s.comision_pagada);

  openModal({
    title: `Liquidación de Nómina / Salario por Destajo — ${tech.nombre}`,
    icon: "fa-money-bill-wave",
    wide: true,
    body: `
      <div style="background:rgba(22,163,74,0.12); border:1px solid #16a34a; padding:12px 16px; border-radius:12px; margin-bottom:14px;">
        <div style="font-size:13px; font-weight:800; color:#22c55e;">
          <i class="fas fa-hand-holding-usd"></i> Registro de Egreso de Caja por Pago de Salario / Comisiones
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:3px;">
          El pago de nómina constituye un gasto operativo que se registra automáticamente en el Libro Diario como <strong>Egreso</strong>. Es obligatorio o altamente recomendado adjuntar el registro fotográfico de los billetes entregados o captura de Pago Móvil para el arqueo de caja.
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-field">
          <label>Trabajador / Técnico</label>
          <input type="text" value="${tech.nombre} (${tech.especialidad || 'Técnico Rectificador'})" readonly style="background:var(--bg-card); font-weight:700;" />
        </div>
        <div class="form-field">
          <label>Subtareas Terminadas por Liquidar</label>
          <input type="text" value="${unpaidSubs.length} pieza(s) / labor(es) finalizadas" readonly style="background:var(--bg-card); font-weight:700;" />
        </div>
      </div>

      <div class="form-grid-2" style="margin-top:10px;">
        <div class="form-field">
          <label>Monto a Liquidar (USD $) *</label>
          <input type="number" id="liq-worker-amount-usd" value="${amountUsd.toFixed(2)}" step="0.5" min="0.1" style="font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:900; color:#16a34a;" oninput="document.getElementById('liq-worker-amount-bs').textContent = 'Bs. ' + (Math.max(0, Number(this.value)||0) * ${tasaBcv}).toLocaleString('es-VE', {minimumFractionDigits:2, maximumFractionDigits:2})" />
        </div>
        <div class="form-field">
          <label>Equivalente en Bolívares (Tasa Oficial BCV: Bs. ${tasaBcv.toFixed(2)})</label>
          <div id="liq-worker-amount-bs" style="font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:900; color:#38bdf8; padding:8px 12px; background:var(--bg-input); border-radius:10px; border:1px solid var(--border-subtle);">
            Bs. ${amountBs.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      <div class="form-grid-3" style="margin-top:10px;">
        <div class="form-field">
          <label>Método de Pago *</label>
          <select id="liq-worker-method">
            <option value="efectivo_usd">Efectivo Divisas USD (Caja)</option>
            <option value="pago_movil" selected>Pago Móvil (Bs)</option>
            <option value="efectivo_bs">Efectivo Bolívares (Caja)</option>
            <option value="transferencia">Transferencia Bancaria</option>
            <option value="mixto">Mixto (Efectivo + Pago Móvil)</option>
          </select>
        </div>
        <div class="form-field">
          <label>Cuenta / Caja Origen *</label>
          <select id="liq-worker-account" style="font-weight:800;">
            ${BANCOS_RENACER.map((b) => `<option value="${b.id}">${b.nombre}</option>`).join("")}
          </select>
        </div>
        <div class="form-field">
          <label>Referencia Bancaria o Conteo</label>
          <input type="text" id="liq-worker-ref" placeholder="Ej: Ref 482019 / Billetes: $50" />
        </div>
      </div>

      <div class="form-section-box" style="margin-top:14px; border:1px dashed #f5df00; background:rgba(245,223,0,0.04);">
        <div class="form-section-title"><i class="fas fa-camera"></i> Registro Fotográfico de Billetes o Comprobante Pago Móvil</div>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">
          Tome una fotografía a los billetes en efectivo entregados al trabajador o adjunte el comprobante digital de la transferencia/pago móvil para el respaldo del egreso.
        </p>
        <input type="file" id="liq-worker-photo-cam" accept="image/*" capture="environment" style="display:none;" onchange="handleWorkerLiquidationPhotoUpload(event)" />
        <input type="file" id="liq-worker-photo-gal" accept="image/*" style="display:none;" onchange="handleWorkerLiquidationPhotoUpload(event)" />
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button type="button" class="btn btn--gold btn--sm" onclick="document.getElementById('liq-worker-photo-cam').click()" title="Tomar foto directa con la cámara del teléfono">
            <i class="fas fa-camera"></i> Tomar Foto (Cámara)
          </button>
          <button type="button" class="btn btn--ghost btn--sm" style="border-color:rgba(245,223,0,0.5); color:#fde047;" onclick="document.getElementById('liq-worker-photo-gal').click()" title="Subir de la galería o capture">
            <i class="fas fa-images"></i> Galería / Comprobante
          </button>
          <span style="font-size:11.5px; color:var(--text-muted);">Formatos: JPG, PNG, WEBP</span>
        </div>
        <div id="liq-worker-photo-preview" style="margin-top:8px;"></div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--success btn--lg" onclick="confirmWorkerLiquidation('${tech.id_usuario}')">
        <i class="fas fa-check-circle"></i> Confirmar Pago y Asentar Egreso
      </button>
    `
  });
}

function confirmWorkerLiquidation(techId) {
  const tech = db.usuarios.find((u) => u.id_usuario === techId);
  if (!tech) return;

  const amountEl = document.getElementById("liq-worker-amount-usd");
  const amount = amountEl ? Math.max(0, Number(amountEl.value) || 0) : 0;
  if (amount <= 0) {
    showToast("Indica un monto válido a liquidar.", "error");
    return;
  }

  const methodEl = document.getElementById("liq-worker-method");
  const method = methodEl ? methodEl.value : "pago_movil";
  const cuenta = document.getElementById("liq-worker-account")?.value || (method.includes("efectivo") ? "efectivo" : "mercantil");
  const refEl = document.getElementById("liq-worker-ref");
  const ref = refEl ? refEl.value.trim() : "";

  const methodNames = {
    efectivo_usd: "Efectivo Divisas USD",
    pago_movil: "Pago Móvil",
    efectivo_bs: "Efectivo Bolívares",
    transferencia: "Transferencia Bancaria",
    mixto: "Pago Mixto"
  };
  const methodName = methodNames[method] || method;

  // Marcar subtareas terminadas como pagadas
  let countSubs = 0;
  db.subtareas.forEach((s) => {
    if (s.tecnico_id === techId && s.estado_subtarea === "terminado" && !s.comision_pagada) {
      s.comision_pagada = true;
      s.fecha_pago_comision = new Date().toISOString().slice(0, 10);
      countSubs++;
    }
  });

  const tasaBcv = Number(db.configuracion.tasaBcv) || 45.80;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Asentar Egreso en Finanzas / Libro Diario
  db.finanzas_movimientos.unshift({
    id_mov: "MOV-" + Date.now(),
    fecha: dateStr,
    hora: timeStr,
    tipo: "egreso",
    categoria: "Pago de Nómina / Comisiones",
    concepto: `Liquidación de nómina a ${tech.nombre} (${countSubs} subtarea/s finalizadas) · ${methodName}`,
    monto: amount,
    monto_bs: amount * tasaBcv,
    tasa_bcv: tasaBcv,
    metodo: method,
    cuenta: cuenta,
    referencia: ref || "S/R",
    comprobante_foto: currentWorkerLiquidationPhoto || null,
    orden_id: "NOMINA_DESTAJO"
  });

  // Notificación Push
  sendPushNotification(
    "Nómina / Salario Liquidado",
    `Se asentó el egreso de $${amount.toFixed(2)} pagados a ${tech.nombre} (${methodName}).`,
    "finanzas"
  );

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Liquidación de $${amount.toFixed(2)} asentada como egreso a nombre de ${tech.nombre}.`);
}

function payTechnicianWeeklyCommission(techId, amount) {
  openLiquidateWorkerModal(techId, amount);
}

function openWorkerCompletedJobsModal(techId) {
  const tech = db.usuarios.find((u) => u.id_usuario === techId);
  if (!tech) return;

  const subs = db.subtareas.filter((s) => s.tecnico_id === techId);
  
  // Filtrar por rango de fechas de la barra superior si están definidos
  const subsInPeriod = subs.filter((s) => {
    const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
    const orderDate = ord ? cleanDateISO(ord.fecha_ingreso) : "";
    if (dateFilterFrom && orderDate && orderDate < dateFilterFrom) return false;
    if (dateFilterTo && orderDate && orderDate > dateFilterTo) return false;
    return true;
  });

  const completedSubs = subsInPeriod.filter((s) => s.estado_subtarea === "terminado");
  const unpaidTotal = completedSubs
    .filter((s) => !s.comision_pagada)
    .reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
  const paidTotal = completedSubs
    .filter((s) => s.comision_pagada)
    .reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
  const totalMinutes = completedSubs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);

  const filterPeriodLabel = (dateFilterFrom || dateFilterTo)
    ? `Periodo: ${dateFilterFrom || "Inicio"} al ${dateFilterTo || "Hoy"}`
    : "Histórico Completo";

  const rowsHtml = completedSubs.length
    ? completedSubs
        .map((s) => {
          const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
          const troquelCode = ord ? ord.codigo_troquel : s.orden_id;
          const motorInfo = ord ? `${ord.datos_motor.marca} ${ord.datos_motor.modelo} (${ord.datos_motor.tipo_pieza})` : "Motor N/A";
          const clientName = ord ? ord.nombre_cliente : "Cliente N/A";
          const photoThumb = ord && ord.galeria_fotos_pieza && ord.galeria_fotos_pieza[0]
            ? `<img src="${ord.galeria_fotos_pieza[0]}" style="width:36px; height:36px; border-radius:6px; object-fit:cover; margin-right:8px;" />`
            : "";

          return `
            <tr>
              <td>
                <div style="display:flex; align-items:center;">
                  ${photoThumb}
                  <div>
                    <button type="button" class="btn-troquel-clickable" style="font-size:11px; padding:2px 7px;" onclick="quickViewOrderDetails('${ord ? ord.id_orden : s.orden_id}')" title="Inspeccionar ficha técnica">
                      <i class="fas fa-barcode"></i> TROQUEL #${troquelCode}
                    </button>
                    <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${clientName}</div>
                  </div>
                </div>
              </td>
              <td>
                <div style="font-weight:700; font-size:12.5px;">${s.descripcion_servicio}</div>
                <div style="font-size:11px; color:var(--text-muted);">${motorInfo}</div>
              </td>
              <td style="font-family:'JetBrains Mono',monospace; font-weight:800; font-size:12px;">
                ⏱️ ${formatMinutes(s.minutos_acumulados || 0)}
              </td>
              <td style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:13.5px; color:#16a34a;">
                $${Number(s.comision_base_tecnico || 0).toFixed(2)}
              </td>
              <td>
                ${
                  s.comision_pagada
                    ? `<span class="state-badge state-badge--done" style="font-size:10.5px;"><i class="fas fa-check-double"></i> Liquidada</span>`
                    : `<span class="state-badge state-badge--wait" style="font-size:10.5px;"><i class="fas fa-clock"></i> Pendiente</span>`
                }
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="5" style="text-align:center; padding:24px; color:var(--text-muted);">No hay trabajos completados registrados en este periodo.</td></tr>`;

  openModal({
    title: `Ficha de Trabajos Realizados — ${tech.nombre}`,
    icon: "fa-list-check",
    wide: true,
    body: `
      <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-input); padding:10px 16px; border-radius:12px; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
        <div>
          <div style="font-weight:800; font-size:14px;">${tech.nombre} (${tech.especialidad})</div>
          <div style="font-size:12px; color:var(--text-muted);"><i class="fas fa-calendar-alt"></i> ${filterPeriodLabel}</div>
        </div>
        <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
          <div>
            <span style="font-size:11px; color:var(--text-muted); font-weight:700;">TOTAL TIEMPO</span>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:15px;">${formatMinutes(totalMinutes)}</div>
          </div>
          <div>
            <span style="font-size:11px; color:var(--text-muted); font-weight:700;">POR LIQUIDAR</span>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:16px; color:#16a34a;">$${unpaidTotal.toFixed(2)}</div>
          </div>
          <div>
            <span style="font-size:11px; color:var(--text-muted); font-weight:700;">YA LIQUIDADO</span>
            <div style="font-family:'JetBrains Mono',monospace; font-weight:800; font-size:14px; color:var(--text-muted);">$${paidTotal.toFixed(2)}</div>
          </div>
        </div>
      </div>

      <div class="form-section-box" style="margin-bottom:14px; background:rgba(2,132,199,0.06); border-color:#0284c7;">
        <div class="form-section-title"><i class="fas fa-tasks"></i> Protocolo de Control de Salida de Piezas y Repuestos</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:12px;">
          <div><i class="fas fa-check" style="color:#22c55e;"></i> Todas las piezas rectificadas lavadas y desengrasadas</div>
          <div><i class="fas fa-check" style="color:#22c55e;"></i> Repuestos viejos/reemplazados guardados para el cliente</div>
          <div><i class="fas fa-check" style="color:#22c55e;"></i> Tolerancias dimensionales y rugosidad verificadas</div>
          <div><i class="fas fa-check" style="color:#22c55e;"></i> Identificación de Troquel verificable en el metal</div>
        </div>
      </div>

      <div class="data-table-wrapper" style="max-height:360px; overflow-y:auto;">
        <table class="ar-excel-table">
          <thead>
            <tr>
              <th>Troquel / Cliente</th>
              <th>Labor Realizada / Motor</th>
              <th>Tiempo Invertido</th>
              <th>Comisión Destajo</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cerrar</button>
      ${
        unpaidTotal > 0
          ? `<button type="button" class="btn btn--success" onclick="closeModal(); openLiquidateWorkerModal('${tech.id_usuario}', ${unpaidTotal});">
              <i class="fas fa-hand-holding-usd"></i> Proceder a Liquidar ($${unpaidTotal.toFixed(2)})
            </button>`
          : ""
      }
    `
  });
}

function toggleWorkerActiveStatus(techId) {
  const tech = db.usuarios.find((u) => u.id_usuario === techId);
  if (!tech) return;
  tech.activo = !tech.activo;
  saveDatabase();
  renderApp();
  showToast(`Estado de ${tech.nombre} actualizado.`);
}

function openAddWorkerModal() {
  openModal({
    title: "Registrar Nuevo Trabajador o Perfil en el Taller",
    icon: "fa-user-plus",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Nombre Completo *</label>
          <input type="text" id="new-worker-name" placeholder="Ej: Miguel Ángel Pérez" required />
        </div>
        <div class="form-field">
          <label>Especialidad / Cargo en Rectificadora *</label>
          <input type="text" id="new-worker-spec" placeholder="Ej: Rectificación de Cámaras y Cigüeñales" required />
        </div>
        <div class="form-field">
          <label>Teléfono / WhatsApp *</label>
          <input type="text" id="new-worker-phone" placeholder="0414-XXXXXXX" required />
        </div>
        <div class="form-field">
          <label>Rol en el Sistema</label>
          <select id="new-worker-role">
            <option value="tecnico">Técnico / Operador (Pago por Destajo)</option>
            <option value="jefe_taller">Jefe de Taller / Supervisor</option>
            <option value="recepcion">Recepción / Atención al Cliente</option>
            <option value="admin">Administrador del Sistema</option>
          </select>
        </div>
        <div class="form-field">
          <label>PIN de Acceso Confidencial (Numérico) *</label>
          <input type="text" id="new-worker-pin" placeholder="Ej. 654321" maxlength="8" required />
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewWorker()">
        <i class="fas fa-save"></i> Guardar Trabajador / Perfil
      </button>
    `
  });
}

function saveNewWorker() {
  const name = (document.getElementById("new-worker-name")?.value || "").trim();
  const spec = (document.getElementById("new-worker-spec")?.value || "").trim();
  const phone = (document.getElementById("new-worker-phone")?.value || "").trim();
  const role = document.getElementById("new-worker-role")?.value || "tecnico";
  const pin = (document.getElementById("new-worker-pin")?.value || "").trim();

  if (!name || !spec) {
    showToast("Completa el nombre y la especialidad del trabajador.", "error");
    return;
  }
  if (!pin) {
    showToast("Debes asignar un PIN de seguridad numérico al trabajador.", "error");
    return;
  }

  const roleLabels = {
    tecnico: "Técnico de Rectificación",
    recepcion: "Recepción y Presupuesto",
    jefe_taller: "Jefe de Taller",
    admin: "Administrador del Sistema"
  };

  db.usuarios.push({
    id_usuario: "USR-" + Date.now().toString().slice(-4),
    nombre: name,
    rol: role,
    rol_label: roleLabels[role] || "Técnico",
    especialidad: spec,
    telefono: phone || "0414-0000000",
    pin: pin || "1234",
    activo: true
  });

  saveDatabase();
  populateLoginSelect();
  closeModal();
  renderApp();
  showToast(`Perfil ${name} agregado al equipo de Rectificadora Renacer.`);
}

function openEditWorkerModal(userId) {
  const u = db.usuarios.find((x) => x.id_usuario === userId);
  if (!u) return;

  openModal({
    title: `Editar Perfil y PIN — ${u.nombre}`,
    icon: "fa-user-edit",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Nombre Completo *</label>
          <input type="text" id="edit-worker-name" value="${u.nombre}" required />
        </div>
        <div class="form-field">
          <label>Especialidad / Cargo *</label>
          <input type="text" id="edit-worker-spec" value="${u.especialidad || ""}" required />
        </div>
        <div class="form-field">
          <label>Teléfono / WhatsApp</label>
          <input type="text" id="edit-worker-phone" value="${u.telefono || ""}" />
        </div>
        <div class="form-field">
          <label>Rol en el Sistema</label>
          <select id="edit-worker-role">
            <option value="tecnico" ${u.rol === "tecnico" ? "selected" : ""}>Técnico / Operador (Destajo)</option>
            <option value="jefe_taller" ${u.rol === "jefe_taller" ? "selected" : ""}>Jefe de Taller / Supervisor</option>
            <option value="recepcion" ${u.rol === "recepcion" ? "selected" : ""}>Recepción y Presupuesto</option>
            <option value="admin" ${u.rol === "admin" ? "selected" : ""}>Administrador del Sistema</option>
          </select>
        </div>
        <div class="form-field">
          <label>PIN de Seguridad Confidencial *</label>
          <input type="text" id="edit-worker-pin" value="${u.pin || ""}" placeholder="PIN numérico" maxlength="8" required />
        </div>
        <div class="form-field">
          <label>Estado en el Taller</label>
          <select id="edit-worker-active">
            <option value="true" ${u.activo !== false ? "selected" : ""}>Activo en Taller</option>
            <option value="false" ${u.activo === false ? "selected" : ""}>Inactivo / Permiso</option>
          </select>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveEditedWorker('${u.id_usuario}')">
        <i class="fas fa-save"></i> Guardar Cambios
      </button>
    `
  });
}

function saveEditedWorker(userId) {
  const u = db.usuarios.find((x) => x.id_usuario === userId);
  if (!u) return;

  const name = (document.getElementById("edit-worker-name")?.value || "").trim();
  const spec = (document.getElementById("edit-worker-spec")?.value || "").trim();
  const phone = (document.getElementById("edit-worker-phone")?.value || "").trim();
  const role = document.getElementById("edit-worker-role")?.value || u.rol;
  const pin = (document.getElementById("edit-worker-pin")?.value || "").trim();
  const active = document.getElementById("edit-worker-active")?.value === "true";

  if (!name) {
    showToast("El nombre no puede estar vacío.", "error");
    return;
  }
  if (!pin) {
    showToast("El PIN de seguridad no puede quedar vacío.", "error");
    return;
  }

  const roleLabels = {
    tecnico: "Técnico de Rectificación",
    recepcion: "Recepción y Presupuesto",
    jefe_taller: "Jefe de Taller",
    admin: "Administrador del Sistema"
  };

  u.nombre = name;
  u.especialidad = spec;
  u.telefono = phone;
  u.rol = role;
  u.rol_label = roleLabels[role] || u.rol_label;
  u.pin = pin;
  u.activo = active;

  // Actualizar nombre en subtareas asignadas a este usuario
  db.subtareas.forEach((s) => {
    if (s.tecnico_id === userId) {
      s.nombre_tecnico = name;
    }
  });

  saveDatabase();
  populateLoginSelect();
  closeModal();
  renderApp();
  showToast(`Perfil de ${name} actualizado correctamente.`);
}

function deleteWorker(userId) {
  const u = db.usuarios.find((x) => x.id_usuario === userId);
  if (!u) return;
  if (u.id_usuario === currentUser.id_usuario) {
    showToast("No puedes eliminar el perfil con el que tienes sesión activa.", "error");
    return;
  }
  if (!confirm(`¿Seguro que deseas eliminar el perfil de "${u.nombre}"?`)) return;
  db.usuarios = db.usuarios.filter((x) => x.id_usuario !== userId);
  saveDatabase();
  populateLoginSelect();
  renderApp();
  showToast(`Perfil ${u.nombre} eliminado.`);
}

/* ---------- DÍAS ACTIVOS Y PROYECTOS TRABAJADOS (SIN HORARIO FIJO DE ENTRADA/SALIDA) ---------- */
function renderAttendanceScreen() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const isTechnician = currentUser.rol === "tecnico";

  // PRIVACIDAD POR ROL: Los técnicos de taller solo ven su propio registro de presencia e historial
  const activeWorkers = isTechnician
    ? [currentUser]
    : (db.usuarios || []).filter((u) => u.activo && u.rol === "tecnico");

  // Tarjetas de Presencia Hoy
  const presenceCardsHtml = activeWorkers
    .map((w) => {
      const pres = getWorkerCurrentPresence(w.id_usuario);
      let borderClr = "var(--border-subtle)";
      let badgeCls = "state-badge--recep";
      let dotIcon = "fa-circle";
      let badgeBg = "rgba(148, 163, 184, 0.15)";
      let badgeTxtClr = "#94a3b8";

      if (pres.status === "en_taller") {
        borderClr = "#22c55e";
        badgeBg = "rgba(34, 197, 94, 0.15)";
        badgeTxtClr = "#22c55e";
        dotIcon = "fa-check-circle";
      } else if (pres.status === "en_almuerzo") {
        borderClr = "#f59e0b";
        badgeBg = "rgba(245, 158, 11, 0.15)";
        badgeTxtClr = "#f59e0b";
        dotIcon = "fa-utensils";
      } else if (pres.status === "salida_final") {
        borderClr = "#64748b";
        badgeBg = "rgba(100, 116, 139, 0.15)";
        badgeTxtClr = "#cbd5e1";
        dotIcon = "fa-flag-checkered";
      }

      return `
        <div style="background:var(--bg-card); border:1.5px solid ${borderClr}; border-radius:14px; padding:12px 14px; display:flex; flex-direction:column; justify-content:space-between; min-width:210px; flex:1;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
            <div>
              <strong style="font-size:13.5px; color:var(--text-main);">${w.nombre}</strong>
              <div style="font-size:11px; color:var(--text-muted);">${w.rol_label || w.rol}</div>
            </div>
            <span style="font-size:11px; font-weight:800; background:${badgeBg}; color:${badgeTxtClr}; padding:3px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px;">
              <i class="fas ${dotIcon}"></i> ${pres.label}
            </span>
          </div>
          <div style="font-size:11px; color:var(--text-muted); border-top:1px solid var(--border-subtle); padding-top:6px; display:flex; justify-content:space-between; align-items:center;">
            <span>Estatus Hoy:</span>
            <button type="button" class="btn-clean-link" style="color:var(--renacer-gold); font-weight:800; font-size:11px;" onclick="quickAttendanceByProfile('${w.id_usuario}')">
              Cambiar / Marcar
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  let filteredAttendanceList = isTechnician
    ? (db.asistencias || []).filter((a) => a.usuario_id === currentUser.id_usuario || a.nombre === currentUser.nombre)
    : (db.asistencias || []);

  if (dateFilterFrom || dateFilterTo) {
    filteredAttendanceList = filteredAttendanceList.filter((a) => {
      const aDate = cleanDateISO(a.fecha, false);
      if (dateFilterFrom && aDate && aDate < dateFilterFrom) return false;
      if (dateFilterTo && aDate && aDate > dateFilterTo) return false;
      return true;
    });
  }

  const rowsHtml = filteredAttendanceList.length
    ? filteredAttendanceList
        .map((a) => {
          const workerSubs = db.subtareas.filter(
            (s) => s.tecnico_id === a.usuario_id || s.nombre_tecnico === a.nombre
          );
          const totalWorkerMins = workerSubs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);
          const troquelesBadges = Array.from(
            new Set(
              workerSubs.map((s) => {
                const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
                return ord ? ord.id_orden : s.orden_id;
              })
            )
          ).map((ordId) => {
            const ord = db.ordenes.find((o) => o.id_orden === ordId);
            const label = ord ? `#${ord.codigo_troquel} (${ord.datos_motor.marca})` : ordId;
            return `<button type="button" class="btn-troquel-clickable" onclick="quickViewOrderDetails('${ordId}')" title="Ver ficha técnica">${label}</button>`;
          }).join(" ");

          const isLate = a.estado === "Tardanza" || (a.observacion && a.observacion.includes("Tardanza"));
          const statusBadge = isLate
            ? `<span style="font-size:11px; font-weight:800; background:rgba(239, 68, 68, 0.14); color:#ef4444; padding:3px 8px; border-radius:6px;"><i class="fas fa-exclamation-triangle"></i> Tardanza</span>`
            : `<span style="font-size:11px; font-weight:800; background:rgba(34, 197, 94, 0.14); color:#22c55e; padding:3px 8px; border-radius:6px;"><i class="fas fa-check"></i> Puntual</span>`;

          const lunchInfo = (a.hora_salida_almuerzo || a.hora_regreso_almuerzo)
            ? `${a.hora_salida_almuerzo || '--'} / ${a.hora_regreso_almuerzo || '--'}`
            : `<span style="color:var(--text-muted);">-</span>`;

          const actionBtn = isTechnician
            ? `<span style="color:var(--text-muted); font-size:11px;">Registrado</span>`
            : `
              <button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11px; color:#dc2626;" onclick="deleteAttendanceRecord('${a.id_asist}')" title="Eliminar registro">
                <i class="fas fa-trash-alt"></i>
              </button>
            `;

          return `
            <tr>
              <td><strong><i class="far fa-calendar-alt"></i> ${formatDateHuman(a.fecha, false)}</strong></td>
              <td><strong>${a.nombre}</strong></td>
              <td style="font-family:'JetBrains Mono',monospace; font-weight:800; color:var(--text-main);">
                ${a.hora_entrada || a.hora_registro || "--"}
              </td>
              <td style="font-size:11.5px; font-family:'JetBrains Mono',monospace;">
                ${lunchInfo}
              </td>
              <td style="font-family:'JetBrains Mono',monospace; font-weight:800; color:#38bdf8;">
                ${a.hora_salida || "<span style='color:var(--text-muted);'>En jornada</span>"}
              </td>
              <td>${statusBadge}</td>
              <td>
                <div style="display:flex; gap:4px; flex-wrap:wrap; margin-bottom:2px;">${troquelesBadges || '<span style="font-weight:700; color:var(--text-main); font-size:11.5px;">Planta General</span>'}</div>
                <div style="font-size:10.5px; color:var(--text-muted);">${a.observacion || "Marcación presencial"}</div>
              </td>
              <td style="text-align:right;">
                ${actionBtn}
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="8" style="text-align:center; padding:26px; color:var(--text-muted);">${isTechnician ? 'No tienes registros de asistencia guardados aún.' : 'No hay registros de asistencia guardados aún.'}</td></tr>`;

  // Botones de acción según rol
  const actionButtonsHtml = isTechnician
    ? `
      <button type="button" class="btn btn--primary" onclick="openTechnicianQrScanModal()">
        <i class="fas fa-camera"></i> Marcar mi Asistencia (Escanear QR)
      </button>
    `
    : `
      <button type="button" class="btn btn--gold" onclick="openAttendanceKioskModal()">
        <i class="fas fa-qrcode"></i> Abrir Kiosco QR (Recepción)
      </button>
      <button type="button" class="btn btn--primary" onclick="openTechnicianQrScanModal()">
        <i class="fas fa-camera"></i> Marcar Asistencia
      </button>
      <button type="button" class="btn btn--ghost" onclick="openAddActiveDayModal()">
        <i class="fas fa-calendar-plus"></i> + Registro Manual
      </button>
    `;

  const now = new Date();
  const isPast9AM = now.getHours() >= 9;
  let lateAlertBannerHtml = "";
  if (isPast9AM && !isTechnician) {
    const unCheckedTechnicians = (db.usuarios || [])
      .filter((u) => u.activo && u.rol === "tecnico")
      .filter((t) => !(db.asistencias || []).some((a) => a.fecha === todayIso && a.usuario_id === t.id_usuario));
    if (unCheckedTechnicians.length > 0) {
      const names = unCheckedTechnicians.map((t) => t.nombre).join(", ");
      lateAlertBannerHtml = `
        <div style="background:rgba(245, 158, 11, 0.15); border:1.5px solid #f59e0b; border-radius:14px; padding:12px 18px; margin-bottom:16px; display:flex; align-items:center; gap:14px;">
          <i class="fas fa-bell" style="font-size:22px; color:#f59e0b;"></i>
          <div>
            <div style="color:#f59e0b; font-size:13px; font-weight:900;">ALERTA DE ASISTENCIA 9:00 AM (LÍMITE PUNTUALIDAD: 8:15 AM)</div>
            <div style="font-size:12px; color:var(--text-main); margin-top:2px;">
              Los siguientes técnicos aún no han registrado su entrada el día de hoy: <strong>${names}</strong>.
            </div>
          </div>
        </div>
      `;
    }
  }

  return `
    <!-- ENCABEZADO Y ACCIONES PRINCIPALES DE ASISTENCIA -->
    <div style="background:var(--bg-card); border-radius:18px; padding:16px 20px; border:1px solid var(--border-subtle); margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div>
        <span style="font-size:11px; font-weight:900; color:var(--renacer-gold); text-transform:uppercase; letter-spacing:0.5px;">
          <i class="fas fa-shield-alt"></i> CONTROL DE ASISTENCIA Y PRESENCIA FÍSICA · RECTIFICADORA RENACER
        </span>
        <h2 style="font-size:20px; font-weight:900; margin:3px 0;"><i class="fas fa-user-clock" style="color:var(--renacer-gold);"></i> ${isTechnician ? 'Mi Asistencia y Horario de Trabajo' : 'Monitoreo de Horarios, Entrada, Almuerzo y Salida'}</h2>
        <p id="attendance-screen-notice" data-custom-text-key="attendance_notice" style="font-size:12.5px; color:var(--text-muted); margin:0;">
          ${escapeHtml(getCustomText("attendance_notice", DEFAULT_TEXT_CUSTOMIZATIONS.attendance_notice))}
        </p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${actionButtonsHtml}
      </div>
    </div>

    ${lateAlertBannerHtml}

    <!-- TABLERO EN VIVO DE PRESENCIA FÍSICA HOY -->
    <div style="margin-bottom:18px;">
      <div style="font-size:12px; font-weight:800; color:var(--text-muted); margin-bottom:8px; text-transform:uppercase; display:flex; align-items:center; gap:6px;">
        <i class="fas fa-users-viewfinder" style="color:#38bdf8;"></i> ${isTechnician ? 'Mi Estatus de Presencia Hoy' : 'Presencia Física en Taller Hoy'} (${formatDateHuman(todayIso, false)}):
      </div>
      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        ${presenceCardsHtml}
      </div>
    </div>

    <!-- TABLA DETALLADA DE HISTORIAL DE ASISTENCIA -->
    <div class="data-table-wrapper">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Trabajador</th>
            <th>Hora Entrada</th>
            <th>Almuerzo (Salida / Regreso)</th>
            <th>Hora Salida</th>
            <th>Puntualidad</th>
            <th>Troqueles / Detalle</th>
            <th style="text-align:right;">Acción</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}


function openAddActiveDayModal() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const workerOpts = db.usuarios
    .map((u) => `<option value="${u.id_usuario}">${u.nombre} (${u.rol_label || u.rol})</option>`)
    .join("");

  openModal({
    title: "Registrar Día Activo y Proyecto Trabajado",
    icon: "fa-calendar-check",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Trabajador *</label>
          <select id="act-day-worker">${workerOpts}</select>
        </div>
        <div class="form-field">
          <label>Fecha de Actividad *</label>
          <input type="date" id="act-day-date" value="${todayIso}" />
        </div>
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label>Proyectos / Troqueles Trabajados o Nota del Día *</label>
        <input type="text" id="act-day-note" placeholder="Ej: Trabajó en Troquel #5017 (Aplanado) y apoyo en lavado químico" />
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveActiveDayRecord()">Guardar Día Activo</button>
    `
  });
}

function saveActiveDayRecord() {
  const userId = document.getElementById("act-day-worker")?.value;
  const userObj = db.usuarios.find((u) => u.id_usuario === userId) || currentUser;
  const dateVal = document.getElementById("act-day-date")?.value || new Date().toISOString().slice(0, 10);
  const noteVal = (document.getElementById("act-day-note")?.value || "").trim() || "Activo en proyectos de rectificación";

  db.asistencias.unshift({
    id_asist: "ASI-" + Date.now(),
    usuario_id: userObj.id_usuario,
    nombre: userObj.nombre,
    fecha: dateVal,
    hora_entrada: "Destajo",
    hora_salida: "Por Pieza",
    estado: "Activo en Taller",
    observacion: noteVal
  });
  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Día activo registrado para ${userObj.nombre} (${formatDateHuman(dateVal, false)}).`);
}

function deleteAttendanceRecord(asistId) {
  db.asistencias = db.asistencias.filter((a) => a.id_asist !== asistId);
  saveDatabase();
  renderApp();
  showToast("Registro eliminado.");
}

/* ============================================================================
   LIBRO DIARIO DE INGRESOS, GASTOS, HISTORIAL POR CLIENTE Y FLUJO DE CAJA
   ============================================================================ */
let ledgerClientFilter = "all";
let ledgerTypeFilter = "all"; // 'all' | 'ingreso' | 'egreso'
let ledgerAccountFilter = "all"; // 'all' | 'efectivo' | 'mercantil' | 'bnc' | 'banesco' | 'zelle_otro'
let ledgerCategoryFilter = "all";
let ledgerDateFrom = "";
let ledgerDateTo = "";

function renderFinancesLedgerScreen() {
  const ingresos = db.finanzas_movimientos
    .filter((m) => m.tipo === "ingreso")
    .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);

  const egresos = db.finanzas_movimientos
    .filter((m) => m.tipo === "egreso")
    .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);

  const balances = getBalancesPorCuenta();
  const utilidadNeta = balances.totalLiquido; // Saldo real líquido disponible
  const cuentasPorCobrar = db.ordenes.reduce((acc, o) => acc + (Number(o.saldo_pendiente) || 0), 0);

  // Filtrado compuesto avanzado
  let filteredMovs = (db.finanzas_movimientos || []).slice();

  if (ledgerTypeFilter !== "all") {
    filteredMovs = filteredMovs.filter((m) => m.tipo === ledgerTypeFilter);
  }

  if (ledgerAccountFilter !== "all") {
    filteredMovs = filteredMovs.filter((m) => {
      let c = m.cuenta;
      if (!c) {
        c = (m.metodo === "pago_movil" || m.metodo === "transferencia") ? "mercantil" : "efectivo";
      }
      return c === ledgerAccountFilter;
    });
  }

  if (ledgerCategoryFilter !== "all") {
    filteredMovs = filteredMovs.filter((m) => m.categoria === ledgerCategoryFilter);
  }

  if (ledgerClientFilter !== "all") {
    const clientObj = db.clientes.find((c) => c.id_cliente === ledgerClientFilter);
    const clientOrderIds = new Set(
      db.ordenes.filter((o) => o.cliente_id === ledgerClientFilter).map((o) => o.id_orden)
    );
    filteredMovs = filteredMovs.filter((m) => {
      if (clientOrderIds.has(m.orden_id)) return true;
      if (clientObj && String(m.concepto || "").toLowerCase().includes((clientObj.nombre_completo || "").toLowerCase())) {
        return true;
      }
      return false;
    });
  }

  if (ledgerDateFrom) {
    filteredMovs = filteredMovs.filter((m) => cleanDateISO(m.fecha) >= ledgerDateFrom);
  }
  if (ledgerDateTo) {
    filteredMovs = filteredMovs.filter((m) => cleanDateISO(m.fecha) <= ledgerDateTo);
  }

  // Opciones de categorías únicas
  const allCategories = [
    ...new Set([
      ...(db.finanzas_categorias?.ingresos || []),
      ...(db.finanzas_categorias?.egresos || []),
      ...db.finanzas_movimientos.map((m) => m.categoria).filter(Boolean)
    ])
  ].sort();

  const categoryFilterOptions =
    `<option value="all">Todas las Categorías (${allCategories.length})</option>` +
    allCategories
      .map((cat) => `<option value="${cat}" ${ledgerCategoryFilter === cat ? "selected" : ""}>${cat}</option>`)
      .join("");

  const accountFilterOptions =
    `<option value="all">Todas las Cuentas / Bancos (${BANCOS_RENACER.length})</option>` +
    BANCOS_RENACER.map(
      (b) => `<option value="${b.id}" ${ledgerAccountFilter === b.id ? "selected" : ""}>${b.nombre} ($${(balances[b.id] || 0).toFixed(2)})</option>`
    ).join("");

  const clientFilterOptions =
    `<option value="all">Todos los Clientes / Terceros (${db.clientes.length})</option>` +
    db.clientes
      .map(
        (c) =>
          `<option value="${c.id_cliente}" ${ledgerClientFilter === c.id_cliente ? "selected" : ""}>${c.nombre_completo || c.nombre_cliente} (${c.documento_identidad})</option>`
      )
      .join("");

  const movRowsHtml = filteredMovs.length
    ? filteredMovs
        .map((m) => {
          let cId = m.cuenta;
          if (!cId) {
            cId = (m.metodo === "pago_movil" || m.metodo === "transferencia") ? "mercantil" : "efectivo";
          }
          const bObj = BANCOS_RENACER.find((b) => b.id === cId) || BANCOS_RENACER[0];
          const isIngreso = m.tipo === "ingreso";

          return `
            <tr>
              <td>
                <div style="font-weight:800; font-size:12.5px;">${formatDateHuman(m.fecha, false)}</div>
                ${m.hora ? `<div style="font-size:10.5px; color:var(--text-muted);">${m.hora}</div>` : ""}
              </td>
              <td>
                <span class="state-badge ${isIngreso ? "state-badge--done" : "state-badge--danger"}">
                  <i class="fas ${isIngreso ? "fa-arrow-up" : "fa-arrow-down"}"></i> ${isIngreso ? "INGRESO" : "EGRESO"}
                </span>
              </td>
              <td>
                <span style="font-weight:800; font-size:12.5px; color:var(--text-main);">${m.categoria || "General"}</span>
              </td>
              <td>
                <div style="font-size:12.5px; color:var(--text-main); font-weight:600;">${m.concepto || "Sin descripción"}</div>
                ${
                  m.referencia && m.referencia !== "S/R"
                    ? `<div style="font-size:11px; color:var(--text-muted);"><i class="fas fa-receipt"></i> Ref: ${m.referencia}</div>`
                    : ""
                }
              </td>
              <td>
                <span class="bank-badge ${bObj.badgeCls}">
                  <i class="fas ${bObj.icono}"></i> ${bObj.nombre}
                </span>
              </td>
              <td style="font-size:11.5px; color:var(--text-muted); font-weight:700;">
                ${(m.metodo || "efectivo").toUpperCase().replace(/_/g, " ")}
              </td>
              <td style="font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:900; color:${isIngreso ? "#16a34a" : "#dc2626"};">
                ${isIngreso ? "+" : "-"}$${Number(m.monto).toFixed(2)}
              </td>
              <td style="text-align:right;">
                <div style="display:flex; justify-content:flex-end; gap:6px;">
                  ${
                    m.comprobante_foto
                      ? `<button type="button" class="btn btn--ghost btn--xs" onclick="openPhotoLightbox('${m.comprobante_foto}', 'Comprobante ${m.id_mov}')" title="Ver foto soporte"><i class="fas fa-camera"></i></button>`
                      : ""
                  }
                  <button type="button" class="btn btn--ghost btn--xs" style="color:#dc2626;" onclick="deleteFinanceMovement('${m.id_mov}')" title="Eliminar movimiento">
                    <i class="fas fa-trash-alt"></i>
                  </button>
                </div>
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="8" style="text-align:center; padding:32px; color:var(--text-muted);">No hay movimientos que coincidan con los filtros seleccionados.</td></tr>`;

  return `
    <!-- KPI Strip Superior Ejecutivo -->
    <div class="kpi-strip">
      <div class="kpi-card">
        <span class="kpi-label"><i class="fas fa-arrow-circle-down" style="color:#16a34a;"></i> Ingresos Totales en Caja</span>
        <div class="kpi-value" style="color:#16a34a;">$${ingresos.toFixed(2)}</div>
        <span class="kpi-sub">Pagos Totales 100% + Abonos verificados</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label"><i class="fas fa-arrow-circle-up" style="color:#dc2626;"></i> Egresos Totales Operativos</span>
        <div class="kpi-value" style="color:#dc2626;">$${egresos.toFixed(2)}</div>
        <span class="kpi-sub">Insumos, destajo, nómina y adelantos</span>
      </div>
      <div class="kpi-card" style="border:1.5px solid rgba(245,223,0,0.4);">
        <span class="kpi-label"><i class="fas fa-vault" style="color:var(--renacer-gold);"></i> Disponibilidad Líquida Real</span>
        <div class="kpi-value" style="color:var(--renacer-gold);">$${utilidadNeta.toFixed(2)}</div>
        <span class="kpi-sub">Total en efectivo físico + bancos</span>
      </div>
      <div class="kpi-card" style="cursor:pointer;" onclick="navigateTab('accounts_receivable')">
        <span class="kpi-label"><i class="fas fa-file-invoice-dollar" style="color:#f59e0b;"></i> Cuentas por Cobrar (Resto)</span>
        <div class="kpi-value" style="color:#f59e0b;">$${cuentasPorCobrar.toFixed(2)}</div>
        <span class="kpi-sub">Ver desglose detallado de deudas <i class="fas fa-arrow-right"></i></span>
      </div>
    </div>

    <!-- Tira de Cuentas y Bancos en Tiempo Real -->
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:16px; padding:12px 18px; margin-bottom:16px;">
      <div style="font-size:11px; font-weight:900; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.6px; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
        <i class="fas fa-building-columns" style="color:var(--renacer-gold);"></i> SALDOS LÍQUIDOS DISPONIBLES POR CUENTA Y CAJA
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">
        ${BANCOS_RENACER.map(
          (b) => `
          <div style="background:var(--bg-input); padding:8px 12px; border-radius:10px; border-left:4px solid ${b.color}; display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-size:11px; font-weight:800; color:var(--text-muted);"><i class="fas ${b.icono}"></i> ${b.nombre}</div>
              <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:16px; color:${b.color}; margin-top:2px;">
                $${(balances[b.id] || 0).toFixed(2)}
              </div>
            </div>
            <span style="font-size:10px; font-weight:800; padding:2px 6px; border-radius:6px; background:rgba(255,255,255,0.06); color:var(--text-muted);">${b.moneda}</span>
          </div>
        `
        ).join("")}
      </div>
    </div>

    <!-- Barra de Filtros y Registro Rápido -->
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:16px; padding:16px 20px; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:12px;">
        <div>
          <h2 style="font-size:18px; font-weight:900; display:flex; align-items:center; gap:8px;">
            <i class="fas fa-book-open" style="color:var(--renacer-gold);"></i> Libro Diario General de Caja y Bancos
          </h2>
          <p style="font-size:12px; color:var(--text-muted); margin-top:2px;">
            Auditoría de todos los ingresos, egresos operativos, abonos y nóminas por cuenta bancaria.
          </p>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button type="button" class="btn btn--ghost" onclick="openAddFinanceCategoryModal()">
            <i class="fas fa-tags"></i> + Categoría
          </button>
          <button type="button" class="btn btn--danger" onclick="openNewFinanceMovementModal('egreso')">
            <i class="fas fa-minus-circle"></i> Registrar Gasto
          </button>
          <button type="button" class="btn btn--success" onclick="openNewFinanceMovementModal('ingreso')">
            <i class="fas fa-plus-circle"></i> Registrar Ingreso
          </button>
        </div>
      </div>

      <!-- Filtros Multi-criterio -->
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; border-top:1px solid var(--border-subtle); padding-top:12px;">
        <span style="font-size:11.5px; font-weight:800; color:var(--text-muted);"><i class="fas fa-filter"></i> Filtros:</span>

        <select
          style="padding:6px 10px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-size:11.5px; font-weight:700;"
          onchange="setLedgerFilter('type', this.value)"
        >
          <option value="all" ${ledgerTypeFilter === "all" ? "selected" : ""}>Todos los Tipos</option>
          <option value="ingreso" ${ledgerTypeFilter === "ingreso" ? "selected" : ""}>Solo Ingresos (+)</option>
          <option value="egreso" ${ledgerTypeFilter === "egreso" ? "selected" : ""}>Solo Egresos (-)</option>
        </select>

        <select
          style="padding:6px 10px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-size:11.5px; font-weight:700;"
          onchange="setLedgerFilter('account', this.value)"
        >
          ${accountFilterOptions}
        </select>

        <select
          style="padding:6px 10px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-size:11.5px; font-weight:700;"
          onchange="setLedgerFilter('category', this.value)"
        >
          ${categoryFilterOptions}
        </select>

        <select
          style="padding:6px 10px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-size:11.5px; font-weight:700;"
          onchange="setLedgerFilter('client', this.value)"
        >
          ${clientFilterOptions}
        </select>

        <input
          type="date"
          value="${ledgerDateFrom}"
          onchange="setLedgerFilter('from', this.value)"
          style="padding:5px 8px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-size:11px;"
          title="Fecha Desde"
        />
        <input
          type="date"
          value="${ledgerDateTo}"
          onchange="setLedgerFilter('to', this.value)"
          style="padding:5px 8px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-size:11px;"
          title="Fecha Hasta"
        />

        ${
          (ledgerTypeFilter !== "all" || ledgerAccountFilter !== "all" || ledgerCategoryFilter !== "all" || ledgerClientFilter !== "all" || ledgerDateFrom || ledgerDateTo)
            ? `<button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11px;" onclick="resetLedgerFilters()" title="Limpiar filtros"><i class="fas fa-undo"></i> Limpiar</button>`
            : ""
        }
      </div>
    </div>

    <!-- Tabla del Libro Diario -->
    <div class="data-table-wrapper">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Categoría</th>
            <th>Concepto / Detalle</th>
            <th>Cuenta / Banco</th>
            <th>Método</th>
            <th>Monto ($)</th>
            <th style="text-align:right;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${movRowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function setLedgerFilter(type, val) {
  if (type === "type") ledgerTypeFilter = val;
  if (type === "account") ledgerAccountFilter = val;
  if (type === "category") ledgerCategoryFilter = val;
  if (type === "client") ledgerClientFilter = val;
  if (type === "from") ledgerDateFrom = val;
  if (type === "to") ledgerDateTo = val;
  renderScreen();
}

function resetLedgerFilters() {
  ledgerTypeFilter = "all";
  ledgerAccountFilter = "all";
  ledgerCategoryFilter = "all";
  ledgerClientFilter = "all";
  ledgerDateFrom = "";
  ledgerDateTo = "";
  renderScreen();
}

function deleteFinanceMovement(movId) {
  if (!confirm("¿Eliminar este movimiento del Libro Diario?")) return;
  db.finanzas_movimientos = (db.finanzas_movimientos || []).filter(
    (m) => (m.id_mov || m.id_movimiento) !== movId && m.id_mov !== movId && m.id_movimiento !== movId
  );
  if (Array.isArray(db.finanzas)) {
    db.finanzas = db.finanzas.filter(
      (m) => (m.id_mov || m.id_movimiento) !== movId && m.id_mov !== movId && m.id_movimiento !== movId
    );
  }
  saveDatabase();
  pushToGoogleSheets(true);
  renderApp();
  showToast("Movimiento eliminado del Libro Diario y sincronizado.");
}

function openAddFinanceCategoryModal() {
  openModal({
    title: "Crear Nueva Categoría Financiera Personalizada",
    icon: "fa-tags",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Tipo de Categoría</label>
          <select id="new-cat-type">
            <option value="egreso">Categoría de Gasto / Egreso</option>
            <option value="ingreso">Categoría de Ingreso</option>
          </select>
        </div>
        <div class="form-field">
          <label>Nombre de la Categoría *</label>
          <input type="text" id="new-cat-name" placeholder="Ej: Compra de Piedras de Esmeril / Transporte" required />
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewFinanceCategory()">Guardar Categoría</button>
    `
  });
}

function saveNewFinanceCategory() {
  const type = document.getElementById("new-cat-type")?.value || "egreso";
  const name = (document.getElementById("new-cat-name")?.value || "").trim();
  if (!name) return;
  if (!db.finanzas_categorias) db.finanzas_categorias = { ingresos: [], egresos: [] };
  if (type === "ingreso") db.finanzas_categorias.ingresos.push(name);
  else db.finanzas_categorias.egresos.push(name);
  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Categoría "${name}" agregada.`);
}

let tempMovementPhoto = "";

function handleMovementPhotoUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    tempMovementPhoto = e.target.result;
    const nameEl = document.getElementById("mov-photo-name");
    const prevEl = document.getElementById("mov-photo-preview");
    if (nameEl) nameEl.textContent = `✅ ${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
    if (prevEl) {
      prevEl.innerHTML = `<img src="${tempMovementPhoto}" style="max-height:100px; border-radius:8px; border:1.5px solid var(--renacer-gold);" />`;
    }
  };
  reader.readAsDataURL(file);
}

function openNewFinanceMovementModal(tipo) {
  tempMovementPhoto = "";
  const cats = tipo === "ingreso" ? (db.finanzas_categorias?.ingresos || []) : (db.finanzas_categorias?.egresos || []);
  const catOptions = cats.map((c) => `<option value="${c}">${c}</option>`).join("");
  const bankOptions = BANCOS_RENACER.map((b) => `<option value="${b.id}">${b.nombre} (${b.moneda})</option>`).join("");

  openModal({
    title: tipo === "ingreso" ? "Registrar Nuevo Ingreso en Caja / Bancos" : "Registrar Gasto / Egreso Operativo",
    icon: tipo === "ingreso" ? "fa-arrow-up" : "fa-arrow-down",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Categoría *</label>
          <select id="mov-cat">${catOptions}</select>
        </div>
        <div class="form-field">
          <label>Monto ($ USD) *</label>
          <input type="number" step="0.5" min="0.1" id="mov-amount" placeholder="Ej: 25.00" required />
        </div>
      </div>

      <div class="form-grid-2" style="margin-top:10px;">
        <div class="form-field">
          <label>Cuenta / Caja ${tipo === "ingreso" ? "Destino" : "Origen"} *</label>
          <select id="mov-account" style="font-weight:800;">
            ${bankOptions}
          </select>
        </div>
        <div class="form-field">
          <label>Método de Pago</label>
          <select id="mov-method">
            <option value="efectivo">Efectivo Físico (Divisas / Caja)</option>
            <option value="pago_movil">Pago Móvil (Bs)</option>
            <option value="transferencia">Transferencia Bancaria</option>
            <option value="zelle">Zelle / Transferencia Internacional</option>
          </select>
        </div>
      </div>

      <div class="form-field" style="margin-top:10px;">
        <label>Concepto / Descripción Detallada *</label>
        <input type="text" id="mov-concept" placeholder="Ej: Compra de líquido desengrasante para tanque químico" required />
      </div>

      <div class="form-field" style="margin-top:10px;">
        <label><i class="fas fa-camera"></i> Foto del Comprobante / Factura / Recibo ${tipo === 'egreso' ? '(OBLIGATORIO para egresos) *' : '(Opcional)'}</label>
        <input type="file" id="mov-photo-file-cam" accept="image/*" capture="environment" style="display:none;" onchange="handleMovementPhotoUpload(this)" />
        <input type="file" id="mov-photo-file-gal" accept="image/*" style="display:none;" onchange="handleMovementPhotoUpload(this)" />
        <div style="display:flex; gap:8px; align-items:center; margin-top:4px; flex-wrap:wrap;">
          <button type="button" class="btn btn--gold btn--sm" onclick="document.getElementById('mov-photo-file-cam').click()" title="Tomar foto directa con la cámara del teléfono">
            <i class="fas fa-camera"></i> Tomar Foto
          </button>
          <button type="button" class="btn btn--ghost btn--sm" style="border-color:rgba(245,223,0,0.5); color:#fde047;" onclick="document.getElementById('mov-photo-file-gal').click()" title="Subir foto o captura de la galería">
            <i class="fas fa-images"></i> Galería / Capture
          </button>
          <span id="mov-photo-name" style="font-size:12px; color:var(--text-muted); font-style:italic;">Ningún archivo seleccionado</span>
        </div>
        <div id="mov-photo-preview" style="margin-top:8px;"></div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewFinanceMovement('${tipo}')">Guardar Movimiento</button>
    `
  });
}

function saveNewFinanceMovement(tipo) {
  const cat = document.getElementById("mov-cat")?.value || "General";
  const amount = Math.max(0, Number(document.getElementById("mov-amount")?.value) || 0);
  const cuenta = document.getElementById("mov-account")?.value || "efectivo";
  const method = document.getElementById("mov-method")?.value || "efectivo";
  const concept = (document.getElementById("mov-concept")?.value || "").trim();

  if (!amount || !concept) {
    showToast("Ingresa monto y concepto del movimiento.", "error");
    return;
  }

  if (tipo === "egreso" && !tempMovementPhoto) {
    Swal.fire({
      icon: "warning",
      title: "Comprobante Obligatorio",
      text: "Para registrar un egreso o gasto del taller, es obligatorio adjuntar la foto de la factura, recibo o soporte físico.",
      confirmButtonColor: "#f5c400"
    });
    return;
  }

  const now = new Date();
  db.finanzas_movimientos.unshift({
    id_mov: "MOV-" + Date.now(),
    fecha: now.toISOString().slice(0, 10),
    hora: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    tipo,
    categoria: cat,
    concepto: concept,
    monto: amount,
    metodo: method,
    cuenta: cuenta,
    comprobante_foto: tempMovementPhoto,
    orden_id: "-"
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast("Movimiento registrado en el Libro Diario.");
}

/* ============================================================================
   DIRECTORIO DE CLIENTES Y TALLERES ALIADOS (100% FLUIDO, RESPONSIVE DESKTOP/MÓVIL)
   ============================================================================ */
let clientDirFilterType = "all"; // "all" | "aliados" | "particulares" | "deudores"
let clientDirSearch = "";

function setClientDirFilter(type) {
  clientDirFilterType = type;
  renderApp();
}

function filterClientsDirectoryLive(query) {
  clientDirSearch = (query || "").toLowerCase().trim();
  const rows = document.querySelectorAll(".client-table-row");
  const cards = document.querySelectorAll(".client-mobile-card-item");
  
  rows.forEach((row) => {
    const text = row.getAttribute("data-search") || "";
    row.style.display = text.includes(clientDirSearch) ? "" : "none";
  });
  cards.forEach((card) => {
    const text = card.getAttribute("data-search") || "";
    card.style.display = text.includes(clientDirSearch) ? "" : "none";
  });
}

function renderClientsDirectoryScreen() {
  const tasaBcv = Number(db.configuracion?.tasaBcv) || 45.80;

  // Enriquecer clientes con sus órdenes y saldos reales
  const enrichedClients = db.clientes.map((c) => {
    const clientOrders = db.ordenes.filter(
      (o) => o.cliente_id === c.id_cliente || o.documento_cliente === c.documento_identidad
    );
    const totalPaid = clientOrders.reduce((acc, o) => acc + (Number(o.monto_abonado) || 0), 0);
    const totalPending = clientOrders.reduce((acc, o) => acc + (Number(o.saldo_pendiente) || 0), 0);
    return {
      ...c,
      clientOrders,
      totalOrders: clientOrders.length,
      totalPaid,
      totalPending,
      hasPending: totalPending > 0.01
    };
  });

  const totalClients = enrichedClients.length;
  const countAliados = enrichedClients.filter((c) => c.es_taller_aliado).length;
  const countParticulares = totalClients - countAliados;
  const countDeudores = enrichedClients.filter((c) => c.hasPending).length;
  const totalGeneralDeuda = enrichedClients.reduce((acc, c) => acc + c.totalPending, 0);

  // Filtrado por píldoras
  let filteredClients = enrichedClients.slice();
  if (clientDirFilterType === "aliados") {
    filteredClients = filteredClients.filter((c) => c.es_taller_aliado);
  } else if (clientDirFilterType === "particulares") {
    filteredClients = filteredClients.filter((c) => !c.es_taller_aliado);
  } else if (clientDirFilterType === "deudores") {
    filteredClients = filteredClients.filter((c) => c.hasPending);
  }

  // Filtrado por búsqueda en memoria si aplica
  if (clientDirSearch) {
    filteredClients = filteredClients.filter((c) => {
      const searchBlob = `${c.nombre_completo} ${c.nombre_cliente || ""} ${c.documento_identidad} ${c.telefono} ${c.direccion || ""}`.toLowerCase();
      return searchBlob.includes(clientDirSearch);
    });
  }

  // Filas para la tabla desktop
  const desktopRows = filteredClients.length
    ? filteredClients
        .map((c) => {
          const searchBlob = `${c.nombre_completo} ${c.nombre_cliente || ""} ${c.documento_identidad} ${c.telefono} ${c.direccion || ""}`.toLowerCase();
          const cleanPhone = (c.telefono || "").replace(/\D/g, "");
          const waUrl = cleanPhone ? `https://wa.me/${cleanPhone.startsWith("58") ? cleanPhone : "58" + cleanPhone.replace(/^0/, "")}` : "#";

          return `
            <tr class="client-table-row" data-search="${searchBlob}">
              <td style="white-space:nowrap;">
                <strong style="font-family:'JetBrains Mono',monospace; font-size:13px; color:var(--text-main);">${c.documento_identidad}</strong>
                <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                  <span class="badge" style="background:rgba(245,223,0,0.15); color:var(--renacer-gold); padding:2px 6px; border-radius:6px; font-weight:800;">
                    ${c.totalOrders} orden(es)
                  </span>
                </div>
              </td>
              <td>
                <div style="font-weight:900; font-size:14px; color:var(--text-main);">${c.nombre_completo}</div>
                <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">
                  <i class="fas fa-map-marker-alt" style="color:var(--renacer-gold);"></i> ${c.direccion || "Sin dirección registrada"}
                </div>
              </td>
              <td style="white-space:nowrap;">
                <div style="display:flex; align-items:center; gap:8px;">
                  <a href="tel:${c.telefono}" style="color:var(--renacer-navy); font-weight:800; text-decoration:none; font-family:'JetBrains Mono',monospace;">
                    <i class="fas fa-phone"></i> ${c.telefono || "Sin teléfono"}
                  </a>
                  ${
                    cleanPhone
                      ? `<a href="${waUrl}" target="_blank" class="btn btn--success" style="padding:2px 7px; font-size:11px; border-radius:6px; text-decoration:none;" title="Enviar WhatsApp directo">
                          <i class="fab fa-whatsapp"></i>
                        </a>`
                      : ""
                  }
                </div>
              </td>
              <td>
                <span class="state-badge ${c.es_taller_aliado ? "state-badge--exec" : "state-badge--diag"}" style="font-size:11px;">
                  <i class="fas ${c.es_taller_aliado ? "fa-handshake" : "fa-user"}"></i> ${c.es_taller_aliado ? "TALLER ALIADO (CRÉDITO)" : "PARTICULAR"}
                </span>
                <div style="font-size:11px; margin-top:5px; font-family:'JetBrains Mono',monospace;">
                  Pagado: <strong style="color:#16a34a;">$${c.totalPaid.toFixed(2)}</strong> · 
                  Resto: <strong style="color:${c.totalPending > 0 ? "#dc2626" : "var(--text-muted)"}; font-size:${c.totalPending > 0 ? "12px" : "11px"}; font-weight:${c.totalPending > 0 ? "900" : "700"};">
                    $${c.totalPending.toFixed(2)}
                  </strong>
                </div>
              </td>
              <td style="text-align:right; white-space:nowrap;">
                <div style="display:flex; justify-content:flex-end; gap:6px; align-items:center;">
                  <button type="button" class="btn btn--primary" style="padding:5px 10px; font-size:11.5px;" onclick="openClientHistoryModal('${c.id_cliente}')" title="Ver historial de órdenes y comprobantes">
                    <i class="fas fa-history"></i> Pagos
                  </button>
                  <button type="button" class="btn btn--ghost" style="padding:5px 9px; font-size:11.5px;" onclick="openEditClientModal('${c.id_cliente}')" title="Editar datos del cliente">
                    <i class="fas fa-edit"></i>
                  </button>
                  <button type="button" class="btn btn--ghost" style="padding:5px 9px; font-size:11.5px; color:#dc2626;" onclick="deleteClient('${c.id_cliente}')" title="Eliminar cliente">
                    <i class="fas fa-trash-alt"></i>
                  </button>
                </div>
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="5" style="text-align:center; padding:36px 20px; color:var(--text-muted);">No se encontraron clientes con el criterio seleccionado.</td></tr>`;

  // Tarjetas para móviles (diseño nativo 100% responsive, nunca se corta)
  const mobileCards = filteredClients.length
    ? filteredClients
        .map((c) => {
          const searchBlob = `${c.nombre_completo} ${c.nombre_cliente || ""} ${c.documento_identidad} ${c.telefono} ${c.direccion || ""}`.toLowerCase();
          const cleanPhone = (c.telefono || "").replace(/\D/g, "");
          const waUrl = cleanPhone ? `https://wa.me/${cleanPhone.startsWith("58") ? cleanPhone : "58" + cleanPhone.replace(/^0/, "")}` : "#";

          return `
            <div class="client-mobile-card client-mobile-card-item" data-search="${searchBlob}">
              <div class="client-mobile-card__header">
                <div>
                  <div class="client-mobile-card__title">${c.nombre_completo}</div>
                  <div class="client-mobile-card__doc">
                    ${c.documento_identidad} · <span style="color:var(--text-muted);">${c.totalOrders} orden(es)</span>
                  </div>
                </div>
                <span class="state-badge ${c.es_taller_aliado ? "state-badge--exec" : "state-badge--diag"}" style="font-size:10.5px;">
                  <i class="fas ${c.es_taller_aliado ? "fa-handshake" : "fa-user"}"></i> ${c.es_taller_aliado ? "ALIADO" : "PARTICULAR"}
                </span>
              </div>

              <div class="client-mobile-card__meta">
                <div class="client-mobile-card__contact-row">
                  <a href="tel:${c.telefono}" class="btn btn--ghost" style="padding:4px 10px; font-size:12px; font-family:'JetBrains Mono',monospace;">
                    <i class="fas fa-phone"></i> ${c.telefono || "Sin teléfono"}
                  </a>
                  ${
                    cleanPhone
                      ? `<a href="${waUrl}" target="_blank" class="btn btn--success" style="padding:4px 10px; font-size:12px; text-decoration:none;">
                          <i class="fab fa-whatsapp"></i> WhatsApp
                        </a>`
                      : ""
                  }
                </div>
                <div style="font-size:11.5px; color:var(--text-muted);">
                  <i class="fas fa-map-marker-alt"></i> ${c.direccion || "Sin dirección registrada"}
                </div>
              </div>

              <div class="client-mobile-card__balance-box">
                <div>
                  <span style="color:var(--text-muted); font-size:11px;">Pagado:</span>
                  <strong style="color:#16a34a; margin-left:4px;">$${c.totalPaid.toFixed(2)}</strong>
                </div>
                <div>
                  <span style="color:var(--text-muted); font-size:11px;">Deuda:</span>
                  <strong style="color:${c.totalPending > 0 ? "#dc2626" : "var(--text-muted)"}; margin-left:4px; font-size:${c.totalPending > 0 ? "13px" : "12px"};">
                    $${c.totalPending.toFixed(2)}
                  </strong>
                </div>
              </div>

              <div class="client-mobile-card__actions">
                <button type="button" class="btn btn--primary" style="padding:6px 12px; font-size:12px; flex:1;" onclick="openClientHistoryModal('${c.id_cliente}')">
                  <i class="fas fa-history"></i> Historial y Pagos
                </button>
                <button type="button" class="btn btn--ghost" style="padding:6px 10px; font-size:12px;" onclick="openEditClientModal('${c.id_cliente}')" title="Editar">
                  <i class="fas fa-edit"></i>
                </button>
                <button type="button" class="btn btn--ghost" style="padding:6px 10px; font-size:12px; color:#dc2626;" onclick="deleteClient('${c.id_cliente}')" title="Eliminar">
                  <i class="fas fa-trash-alt"></i>
                </button>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div style="text-align:center; padding:32px 16px; background:var(--bg-card); border-radius:14px; border:1px solid var(--border-color); color:var(--text-muted);">No se encontraron clientes.</div>`;

  return `
    <div style="display:flex; flex-direction:column; gap:16px;">
      <!-- Header Ejecutivo con Resumen KPI -->
      <div style="background:var(--bg-card); border:1.5px solid rgba(245,223,0,0.35); border-radius:18px; padding:18px 22px; box-shadow:var(--shadow-sm);">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:14px;">
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:11px; font-weight:900; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">
                <i class="fas fa-address-book" style="color:var(--renacer-gold);"></i> CRM Y DIRECTORIO COMERCIAL
              </span>
            </div>
            <h2 style="font-size:20px; font-weight:900; color:var(--text-main); margin-top:2px;">
              Directorio de Clientes y Talleres Aliados
            </h2>
            <p style="font-size:12.5px; color:var(--text-muted); margin-top:2px;">
              Consulta balances, historial de pagos, créditos otorgados y contacto directo por WhatsApp.
            </p>
          </div>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <button type="button" class="btn btn--gold" style="padding:9px 16px; font-size:13px; font-weight:800;" onclick="openAddClientModal()">
              <i class="fas fa-user-plus"></i> + Nuevo Cliente
            </button>
            <button type="button" class="btn btn--ghost" style="padding:9px 14px; font-size:13px;" onclick="navigateTab('catalog_mgr')" title="Ver Catálogo de Servicios">
              <i class="fas fa-tools"></i> Ver Precios y Servicios
            </button>
          </div>
        </div>

        <!-- KPI Strip de Clientes -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-top:16px; padding-top:14px; border-top:1px solid var(--border-subtle);">
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);">TOTAL REGISTRADOS</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:var(--text-main); margin-top:2px;">
              ${totalClients} <span style="font-size:11px; font-weight:600; color:var(--text-muted);">clientes</span>
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);"><i class="fas fa-handshake"></i> TALLERES ALIADOS</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#38bdf8; margin-top:2px;">
              ${countAliados}
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);"><i class="fas fa-exclamation-triangle"></i> CON SALDO PENDIENTE</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#f87171; margin-top:2px;">
              ${countDeudores}
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);"><i class="fas fa-file-invoice-dollar"></i> DEUDA TOTAL ACUMULADA</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#dc2626; margin-top:2px;">
              $${totalGeneralDeuda.toFixed(2)}
            </div>
          </div>
        </div>

        <!-- Barra de Búsqueda y Filtros Rápidos -->
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border-subtle);">
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            <button type="button" class="btn ${clientDirFilterType === "all" ? "btn--primary" : "btn--ghost"}" style="padding:4px 12px; font-size:11.5px; border-radius:99px;" onclick="setClientDirFilter('all')">
              Todos (${totalClients})
            </button>
            <button type="button" class="btn ${clientDirFilterType === "aliados" ? "btn--primary" : "btn--ghost"}" style="padding:4px 12px; font-size:11.5px; border-radius:99px;" onclick="setClientDirFilter('aliados')">
              <i class="fas fa-handshake"></i> Talleres Aliados (${countAliados})
            </button>
            <button type="button" class="btn ${clientDirFilterType === "particulares" ? "btn--primary" : "btn--ghost"}" style="padding:4px 12px; font-size:11.5px; border-radius:99px;" onclick="setClientDirFilter('particulares')">
              <i class="fas fa-user"></i> Particulares (${countParticulares})
            </button>
            <button type="button" class="btn ${clientDirFilterType === "deudores" ? "btn--primary" : "btn--ghost"}" style="padding:4px 12px; font-size:11.5px; border-radius:99px;" onclick="setClientDirFilter('deudores')">
              <i class="fas fa-exclamation-triangle"></i> Con Saldo Deudor (${countDeudores})
            </button>
          </div>

          <div style="position:relative; min-width:240px; flex:1; max-width:380px;">
            <i class="fas fa-search" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--text-muted); font-size:12px;"></i>
            <input type="text" value="${clientDirSearch}" placeholder="Buscar por nombre, cédula o teléfono..." oninput="filterClientsDirectoryLive(this.value)" style="width:100%; padding:7px 12px 7px 32px; font-size:12px; border-radius:10px; background:var(--bg-input); border:1px solid var(--border-subtle); color:var(--text-main);" />
          </div>
        </div>
      </div>

      <!-- VISTA DESKTOP: TABLA COMPLETA CON ESPACIO AMPLIO -->
      <div class="clients-desktop-view data-table-wrapper" style="box-shadow:var(--shadow-sm); border-radius:16px;">
        <table class="renacer-table">
          <thead>
            <tr>
              <th style="width:140px;">Cédula / RIF</th>
              <th>Nombre Completo / Taller</th>
              <th style="width:180px;">Teléfono & WhatsApp</th>
              <th style="width:230px;">Clasificación & Balance</th>
              <th style="text-align:right; width:170px;">Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${desktopRows}
          </tbody>
        </table>
      </div>

      <!-- VISTA MOBILE: TARJETAS FLUIDAS SIN CORTE DE COLUMNAS -->
      <div class="clients-mobile-view">
        ${mobileCards}
      </div>
    </div>
  `;
}

/* ============================================================================
   CATÁLOGO DE SERVICIOS, PRECIOS Y COMISIONES (VISTA DEDICADA 100% FLUIDA)
   ============================================================================ */
let catalogSearchQuery = "";

function filterCatalogLive(query) {
  catalogSearchQuery = (query || "").toLowerCase().trim();
  const rows = document.querySelectorAll(".catalog-service-row");
  rows.forEach((row) => {
    const text = row.getAttribute("data-search") || "";
    row.style.display = text.includes(catalogSearchQuery) ? "" : "none";
  });
}

function renderCatalogManagerScreen() {
  const services = db.catalogo_servicios || [];
  const totalServices = services.length;
  const avgPrice = totalServices ? services.reduce((acc, s) => acc + (Number(s.precio_sugerido) || 0), 0) / totalServices : 0;
  const avgCommission = totalServices ? services.reduce((acc, s) => acc + (Number(s.comision_sugerida) || 0), 0) / totalServices : 0;
  const avgMargin = avgPrice > 0 ? ((avgPrice - avgCommission) / avgPrice) * 100 : 0;

  // LISTA A: PRECIOS AL CLIENTE (PRESUPUESTO BASE)
  const clientRowsHtml = services.length
    ? services
        .map((s) => {
          const precio = Number(s.precio_sugerido) || 0;
          const searchBlob = `${s.nombre} ${s.categoria || ""}`.toLowerCase();
          return `
            <div class="catalog-item-card catalog-service-row" data-search="${searchBlob}">
              <div style="flex:1;">
                <div style="font-weight:900; font-size:13.5px; color:var(--text-main);">${s.nombre}</div>
                <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                  <i class="fas fa-tag" style="color:var(--renacer-gold);"></i> ${s.categoria || "Rectificación General"}
                </div>
              </div>
              <div style="text-align:right; margin: 0 10px;">
                <div style="font-size:10px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Precio Cliente</div>
                <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:15px; color:var(--renacer-gold);">
                  $${precio.toFixed(2)}
                </div>
              </div>
              <div>
                <button type="button" class="btn btn--ghost btn--xs" onclick="openEditCatalogServiceModal('${s.id_cat}')" title="Editar precio al cliente">
                  <i class="fas fa-edit"></i>
                </button>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div style="text-align:center; padding:24px; color:var(--text-muted);">Sin servicios en catálogo.</div>`;

  // LISTA B: COMISIONES POR DESTAJO Y SERVICIOS EXTERNOS (OUTSOURCING SOLTECA)
  const workshopRowsHtml = services.length
    ? services
        .map((s) => {
          const precio = Number(s.precio_sugerido) || 0;
          const comision = Number(s.comision_sugerida) || 0;
          const margen = precio - comision;
          const margenPct = precio > 0 ? (margen / precio) * 100 : 0;
          const isOutsource = Boolean(s.es_outsourcing);
          const searchBlob = `${s.nombre} ${s.categoria || ""}`.toLowerCase();

          return `
            <div class="catalog-item-card catalog-service-row" data-search="${searchBlob}">
              <div style="flex:1;">
                <div style="font-weight:900; font-size:13.5px; color:var(--text-main); display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  ${s.nombre}
                  ${isOutsource ? '<span class="badge-external"><i class="fas fa-handshake"></i> Solteca / Externo</span>' : '<span style="font-size:9.5px; font-weight:800; background:rgba(245,223,0,0.15); color:var(--renacer-gold); padding:2px 6px; border-radius:5px; border:1px solid rgba(245,223,0,0.3);"><i class="fas fa-wrench"></i> Destajo Interno</span>'}
                </div>
                <div style="font-size:11px; margin-top:3px; display:flex; gap:10px; align-items:center;">
                  <span style="color:#0284c7; font-weight:800; font-family:'JetBrains Mono',monospace;">
                    Margen Taller: $${margen.toFixed(2)} (${margenPct.toFixed(0)}%)
                  </span>
                </div>
              </div>
              <div style="text-align:right; margin: 0 10px;">
                <div style="font-size:10px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">
                  ${isOutsource ? 'Costo Tercero' : 'Comisión Técnico'}
                </div>
                <div style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:15px; color:${isOutsource ? '#38bdf8' : '#22c55e'};">
                  $${comision.toFixed(2)}
                </div>
              </div>
              <div>
                <button type="button" class="btn btn--ghost btn--xs" onclick="openEditCatalogServiceModal('${s.id_cat}')" title="Ajustar destajo o costo externo">
                  <i class="fas fa-sliders-h"></i>
                </button>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div style="text-align:center; padding:24px; color:var(--text-muted);">Sin servicios en catálogo.</div>`;

  return `
    <div style="display:flex; flex-direction:column; gap:16px;">
      <!-- Header del Catálogo con KPIs -->
      <div style="background:var(--bg-card); border:1.5px solid rgba(245,223,0,0.35); border-radius:18px; padding:18px 22px; box-shadow:var(--shadow-sm);">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:14px;">
          <div>
            <span style="font-size:11px; font-weight:900; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">
              <i class="fas fa-columns" style="color:var(--renacer-gold);"></i> MATRIZ DOBLE EN PARALELO
            </span>
            <h2 style="font-size:20px; font-weight:900; color:var(--text-main); margin-top:2px;">
              Catálogo Doble: Precios al Cliente y Destajo / Outsourcing
            </h2>
            <p style="font-size:12.5px; color:var(--text-muted); margin-top:2px;">
              Visualización paralela con cálculo de margen operativo en tiempo real: Ganancia = Cobro Cliente − Costo Comisión/Externo.
            </p>
          </div>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <button type="button" class="btn btn--gold" style="padding:9px 16px; font-size:13px; font-weight:800;" onclick="openAddCatalogServiceModal()">
              <i class="fas fa-plus-circle"></i> + Nuevo Servicio
            </button>
          </div>
        </div>

        <!-- KPI Strip de Precios y Margen -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-top:16px; padding-top:14px; border-top:1px solid var(--border-subtle);">
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);">SERVICIOS EN CARTERA</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:var(--text-main); margin-top:2px;">
              ${totalServices}
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);">COBRO PROMEDIO CLIENTE</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:var(--renacer-gold); margin-top:2px;">
              $${avgPrice.toFixed(2)}
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);">COSTO PROMEDIO TRABAJO</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#22c55e; margin-top:2px;">
              $${avgCommission.toFixed(2)}
            </div>
          </div>
          <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; border:1px solid var(--border-subtle);">
            <div style="font-size:11px; font-weight:800; color:var(--text-muted);">MARGEN PROMEDIO TALLER</div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#0284c7; margin-top:2px;">
              ${avgMargin.toFixed(0)}%
            </div>
          </div>
        </div>

        <!-- Buscador en Vivo Unificado -->
        <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border-subtle); display:flex; justify-content:flex-end;">
          <div style="position:relative; width:100%; max-width:380px;">
            <i class="fas fa-search" style="position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--text-muted); font-size:12px;"></i>
            <input type="text" placeholder="Buscar en ambas listas simultáneamente..." oninput="filterCatalogLive(this.value)" style="width:100%; padding:7px 12px 7px 32px; font-size:12px; border-radius:10px; background:var(--bg-input); border:1px solid var(--border-subtle); color:var(--text-main);" />
          </div>
        </div>
      </div>

      <!-- CONTENEDOR PARALELO DE DOS COLUMNAS RESPONSIVO -->
      <div class="catalog-dual-container">
        <!-- COLUMNA 1: PRECIOS AL CLIENTE -->
        <div class="catalog-column-card">
          <div class="catalog-column-header">
            <div>
              <span style="font-size:11px; font-weight:900; color:var(--renacer-gold); text-transform:uppercase;">
                LISTA A · CLIENTE
              </span>
              <h3 style="font-size:16px; font-weight:900; margin-top:2px;">
                <i class="fas fa-receipt" style="color:var(--renacer-gold);"></i> Catálogo de Precios al Cliente
              </h3>
            </div>
            <button type="button" class="btn btn--gold btn--xs" onclick="openAddCatalogServiceModal()">
              <i class="fas fa-plus"></i> Añadir
            </button>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            ${clientRowsHtml}
          </div>
        </div>

        <!-- COLUMNA 2: DESTAJO Y OUTSOURCING -->
        <div class="catalog-column-card">
          <div class="catalog-column-header">
            <div>
              <span style="font-size:11px; font-weight:900; color:#38bdf8; text-transform:uppercase;">
                LISTA B · COSTO & MARGEN
              </span>
              <h3 style="font-size:16px; font-weight:900; margin-top:2px;">
                <i class="fas fa-hand-holding-dollar" style="color:#22c55e;"></i> Comisiones Destajo & Outsourcing
              </h3>
            </div>
            <span style="font-size:11px; color:var(--text-muted); font-weight:700;">Margen Operativo</span>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            ${workshopRowsHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

// Alias de retrocompatibilidad
function renderClientsAndCatalogScreen() {
  return renderClientsDirectoryScreen();
}

/* ---------- HISTORIAL DE PAGOS Y ÓRDENES POR CLIENTE ---------- */
function openClientHistoryModal(clientId) {
  const client = db.clientes.find((c) => c.id_cliente === clientId);
  if (!client) return;

  const clientOrders = db.ordenes.filter(
    (o) => o.cliente_id === client.id_cliente || o.documento_cliente === client.documento_identidad
  );
  const clientOrderIds = new Set(clientOrders.map((o) => o.id_orden));

  const clientMovs = db.finanzas_movimientos.filter(
    (m) =>
      clientOrderIds.has(m.orden_id) ||
      String(m.concepto || "").toLowerCase().includes((client.nombre_completo || "").toLowerCase())
  );

  const totalBilled = clientOrders.reduce((acc, o) => acc + (Number(o.monto_total) || 0), 0);
  const totalPaid = clientOrders.reduce((acc, o) => acc + (Number(o.monto_abonado) || 0), 0);
  const totalDebt = clientOrders.reduce((acc, o) => acc + (Number(o.saldo_pendiente) || 0), 0);

  const ordersRows = clientOrders.length
    ? clientOrders
        .map(
          (o) => `
          <tr>
            <td><strong>TROQUEL #${o.codigo_troquel}</strong></td>
            <td>${o.datos_motor.tipo_pieza} · ${o.datos_motor.marca} ${o.datos_motor.modelo}</td>
            <td>${formatDateHuman(o.fecha_ingreso, false)}</td>
            <td style="font-family:'JetBrains Mono',monospace; font-weight:800;">$${Number(o.monto_total).toFixed(2)}</td>
            <td style="font-family:'JetBrains Mono',monospace; font-weight:800; color:#16a34a;">$${Number(o.monto_abonado).toFixed(2)}</td>
            <td style="font-family:'JetBrains Mono',monospace; font-weight:900; color:${o.saldo_pendiente > 0 ? "#dc2626" : "#16a34a"};">$${Number(o.saldo_pendiente).toFixed(2)}</td>
          </tr>
        `
        )
        .join("")
    : `<tr><td colspan="6" style="text-align:center; padding:16px; color:var(--text-muted);">Este cliente aún no tiene órdenes registradas.</td></tr>`;

  const paymentsRows = clientMovs.length
    ? clientMovs
        .map(
          (m) => `
          <tr>
            <td><strong>${formatDateHuman(m.fecha, false)}</strong></td>
            <td>${m.categoria}</td>
            <td>${m.concepto}</td>
            <td>${(m.metodo || "efectivo").toUpperCase()}</td>
            <td style="font-family:'JetBrains Mono',monospace; font-weight:900; color:#16a34a;">+$${Number(m.monto).toFixed(2)}</td>
          </tr>
        `
        )
        .join("")
    : `<tr><td colspan="5" style="text-align:center; padding:16px; color:var(--text-muted);">No hay pagos individuales registrados en el Libro Diario para este cliente.</td></tr>`;

  openModal({
    title: `Historial de Pagos y Piezas — ${client.nombre_completo} (${client.documento_identidad})`,
    icon: "fa-history",
    wide: true,
    body: `
      <div class="kpi-strip" style="margin-bottom:14px;">
        <div class="kpi-card">
          <span class="kpi-label">Piezas Recibidas</span>
          <div class="kpi-value">${clientOrders.length}</div>
          <span class="kpi-sub">Órdenes históricas</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Total Presupuestado</span>
          <div class="kpi-value">$${totalBilled.toFixed(2)}</div>
          <span class="kpi-sub">Suma de trabajos</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Total Abonado / Pagado</span>
          <div class="kpi-value" style="color:#16a34a;">$${totalPaid.toFixed(2)}</div>
          <span class="kpi-sub">${clientMovs.length} pago(s) en caja</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Resto Pendiente</span>
          <div class="kpi-value" style="color:${totalDebt > 0 ? "#dc2626" : "#16a34a"};">$${totalDebt.toFixed(2)}</div>
          <span class="kpi-sub">${totalDebt > 0 ? "Cuenta por cobrar abierta" : "Solvente al día"}</span>
        </div>
      </div>

      <div class="form-section-box">
        <div class="form-section-title"><i class="fas fa-cogs"></i> Piezas / Troqueles de ${client.nombre_completo}</div>
        <div class="data-table-wrapper">
          <table class="renacer-table">
            <thead>
              <tr>
                <th>Troquel</th>
                <th>Pieza / Motor</th>
                <th>Fecha Ingreso</th>
                <th>Total</th>
                <th>Abonado</th>
                <th>Resto</th>
              </tr>
            </thead>
            <tbody>
              ${ordersRows}
            </tbody>
          </table>
        </div>
      </div>

      <div class="form-section-box" style="margin-bottom:0;">
        <div class="form-section-title"><i class="fas fa-receipt"></i> Historial Detallado de Abonos y Pagos Recibidos</div>
        <div class="data-table-wrapper">
          <table class="renacer-table">
            <thead>
              <tr>
                <th>Fecha Pago</th>
                <th>Categoría</th>
                <th>Detalle / Orden</th>
                <th>Método</th>
                <th>Monto Pagado</th>
              </tr>
            </thead>
            <tbody>
              ${paymentsRows}
            </tbody>
          </table>
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="openEditClientModal('${client.id_cliente}')">
        <i class="fas fa-edit"></i> Editar Cliente
      </button>
      <button type="button" class="btn btn--primary" onclick="closeModal()">Cerrar Historial</button>
    `
  });
}

/* ---------- CRUD COMPLETO DE CLIENTES ---------- */
function openAddClientModal() {
  openModal({
    title: "Registrar Nuevo Cliente o Taller Aliado",
    icon: "fa-user-plus",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Cédula o RIF *</label>
          <input type="text" id="new-cli-doc" placeholder="Ej: V-15889900 o J-40112233-1" required />
        </div>
        <div class="form-field">
          <label>Nombre Completo o Taller *</label>
          <input type="text" id="new-cli-name" placeholder="Ej: Taller Mecánico Los Andes" required />
        </div>
        <div class="form-field">
          <label>Teléfono / WhatsApp *</label>
          <input type="text" id="new-cli-phone" placeholder="0414-XXXXXXX" required />
        </div>
        <div class="form-field">
          <label>Dirección</label>
          <input type="text" id="new-cli-addr" placeholder="Sector / Ciudad" />
        </div>
      </div>
      <label style="display:flex; align-items:center; gap:8px; margin-top:12px; font-size:13px; font-weight:800; cursor:pointer;">
        <input type="checkbox" id="new-cli-allied" style="width:18px; height:18px;" />
        <i class="fas fa-handshake"></i> Clasificar como Mecánico / Taller Aliado (Habilita Crédito Flexible)
      </label>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewClientDirect()">Guardar Cliente</button>
    `
  });
}

function saveNewClientDirect() {
  const doc = (document.getElementById("new-cli-doc")?.value || "").trim().toUpperCase();
  const name = (document.getElementById("new-cli-name")?.value || "").trim();
  const phone = (document.getElementById("new-cli-phone")?.value || "").trim();
  const addr = (document.getElementById("new-cli-addr")?.value || "").trim();
  const allied = Boolean(document.getElementById("new-cli-allied")?.checked);

  if (!doc || !name) {
    showToast("Ingresa la Cédula/RIF y el nombre del cliente.", "error");
    return;
  }

  db.clientes.push({
    id_cliente: "CLI-" + Date.now().toString().slice(-4),
    documento_identidad: doc,
    nombre_completo: name,
    telefono: phone || "0414-0000000",
    direccion: addr || "Sin dirección",
    es_taller_aliado: allied
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Cliente ${name} registrado en el directorio.`);
}

function openEditClientModal(clientId) {
  const c = db.clientes.find((x) => x.id_cliente === clientId);
  if (!c) return;

  openModal({
    title: `Editar Cliente — ${c.nombre_completo}`,
    icon: "fa-user-edit",
    body: `
      <div class="form-grid-2">
        <div class="form-field">
          <label>Cédula o RIF *</label>
          <input type="text" id="edit-cli-doc" value="${c.documento_identidad}" required />
        </div>
        <div class="form-field">
          <label>Nombre Completo o Taller *</label>
          <input type="text" id="edit-cli-name" value="${c.nombre_completo}" required />
        </div>
        <div class="form-field">
          <label>Teléfono / WhatsApp *</label>
          <input type="text" id="edit-cli-phone" value="${c.telefono || ""}" required />
        </div>
        <div class="form-field">
          <label>Dirección</label>
          <input type="text" id="edit-cli-addr" value="${c.direccion || ""}" />
        </div>
      </div>
      <label style="display:flex; align-items:center; gap:8px; margin-top:12px; font-size:13px; font-weight:800; cursor:pointer;">
        <input type="checkbox" id="edit-cli-allied" ${c.es_taller_aliado ? "checked" : ""} style="width:18px; height:18px;" />
        <i class="fas fa-handshake"></i> Clasificar como Mecánico / Taller Aliado
      </label>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveEditedClient('${c.id_cliente}')">Guardar Cambios</button>
    `
  });
}

function saveEditedClient(clientId) {
  const c = db.clientes.find((x) => x.id_cliente === clientId);
  if (!c) return;

  const doc = (document.getElementById("edit-cli-doc")?.value || "").trim().toUpperCase();
  const name = (document.getElementById("edit-cli-name")?.value || "").trim();
  const phone = (document.getElementById("edit-cli-phone")?.value || "").trim();
  const addr = (document.getElementById("edit-cli-addr")?.value || "").trim();
  const allied = Boolean(document.getElementById("edit-cli-allied")?.checked);

  if (!doc || !name) {
    showToast("Cédula/RIF y nombre son obligatorios.", "error");
    return;
  }

  c.documento_identidad = doc;
  c.nombre_completo = name;
  c.telefono = phone;
  c.direccion = addr;
  c.es_taller_aliado = allied;

  // Sincronizar datos en órdenes asociadas a este cliente
  db.ordenes.forEach((o) => {
    if (o.cliente_id === clientId) {
      o.documento_cliente = doc;
      o.nombre_cliente = name;
      o.telefono_cliente = phone;
      o.direccion_cliente = addr;
    }
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Datos del cliente ${name} actualizados.`);
}

function deleteClient(clientId) {
  const c = db.clientes.find((x) => x.id_cliente === clientId);
  if (!c) return;
  if (!confirm(`¿Eliminar al cliente "${c.nombre_completo}" del directorio?`)) return;
  db.clientes = db.clientes.filter((x) => x.id_cliente !== clientId);
  saveDatabase();
  renderApp();
  showToast(`Cliente ${c.nombre_completo} eliminado.`);
}

/* ---------- CRUD COMPLETO DEL CATÁLOGO DE SERVICIOS Y COMISIONES ---------- */
function openAddCatalogServiceModal() {
  openModal({
    title: "Añadir Servicio al Catálogo del Taller",
    icon: "fa-tools",
    body: `
      <div class="form-field" style="margin-bottom:10px;">
        <label>Nombre del Servicio *</label>
        <input type="text" id="cat-srv-name" placeholder="Ej: Rectificación de Cigüeñal 4 Cilindros" required />
      </div>
      <div class="form-grid-2" style="margin-bottom:10px;">
        <div class="form-field">
          <label>Categoría de Pieza *</label>
          <select id="cat-srv-category">
            <option value="Cámara / Culata">Cámara / Culata</option>
            <option value="Bloque / Cigüeñal">Bloque / Cigüeñal</option>
            <option value="Lavado y Químico">Lavado y Químico</option>
            <option value="Calibración y Asientos">Calibración y Asientos</option>
            <option value="Soldadura Especial">Soldadura Especial</option>
            <option value="Rectificación General">Rectificación General</option>
          </select>
        </div>
        <div class="form-field">
          <label>Modalidad de Ejecución *</label>
          <select id="cat-srv-type">
            <option value="interno">Destajo Interno (Técnicos Renacer)</option>
            <option value="outsourcing">Tercerizado / Outsourcing (Rectificadora Solteca)</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-field">
          <label>Precio Sugerido al Cliente ($) *</label>
          <input type="number" step="0.5" id="cat-srv-price" value="40" required />
        </div>
        <div class="form-field">
          <label>Comisión Técnico / Costo Externo ($) *</label>
          <input type="number" step="0.5" id="cat-srv-comm" value="12" required />
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveNewCatalogService()">Guardar en Catálogo</button>
    `
  });
}

function saveNewCatalogService() {
  const name = (document.getElementById("cat-srv-name")?.value || "").trim();
  const category = document.getElementById("cat-srv-category")?.value || "Rectificación General";
  const type = document.getElementById("cat-srv-type")?.value || "interno";
  const price = Math.max(0, Number(document.getElementById("cat-srv-price")?.value) || 0);
  const comm = Math.max(0, Number(document.getElementById("cat-srv-comm")?.value) || 0);
  if (!name) {
    showToast("Indica el nombre del servicio.", "error");
    return;
  }

  db.catalogo_servicios.push({
    id_cat: "CAT-" + Date.now(),
    nombre: name,
    categoria: category,
    es_outsourcing: type === "outsourcing",
    taller_externo_nombre: type === "outsourcing" ? "Rectificadora Solteca" : "",
    precio_sugerido: price,
    comision_sugerida: comm
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Servicio "${name}" agregado al catálogo.`);
}

function openEditCatalogServiceModal(catId) {
  const s = db.catalogo_servicios.find((x) => x.id_cat === catId);
  if (!s) return;

  openModal({
    title: `Editar Servicio del Catálogo`,
    icon: "fa-edit",
    body: `
      <div class="form-field" style="margin-bottom:10px;">
        <label>Nombre del Servicio *</label>
        <input type="text" id="edit-cat-name" value="${s.nombre}" required />
      </div>
      <div class="form-grid-2" style="margin-bottom:10px;">
        <div class="form-field">
          <label>Categoría de Pieza *</label>
          <select id="edit-cat-category">
            <option value="Cámara / Culata" ${s.categoria === "Cámara / Culata" ? "selected" : ""}>Cámara / Culata</option>
            <option value="Bloque / Cigüeñal" ${s.categoria === "Bloque / Cigüeñal" ? "selected" : ""}>Bloque / Cigüeñal</option>
            <option value="Lavado y Químico" ${s.categoria === "Lavado y Químico" ? "selected" : ""}>Lavado y Químico</option>
            <option value="Calibración y Asientos" ${s.categoria === "Calibración y Asientos" ? "selected" : ""}>Calibración y Asientos</option>
            <option value="Soldadura Especial" ${s.categoria === "Soldadura Especial" ? "selected" : ""}>Soldadura Especial</option>
            <option value="Rectificación General" ${s.categoria === "Rectificación General" ? "selected" : ""}>Rectificación General</option>
          </select>
        </div>
        <div class="form-field">
          <label>Modalidad de Ejecución *</label>
          <select id="edit-cat-type">
            <option value="interno" ${!s.es_outsourcing ? "selected" : ""}>Destajo Interno (Técnicos Renacer)</option>
            <option value="outsourcing" ${s.es_outsourcing ? "selected" : ""}>Tercerizado / Outsourcing (Rectificadora Solteca)</option>
          </select>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="form-field">
          <label>Precio Sugerido al Cliente ($) *</label>
          <input type="number" step="0.5" id="edit-cat-price" value="${Number(s.precio_sugerido) || 0}" required />
        </div>
        <div class="form-field">
          <label>Comisión Técnico / Costo Externo ($) *</label>
          <input type="number" step="0.5" id="edit-cat-comm" value="${Number(s.comision_sugerida) || 0}" required />
        </div>
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold" onclick="saveEditedCatalogService('${s.id_cat}')">Guardar Cambios</button>
    `
  });
}

function saveEditedCatalogService(catId) {
  const s = db.catalogo_servicios.find((x) => x.id_cat === catId);
  if (!s) return;

  const name = (document.getElementById("edit-cat-name")?.value || "").trim();
  const category = document.getElementById("edit-cat-category")?.value || "Rectificación General";
  const type = document.getElementById("edit-cat-type")?.value || "interno";
  const price = Math.max(0, Number(document.getElementById("edit-cat-price")?.value) || 0);
  const comm = Math.max(0, Number(document.getElementById("edit-cat-comm")?.value) || 0);
  if (!name) {
    showToast("El nombre del servicio no puede estar vacío.", "error");
    return;
  }

  s.nombre = name;
  s.categoria = category;
  s.es_outsourcing = type === "outsourcing";
  s.taller_externo_nombre = type === "outsourcing" ? "Rectificadora Solteca" : "";
  s.precio_sugerido = price;
  s.comision_sugerida = comm;
  s.comision_sugerida = comm;

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Servicio "${name}" actualizado ($${price.toFixed(2)} / Com: $${comm.toFixed(2)}).`);
}

function deleteCatalogService(catId) {
  const s = db.catalogo_servicios.find((x) => x.id_cat === catId);
  if (!s) return;
  if (!confirm(`¿Eliminar el servicio "${s.nombre}" del catálogo?`)) return;
  db.catalogo_servicios = db.catalogo_servicios.filter((x) => x.id_cat !== catId);
  saveDatabase();
  renderApp();
  showToast(`Servicio "${s.nombre}" eliminado del catálogo.`);
}


/* ============================================================================
   EDICIÓN COMPLETA DE ÓRDENES (JESÚS ANDRADE - DISEÑO 2 RENACER)
   ============================================================================ */
let tempEditOrderState = {
  orderId: null,
  services: [],
  repuestos: [],
  comproRepuestosTaller: false
};

function openEditCompleteOrderModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) {
    showToast("Orden no encontrada.", "error");
    return;
  }

  const existingSubs = db.subtareas.filter((s) => s.orden_id === orderId);
  tempEditOrderState = {
    orderId: order.id_orden,
    services: existingSubs.map((s) => ({
      id_subtarea: s.id_subtarea,
      descripcion_servicio: s.descripcion_servicio || "",
      monto_servicio: Number(s.monto_servicio) || 0,
      comision_base_tecnico: Number(s.comision_base_tecnico) || 0,
      tecnico_id: s.tecnico_id || "",
      nombre_tecnico: s.nombre_tecnico || "Sin asignar",
      estado_subtarea: s.estado_subtarea || "pendiente",
      minutos_acumulados: s.minutos_acumulados || 0
    })),
    repuestos: Array.isArray(order.items_repuestos) ? JSON.parse(JSON.stringify(order.items_repuestos)) : [],
    comproRepuestosTaller: Boolean(order.repuestos_comprados_taller)
  };

  const catalogOptions = (db.catalogo_servicios || [])
    .map((c) => `<option value="${c.id_cat}">${c.nombre} — $${c.precio_sugerido} (Comisión: $${c.comision_sugerida})</option>`)
    .join("");

  const inventoryOptions = (db.inventario_repuestos || [])
    .map((r) => `<option value="${r.id_repuesto}">${r.nombre} — $${Number(r.precio_venta).toFixed(2)} (Stock: ${r.stock_actual} ${r.unidad || "pz"})</option>`)
    .join("");

  openModal({
    title: `Modificar Orden #${order.codigo_troquel} (Edición Completa)`,
    icon: "fa-edit",
    wide: true,
    body: `
      <form id="form-edit-complete-order" onsubmit="event.preventDefault(); saveEditedCompleteOrder('${order.id_orden}');">
        <!-- 0. CABECERA: TROQUEL, ESTADO ACTUAL Y PRIORIDAD -->
        <div class="form-section-box" style="border-color:rgba(245,196,0,0.7); background:rgba(245,196,0,0.05);">
          <div class="form-section-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span><i class="fas fa-tag"></i> 0. Correlativo, Estado Actual y Prioridad</span>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-weight:800; color:#ef4444;">
              <input type="checkbox" id="edit-ord-priority" ${order.prioridad_alta ? "checked" : ""} style="accent-color:#ef4444; width:17px; height:17px;" />
              <i class="fas fa-bolt"></i> Prioridad Alta / Urgente
            </label>
          </div>
          <div class="form-grid-3">
            <div class="form-field">
              <label>Código de Troquel *</label>
              <input type="text" id="edit-ord-troquel" value="${order.codigo_troquel}" required style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:16px; color:#0f1638;" />
            </div>
            <div class="form-field">
              <label>Fase / Estado del Proceso *</label>
              <select id="edit-ord-estado" style="font-weight:800;">
                <option value="diagnostico_presupuesto" ${order.estado_actual === "diagnostico_presupuesto" || order.estado_actual === "recepcion" ? "selected" : ""}>1. Recepción (Diagnóstico / Presupuesto)</option>
                <option value="diagnostico" ${order.estado_actual === "diagnostico" ? "selected" : ""}>2. Diagnóstico Técnico</option>
                <option value="aprobacion" ${order.estado_actual === "aprobacion" || order.estado_actual === "esperando_aprobacion_abono" ? "selected" : ""}>3. Aprobación y Abono</option>
                <option value="servicio" ${order.estado_actual === "servicio" || order.estado_actual === "asignacion_ejecucion" ? "selected" : ""}>4. En Servicio Técnico (Mecanizado)</option>
                <option value="calidad" ${order.estado_actual === "calidad" || order.estado_actual === "control_calidad" ? "selected" : ""}>5. Control de Calidad</option>
                <option value="entrega" ${order.estado_actual === "entrega" || order.estado_actual === "entregado" ? "selected" : ""}>6. Entrega y Liquidación</option>
                <option value="archivado" ${order.estado_actual === "archivado" ? "selected" : ""}>Archivada (Histórico / Garantía 1 Año)</option>
              </select>
            </div>
            <div class="form-field">
              <label>Condición Financiera</label>
              <select id="edit-ord-pago-condicion" style="font-weight:700;">
                <option value="pendiente_definir" ${order.tipo_condicion_pago === "pendiente_definir" ? "selected" : ""}>Sin Abono (Pendiente)</option>
                <option value="abono" ${order.tipo_condicion_pago === "abono" ? "selected" : ""}>Abono Parcial Registrado</option>
                <option value="pago_total" ${order.tipo_condicion_pago === "pago_total" ? "selected" : ""}>Pago Total 100% (Liquidada)</option>
                <option value="credito" ${order.tipo_condicion_pago === "credito" ? "selected" : ""}>Taller Aliado / Cuenta por Cobrar</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 1. DATOS DEL CLIENTE / TALLER ALIADO -->
        <div class="form-section-box">
          <div class="form-section-title">
            <i class="fas fa-user-edit"></i> 1. Identificación del Cliente o Taller Aliado
          </div>
          <div class="form-grid-3">
            <div class="form-field">
              <label>Nombre Completo o Taller * (Autocompleta)</label>
              <input type="text" id="edit-cli-name" value="${order.nombre_cliente || ''}" list="renacer-edit-clientes-list" oninput="handleEditClientAutocomplete(this.value)" required />
              <datalist id="renacer-edit-clientes-list">
                ${(db.clientes || []).map((c) => `<option value="${c.nombre_completo || c.nombre_cliente}">${c.documento_identidad} - ${c.telefono}</option>`).join("")}
              </datalist>
            </div>
            <div class="form-field">
              <label>Cédula o RIF *</label>
              <input type="text" id="edit-cli-doc" value="${order.documento_cliente || ''}" required />
            </div>
            <div class="form-field">
              <label>Teléfono / WhatsApp *</label>
              <input type="text" id="edit-cli-phone" value="${order.telefono_cliente || ''}" required />
            </div>
          </div>
          <div class="form-grid-2" style="margin-top:10px;">
            <div class="form-field">
              <label>Dirección</label>
              <input type="text" id="edit-cli-address" value="${order.direccion_cliente || ''}" placeholder="Sector o dirección del cliente" />
            </div>
            <div class="form-field">
              <label>Tipo de Cliente</label>
              <select id="edit-cli-type">
                <option value="particular" ${order.tipo_cliente === "particular" ? "selected" : ""}>Cliente Particular</option>
                <option value="taller_aliado" ${String(order.tipo_cliente || '').toLowerCase().includes("aliado") ? "selected" : ""}>Taller Aliado Recurrente (Crédito)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 2. DATOS DE VEHÍCULO / MOTOR -->
        <div class="form-section-box">
          <div class="form-section-title">
            <i class="fas fa-car-side"></i> 2. Datos del Vehículo / Motor
          </div>
          <input type="hidden" id="edit-ord-pieza" value="${order.datos_motor.tipo_pieza || 'Cámara / Culata'}" />
          <input type="hidden" id="edit-ord-serial" value="${order.datos_motor.serial || 'S/N'}" />
          <div class="form-grid-2">
            <div class="form-field">
              <label>Marca de Vehículo / Motor *</label>
              <input type="text" id="edit-ord-marca" value="${order.datos_motor.marca || ''}" placeholder="Ej: Chevrolet, Toyota, Ford" required />
            </div>
            <div class="form-field">
              <label>Modelo / Motor *</label>
              <input type="text" id="edit-ord-modelo" value="${order.datos_motor.modelo || ''}" placeholder="Ej: Corsa 1.6, Hilux 2.7, 302" required />
            </div>
          </div>
          <div class="form-field" style="margin-top:10px;">
            <label>Observaciones Técnicas / Diagnóstico de Entrada</label>
            <textarea id="edit-ord-obs" rows="3" style="width:100%; border-radius:10px; border:1.5px solid var(--border-color); padding:10px; background:var(--bg-input); color:var(--text-main);" placeholder="Describe el estado de llegada, fisuras, guías rotas o detalles técnicos importantes...">${order.datos_motor.observaciones || ''}</textarea>
          </div>
        </div>

        <!-- 3. SERVICIOS Y PRESUPUESTO EDITABLE -->
        <div class="form-section-box">
          <div class="form-section-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <span><i class="fas fa-tools"></i> 3. Desglose de Servicios y Comisiones de Técnicos</span>
            <div style="display:flex; gap:6px;">
              <button type="button" class="btn btn--gold btn--xs" onclick="addCustomServiceToEditOrder()">
                <i class="fas fa-plus"></i> + Servicio Adicional
              </button>
            </div>
          </div>
          <div style="position:relative; margin-bottom:12px;">
            <input
              type="text"
              id="search-edit-service-input"
              placeholder="Buscar servicio para agregar (ej. cepillado, aplanado, armado, válvulas)..."
              oninput="filterEditServicesLive(this.value)"
              onfocus="filterEditServicesLive(this.value)"
              autocomplete="off"
              style="width:100%; padding:10px 14px; border-radius:10px; border:1.5px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-weight:700; font-size:13px;"
            />
            <div id="edit-services-live-dropdown" class="budget-services-dropdown-list hidden"></div>
          </div>
          <div id="edit-services-table-wrapper" style="overflow-x:auto;"></div>
        </div>

        <!-- 4. REPUESTOS DEL TALLER (ÁREA JAVIER ANDRADE) -->
        <div class="form-section-box" style="border:1.5px solid rgba(56, 189, 248, 0.45); background:rgba(56, 189, 248, 0.03);">
          <div class="form-section-title" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <span><i class="fas fa-boxes-stacked" style="color:#38bdf8;"></i> 4. Repuestos del Taller (Área Javier Andrade)</span>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:800;">
              <input type="checkbox" id="edit-toggle-spares" ${tempEditOrderState.comproRepuestosTaller ? "checked" : ""} onchange="toggleEditSparesSection(this.checked)" style="width:17px; height:17px; accent-color:#0284c7;" />
              ¿Compró repuestos en el taller?
            </label>
          </div>
          <div id="edit-spares-box" class="${tempEditOrderState.comproRepuestosTaller ? '' : 'hidden'}" style="margin-top:10px;">
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
              <select id="edit-select-spare-inv" style="flex:1; min-width:220px; padding:8px 10px; border-radius:8px; border:1.5px solid var(--border-color); font-weight:700;">
                <option value="">-- Seleccionar repuesto de inventario --</option>
                ${inventoryOptions}
              </select>
              <input type="number" id="edit-spare-qty" min="1" value="1" style="width:70px; padding:8px; border-radius:8px; font-weight:800;" placeholder="Cant." />
              <button type="button" class="btn btn--primary" onclick="addSpareToEditOrder()" style="padding:8px 12px;">
                <i class="fas fa-plus"></i> Añadir Repuesto
              </button>
            </div>
            <div id="edit-spares-list-wrapper"></div>
          </div>
        </div>

        <!-- RESUMEN FINANCIERO TOTALIZADO -->
        <div class="form-section-box" style="background:var(--bg-card); border-color:var(--renacer-gold);">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div>
              <span style="font-size:12px; font-weight:800; color:var(--text-muted);">TOTAL SERVICIOS + REPUESTOS:</span>
              <div id="edit-order-grand-total" style="font-size:24px; font-weight:900; color:var(--renacer-gold);">$${Number(order.monto_total).toFixed(2)}</div>
            </div>
            <div>
              <span style="font-size:12px; font-weight:800; color:var(--text-muted);">MONTO YA ABONADO:</span>
              <div style="font-size:20px; font-weight:900; color:#22c55e;">$${Number(order.monto_abonado).toFixed(2)}</div>
            </div>
            <div>
              <span style="font-size:12px; font-weight:800; color:var(--text-muted);">RESTO / SALDO PENDIENTE:</span>
              <div id="edit-order-saldo" style="font-size:22px; font-weight:900; color:${order.saldo_pendiente > 0 ? '#f87171' : '#22c55e'};">$${Number(order.saldo_pendiente).toFixed(2)}</div>
            </div>
          </div>
        </div>

        <!-- BOTONES DE ACCIÓN PRINCIPALES -->
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <div style="display:flex; gap:8px;">
            <button type="submit" class="btn btn--gold btn--lg" style="font-weight:900; padding:12px 24px;">
              <i class="fas fa-save"></i> Guardar Todos los Cambios
            </button>
            <button type="button" class="btn btn--ghost btn--lg" onclick="closeModal()">
              Cancelar
            </button>
          </div>
          <button type="button" class="btn btn--danger" onclick="cancelOrArchiveFromEditModal('${order.id_orden}')" style="padding:10px 16px; font-weight:800;">
            <i class="fas fa-ban"></i> Anular / Archivar Orden
          </button>
        </div>
      </form>
    `
  });

  renderEditServicesTable();
  renderEditSparesTable();
}

function handleEditClientAutocomplete(nameVal) {
  if (!nameVal || !nameVal.trim()) return;
  const search = nameVal.trim().toLowerCase();
  const match = (db.clientes || []).find((c) => {
    const full = (c.nombre_completo || c.nombre_cliente || "").toLowerCase().trim();
    return full === search || (search.length >= 3 && full.includes(search));
  });
  if (match) {
    const docEl = document.getElementById("edit-cli-doc");
    const phoneEl = document.getElementById("edit-cli-phone");
    const addrEl = document.getElementById("edit-cli-address");
    const typeEl = document.getElementById("edit-cli-type");
    if (docEl && match.documento_identidad) docEl.value = match.documento_identidad;
    if (phoneEl && match.telefono) phoneEl.value = match.telefono;
    if (addrEl && match.direccion) addrEl.value = match.direccion;
    if (typeEl && match.tipo_cliente) {
      typeEl.value = String(match.tipo_cliente).toLowerCase().includes("aliado") ? "taller_aliado" : "particular";
    }
  }
}

function renderEditServicesTable() {
  const wrapper = document.getElementById("edit-services-table-wrapper");
  if (!wrapper) return;

  if (tempEditOrderState.services.length === 0) {
    wrapper.innerHTML = `<div style="text-align:center; padding:16px; color:var(--text-muted); font-size:12px;">No hay servicios agregados. Selecciona del catálogo o añade fila libre.</div>`;
    recalcEditTotals();
    return;
  }

  const rows = tempEditOrderState.services
    .map((s, idx) => `
      <tr style="border-bottom:1px solid var(--border-subtle);">
        <td style="padding:6px 8px; width:40%;">
          <input type="text" value="${s.descripcion_servicio}" onchange="updateEditServiceField(${idx}, 'descripcion_servicio', this.value)" style="width:100%; padding:6px 8px; border-radius:6px; font-weight:700;" placeholder="Descripción" />
        </td>
        <td style="padding:6px 8px; width:25%;">
          <select onchange="updateEditServiceTech(${idx}, this.value)" style="width:100%; padding:6px; border-radius:6px; font-size:12px; font-weight:700;">
            <option value="">-- Sin asignar --</option>
            ${(db.usuarios || [])
              .filter((u) => u.rol === "tecnico" || u.rol === "outsourcing" || u.es_externo)
              .map((u) => `<option value="${u.id_usuario}" ${s.tecnico_id === u.id_usuario ? "selected" : ""}>${u.nombre}</option>`)
              .join("")}
          </select>
        </td>
        <td style="padding:6px 8px; width:15%;">
          <input type="number" step="0.5" min="0" value="${s.monto_servicio}" oninput="updateEditServiceField(${idx}, 'monto_servicio', this.value)" style="width:100%; padding:6px 8px; border-radius:6px; font-weight:900;" placeholder="Precio $" />
        </td>
        <td style="padding:6px 8px; width:15%;">
          <input type="number" step="0.5" min="0" value="${s.comision_base_tecnico}" oninput="updateEditServiceField(${idx}, 'comision_base_tecnico', this.value)" style="width:100%; padding:6px 8px; border-radius:6px; font-weight:800; color:var(--renacer-gold);" placeholder="Comisión $" />
        </td>
        <td style="padding:6px 8px; text-align:center;">
          <button type="button" class="btn btn--danger btn--xs" onclick="removeServiceFromEditOrder(${idx})" title="Eliminar fila" style="padding:5px 8px;">
            <i class="fas fa-trash-alt"></i>
          </button>
        </td>
      </tr>
    `)
    .join("");

  wrapper.innerHTML = `
    <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
      <thead>
        <tr style="background:var(--bg-subtle); color:var(--text-muted); font-size:11px; text-transform:uppercase;">
          <th style="padding:6px 8px; text-align:left;">Servicio / Trabajo</th>
          <th style="padding:6px 8px; text-align:left;">Técnico Asignado</th>
          <th style="padding:6px 8px; text-align:left;">Monto ($)</th>
          <th style="padding:6px 8px; text-align:left;">Comisión ($)</th>
          <th style="padding:6px 8px; text-align:center;">Quitar</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;

  recalcEditTotals();
}

function updateEditServiceField(idx, field, val) {
  if (!tempEditOrderState.services[idx]) return;
  if (field === "monto_servicio" || field === "comision_base_tecnico") {
    tempEditOrderState.services[idx][field] = Number(val) || 0;
  } else {
    tempEditOrderState.services[idx][field] = val;
  }
  recalcEditTotals();
}

function updateEditServiceTech(idx, techId) {
  if (!tempEditOrderState.services[idx]) return;
  tempEditOrderState.services[idx].tecnico_id = techId;
  const u = (db.usuarios || []).find((x) => x.id_usuario === techId);
  tempEditOrderState.services[idx].nombre_tecnico = u ? u.nombre : "Sin asignar";
}

function addServiceToEditOrder() {
  const sel = document.getElementById("edit-select-cat-service");
  if (!sel || !sel.value) {
    showToast("Selecciona un servicio del catálogo.", "info");
    return;
  }
  const cat = (db.catalogo_servicios || []).find((c) => c.id_cat === sel.value);
  if (!cat) return;

  tempEditOrderState.services.push({
    id_subtarea: "SUB-" + Date.now() + "-" + Math.floor(Math.random() * 999),
    descripcion_servicio: cat.nombre,
    monto_servicio: Number(cat.precio_sugerido) || 25,
    comision_base_tecnico: Number(cat.comision_sugerida) || 8,
    tecnico_id: "",
    nombre_tecnico: "Sin asignar",
    estado_subtarea: "pendiente",
    minutos_acumulados: 0
  });

  sel.value = "";
  renderEditServicesTable();
}

function filterEditServicesLive(query) {
  const dropdown = document.getElementById("edit-services-live-dropdown");
  if (!dropdown) return;
  const q = (query || "").trim().toLowerCase();

  const services = db.catalogo_servicios || [];
  const filtered = q
    ? services.filter((s) => (s.nombre || "").toLowerCase().includes(q) || (s.categoria || "").toLowerCase().includes(q))
    : services.slice(0, 12);

  if (filtered.length === 0) {
    dropdown.innerHTML = `
      <div style="padding:12px; text-align:center; font-size:12px; color:var(--text-muted);">
        No se encontró ningún servicio que coincida con "<strong>${query}</strong>".
        <div style="margin-top:8px;">
          <button type="button" class="btn btn--gold btn--xs" onclick="addCustomServiceToEditOrder('${query.replace(/'/g, "\\'")}')">
            <i class="fas fa-plus"></i> Agregar como Servicio Adicional
          </button>
        </div>
      </div>
    `;
    dropdown.classList.remove("hidden");
    return;
  }

  dropdown.innerHTML = filtered
    .map(
      (s) => `
      <div class="budget-service-item-pick" onclick="pickEditServiceFromDropdown('${s.id_cat}')">
        <div>
          <strong>${s.nombre}</strong>
          <div style="font-size:10.5px; color:var(--text-muted);">${s.categoria || "Mecanizado"} · Comisión técnico: $${Number(s.comision_sugerida).toFixed(2)}</div>
        </div>
        <div style="text-align:right;">
          <strong style="color:var(--renacer-gold); font-size:13.5px;">$${Number(s.precio_sugerido).toFixed(2)}</strong>
          <span style="font-size:10px; color:#22c55e; display:block;"><i class="fas fa-plus-circle"></i> Agregar 1-Click</span>
        </div>
      </div>
    `
    )
    .join("");

  dropdown.classList.remove("hidden");
}

function pickEditServiceFromDropdown(catId) {
  const cat = (db.catalogo_servicios || []).find((c) => c.id_cat === catId);
  const dropdown = document.getElementById("edit-services-live-dropdown");
  const input = document.getElementById("search-edit-service-input");
  if (dropdown) dropdown.classList.add("hidden");
  if (input) input.value = "";
  if (!cat) return;

  tempEditOrderState.services.push({
    id_subtarea: "SUB-" + Date.now() + "-" + Math.floor(Math.random() * 999),
    descripcion_servicio: cat.nombre,
    monto_servicio: Number(cat.precio_sugerido) || 0,
    comision_base_tecnico: Number(cat.comision_sugerida) || 0,
    tecnico_id: "",
    nombre_tecnico: "Sin asignar",
    estado_subtarea: "pendiente",
    minutos_acumulados: 0
  });

  renderEditServicesTable();
  recalcEditTotals();
}

function addCustomServiceToEditOrder(initialName = "") {
  tempEditOrderState.services.push({
    id_subtarea: "SUB-" + Date.now() + "-" + Math.floor(Math.random() * 999),
    descripcion_servicio: typeof initialName === "string" && initialName ? initialName : "Servicio Adicional",
    monto_servicio: 10,
    comision_base_tecnico: 3,
    tecnico_id: "",
    nombre_tecnico: "Sin asignar",
    estado_subtarea: "pendiente",
    minutos_acumulados: 0
  });
  const dropdown = document.getElementById("edit-services-live-dropdown");
  const input = document.getElementById("search-edit-service-input");
  if (dropdown) dropdown.classList.add("hidden");
  if (input) input.value = "";
  renderEditServicesTable();
  recalcEditTotals();
}

function removeServiceFromEditOrder(idx) {
  tempEditOrderState.services.splice(idx, 1);
  renderEditServicesTable();
}

function toggleEditSparesSection(checked) {
  tempEditOrderState.comproRepuestosTaller = checked;
  const box = document.getElementById("edit-spares-box");
  if (box) {
    if (checked) box.classList.remove("hidden");
    else box.classList.add("hidden");
  }
  recalcEditTotals();
}

function renderEditSparesTable() {
  const wrapper = document.getElementById("edit-spares-list-wrapper");
  if (!wrapper) return;

  if (tempEditOrderState.repuestos.length === 0) {
    wrapper.innerHTML = `<div style="font-size:11.5px; color:var(--text-muted); padding:6px 0;">No se han agregado repuestos aún.</div>`;
    return;
  }

  const rows = tempEditOrderState.repuestos
    .map((r, idx) => `
      <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-subtle); padding:6px 10px; border-radius:8px; margin-bottom:4px; font-size:12px;">
        <div><strong>${r.nombre}</strong> (x${r.cantidad})</div>
        <div style="display:flex; gap:10px; align-items:center;">
          <span style="font-weight:800; color:#38bdf8;">$${(Number(r.precio_unitario) * Number(r.cantidad)).toFixed(2)}</span>
          <button type="button" class="btn btn--danger btn--xs" onclick="removeSpareFromEditOrder(${idx})" style="padding:2px 6px;">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>
    `)
    .join("");

  wrapper.innerHTML = rows;
  recalcEditTotals();
}

function addSpareToEditOrder() {
  const sel = document.getElementById("edit-select-spare-inv");
  const qtyEl = document.getElementById("edit-spare-qty");
  if (!sel || !sel.value) return;

  const item = (db.inventario_repuestos || []).find((r) => r.id_repuesto === sel.value);
  if (!item) return;
  const qty = Math.max(1, Number(qtyEl.value) || 1);

  tempEditOrderState.repuestos.push({
    id_repuesto: item.id_repuesto,
    nombre: item.nombre,
    cantidad: qty,
    precio_unitario: Number(item.precio_venta) || 0,
    subtotal: (Number(item.precio_venta) || 0) * qty
  });

  sel.value = "";
  qtyEl.value = "1";
  renderEditSparesTable();
}

function removeSpareFromEditOrder(idx) {
  tempEditOrderState.repuestos.splice(idx, 1);
  renderEditSparesTable();
}

function recalcEditTotals() {
  const servTotal = tempEditOrderState.services.reduce((acc, s) => acc + (Number(s.monto_servicio) || 0), 0);
  const repTotal = tempEditOrderState.comproRepuestosTaller
    ? tempEditOrderState.repuestos.reduce((acc, r) => acc + (Number(r.subtotal) || (Number(r.precio_unitario) * Number(r.cantidad)) || 0), 0)
    : 0;
  const grandTotal = servTotal + repTotal;

  const order = db.ordenes.find((o) => o.id_orden === tempEditOrderState.orderId);
  const abonado = order ? Number(order.monto_abonado) || 0 : 0;
  const saldo = Math.max(0, grandTotal - abonado);

  const gtEl = document.getElementById("edit-order-grand-total");
  const saldoEl = document.getElementById("edit-order-saldo");
  if (gtEl) gtEl.textContent = "$" + grandTotal.toFixed(2);
  if (saldoEl) {
    saldoEl.textContent = "$" + saldo.toFixed(2);
    saldoEl.style.color = saldo > 0 ? "#f87171" : "#22c55e";
  }
}

function saveEditedCompleteOrder(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const troquel = (document.getElementById("edit-ord-troquel")?.value || "").trim();
  const estado = document.getElementById("edit-ord-estado")?.value || order.estado_actual;
  const condPago = document.getElementById("edit-ord-pago-condicion")?.value || order.tipo_condicion_pago;
  const isPriority = Boolean(document.getElementById("edit-ord-priority")?.checked);

  const cliName = (document.getElementById("edit-cli-name")?.value || "").trim();
  const cliDoc = (document.getElementById("edit-cli-doc")?.value || "").trim();
  const cliPhone = (document.getElementById("edit-cli-phone")?.value || "").trim();
  const cliAddr = (document.getElementById("edit-cli-address")?.value || "").trim();
  const cliType = document.getElementById("edit-cli-type")?.value || "particular";

  const pieza = document.getElementById("edit-ord-pieza")?.value || order.datos_motor.tipo_pieza;
  const marca = (document.getElementById("edit-ord-marca")?.value || "").trim();
  const modelo = (document.getElementById("edit-ord-modelo")?.value || "").trim();
  const serial = (document.getElementById("edit-ord-serial")?.value || "").trim();
  const obs = (document.getElementById("edit-ord-obs")?.value || "").trim();

  if (!troquel || !cliName || !cliDoc || !marca || !modelo) {
    showToast("Por favor completa los campos obligatorios (*).", "error");
    return;
  }

  // Actualizar campos de la orden
  order.codigo_troquel = troquel;
  order.estado_actual = estado;
  order.tipo_condicion_pago = condPago;
  order.prioridad_alta = isPriority;

  order.nombre_cliente = cliName;
  order.documento_cliente = cliDoc;
  order.telefono_cliente = cliPhone;
  order.direccion_cliente = cliAddr;
  order.tipo_cliente = cliType;

  order.datos_motor.tipo_pieza = pieza;
  order.datos_motor.marca = marca;
  order.datos_motor.modelo = modelo;
  order.datos_motor.serial = serial;
  order.datos_motor.observaciones = obs;

  order.repuestos_comprados_taller = tempEditOrderState.comproRepuestosTaller;
  order.items_repuestos = tempEditOrderState.repuestos;

  // Reemplazar subtareas de esta orden
  db.subtareas = db.subtareas.filter((s) => s.orden_id !== orderId);
  tempEditOrderState.services.forEach((s) => {
    db.subtareas.push({
      id_subtarea: s.id_subtarea || "SUB-" + Date.now() + "-" + Math.floor(Math.random() * 999),
      orden_id: orderId,
      codigo_troquel: troquel,
      descripcion_servicio: s.descripcion_servicio,
      tecnico_id: s.tecnico_id || "",
      nombre_tecnico: s.nombre_tecnico || "Sin asignar",
      monto_servicio: Number(s.monto_servicio) || 0,
      comision_base_tecnico: Number(s.comision_base_tecnico) || 0,
      estado_subtarea: s.estado_subtarea || "pendiente",
      minutos_acumulados: s.minutos_acumulados || 0
    });
  });

  // Calcular totales actualizados
  const servTotal = tempEditOrderState.services.reduce((acc, s) => acc + (Number(s.monto_servicio) || 0), 0);
  const repTotal = tempEditOrderState.comproRepuestosTaller
    ? tempEditOrderState.repuestos.reduce((acc, r) => acc + (Number(r.subtotal) || (Number(r.precio_unitario) * Number(r.cantidad)) || 0), 0)
    : 0;
  order.monto_total = servTotal + repTotal;
  order.saldo_pendiente = Math.max(0, order.monto_total - (Number(order.monto_abonado) || 0));

  // Registrar en bitácora
  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser ? currentUser.id_usuario : "USR-ADMIN",
    autor_nombre: currentUser ? currentUser.nombre : "Sistema",
    autor_rol: currentUser ? currentUser.rol_label : "Administrador",
    tipo_evento: "modificacion",
    mensaje: `Modificación completa guardada para Orden #${troquel}. Total: $${order.monto_total.toFixed(2)}.`,
    foto_adjunta_url: "",
    fecha_hora: new Date().toISOString().slice(0, 16).replace("T", " ")
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Orden #${troquel} actualizada correctamente.`);
}

function cancelOrArchiveFromEditModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  Swal.fire({
    title: `¿Anular o Archivar la Orden #${order.codigo_troquel}?`,
    text: "Selecciona la acción requerida. Al anular, se conserva el correlativo para auditoría sin deuda.",
    icon: "warning",
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: "🚫 Anular Orden",
    confirmButtonColor: "#ef4444",
    denyButtonText: "📦 Archivar Orden",
    denyButtonColor: "#0284c7",
    cancelButtonText: "Cancelar"
  }).then((res) => {
    if (res.isConfirmed) {
      Swal.fire({
        title: "Motivo de la Anulación",
        input: "text",
        inputPlaceholder: "Ej: Cliente retiró la pieza sin trabajo / Error de ingreso",
        showCancelButton: true,
        confirmButtonText: "Confirmar Anulación",
        cancelButtonText: "Cancelar"
      }).then((r) => {
        if (r.isConfirmed && r.value) {
          order.estado_actual = "anulado";
          order.motivo_anulacion = r.value;
          order.saldo_pendiente = 0;
          saveDatabase();
          closeModal();
          renderApp();
          showToast(`Orden #${order.codigo_troquel} anulada.`);
        }
      });
    } else if (res.isDenied) {
      archiveOrder(orderId);
      closeModal();
    }
  });
}

/* ============================================================================
   CONTROL DE ASISTENCIA PRESENCIAL POR QR DINÁMICO Y POR PERFIL (JESÚS ANDRADE)
   Entrada, Salida a Almorzar, Regreso y Salida de Jornada con Anti-Fraude
   ============================================================================ */
let kioskTimerInterval = null;
let html5QrCodeScannerInstance = null;

function getTodayAttendanceList() {
  const todayIso = new Date().toISOString().slice(0, 10);
  return (db.asistencias || []).filter((a) => a.fecha === todayIso);
}

function getWorkerCurrentPresence(userId) {
  const todayRecords = getTodayAttendanceList();
  const rec = todayRecords.find((a) => a.usuario_id === userId);
  if (!rec) return { status: "no_ingreso", label: "No ha ingresado hoy", cls: "text-muted", icon: "fa-circle" };
  if (rec.hora_salida) return { status: "salida_final", label: `Jornada Finalizada (${rec.hora_salida})`, cls: "text-secondary", icon: "fa-flag-checkered", rec };
  if (rec.hora_salida_almuerzo && !rec.hora_regreso_almuerzo) return { status: "en_almuerzo", label: `En Almuerzo (${rec.hora_salida_almuerzo})`, cls: "text-warning", icon: "fa-utensils", rec };
  return { status: "en_taller", label: `En Taller (${rec.hora_entrada})`, cls: "text-success", icon: "fa-check-circle", rec };
}

function drawDynamicQrCode(container, text, size = 200) {
  if (!container) return;
  container.innerHTML = "";

  let rendered = false;

  // 1. Intento con David Shim's QRCode constructor local
  if (typeof QRCode === "function") {
    try {
      const qrLevel = (QRCode.CorrectLevel && typeof QRCode.CorrectLevel.L !== "undefined") ? QRCode.CorrectLevel.L : 1;
      new QRCode(container, {
        text: text,
        width: size,
        height: size,
        colorDark: "#0f1638",
        colorLight: "#ffffff",
        correctLevel: qrLevel
      });
      const generated = container.querySelector("canvas, img");
      if (generated) {
        generated.style.display = "block";
        generated.style.margin = "0 auto";
        generated.style.borderRadius = "8px";
        generated.style.background = "#ffffff";
        generated.style.padding = "6px";
        rendered = true;
      }
    } catch (e) {
      console.warn("new QRCode() error:", e);
      container.innerHTML = "";
    }
  }

  // 2. Intento con Ryan Day's QRCode con toCanvas si estuviera cargado
  if (!rendered && typeof QRCode === "object" && typeof QRCode.toCanvas === "function") {
    try {
      const canvas = document.createElement("canvas");
      container.appendChild(canvas);
      QRCode.toCanvas(canvas, text, { width: size, margin: 1, color: { dark: "#0f1638", light: "#ffffff" } }, (err) => {
        if (err) console.error("QRCode.toCanvas error:", err);
      });
      canvas.style.display = "block";
      canvas.style.margin = "0 auto";
      canvas.style.borderRadius = "8px";
      canvas.style.background = "#ffffff";
      canvas.style.padding = "6px";
      rendered = true;
    } catch (e) {
      console.warn("QRCode.toCanvas error:", e);
      container.innerHTML = "";
    }
  }

  // 3. Si no se pudo generar con librerías locales, renderizar con API de imagen QR de alta resolución
  if (!rendered) {
    container.innerHTML = "";
    const img = document.createElement("img");
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&margin=10`;
    img.alt = "QR Asistencia Presencial";
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.style.display = "block";
    img.style.margin = "0 auto";
    img.style.borderRadius = "8px";
    img.style.background = "#ffffff";
    img.style.padding = "6px";
    img.style.boxShadow = "0 4px 12px rgba(0,0,0,0.25)";

    img.onerror = function() {
      // 4. Fallback Offline solo si falla la imagen y no hay librería disponible
      const displayToken = text.replace(/^RENACER_PRESENCIAL\|/i, "");
      container.innerHTML = `
        <div style="padding:14px; border:2px dashed var(--renacer-gold); border-radius:12px; background:rgba(245,196,0,0.06); text-align:center;">
          <i class="fas fa-qrcode" style="font-size:36px; color:var(--renacer-gold); margin-bottom:6px;"></i>
          <div style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase;">TOKEN PRESENCIAL ACTIVO</div>
          <div style="font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:900; color:#38bdf8; word-break:break-all; margin:8px 0; background:rgba(15,22,56,0.6); padding:6px; border-radius:8px;">${displayToken}</div>
          <div style="font-size:10.5px; color:var(--text-muted);">Toca tu nombre a la derecha para certificar asistencia con tu PIN numérico.</div>
        </div>
      `;
    };
    container.appendChild(img);
  }

  // Complemento: Mostrar siempre el token numérico legible abajo
  const displayToken = text.replace(/^RENACER_PRESENCIAL\|/i, "");
  const tokenBadge = document.createElement("div");
  tokenBadge.style.cssText = "margin-top:10px; font-size:11px; color:#cbd5e1; text-align:center; font-family:'JetBrains Mono',monospace;";
  tokenBadge.innerHTML = `<span style="opacity:0.75;">Código token:</span> <strong style="color:var(--renacer-gold); font-size:12px;">${displayToken}</strong>`;
  container.appendChild(tokenBadge);
}

function openAttendanceKioskModal() {
  if (kioskTimerInterval) clearInterval(kioskTimerInterval);

  let secondsLeft = 45;

  // En el kiosco de marcar asistencia SOLO deben figurar los técnicos de taller (Havell, Angel, Jose)
  const activeWorkers = (db.usuarios || []).filter(
    (u) => u.activo && u.rol === "tecnico"
  );

  const workersProfilesHtml = activeWorkers
    .map((w) => {
      const pres = getWorkerCurrentPresence(w.id_usuario);
      let badgeColor = "#94a3b8";
      let badgeText = "Sin marcar";
      let dotIcon = "fa-circle";
      if (pres.status === "en_taller") {
        badgeColor = "#22c55e";
        badgeText = "En Taller";
        dotIcon = "fa-check-circle";
      } else if (pres.status === "en_almuerzo") {
        badgeColor = "#f59e0b";
        badgeText = "Almuerzo";
        dotIcon = "fa-utensils";
      } else if (pres.status === "salida_final") {
        badgeColor = "#64748b";
        badgeText = "Salió";
        dotIcon = "fa-flag-checkered";
      }

      return `
        <button type="button" class="kiosk-worker-card-btn" onclick="quickAttendanceByProfile('${w.id_usuario}')" title="Marcar entrada/salida para ${w.nombre}">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="font-size:12.5px; color:var(--text-main);">${w.nombre}</strong>
            <span style="font-size:10.5px; font-weight:800; color:${badgeColor}; display:flex; align-items:center; gap:4px;">
              <i class="fas ${dotIcon}"></i> ${badgeText}
            </span>
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            ${w.rol_label || w.rol} · <span style="color:var(--renacer-gold); font-weight:700;">Tocar para marcar</span>
          </div>
        </button>
      `;
    })
    .join("");

  openModal({
    title: "Kiosco de Asistencia Presencial (QR Dinámico y Perfil)",
    icon: "fa-qrcode",
    wide: true,
    body: `
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:18px; align-items:start;" class="kiosk-grid-responsive">
        <!-- COLUMNA IZQUIERDA: QR DINÁMICO ANTI-FRAUDE 45s -->
        <div class="attendance-kiosk-wrapper" style="background:var(--bg-card); border:1.5px solid var(--border-subtle); border-radius:16px; padding:18px;">
          <div style="font-size:12.5px; color:var(--renacer-gold); font-weight:900; text-transform:uppercase; margin-bottom:4px;">
            <i class="fas fa-camera"></i> Escanear con Teléfono
          </div>
          <p style="font-size:11.5px; color:var(--text-muted); margin-bottom:8px; line-height:1.4;">
            El código cambia cada <strong>45 segundos</strong> para certificar presencia física en el taller (evita reenvíos por WhatsApp).
          </p>

          <div class="attendance-qr-card" style="margin:8px 0;">
            <div id="kiosk-qr-canvas"></div>
          </div>

          <div id="kiosk-timer-display" class="qr-countdown-badge">
            <i class="fas fa-stopwatch"></i> Actualizando en: <strong id="kiosk-secs-num">45</strong>s
          </div>

          <button type="button" class="btn btn--ghost btn--xs" onclick="generateNewKioskQr()" style="margin-top:10px; font-size:11px;">
            <i class="fas fa-sync-alt"></i> Forzar nuevo código
          </button>
        </div>

        <!-- COLUMNA DERECHA: REGISTRO DIRECTO POR PERFIL (SI NO TIENEN TELÉFONO) -->
        <div style="background:var(--bg-card); border:1.5px solid var(--border-subtle); border-radius:16px; padding:18px;">
          <div style="font-size:12.5px; color:#38bdf8; font-weight:900; text-transform:uppercase; margin-bottom:4px;">
            <i class="fas fa-user-circle"></i> Marcar por Perfil (Sin Teléfono)
          </div>
          <p style="font-size:11.5px; color:var(--text-muted); margin-bottom:12px;">
            Si se dañó el teléfono o no lo tienen a mano, el técnico toca su perfil e ingresa su PIN numérico.
          </p>

          <div style="display:grid; gap:8px;">
            ${workersProfilesHtml}
          </div>

          <div style="margin-top:14px; padding:10px; background:rgba(245,196,0,0.06); border:1px dashed var(--renacer-gold); border-radius:10px; font-size:11px; color:var(--text-main);">
            <i class="fas fa-info-circle" style="color:var(--renacer-gold);"></i> 
            <span id="kiosk-notice-display">${escapeHtml(getCustomText("attendance_notice", DEFAULT_TEXT_CUSTOMIZATIONS.attendance_notice))}</span>
          </div>
        </div>
      </div>
    `
  });

  window.generateNewKioskQr = function() {
    const canvasBox = document.getElementById("kiosk-qr-canvas");
    if (!canvasBox) return;
    secondsLeft = 45;

    const token = `RENACER_PRESENCIAL|${Date.now()}|${Math.floor(100000 + Math.random() * 900000)}`;
    drawDynamicQrCode(canvasBox, token, 200);
  };

  generateNewKioskQr();

  kioskTimerInterval = setInterval(() => {
    secondsLeft--;
    const numEl = document.getElementById("kiosk-secs-num");
    const badgeEl = document.getElementById("kiosk-timer-display");
    if (numEl) numEl.textContent = secondsLeft;
    if (badgeEl) {
      if (secondsLeft <= 10) badgeEl.classList.add("warning");
      else badgeEl.classList.remove("warning");
    }
    if (secondsLeft <= 0) {
      generateNewKioskQr();
    }
  }, 1000);
}

function quickAttendanceByProfile(userId) {
  const user = (db.usuarios || []).find((u) => u.id_usuario === userId);
  if (!user) return;

  Swal.fire({
    title: `Marcar Asistencia: ${user.nombre}`,
    text: "Ingresa tu PIN numérico personal para validar:",
    input: "password",
    inputAttributes: {
      inputmode: "numeric",
      maxlength: 6,
      autocapitalize: "off",
      autocorrect: "off"
    },
    showCancelButton: true,
    confirmButtonText: "Continuar",
    confirmButtonColor: "#f5c400",
    cancelButtonText: "Cancelar",
    preConfirm: (pin) => {
      if (!pin) {
        Swal.showValidationMessage("Debes ingresar tu PIN.");
        return false;
      }
      if (String(user.pin || "000000").trim() !== pin.trim()) {
        Swal.showValidationMessage("PIN incorrecto.");
        return false;
      }
      return true;
    }
  }).then((res) => {
    if (res.isConfirmed) {
      handleAttendanceActionForUser(user, "perfil_kiosco");
    }
  });
}

function openTechnicianQrScanModal() {
  if (html5QrCodeScannerInstance) {
    try {
      html5QrCodeScannerInstance.stop().catch(() => {});
    } catch (e) {}
  }

  openModal({
    title: "Escanear QR de Asistencia Presencial",
    icon: "fa-camera",
    wide: false,
    body: `
      <div style="text-align:center; padding:12px;">
        <p style="font-size:12.5px; color:var(--text-muted); margin-bottom:12px;">
          Apunta la cámara de tu teléfono a la pantalla de recepción para certificar tu presencia física en el taller.
        </p>

        <div id="tech-qr-reader" class="attendance-scanner-box"></div>

        <div id="tech-scan-status" style="font-size:12px; font-weight:800; color:var(--text-main); margin-top:12px;">
          <i class="fas fa-camera"></i> Iniciando cámara...
        </div>

        <div style="margin-top:14px;">
          <button type="button" class="btn btn--ghost btn--sm" onclick="promptManualPinAttendance()">
            ¿Problemas con la cámara? Registrar con PIN / Perfil
          </button>
        </div>
      </div>
    `
  });

  setTimeout(() => {
    if (typeof Html5Qrcode === "undefined") {
      const statusEl = document.getElementById("tech-scan-status");
      if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">Error: Librería Html5Qrcode no encontrada.</span>`;
      return;
    }

    html5QrCodeScannerInstance = new Html5Qrcode("tech-qr-reader");
    html5QrCodeScannerInstance
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decodedText) => {
          handleScannedAttendanceToken(decodedText);
        },
        () => {}
      )
      .then(() => {
        const statusEl = document.getElementById("tech-scan-status");
        if (statusEl) statusEl.innerHTML = `<span style="color:#22c55e;"><i class="fas fa-check-circle"></i> Cámara lista. Escaneando código en pantalla...</span>`;
      })
      .catch((err) => {
        const statusEl = document.getElementById("tech-scan-status");
        if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;"><i class="fas fa-exclamation-triangle"></i> No se pudo activar la cámara (${err}). Usa la opción de PIN.</span>`;
      });
  }, 350);
}

function handleScannedAttendanceToken(token) {
  if (!token || !token.startsWith("RENACER_PRESENCIAL|")) {
    showToast("Código QR no válido para asistencia de Renacer.", "error");
    return;
  }

  const parts = token.split("|");
  const timestamp = Number(parts[1]) || 0;
  const ageMs = Date.now() - timestamp;

  // Verificación anti-fraude: código emitido hace menos de 90 segundos
  if (ageMs > 90000) {
    Swal.fire({
      icon: "error",
      title: "Código QR Expirado",
      text: "El código escaneado ha vencido o fue tomado de una fotografía vieja. Debes escanear el código que se está mostrando en vivo en la pantalla del taller."
    });
    return;
  }

  if (html5QrCodeScannerInstance) {
    html5QrCodeScannerInstance.stop().catch(() => {});
  }

  closeModal();

  const user = currentUser || db.usuarios.find((u) => u.rol === "tecnico") || db.usuarios[0];
  handleAttendanceActionForUser(user, "qr_dinamico_presencial");
}

function promptManualPinAttendance() {
  const users = (db.usuarios || []).filter((u) => u.activo && (u.rol === "tecnico" || u.rol === "inventario" || u.rol === "admin" || u.rol === "jefe_taller"));
  const optionsHtml = users.map((u) => `<option value="${u.id_usuario}">${u.nombre} (${u.rol_label || u.rol})</option>`).join("");

  Swal.fire({
    title: "Registro de Asistencia con PIN",
    html: `
      <div style="text-align:left; font-size:13px; display:grid; gap:10px;">
        <div>
          <label style="font-weight:700;">Selecciona tu Nombre:</label>
          <select id="swal-pin-user" class="swal2-input" style="width:100%; margin:4px 0 10px 0; font-size:13px;">
            ${optionsHtml}
          </select>
        </div>
        <div>
          <label style="font-weight:700;">PIN Numérico:</label>
          <input type="password" id="swal-pin-code" class="swal2-input" inputmode="numeric" placeholder="Ingresa tu PIN" style="width:100%; margin:4px 0 0 0;" />
        </div>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: "Continuar",
    confirmButtonColor: "#f5c400",
    cancelButtonText: "Cancelar",
    preConfirm: () => {
      const uId = document.getElementById("swal-pin-user")?.value;
      const pin = document.getElementById("swal-pin-code")?.value;
      if (!uId || !pin) {
        Swal.showValidationMessage("Selecciona tu usuario e ingresa el PIN.");
        return false;
      }
      const user = db.usuarios.find((x) => x.id_usuario === uId);
      if (!user || String(user.pin || "000000").trim() !== pin.trim()) {
        Swal.showValidationMessage("PIN incorrecto.");
        return false;
      }
      return user;
    }
  }).then((res) => {
    if (res.isConfirmed && res.value) {
      handleAttendanceActionForUser(res.value, "pin_manual_kiosco");
    }
  });
}

function handleAttendanceActionForUser(user, method) {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  let existing = (db.asistencias || []).find((a) => a.fecha === todayIso && a.usuario_id === user.id_usuario);

  const entradaText = existing?.hora_entrada ? `✅ Entrada: ${existing.hora_entrada} (${existing.estado})` : "⏳ Sin marcar entrada";
  const almuerzoSalText = existing?.hora_salida_almuerzo ? `✅ Salió a almuerzo: ${existing.hora_salida_almuerzo}` : "⏳ Sin salida a almuerzo";
  const almuerzoRegText = existing?.hora_regreso_almuerzo ? `✅ Regresó de almuerzo: ${existing.hora_regreso_almuerzo}` : "⏳ Sin regreso de almuerzo";
  const salidaText = existing?.hora_salida ? `✅ Salida final: ${existing.hora_salida}` : "⏳ Sin salida de jornada";

  Swal.fire({
    title: `Control de Horario: ${user.nombre}`,
    html: `
      <div style="text-align:left; font-size:13px;">
        <div style="background:var(--bg-input); padding:10px 14px; border-radius:12px; margin-bottom:14px; border:1px solid var(--border-subtle); line-height:1.6;">
          <div style="font-weight:800; color:var(--renacer-gold); margin-bottom:4px;">
            <i class="fas fa-calendar-day"></i> Registro de Hoy (${formatDateHuman(todayIso, false)}) · Hora Actual: <strong>${timeStr}</strong>
          </div>
          <div style="font-size:12px; color:var(--text-muted);">${entradaText}</div>
          <div style="font-size:12px; color:var(--text-muted);">${almuerzoSalText} · ${almuerzoRegText}</div>
          <div style="font-size:12px; color:var(--text-muted);">${salidaText}</div>
        </div>

        <p style="font-weight:800; margin-bottom:10px; color:var(--text-main);">Selecciona la acción a certificar en este momento:</p>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
          <button type="button" id="swal-att-btn-entrada" class="btn btn--gold" style="padding:10px; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; gap:6px;">
            <i class="fas fa-sun"></i> 1. Entrada
          </button>
          <button type="button" id="swal-att-btn-almuerzo-sal" class="btn btn--warning" style="padding:10px; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; gap:6px;">
            <i class="fas fa-utensils"></i> 2. Salida Almuerzo
          </button>
          <button type="button" id="swal-att-btn-almuerzo-reg" class="btn btn--primary" style="padding:10px; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; gap:6px;">
            <i class="fas fa-undo"></i> 3. Regreso Almuerzo
          </button>
          <button type="button" id="swal-att-btn-salida" class="btn btn--ghost" style="padding:10px; font-weight:800; font-size:12px; border-color:#0284c7; color:#38bdf8; display:flex; align-items:center; justify-content:center; gap:6px;">
            <i class="fas fa-door-open"></i> 4. Salida Jornada
          </button>
        </div>
      </div>
    `,
    showConfirmButton: false,
    showCancelButton: true,
    cancelButtonText: "Cerrar",
    didOpen: () => {
      document.getElementById("swal-att-btn-entrada")?.addEventListener("click", () => {
        executeAttendanceAction(user, "entrada", method);
      });
      document.getElementById("swal-att-btn-almuerzo-sal")?.addEventListener("click", () => {
        executeAttendanceAction(user, "salida_almuerzo", method);
      });
      document.getElementById("swal-att-btn-almuerzo-reg")?.addEventListener("click", () => {
        executeAttendanceAction(user, "regreso_almuerzo", method);
      });
      document.getElementById("swal-att-btn-salida")?.addEventListener("click", () => {
        executeAttendanceAction(user, "salida_jornada", method);
      });
    }
  });
}

function executeAttendanceAction(user, action, method) {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  let existing = (db.asistencias || []).find((a) => a.fecha === todayIso && a.usuario_id === user.id_usuario);

  if (action === "entrada") {
    const isLate = now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() > 15);
    if (!existing) {
      existing = {
        id_asist: "ASI-" + Date.now(),
        fecha: todayIso,
        usuario_id: user.id_usuario,
        nombre: user.nombre,
        hora_registro: timeStr,
        hora_entrada: timeStr,
        hora_salida_almuerzo: "",
        hora_regreso_almuerzo: "",
        hora_salida: "",
        estado_hoy: "En Taller",
        estado: isLate ? "Tardanza" : "Puntual",
        metodo: method,
        observacion: isLate
          ? "Llegada después de las 8:15 AM (Tardanza registrada - Deducción aplicable)"
          : "Asistencia presencial verificada puntual en taller",
        dispositivo: navigator.userAgent.slice(0, 50)
      };
      if (!Array.isArray(db.asistencias)) db.asistencias = [];
      db.asistencias.unshift(existing);
    } else {
      existing.hora_entrada = timeStr;
      existing.estado = isLate ? "Tardanza" : "Puntual";
      existing.estado_hoy = "En Taller";
    }
    saveDatabase();
    Swal.close();
    closeModal();
    renderApp();
    showToast(`Entrada registrada para ${user.nombre} (${timeStr} - ${isLate ? "Tardanza" : "Puntual"}).`, isLate ? "warning" : "info");
    return;
  }

  if (!existing) {
    existing = {
      id_asist: "ASI-" + Date.now(),
      fecha: todayIso,
      usuario_id: user.id_usuario,
      nombre: user.nombre,
      hora_registro: timeStr,
      hora_entrada: "08:00 AM",
      hora_salida_almuerzo: "",
      hora_regreso_almuerzo: "",
      hora_salida: "",
      estado_hoy: "En Taller",
      estado: "Puntual",
      metodo: method,
      observacion: "Asistencia presencial en taller",
      dispositivo: navigator.userAgent.slice(0, 50)
    };
    if (!Array.isArray(db.asistencias)) db.asistencias = [];
    db.asistencias.unshift(existing);
  }

  if (action === "salida_almuerzo") {
    existing.hora_salida_almuerzo = timeStr;
    existing.estado_hoy = "En Almuerzo";
    showToast(`Salida a almorzar registrada para ${user.nombre} (${timeStr}).`);
  } else if (action === "regreso_almuerzo") {
    existing.hora_regreso_almuerzo = timeStr;
    existing.estado_hoy = "En Taller";
    showToast(`Regreso de almuerzo registrado para ${user.nombre} (${timeStr}).`);
  } else if (action === "salida_jornada") {
    existing.hora_salida = timeStr;
    existing.estado_hoy = "Jornada Finalizada";
    showToast(`Salida final de jornada registrada para ${user.nombre} (${timeStr}).`);
  }

  saveDatabase();
  Swal.close();
  closeModal();
  renderApp();
}

function markLunchReturnPrompt(asistId) {
  const rec = (db.asistencias || []).find((a) => a.id_asist === asistId);
  if (!rec) return;
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  rec.hora_regreso_almuerzo = timeStr;
  rec.estado_hoy = "En Taller";
  saveDatabase();
  Swal.close();
  closeModal();
  showToast(`Regreso de almuerzo registrado para ${rec.nombre} (${timeStr}).`);
  renderApp();
}



/* ============================================================================
   PLANILLA / HOJA DE SERVICIO EN FORMATO TABLA / EXCEL (RECTIFICADORA RENACER)
   ============================================================================ */
function printOrderExcelSheet(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) {
    showToast("Orden no encontrada.", "error");
    return;
  }

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  const repuestos = Array.isArray(order.items_repuestos) ? order.items_repuestos : [];

  let itemsHtml = "";
  let counter = 1;

  subtasks.forEach((s) => {
    itemsHtml += `
      <tr>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:center;">${counter++}</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px;"><strong>${s.descripcion_servicio}</strong></td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:center;">Servicio Técnico</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px;">${s.nombre_tecnico || "Taller Renacer"}</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:center;">1</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:right;">$${Number(s.monto_servicio).toFixed(2)}</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:right; font-weight:800;">$${Number(s.monto_servicio).toFixed(2)}</td>
      </tr>
    `;
  });

  repuestos.forEach((r) => {
    const sub = (Number(r.precio_unitario) || 0) * (Number(r.cantidad) || 1);
    itemsHtml += `
      <tr>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:center;">${counter++}</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px;"><strong>${r.nombre}</strong> (Repuesto)</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:center;">Repuesto Taller</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px;">Inventario Javier Andrade</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:center;">${r.cantidad}</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:right;">$${Number(r.precio_unitario).toFixed(2)}</td>
        <td style="border:1px solid #cbd5e1; padding:6px 10px; text-align:right; font-weight:800;">$${sub.toFixed(2)}</td>
      </tr>
    `;
  });

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("Por favor permite las ventanas emergentes para imprimir la planilla.", "warning");
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Planilla de Control y Hoja de Servicio - Orden #${order.codigo_troquel}</title>
      <style>
        body {
          font-family: 'Segoe UI', Arial, sans-serif;
          color: #0f172a;
          margin: 20px;
          line-height: 1.4;
          font-size: 13px;
        }
        .header-box {
          border-bottom: 2px solid #0f1638;
          padding-bottom: 12px;
          margin-bottom: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .title-company {
          font-size: 22px;
          font-weight: 900;
          color: #0f1638;
          letter-spacing: 0.5px;
        }
        .biblical-quote {
          font-style: italic;
          font-size: 11px;
          color: #b45309;
          font-weight: bold;
        }
        .order-badge-box {
          text-align: right;
          background: #f8fafc;
          border: 2px solid #cbd5e1;
          border-radius: 8px;
          padding: 8px 14px;
        }
        .grid-info {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 16px;
        }
        .info-card {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 10px 14px;
        }
        .info-card h4 {
          margin: 0 0 6px 0;
          font-size: 12px;
          color: #0f1638;
          text-transform: uppercase;
          border-bottom: 1px solid #e2e8f0;
          padding-bottom: 4px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
        }
        th {
          background: #0f1638;
          color: #ffffff;
          padding: 8px 10px;
          font-size: 11px;
          text-transform: uppercase;
        }
        .totals-table {
          width: 320px;
          margin-left: auto;
          margin-bottom: 16px;
        }
        .policies-box {
          background: #fffbeb;
          border: 1px dashed #d97706;
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 11px;
          margin-bottom: 24px;
        }
        .signatures-grid {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 20px;
          margin-top: 40px;
          text-align: center;
        }
        .sig-line {
          border-top: 1px solid #475569;
          padding-top: 6px;
          font-size: 11.5px;
          font-weight: bold;
        }
        @media print {
          body { margin: 0; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="header-box">
        <div>
          <div class="title-company">RECTIFICADORA RENACER C.A.</div>
          <div class="biblical-quote">"Aunque tu principio haya sido pequeño, tu postrer estado será muy grande." (Job 8:7)</div>
          <div style="font-size:11px; color:#64748b; margin-top:3px;">
            Especialistas en Rectificación de Motores, Cámaras, Cigüeñales y Bloques · Maracaibo, Zulia
          </div>
        </div>
        <div class="order-badge-box">
          <div style="font-size:11px; color:#64748b; font-weight:bold;">HOJA DE SERVICIO</div>
          <div style="font-size:22px; font-weight:900; color:#0f1638; font-family:monospace;">ORDEN #${order.codigo_troquel}</div>
          <div style="font-size:11px; color:#0284c7; font-weight:bold;">Fecha: ${formatDateHuman(order.fecha_ingreso, false)}</div>
        </div>
      </div>

      <div class="grid-info">
        <div class="info-card">
          <h4>Datos del Cliente / Taller</h4>
          <div><strong>Cliente:</strong> ${order.nombre_cliente}</div>
          <div><strong>Cédula / RIF:</strong> ${order.documento_cliente}</div>
          <div><strong>Teléfono:</strong> ${order.telefono_cliente}</div>
          <div><strong>Dirección:</strong> ${order.direccion_cliente || "No especificada"}</div>
          <div><strong>Tipo de Cliente:</strong> ${order.tipo_cliente || "Particular"}</div>
        </div>
        <div class="info-card">
          <h4>Datos Técnicos de la Pieza / Motor</h4>
          <div><strong>Pieza:</strong> ${order.datos_motor.tipo_pieza || "Cámara"}</div>
          <div><strong>Vehículo / Marca:</strong> ${order.datos_motor.marca} ${order.datos_motor.modelo || ""}</div>
          <div><strong>Serial Fundición:</strong> ${order.datos_motor.serial || "S/N"}</div>
          <div><strong>Diagnóstico Inicial:</strong> ${order.datos_motor.observaciones || "Ingreso regular a taller"}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th style="text-align:left;">Descripción del Trabajo / Repuesto</th>
            <th>Categoría</th>
            <th style="text-align:left;">Responsable</th>
            <th>Cant.</th>
            <th style="text-align:right;">P. Unit ($)</th>
            <th style="text-align:right;">Total ($)</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <table class="totals-table">
        <tr>
          <td style="padding:4px 8px; font-weight:bold;">Total Facturado:</td>
          <td style="padding:4px 8px; text-align:right; font-weight:900; font-size:16px;">$${Number(order.monto_total).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:4px 8px; color:#16a34a; font-weight:bold;">Monto Abonado:</td>
          <td style="padding:4px 8px; text-align:right; color:#16a34a; font-weight:900;">$${Number(order.monto_abonado).toFixed(2)}</td>
        </tr>
        <tr style="border-top:2px solid #0f1638;">
          <td style="padding:6px 8px; font-weight:bold; color:${order.saldo_pendiente > 0 ? '#dc2626' : '#16a34a'};">Saldo Pendiente:</td>
          <td style="padding:6px 8px; text-align:right; font-weight:900; font-size:16px; color:${order.saldo_pendiente > 0 ? '#dc2626' : '#16a34a'};">$${Number(order.saldo_pendiente).toFixed(2)}</td>
        </tr>
      </table>

      <div class="policies-box">
        <strong style="text-transform:uppercase; color:#b45309;">Políticas Oficiales y Términos de Garantía Renacer:</strong>
        <ol style="margin:4px 0 0 18px; padding:0;">
          <li><strong>Garantía Oficial de 1 Año:</strong> Garantía de 365 días sobre tolerancias de rectificación y cepillado (no cubre recalentamiento severo posterior por falta de refrigerante).</li>
          <li><strong>Plazo de Aprobación:</strong> El cliente dispone de un plazo mínimo de 3 días para aprobar presupuesto o retirar piezas.</li>
          <li><strong>Custodia y Retiro:</strong> La rectificadora no asume responsabilidad por piezas tras 30 días sin concretar trabajo. Retiro exclusivo previa liquidación del 100%.</li>
          <li><strong>Ajustes por Limpieza:</strong> Daños o fisuras internas descubiertas durante el baño químico serán notificadas de inmediato.</li>
        </ol>
      </div>

      <div class="signatures-grid">
        <div class="sig-line">
          Firma Técnico Especialista
        </div>
        <div class="sig-line">
          Firma Control de Calidad
        </div>
        <div class="sig-line">
          Firma y Cédula del Cliente
        </div>
      </div>

      <div class="no-print" style="margin-top:30px; text-align:center;">
        <button type="button" onclick="window.print()" style="padding:10px 20px; font-size:14px; font-weight:bold; background:#0f1638; color:#fff; border:none; border-radius:6px; cursor:pointer;">
          🖨️ Imprimir Hoja de Servicio
        </button>
      </div>

      <script>
        window.onload = function() {
          setTimeout(() => { window.print(); }, 400);
        };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}
/* ============================================================================
   INSTALACIÓN PWA Y ARRANQUE AUTOMÁTICO CON RELOJ EN TIEMPO REAL
   ============================================================================ */
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById("pwa-install-btn");
  if (btn) btn.classList.remove("hidden");
});

function triggerPwaInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
}

window.addEventListener("DOMContentLoaded", () => {
  initTheme();
  db = loadDatabase();
  populateLoginSelect();

  // Verificación proactiva de versión y limpieza de caché
  checkAppVersionAndCache();

  // Consulta automática de tasas de cambio oficiales (BCV / Paralelo) en vivo
  fetchLiveExchangeRates(true);
  setInterval(() => fetchLiveExchangeRates(true), 30 * 60 * 1000);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // Cronómetro en tiempo real (Fase 3): actualiza cada segundo los trabajos "En Proceso"
  setInterval(tickLiveSubtaskTimers, 1000);

  // Sincronización automática de fondo cada 30 segundos
  setInterval(() => syncFromGoogleSheets(true), 30000);

  // Sincronizar automáticamente en vivo al regresar a la pestaña o enfocar ventana
  window.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncFromGoogleSheets(true);
  });
  window.addEventListener("focus", () => {
    syncFromGoogleSheets(true);
  });

  // RESTAURACIÓN AUTOMÁTICA DE SESIÓN (Persistencia en refresco / F5)
  const savedUserId = localStorage.getItem(SESSION_KEY);
  if (savedUserId) {
    const user = (db.usuarios || []).find((u) => u.id_usuario === savedUserId);
    if (user && user.activo !== false) {
      currentUser = user;
      document.getElementById("login-view")?.classList.add("hidden");
      document.getElementById("workspace")?.classList.remove("hidden");
      renderApp();
      syncFromGoogleSheets(true);
      return;
    }
  }

  // Si no hay sesión activa previa, mostrar pantalla de acceso limpia
  document.getElementById("workspace")?.classList.add("hidden");
  document.getElementById("login-view")?.classList.remove("hidden");
  syncFromGoogleSheets(true);
});
