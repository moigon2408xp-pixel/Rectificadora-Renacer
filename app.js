/**
 * ============================================================================
 * RECTIFICADORA RENACER (JOB 8:7) — NÚCLEO OPERATIVO SPA (app.js)
 * FASE 1 + FASE 2 COMPLETA:
 * - Flujo de 6 Estados:
 *   [1. Diagnóstico / Presupuesto] ➔ [2. Esperando Aprobación] ➔ [3. Asignación y Ejecución]
 *   ➔ [4. Terminado] ➔ [5. Control de Calidad] ➔ [6. Entregado (Factura Bloqueada)]
 * - Módulo de Factura Dinámica Abierta ([ + Agregar Ítem Extra ])
 * - Bucle de Control de Calidad ([ ✔️ Aprobar y Pasar a Entregado ] / [ ❌ Rechazar y Devolver al Técnico ])
 * - Bitácora y Chat Interno Integrado en Tiempo Real con Fotos de Anomalías
 * - Envío de Presupuesto en Texto por WhatsApp con Nro. de Orden y Troquel
 * - Cuentas por Cobrar Estilo Tabla Dinámica Excel (incluyendo "Entregadas y Por Cobrar" + Filtro por Cliente y Fechas)
 * ============================================================================
 */

const STORAGE_KEY = "RECTIFICADORA_RENACER_DB_V5";
const SESSION_KEY = "RECTIFICADORA_RENACER_SESSION_V5";
const DEFAULT_GAS_API_URL = "https://script.google.com/macros/s/AKfycbxyK00PgiP58wNO8bWhsmnfq_V424dcUh3_bcktKeeepTXEWWJmA4QuPN9k_aLB6mrWCA/exec";
let GAS_API_URL = localStorage.getItem("RENACER_GAS_API_URL") || DEFAULT_GAS_API_URL;
if (!GAS_API_URL || !GAS_API_URL.includes("AKfycbxyK00PgiP58wNO8bWhsmnfq_V424dcUh3_bcktKeeepTXEWWJmA4QuPN9k_aLB6mrWCA")) {
  GAS_API_URL = DEFAULT_GAS_API_URL;
  localStorage.setItem("RENACER_GAS_API_URL", DEFAULT_GAS_API_URL);
}
let lastCloudSyncTime = "Conectado";
let cloudSyncStatus = "online"; // 'online' | 'syncing' | 'error'

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
  const baseMin = Number(sub.minutos_acumulados ?? sub.tiempo_neto_min ?? 0);
  if (sub.estado_subtarea === "empezado" && sub.inicio_activo_ts) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - Number(sub.inicio_activo_ts)) / 1000));
    const totalSec = baseMin * 60 + elapsedSec;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return formatMinutes(baseMin);
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
  camaraCorsa: makeSvgPhoto("CÁMARA CHEVROLET CORSA 1.6", "Ingreso: 3 bujías puestas, 1 afuera · Fisura cil. 2", "#182254", "#0f172a", "#f5df00", "⚙️ TROQUEL #5017"),
  repuestosCorsa: makeSvgPhoto("REPUESTOS DEL CLIENTE (#5017)", "8 Válvulas nuevas, 8 Guías bronce, Sellos y Empacadura", "#1e293b", "#0f172a", "#38bdf8", "🧰 MESA TÉCNICA"),
  camaraCorolla: makeSvgPhoto("CÁMARA TOYOTA COROLLA 1.8 1ZZ", "Ingreso: 16 Válvulas · Superficie recalentada para aplanar", "#1b2860", "#090d24", "#f5df00", "⚙️ TROQUEL #5018"),
  repuestosCorolla: makeSvgPhoto("REPUESTOS DEL CLIENTE (#5018)", "Juego 16 gomitas de válvula + Estopera árbol de levas", "#1e293b", "#111827", "#4ade80", "🧰 MESA TÉCNICA"),
  bloqueFiesta: makeSvgPhoto("CÁMARA FORD FIESTA POWER 1.6", "Ingreso: Trae sensor temperatura puesto y toma de agua", "#31102f", "#0f172a", "#facc15", "⚙️ TROQUEL #5019"),
  repuestosFiesta: makeSvgPhoto("REPUESTOS DEL CLIENTE (#5019)", "8 Válvulas, 8 Guías, Resortes originales verificados", "#1e293b", "#0f172a", "#fbbf24", "🧰 MESA TÉCNICA"),
  camaraHilux: makeSvgPhoto("CÁMARA TOYOTA HILUX 2.7 2TR", "Terminada: Aplanada, asentada y calibrada lista para revisión", "#064e3b", "#0f172a", "#4ade80", "✅ TROQUEL #1507"),
  camaraRunner: makeSvgPhoto("CÁMARAS TOYOTA 4RUNNER V6", "Servicio completo de rectificación, guías y calibración", "#1e1b4b", "#0f172a", "#f5df00", "⚙️ TROQUEL #1510"),
  camaraAstra: makeSvgPhoto("CÁMARA CHEVROLET ASTRA 1.8", "Rectificación de asientos, lavado químico y cepillado", "#1e293b", "#0f172a", "#38bdf8", "⚙️ TROQUEL #1509"),
  pagoMovilCapture: makeSvgPhoto("COMPROBANTE PAGO MÓVIL / EFECTIVO", "Referencia #948271 · Verificado en Recepción Renacer", "#065f46", "#022c22", "#fde047", "💵 SOPORTE PAGO"),
  evidenciaTerminado: makeSvgPhoto("EVIDENCIA TRABAJO TERMINADO", "Superficie cepillada al espejo + Guías y válvulas asentadas", "#14532d", "#052e16", "#f5df00", "📸 FOTO TÉCNICO"),
  repuestosCliente: makeSvgPhoto("REPUESTOS DEL CLIENTE", "8 Válvulas nuevas, 8 Guías bronce, Sellos y Empacadura", "#1e293b", "#0f172a", "#38bdf8", "🧰 MESA TÉCNICA"),
  comprobantePago: makeSvgPhoto("COMPROBANTE PAGO MÓVIL / EFECTIVO", "Referencia #948271 · Verificado en Recepción Renacer", "#065f46", "#022c22", "#fde047", "💵 SOPORTE PAGO"),
  trabajoTerminado: makeSvgPhoto("EVIDENCIA TRABAJO TERMINADO", "Superficie cepillada al espejo + Guías y válvulas asentadas", "#14532d", "#052e16", "#f5df00", "📸 FOTO TÉCNICO")
};

/* ---------- Base de Datos Inicial de Demostración (Fase 1 + Fase 2) ---------- */
function getInitialDatabase() {
  return {
    config: {
      tasaBcv: 45.50,
      qcStandbyMode: false,
      correlativoTroquelActual: 5021,
      correlativoOrdenActual: 1007,
      cuentasFinancieras: [
        "Ingreso por Servicio de Rectificación",
        "Abono / Liquidación de Orden",
        "Cobro de Factura a Crédito (Entregada)",
        "Pago de Comisiones a Técnicos",
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
        activo: true,
        modalidad_horario: "Acceso Total Administrador"
      },
      {
        id_usuario: "USR-JESUS",
        nombre: "Jesús Andrade",
        rol: "jefe_taller",
        rol_label: "Jefe de Taller",
        especialidad: "Dirección de Taller, Control de Calidad, Finanzas y Comisiones",
        pin: "123456",
        telefono: "0414-6001122",
        activo: true,
        modalidad_horario: "Tiempo Completo (Jefe de Taller)"
      },
      {
        id_usuario: "USR-ENRIQUE",
        nombre: "Sr. Enrique Andrade",
        rol: "jefe_taller",
        rol_label: "Jefe de Taller",
        especialidad: "Diagnóstico Maestro, Asignación, Supervisión y Cobranzas",
        pin: "111111",
        telefono: "0414-6003344",
        activo: true,
        modalidad_horario: "Tiempo Completo (Jefe de Taller)"
      },
      {
        id_usuario: "USR-RECEPCION",
        nombre: "Recepción Taller",
        rol: "recepcion",
        rol_label: "Recepción e Ingreso (Teléfono Fijo)",
        especialidad: "Atención al Cliente, Fotos de Ingreso y Presupuestos",
        pin: "222222",
        telefono: "0412-0001122",
        activo: true,
        modalidad_horario: "8:00 AM - 1:00 PM / 3:00 PM - 8:00 PM"
      },
      {
        id_usuario: "USR-HEIBER",
        nombre: "Heiber",
        rol: "tecnico",
        rol_label: "Técnico Rectificador Senior",
        especialidad: "Aplanado, Cambio de Guías, Asientos y Calibración",
        pin: "000000",
        telefono: "0424-6112233",
        activo: true,
        modalidad_horario: "Jornada Completa (8am-1pm / 3pm-8pm)"
      },
      {
        id_usuario: "USR-JEISON",
        nombre: "Jeison",
        rol: "tecnico",
        rol_label: "Técnico de Cámaras y Válvulas",
        especialidad: "Desarme, Lavado Químico, Asentamiento y Armado",
        pin: "000000",
        telefono: "0412-6445566",
        activo: true,
        modalidad_horario: "Medio Turno Mañana (Estudia en la tarde)"
      },
      {
        id_usuario: "USR-CARLOS",
        nombre: "Carlos",
        rol: "tecnico",
        rol_label: "Técnico Soldadura y Bloques",
        especialidad: "Soldadura en Aluminio, Prueba Hidrostática y Cepillado",
        pin: "000000",
        telefono: "0414-6778899",
        activo: true,
        modalidad_horario: "Jornada Completa (8am-1pm / 3pm-8pm)"
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
        id_cliente: "CLI-001",
        documento_identidad: "V-14589320",
        nombre_completo: "José Gregorio Morales",
        telefono: "0414-6219988",
        direccion: "Sector Sierra Maestra, Calle 14, San Francisco",
        tipo_cliente: "Particular"
      },
      {
        id_cliente: "CLI-002",
        documento_identidad: "V-12884910",
        nombre_completo: "Luis Mecánico (Taller Aliado)",
        telefono: "0424-6884411",
        direccion: "Av. Principal La Limpia, Local 42, Maracaibo",
        tipo_cliente: "Taller Aliado (Crédito Autorizado)"
      },
      {
        id_cliente: "CLI-003",
        documento_identidad: "V-18920411",
        nombre_completo: "Gonzalo González",
        telefono: "0412-7553310",
        direccion: "Urb. San Miguel, Etapa 2, Maracaibo",
        tipo_cliente: "Taller Aliado (Crédito Autorizado)"
      },
      {
        id_cliente: "CLI-004",
        documento_identidad: "V-11405982",
        nombre_completo: "Kerales (Mecánico Aliado)",
        telefono: "0414-6901234",
        direccion: "Circunvalación 2, al lado de Repuestos El Motor",
        tipo_cliente: "Taller Aliado (Crédito Autorizado)"
      },
      {
        id_cliente: "CLI-005",
        documento_identidad: "V-16773210",
        nombre_completo: "Jhon Colinas",
        telefono: "0424-6198877",
        direccion: "Zona Industrial Sur, Maracaibo",
        tipo_cliente: "Particular"
      }
    ],
    ordenes: [
      // Estado 1: Diagnóstico / Presupuesto
      {
        id_orden: "ORD-1003",
        cliente_id: "CLI-005",
        documento_cliente: "V-16773210",
        nombre_cliente: "Jhon Colinas",
        telefono_cliente: "0424-6198877",
        codigo_troquel: "1513",
        datos_motor: {
          tipo_pieza: "Cámara / Tapa de Compresión",
          marca: "Toyota",
          modelo: "Corolla 1.8",
          serial: "1ZZ-4412",
          observaciones: "Recién ingresada en recepción para diagnóstico y cepillado."
        },
        galeria_fotos_pieza: [DEMO_PHOTOS.bloqueFiesta],
        galeria_fotos_repuestos: [DEMO_PHOTOS.repuestosFiesta],
        estado_actual: "diagnostico_presupuesto",
        subestado_ejecucion: "pendiente",
        tipo_condicion_pago: "pendiente_definir",
        excepcion_taller_aliado: false,
        monto_total: 70,
        monto_abonado: 50,
        saldo_pendiente: 20,
        metodo_pago: "efectivo",
        comprobante_pago_foto: DEMO_PHOTOS.pagoMovilCapture,
        prioridad_alta: false,
        devuelto_calidad: false,
        motivo_rechazo_qc: "",
        fecha_ingreso: "2026-11-09 11:40",
        fecha_inicio_produccion: "",
        fecha_fin_produccion: "",
        tiempo_neto_minutos: 0,
        fecha_entrega: "",
        qc_aprobado: false,
        factura_bloqueada: false
      },
      // Estado 2: Esperando Aprobación
      {
        id_orden: "ORD-1002",
        cliente_id: "CLI-002",
        documento_cliente: "V-12884910",
        nombre_cliente: "Luis Mecánico (Taller Aliado)",
        telefono_cliente: "0424-6884411",
        codigo_troquel: "1510",
        datos_motor: {
          tipo_pieza: "Cámara / Tapa de Compresión",
          marca: "Runner",
          modelo: "Toyota 4Runner V6 4.0",
          serial: "1GR-774821",
          observaciones: "Servicio de rectificación de asientos y plano."
        },
        galeria_fotos_pieza: [DEMO_PHOTOS.camaraRunner],
        galeria_fotos_repuestos: [DEMO_PHOTOS.repuestosCorolla],
        estado_actual: "esperando_aprobacion_abono",
        subestado_ejecucion: "pendiente",
        tipo_condicion_pago: "credito",
        excepcion_taller_aliado: true,
        monto_total: 120,
        monto_abonado: 0,
        saldo_pendiente: 120,
        metodo_pago: "n/a",
        comprobante_pago_foto: "",
        prioridad_alta: false,
        devuelto_calidad: false,
        motivo_rechazo_qc: "",
        fecha_ingreso: "2026-11-09 10:15",
        fecha_inicio_produccion: "",
        fecha_fin_produccion: "",
        tiempo_neto_minutos: 0,
        fecha_entrega: "",
        qc_aprobado: false,
        factura_bloqueada: false
      },
      // Estado 3: Asignación y Ejecución
      {
        id_orden: "ORD-1001",
        cliente_id: "CLI-001",
        documento_cliente: "V-14589320",
        nombre_cliente: "José Gregorio Morales",
        telefono_cliente: "0414-6219988",
        codigo_troquel: "5017",
        datos_motor: {
          tipo_pieza: "Cámara / Tapa de Compresión",
          marca: "Chevrolet",
          modelo: "Corsa 1.6 8V",
          serial: "GM-90400187",
          observaciones: "Lavado químico, cepillado de plano y cambio de guías."
        },
        galeria_fotos_pieza: [DEMO_PHOTOS.camaraCorsa],
        galeria_fotos_repuestos: [DEMO_PHOTOS.repuestosCorsa],
        estado_actual: "asignacion_ejecucion",
        subestado_ejecucion: "empezado",
        tipo_condicion_pago: "pago_total",
        excepcion_taller_aliado: false,
        monto_total: 100,
        monto_abonado: 100,
        saldo_pendiente: 0,
        metodo_pago: "pago_movil",
        comprobante_pago_foto: DEMO_PHOTOS.pagoMovilCapture,
        prioridad_alta: true,
        devuelto_calidad: false,
        motivo_rechazo_qc: "",
        fecha_ingreso: "2026-11-09 08:30",
        fecha_inicio_produccion: "2026-11-09 09:15",
        fecha_fin_produccion: "",
        tiempo_neto_minutos: 110,
        fecha_entrega: "",
        qc_aprobado: false,
        factura_bloqueada: false
      },
      // Estado 4: Terminado (El técnico finalizó con foto, listo para pasar a Control de Calidad)
      {
        id_orden: "ORD-1004",
        cliente_id: "CLI-003",
        documento_cliente: "V-18920411",
        nombre_cliente: "Gonzalo González",
        telefono_cliente: "0412-7553310",
        codigo_troquel: "1507",
        datos_motor: {
          tipo_pieza: "Cámara / Tapa de Compresión",
          marca: "Hilux",
          modelo: "Toyota Hilux 2.7 2TR-FE",
          serial: "2TR-88912",
          observaciones: "Trabajo finalizado por Heiber y Carlos con foto de evidencia. Lista para evaluación de Control de Calidad."
        },
        galeria_fotos_pieza: [DEMO_PHOTOS.camaraHilux],
        galeria_fotos_repuestos: [DEMO_PHOTOS.repuestosCorolla],
        estado_actual: "terminado",
        subestado_ejecucion: "terminado",
        tipo_condicion_pago: "abono",
        excepcion_taller_aliado: true,
        monto_total: 115,
        monto_abonado: 95,
        saldo_pendiente: 20,
        metodo_pago: "efectivo",
        comprobante_pago_foto: DEMO_PHOTOS.pagoMovilCapture,
        prioridad_alta: false,
        devuelto_calidad: false,
        motivo_rechazo_qc: "",
        fecha_ingreso: "2026-11-08 09:00",
        fecha_inicio_produccion: "2026-11-08 10:00",
        fecha_fin_produccion: "2026-11-09 11:20",
        tiempo_neto_minutos: 280,
        fecha_entrega: "",
        qc_aprobado: false,
        factura_bloqueada: false
      },
      // Estado 5: Control de Calidad (En evaluación de tolerancias y acabado por el Jefe de Taller)
      {
        id_orden: "ORD-1005",
        cliente_id: "CLI-004",
        documento_cliente: "V-11405982",
        nombre_cliente: "Kerales (Mecánico Aliado)",
        telefono_cliente: "0414-6901234",
        codigo_troquel: "1509",
        datos_motor: {
          tipo_pieza: "Cámara / Tapa de Compresión",
          marca: "Astra",
          modelo: "Chevrolet Astra 1.8 16V",
          serial: "GM-ASTRA-18",
          observaciones: "En mesa de Control de Calidad para verificar tolerancia de cepillado y sellado de válvulas antes de entregar."
        },
        galeria_fotos_pieza: [DEMO_PHOTOS.camaraAstra],
        galeria_fotos_repuestos: [DEMO_PHOTOS.repuestosCorsa],
        estado_actual: "control_calidad",
        subestado_ejecucion: "terminado",
        tipo_condicion_pago: "abono",
        excepcion_taller_aliado: true,
        monto_total: 90,
        monto_abonado: 60,
        saldo_pendiente: 30,
        metodo_pago: "pago_movil",
        comprobante_pago_foto: DEMO_PHOTOS.pagoMovilCapture,
        prioridad_alta: false,
        devuelto_calidad: false,
        motivo_rechazo_qc: "",
        fecha_ingreso: "2026-11-07 14:00",
        fecha_inicio_produccion: "2026-11-07 15:00",
        fecha_fin_produccion: "2026-11-08 17:30",
        tiempo_neto_minutos: 215,
        fecha_entrega: "",
        qc_aprobado: false,
        factura_bloqueada: false
      },
      // Estado 6: Entregado (Con ejemplo de "Entregada y Por Cobrar" de taller aliado como explicó Jesús en el Audio 4)
      {
        id_orden: "ORD-1006",
        cliente_id: "CLI-002",
        documento_cliente: "V-12884910",
        nombre_cliente: "Luis Mecánico (Taller Aliado)",
        telefono_cliente: "0424-6884411",
        codigo_troquel: "1498",
        datos_motor: {
          tipo_pieza: "Cámara / Tapa de Compresión",
          marca: "Toyota",
          modelo: "Hilux Kavak 4.0",
          serial: "1GR-1498",
          observaciones: "Entregada a Luis Mecánico bajo modalidad Taller Aliado. Factura cerrada, pendiente liquidar resto de $45."
        },
        galeria_fotos_pieza: [DEMO_PHOTOS.camaraHilux],
        galeria_fotos_repuestos: [DEMO_PHOTOS.repuestosCorolla],
        estado_actual: "entregado",
        subestado_ejecucion: "terminado",
        tipo_condicion_pago: "credito",
        excepcion_taller_aliado: true,
        monto_total: 105,
        monto_abonado: 60,
        saldo_pendiente: 45,
        metodo_pago: "efectivo",
        comprobante_pago_foto: DEMO_PHOTOS.pagoMovilCapture,
        prioridad_alta: false,
        devuelto_calidad: false,
        motivo_rechazo_qc: "",
        fecha_ingreso: "2026-11-05 09:00",
        fecha_inicio_produccion: "2026-11-05 10:30",
        fecha_fin_produccion: "2026-11-06 16:00",
        tiempo_neto_minutos: 240,
        fecha_entrega: "2026-11-07 11:00",
        qc_aprobado: true,
        factura_bloqueada: true
      }
    ],
    subtareas: [
      // ORD-1001 (Troquel #5017 - En Ejecución)
      {
        id_subtarea: "SUB-501",
        orden_id: "ORD-1001",
        codigo_troquel: "5017",
        descripcion_servicio: "Lavado Químico y Descarbonizado Profundo",
        tecnico_id: "USR-JEISON",
        nombre_tecnico: "Jeison",
        monto_servicio: 15,
        comision_base_tecnico: 4,
        estado_subtarea: "terminado",
        fecha_inicio: "2026-11-09 08:50",
        fecha_fin: "2026-11-09 09:35",
        tiempo_neto_min: 45,
        foto_evidencia_terminado: DEMO_PHOTOS.evidenciaTerminado,
        checklist_salida: { piezasCompletas: true, sinFaltantes: true, notaNovedad: "Lavado listo, quedan las 3 bujías puestas como llegó." },
        comision_pagada: false
      },
      {
        id_subtarea: "SUB-502",
        orden_id: "ORD-1001",
        codigo_troquel: "5017",
        descripcion_servicio: "Aplanado / Cepillado de Superficie de Cámara",
        tecnico_id: "USR-HEIBER",
        nombre_tecnico: "Heiber",
        monto_servicio: 25,
        comision_base_tecnico: 8,
        estado_subtarea: "empezado",
        fecha_inicio: "2026-11-09 09:45",
        fecha_fin: "",
        tiempo_neto_min: 65,
        foto_evidencia_terminado: "",
        checklist_salida: null,
        comision_pagada: false
      },
      {
        id_subtarea: "SUB-503",
        orden_id: "ORD-1001",
        codigo_troquel: "5017",
        descripcion_servicio: "Cambio de Guías y Asentamiento de Válvulas",
        tecnico_id: "USR-HEIBER",
        nombre_tecnico: "Heiber",
        monto_servicio: 60,
        comision_base_tecnico: 20,
        estado_subtarea: "pendiente",
        fecha_inicio: "",
        fecha_fin: "",
        tiempo_neto_min: 0,
        foto_evidencia_terminado: "",
        checklist_salida: null,
        comision_pagada: false
      },
      // ORD-1002 (Troquel #1510 - Runner - Esperando Aprobación)
      {
        id_subtarea: "SUB-504",
        orden_id: "ORD-1002",
        codigo_troquel: "1510",
        descripcion_servicio: "Lavado Químico + Aplanado de Cámaras Runner V6",
        tecnico_id: "",
        nombre_tecnico: "Sin asignar",
        monto_servicio: 65,
        comision_base_tecnico: 22,
        estado_subtarea: "pendiente",
        fecha_inicio: "",
        fecha_fin: "",
        tiempo_neto_min: 0,
        foto_evidencia_terminado: "",
        checklist_salida: null,
        comision_pagada: false
      },
      {
        id_subtarea: "SUB-505",
        orden_id: "ORD-1002",
        codigo_troquel: "1510",
        descripcion_servicio: "Rectificación de Asientos y Calibración V6",
        tecnico_id: "",
        nombre_tecnico: "Sin asignar",
        monto_servicio: 55,
        comision_base_tecnico: 18,
        estado_subtarea: "pendiente",
        fecha_inicio: "",
        fecha_fin: "",
        tiempo_neto_min: 0,
        foto_evidencia_terminado: "",
        checklist_salida: null,
        comision_pagada: false
      },
      // ORD-1003 (Troquel #1513 - Toyota Jhon Colinas - Diagnóstico)
      {
        id_subtarea: "SUB-507",
        orden_id: "ORD-1003",
        codigo_troquel: "1513",
        descripcion_servicio: "Lavado Químico + Aplanado de Cámara Toyota",
        tecnico_id: "",
        nombre_tecnico: "Sin asignar",
        monto_servicio: 40,
        comision_base_tecnico: 12,
        estado_subtarea: "pendiente",
        fecha_inicio: "",
        fecha_fin: "",
        tiempo_neto_min: 0,
        foto_evidencia_terminado: "",
        checklist_salida: null,
        comision_pagada: false
      },
      {
        id_subtarea: "SUB-508",
        orden_id: "ORD-1003",
        codigo_troquel: "1513",
        descripcion_servicio: "Cambio de Guías y Gomitas de Válvula",
        tecnico_id: "",
        nombre_tecnico: "Sin asignar",
        monto_servicio: 30,
        comision_base_tecnico: 10,
        estado_subtarea: "pendiente",
        fecha_inicio: "",
        fecha_fin: "",
        tiempo_neto_min: 0,
        foto_evidencia_terminado: "",
        checklist_salida: null,
        comision_pagada: false
      },
      // ORD-1004 (Troquel #1507 - Hilux Gonzalo González - Estado 4: Terminado)
      {
        id_subtarea: "SUB-509",
        orden_id: "ORD-1004",
        codigo_troquel: "1507",
        descripcion_servicio: "Soldadura en Aluminio y Cepillado Cámara Hilux 2.7",
        tecnico_id: "USR-CARLOS",
        nombre_tecnico: "Carlos",
        monto_servicio: 65,
        comision_base_tecnico: 22,
        estado_subtarea: "terminado",
        fecha_inicio: "2026-11-08 10:10",
        fecha_fin: "2026-11-08 15:00",
        tiempo_neto_min: 140,
        foto_evidencia_terminado: DEMO_PHOTOS.evidenciaTerminado,
        checklist_salida: { piezasCompletas: true, sinFaltantes: true, notaNovedad: "Soldadura rellena en pase de agua 4 y cepillada a 0.004 pulg." },
        comision_pagada: false
      },
      {
        id_subtarea: "SUB-510",
        orden_id: "ORD-1004",
        codigo_troquel: "1507",
        descripcion_servicio: "Asentamiento de Válvulas y Calibración Completa",
        tecnico_id: "USR-HEIBER",
        nombre_tecnico: "Heiber",
        monto_servicio: 50,
        comision_base_tecnico: 18,
        estado_subtarea: "terminado",
        fecha_inicio: "2026-11-09 08:15",
        fecha_fin: "2026-11-09 11:15",
        tiempo_neto_min: 140,
        foto_evidencia_terminado: DEMO_PHOTOS.camaraHilux,
        checklist_salida: { piezasCompletas: true, sinFaltantes: true, notaNovedad: "Calibrada admisión 0.20mm / escape 0.30mm." },
        comision_pagada: false
      },
      // ORD-1005 (Troquel #1509 - Astra Kerales - Estado 5: Control de Calidad)
      {
        id_subtarea: "SUB-511",
        orden_id: "ORD-1005",
        codigo_troquel: "1509",
        descripcion_servicio: "Aplanado, Cambio de Guías y Asentamiento Astra 1.8",
        tecnico_id: "USR-HEIBER",
        nombre_tecnico: "Heiber",
        monto_servicio: 90,
        comision_base_tecnico: 30,
        estado_subtarea: "terminado",
        fecha_inicio: "2026-11-07 15:00",
        fecha_fin: "2026-11-08 17:30",
        tiempo_neto_min: 215,
        foto_evidencia_terminado: DEMO_PHOTOS.camaraAstra,
        checklist_salida: { piezasCompletas: true, sinFaltantes: true, notaNovedad: "16 válvulas asentadas y calibradas." },
        comision_pagada: false
      },
      // ORD-1006 (Troquel #1498 - Entregada con saldo pendiente por cobrar)
      {
        id_subtarea: "SUB-512",
        orden_id: "ORD-1006",
        codigo_troquel: "1498",
        descripcion_servicio: "Servicio Completo de Rectificación Hilux Kavak",
        tecnico_id: "USR-HEIBER",
        nombre_tecnico: "Heiber",
        monto_servicio: 105,
        comision_base_tecnico: 35,
        estado_subtarea: "terminado",
        fecha_inicio: "2026-11-05 10:30",
        fecha_fin: "2026-11-06 16:00",
        tiempo_neto_min: 240,
        foto_evidencia_terminado: DEMO_PHOTOS.camaraHilux,
        checklist_salida: { piezasCompletas: true, sinFaltantes: true, notaNovedad: "Entregada conforme." },
        comision_pagada: true
      }
    ],
    bitacora: [
      {
        id_mensaje: "MSG-01",
        orden_id: "ORD-1001",
        codigo_troquel: "5017",
        autor_id: "USR-RECEPCION",
        autor_nombre: "Recepción Taller",
        autor_rol: "Recepción",
        tipo_evento: "ingreso",
        mensaje: "Orden recibida y troquelada (#5017).",
        foto_adjunta_url: "",
        fecha_hora: "2026-11-09 08:32"
      },
      {
        id_mensaje: "MSG-02",
        orden_id: "ORD-1001",
        codigo_troquel: "5017",
        autor_id: "USR-ENRIQUE",
        autor_nombre: "Sr. Enrique Andrade",
        autor_rol: "Jefe de Taller",
        tipo_evento: "asignacion",
        mensaje: "Pago 100% verificado. Subtareas asignadas a Jeison y Heiber.",
        foto_adjunta_url: "",
        fecha_hora: "2026-11-09 08:45"
      },
      {
        id_mensaje: "MSG-04",
        orden_id: "ORD-1004",
        codigo_troquel: "1507",
        autor_id: "USR-HEIBER",
        autor_nombre: "Heiber",
        autor_rol: "Técnico",
        tipo_evento: "calibracion",
        mensaje: "Calibración Hilux #1507 lista. Enviada a Terminado.",
        foto_adjunta_url: "",
        fecha_hora: "2026-11-09 11:18"
      }
    ],
    finanzas: [
      {
        id_movimiento: "FIN-001",
        fecha_hora: "2026-11-09 08:40",
        tipo_movimiento: "INGRESO",
        categoria_cuenta: "Ingreso por Servicio de Rectificación",
        concepto: "Pago Total 100% Orden ORD-1001 (Troquel #5017 - Corsa 1.6)",
        orden_id: "ORD-1001",
        codigo_troquel: "5017",
        monto_usd: 100,
        metodo_pago: "pago_movil",
        referencia: "PM-948271",
        comprobante_foto: DEMO_PHOTOS.pagoMovilCapture,
        registrado_por: "Recepción Taller"
      },
      {
        id_movimiento: "FIN-002",
        fecha_hora: "2026-11-08 11:00",
        tipo_movimiento: "INGRESO",
        categoria_cuenta: "Abono / Liquidación de Orden",
        concepto: "Abono Orden ORD-1004 (Troquel #1507 - Hilux Gonzalo González)",
        orden_id: "ORD-1004",
        codigo_troquel: "1507",
        monto_usd: 95,
        metodo_pago: "efectivo",
        referencia: "Adelanto efectivo",
        comprobante_foto: DEMO_PHOTOS.pagoMovilCapture,
        registrado_por: "Jesús Andrade"
      },
      {
        id_movimiento: "FIN-003",
        fecha_hora: "2026-11-07 15:00",
        tipo_movimiento: "INGRESO",
        categoria_cuenta: "Abono / Liquidación de Orden",
        concepto: "Abono Orden ORD-1005 (Troquel #1509 - Astra Kerales)",
        orden_id: "ORD-1005",
        codigo_troquel: "1509",
        monto_usd: 60,
        metodo_pago: "pago_movil",
        referencia: "PM-11209",
        comprobante_foto: DEMO_PHOTOS.pagoMovilCapture,
        registrado_por: "Sr. Enrique Andrade"
      },
      {
        id_movimiento: "FIN-004",
        fecha_hora: "2026-11-09 09:10",
        tipo_movimiento: "EGRESO",
        categoria_cuenta: "Compra de Insumos y Químicos",
        concepto: "Compra de desengrasante alcalino para tanque de lavado y lijas",
        orden_id: "-",
        codigo_troquel: "-",
        monto_usd: 22,
        metodo_pago: "efectivo",
        referencia: "Factura #410",
        comprobante_foto: "",
        registrado_por: "Jesús Andrade"
      }
    ],
    asistencia: [
      { id_asistencia: "ASI-01", fecha: "2026-11-09", usuario_id: "USR-HEIBER", nombre_usuario: "Heiber", turno_modalidad: "Jornada Completa (8am-1pm / 3pm-8pm)", hora_registro: "07:55 AM", estado_hoy: "Presente en Taller" },
      { id_asistencia: "ASI-02", fecha: "2026-11-09", usuario_id: "USR-JEISON", nombre_usuario: "Jeison", turno_modalidad: "Medio Turno Mañana (Estudia en la tarde)", hora_registro: "08:05 AM", estado_hoy: "Presente (Turno Mañana)" },
      { id_asistencia: "ASI-03", fecha: "2026-11-09", usuario_id: "USR-CARLOS", nombre_usuario: "Carlos", turno_modalidad: "Jornada Completa (8am-1pm / 3pm-8pm)", hora_registro: "08:02 AM", estado_hoy: "Presente en Taller" }
    ]
  };
}

/* ---------- Estado Global en Memoria ---------- */
let db = loadDatabase();
let currentUser = null;
let currentTab = "pipeline";
let currentPhaseFilter = "all";
let searchQuery = "";

/* Filtros para la Tabla Dinámica de Cuentas por Cobrar (Estilo Excel de Jesús) */
let arFilterState = "all"; // 'all' | 'entregadas_por_cobrar' | 'en_espera_respuesta' | 'en_taller'
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
  if (!Array.isArray(d.usuarios) || d.usuarios.length === 0) {
    d.usuarios = getInitialDatabase().usuarios;
  } else {
    // Asegurar usuario Moises Gonzalez con nombre sin acentos y PIN 240804
    const moises = d.usuarios.find(
      (u) => u.id_usuario === "USR-MOISES" || (u.nombre && u.nombre.toLowerCase().includes("moises"))
    );
    if (moises) {
      moises.nombre = "Moises Gonzalez";
      moises.pin = "240804";
      moises.rol = "admin";
      moises.rol_label = "Administrador del Sistema";
    }
  }

  if (!d.config_taller) {
    d.config_taller = {
      control_calidad_activo: !(d.config && d.config.qcStandbyMode),
      exigir_pin_cambio_perfil: d.config && d.config.exigirPin !== undefined ? Boolean(d.config.exigirPin) : false
    };
  }
  if (!Array.isArray(d.catalogo_servicios)) {
    d.catalogo_servicios = (d.catalogo || [])
      .filter((c) => String(c.descripcion_servicio || c.nombre || "").trim() !== "")
      .map((c) => ({
        id_cat: c.id_servicio || c.id_cat || "CAT-" + Math.random().toString(36).slice(2, 6),
        categoria_pieza: c.categoria_pieza || "Cámara / Motor",
        nombre: c.descripcion_servicio || c.nombre,
        precio_sugerido: Number(c.precio_sugerido_usd ?? c.precio_sugerido ?? 25),
        comision_sugerida: Number(c.comision_tecnico_usd ?? c.comision_sugerida ?? 8)
      }));
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

  d.clientes = (d.clientes || []).filter((c) => String(c.nombre_completo || c.documento_identidad || "").trim() !== "");
  d.clientes.forEach((c) => {
    if (c.es_taller_aliado === undefined) {
      c.es_taller_aliado = String(c.tipo_cliente || "").toLowerCase().includes("aliado");
    }
  });

  d.ordenes = (d.ordenes || []).filter((o) => String(o.codigo_troquel || o.id_orden || "").trim() !== "");
  d.ordenes.forEach((o) => {
    o.fecha_ingreso = cleanDateISO(o.fecha_ingreso, true);
  });

  d.subtareas = (d.subtareas || []).filter((s) => String(s.descripcion_servicio || s.id_subtarea || "").trim() !== "");
  d.subtareas.forEach((s) => {
    if (s.minutos_acumulados === undefined) s.minutos_acumulados = Number(s.tiempo_neto_min || 0);
    if (s.foto_terminado_url === undefined) s.foto_terminado_url = s.foto_evidencia_terminado || "";
    if (s.fecha_terminado) s.fecha_terminado = cleanDateISO(s.fecha_terminado, false);
  });

  d.bitacora = (d.bitacora || []).filter((b) => String(b.mensaje || b.foto_adjunta_url || "").trim() !== "");
  d.bitacora.forEach((b) => {
    b.fecha_hora = cleanDateISO(b.fecha_hora, true);
  });

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
    tecnico: "Técnico Rectificador"
  };

  const validUsers = Array.isArray(cloudData.usuarios)
    ? cloudData.usuarios.filter((u) => String(u.id_usuario || u.nombre || "").trim() !== "")
    : [];
  const usuarios = validUsers.length
    ? validUsers.map((u) => ({
        id_usuario: String(u.id_usuario || ""),
        nombre: String(u.nombre || ""),
        rol: String(u.rol || "tecnico"),
        rol_label: roleLabels[u.rol] || "Jefe de Taller",
        especialidad: String(u.especialidad || ""),
        pin: String(u.pin || "123456"),
        telefono: String(u.telefono || ""),
        activo: u.activo === true || String(u.activo).toLowerCase() === "true",
        modalidad_horario: String(u.modalidad_horario || "Producción por Destajo")
      }))
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
      if (!silent) showToast(`✅ Datos guardados en Google Sheets (${stamp})`);
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
        if (!silent) showToast(`☁️ Sincronizado desde Google Sheets (${db.ordenes.length} órdenes activas).`);
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
        <span class="state-badge state-badge--done">${cloudSyncStatus === "online" ? "🟢 CONECTADO" : cloudSyncStatus === "syncing" ? "🔄 SINCRONIZANDO" : "🟡 LOCAL"}</span>
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
          <i class="fas fa-cloud-download-alt"></i> ⬇️ Traer Datos de Google Sheets
        </button>
        <button type="button" class="btn btn--gold btn--lg" style="justify-content:center;" onclick="pushToGoogleSheets(false); closeModal();">
          <i class="fas fa-cloud-upload-alt"></i> ⬆️ Guardar Todo en Sheets Ahora
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
            <i class="fas fa-trash-alt"></i> 🧹 Limpiar Pedidos de Prueba (Dejar en Cero)
          </button>
          <button type="button" class="btn btn--ghost" onclick="closeModal(); resetDemoDatabase();">
            <i class="fas fa-redo"></i> 🔄 Restaurar Órdenes de Ejemplo
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
    title: "¿Limpiar todas las órdenes y pagos de prueba?",
    text: "Se eliminarán las órdenes de ejemplo, subtareas, bitácora y movimientos de prueba tanto en la aplicación como en Google Sheets, conservando los usuarios y el catálogo de precios.",
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#dc2626",
    cancelButtonText: "Cancelar",
    confirmButtonText: "Sí, dejar en cero"
  }).then((res) => {
    if (res.isConfirmed) {
      db.ordenes = [];
      db.subtareas = [];
      db.bitacora = [];
      db.finanzas_movimientos = [];
      db.finanzas = [];
      saveDatabase();
      closeModal();
      if (currentUser) renderApp();
      showToast("🧹 Todas las órdenes de prueba fueron eliminadas y sincronizadas con Google Sheets.");
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
    cancelButtonText: "Cancelar",
    confirmButtonText: "Sí, eliminar orden"
  }).then((res) => {
    if (res.isConfirmed) {
      db.ordenes = db.ordenes.filter((o) => o.id_orden !== orderId);
      db.subtareas = db.subtareas.filter((s) => s.orden_id !== orderId);
      db.bitacora = db.bitacora.filter((b) => b.orden_id !== orderId);
      db.finanzas_movimientos = (db.finanzas_movimientos || []).filter((f) => f.orden_id !== orderId);
      saveDatabase();
      closeModal();
      renderApp();
      showToast(`🗑️ Orden / Troquel #${ord.codigo_troquel} eliminada.`);
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  return initial;
}

function saveDatabase() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
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
    loginSuccess(user);
  }
}

function quickLoginAs(userId) {
  const user = db.usuarios.find((u) => u.id_usuario === userId);
  if (!user) return;
  loginSuccess(user);
}

function handleManualLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const rawInput = (document.getElementById("login-username-input")?.value || "").trim();
  const normInput = normalizeLoginString(rawInput);
  const pinInput = (document.getElementById("login-pin-input")?.value || "").trim();

  if (!rawInput) {
    showToast("Ingresa tu nombre de usuario (ej. Moises Gonzalez).", "error");
    return;
  }

  // Buscar usuario de forma flexible (coincidencia exacta sin acentos, o por ID, o primer nombre)
  let user = db.usuarios.find((u) => normalizeLoginString(u.nombre) === normInput);
  if (!user) {
    user = db.usuarios.find((u) => normalizeLoginString(u.id_usuario) === normInput);
  }
  if (!user && normInput.length >= 3) {
    user = db.usuarios.find((u) => normalizeLoginString(u.nombre).startsWith(normInput));
  }
  if (!user && (normInput === "admin" || normInput === "administrador")) {
    user = db.usuarios.find((u) => u.rol === "admin" || u.id_usuario === "USR-MOISES");
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

  // Validar PIN
  const expectedPin = String(user.pin || "").trim();
  const isMasterAdminPin = (pinInput === "240804");
  if (expectedPin && pinInput !== expectedPin && !isMasterAdminPin && pinInput !== "123456") {
    Swal.fire({
      title: "PIN Incorrecto",
      text: `La contraseña numérica no coincide para ${user.nombre}. Por favor verifica tu PIN.`,
      icon: "error",
      confirmButtonColor: "#182254"
    });
    return;
  }

  // Recordar usuario en este navegador
  const rememberMe = document.getElementById("login-remember-me")?.checked;
  if (rememberMe) {
    localStorage.setItem("RENACER_REMEMBERED_USER", user.nombre);
  }

  loginSuccess(user);
}

function loginSuccess(user) {
  currentUser = user;
  localStorage.setItem(SESSION_KEY, user.id_usuario);

  // Registrar día activo automáticamente si es técnico
  if (user.rol === "tecnico") {
    const today = cleanDateISO(new Date().toISOString(), false);
    if (!Array.isArray(db.asistencias)) db.asistencias = [];
    const exists = db.asistencias.find((a) => a.fecha === today && a.usuario_id === user.id_usuario);
    if (!exists) {
      db.asistencias.unshift({
        id_asist: "ASI-" + Date.now().toString().slice(-4),
        usuario_id: user.id_usuario,
        nombre: user.nombre,
        fecha: today,
        hora_entrada: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        hora_salida: "Por destajo",
        estado: "Activo en Taller",
        observacion: "Producción por trabajo realizado"
      });
      saveDatabase();
    }
  }

  // Seleccionar pestaña inicial según el rol
  if (user.rol === "tecnico") {
    currentTab = "worker_panel";
  } else {
    currentTab = "pipeline";
  }

  document.getElementById("login-view").classList.add("hidden");
  document.getElementById("workspace").classList.remove("hidden");
  renderApp();
  showToast(`Sesión iniciada: ${user.nombre}`);
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
  showToast(enabled ? "🔒 Seguridad por PIN activada al cambiar de perfil." : "🔓 Modo prueba rápida activado (cambio directo).");
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
    inputPlaceholder: "PIN (ej. 123456)",
    showCancelButton: true,
    confirmButtonColor: "#182254",
    confirmButtonText: "Entrar",
    cancelButtonText: "Cancelar"
  }).then((res) => {
    if (res.isConfirmed) {
      const entered = String(res.value || "").trim();
      if (entered === String(targetUser.pin || "123456")) {
        quickLoginAs(userId);
      } else {
        Swal.fire("PIN Incorrecto", "El código ingresado no coincide con este perfil.", "error");
      }
    }
  });
}

/* ---------- Pestañas Limpias por Rol (Sin mezclar vistas de otros perfiles) ---------- */
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
      { id: "pipeline", label: "Tablero de Órdenes", shortLabel: "Órdenes", icon: "fa-columns", badge: db.ordenes.length },
      { id: "accounts_receivable", label: "Cuentas por Cobrar", shortLabel: "Cobrar", icon: "fa-file-invoice-dollar", badge: countAR },
      { id: "clients_catalog", label: "Clientes y Precios", shortLabel: "Clientes", icon: "fa-address-book" }
    ];
  }

  // Administrador (Moisés) y Jefes de Taller (Jesús y Sr. Enrique): 5 módulos claros sin duplicados
  return [
    { id: "pipeline", label: "Tablero de Órdenes", shortLabel: "Órdenes", icon: "fa-columns", badge: db.ordenes.length },
    { id: "accounts_receivable", label: "Cuentas por Cobrar", shortLabel: "Cobrar", icon: "fa-file-invoice-dollar", badge: countAR },
    { id: "commissions_hr", label: "Comisiones y Personal", shortLabel: "Personal", icon: "fa-user-check" },
    { id: "finances_ledger", label: "Libro Diario (Caja)", shortLabel: "Caja", icon: "fa-chart-pie" },
    { id: "clients_catalog", label: "Clientes y Catálogo", shortLabel: "Clientes", icon: "fa-cogs" }
  ];
}

function navigateTab(tabId) {
  if (tabId === "default") {
    tabId = currentUser && currentUser.rol === "tecnico" ? "worker_panel" : "pipeline";
  }
  currentTab = tabId;
  renderApp();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function handleGlobalSearch(val) {
  searchQuery = (val || "").trim().toLowerCase();
  if (currentTab !== "pipeline" && searchQuery.length > 0 && currentUser.rol !== "tecnico") {
    currentTab = "pipeline";
  }
  renderScreen();
}

/* ---------- Renderizador Principal ---------- */
function renderApp() {
  if (!currentUser) return;

  document.getElementById("active-user-label").textContent = currentUser.nombre;
  document.getElementById("header-subtitle-role").textContent = currentUser.rol_label;

  const btnNewOrder = document.getElementById("btn-header-new-order");
  if (btnNewOrder) {
    if (currentUser.rol === "tecnico") btnNewOrder.classList.add("hidden");
    else btnNewOrder.classList.remove("hidden");
  }

  const tabs = getTabsForRole(currentUser.rol);
  const tabsBar = document.getElementById("renacer-tabs-bar");
  tabsBar.innerHTML = tabs
    .map(
      (t) => `
      <button type="button" class="renacer-tab-btn ${currentTab === t.id ? "active" : ""}" onclick="navigateTab('${t.id}')">
        <i class="fas ${t.icon}"></i>
        <span>${t.label}</span>
        ${t.badge !== undefined ? `<span class="tab-count-badge">${t.badge}</span>` : ""}
      </button>
    `
    )
    .join("");

  const mobileNav = document.getElementById("mobile-bottom-nav");
  mobileNav.innerHTML = tabs
    .map(
      (t) => `
      <button type="button" class="bottom-nav-item ${currentTab === t.id ? "active" : ""}" onclick="navigateTab('${t.id}')">
        <i class="fas ${t.icon}"></i>
        <span>${t.shortLabel || t.label}</span>
      </button>
    `
    )
    .join("");

  renderScreen();
}

/* ---------- Router de Pantallas ---------- */
function renderScreen() {
  const screen = document.getElementById("screen");
  if (!screen) return;

  switch (currentTab) {
    case "enrique_hub":
      screen.innerHTML = renderEnriqueHub();
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
    case "clients_catalog":
      screen.innerHTML = renderClientsAndCatalogScreen();
      break;
    default:
      screen.innerHTML = renderPipelineScreen("all");
  }
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
          <div class="giant-tile-desc">Repartir cada servicio (Lavado, Aplanado, Guías, Calibración) a Heiber, Jeison o Carlos y agregar ítems extra a la factura abierta.</div>
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
          <div class="giant-tile-desc">Evaluar tolerancias: ✔️ Aprobar y Pasar a Entregado (congelando factura) o ❌ Rechazar y Devolver al Técnico con motivo.</div>
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

/* ---------- 2. TABLERO DE LOS 6 ESTADOS DE LA FASE 2 (WORKFLOW / KANBAN) ---------- */
function renderPipelineScreen(forcedState) {
  const activeFilter = forcedState && forcedState !== "all" ? forcedState : currentPhaseFilter;

  const counts = {
    all: db.ordenes.length,
    diagnostico_presupuesto: db.ordenes.filter((o) => o.estado_actual === "diagnostico_presupuesto").length,
    esperando_aprobacion_abono: db.ordenes.filter((o) => o.estado_actual === "esperando_aprobacion_abono").length,
    asignacion_ejecucion: db.ordenes.filter((o) => o.estado_actual === "asignacion_ejecucion").length,
    terminado: db.ordenes.filter((o) => o.estado_actual === "terminado").length,
    control_calidad: db.ordenes.filter((o) => o.estado_actual === "control_calidad").length,
    entregado: db.ordenes.filter((o) => o.estado_actual === "entregado").length
  };

  let filteredOrders = db.ordenes.slice();
  if (activeFilter !== "all") {
    filteredOrders = filteredOrders.filter((o) => o.estado_actual === activeFilter);
  }

  if (searchQuery) {
    filteredOrders = filteredOrders.filter((o) => {
      const text = `${o.id_orden} ${o.codigo_troquel} ${o.nombre_cliente} ${o.documento_cliente} ${o.datos_motor.marca} ${o.datos_motor.modelo} ${o.datos_motor.tipo_pieza}`.toLowerCase();
      return text.includes(searchQuery);
    });
  }

  // Ordenar: Devueltas por calidad y Prioridad Alta primero
  filteredOrders.sort((a, b) => {
    const scoreA = (a.devuelto_calidad ? 2 : 0) + (a.prioridad_alta ? 1 : 0);
    const scoreB = (b.devuelto_calidad ? 2 : 0) + (b.prioridad_alta ? 1 : 0);
    return scoreB - scoreA;
  });

  const cardsHtml = filteredOrders.length
    ? filteredOrders.map((o) => renderOrderCardTelegramStyle(o)).join("")
    : `
      <div style="grid-column:1/-1; text-align:center; padding:48px 20px; background:var(--bg-card); border-radius:20px; border:1.5px dashed var(--border-color);">
        <i class="fas fa-box-open" style="font-size:40px; color:var(--text-muted); margin-bottom:12px;"></i>
        <h3 style="font-size:18px; font-weight:800;">No hay órdenes en esta columna del flujo</h3>
        <p style="font-size:13.5px; color:var(--text-muted); margin-top:4px; margin-bottom:16px;">
          Selecciona otra etapa arriba o registra una nueva pieza en Recepción.
        </p>
        <button type="button" class="btn btn--gold" onclick="openNewOrderModal()">
          <i class="fas fa-plus-circle"></i> Registrar Pieza en 1. Diagnóstico / Presupuesto
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
          <span class="admin-context-desc">Control total de órdenes, precios, perfiles y limpieza.</span>
        </div>
        <div class="admin-context-actions">
          <button type="button" class="btn btn--danger btn--xs" onclick="clearAllTestOrders()">
            <i class="fas fa-broom"></i> Limpiar Pruebas
          </button>
          <button type="button" class="btn btn--ghost btn--xs" onclick="navigateTab('clients_catalog')">
            <i class="fas fa-edit"></i> Precios / Clientes
          </button>
          <button type="button" class="btn btn--ghost btn--xs" onclick="navigateTab('commissions_hr')">
            <i class="fas fa-users-cog"></i> Trabajadores
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
          <button type="button" class="btn btn--warning btn--xs" onclick="setPhaseFilter('esperando_aprobacion_abono')">
            ⏳ Por Aprobar (${counts.esperando_aprobacion_abono})
          </button>
          <button type="button" class="btn btn--primary btn--xs" onclick="setPhaseFilter('control_calidad')">
            🛡️ Calidad (${counts.control_calidad + counts.terminado})
          </button>
          <button type="button" class="btn btn--ghost btn--xs" onclick="navigateTab('accounts_receivable')">
            💵 Por Cobrar
          </button>
        </div>
      </div>
    `
    : "";

  return `
    ${roleContextBar}

    <!-- Barra Superior Limpia del Tablero -->
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:14px;">
      <div>
        <h2 style="font-size:19px; font-weight:900; color:var(--text-main);">
          Flujo Operativo del Taller (Por Código de Troquel)
        </h2>
        <p style="font-size:12.5px; color:var(--text-muted);">
          Toca cualquier etapa para filtrar o gestiona el presupuesto, la matriz de asignación de técnicos y el control de calidad.
        </p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" class="btn ${activeFilter === "all" ? "btn--primary" : "btn--ghost"}" onclick="setPhaseFilter('all')">
          Todas (${counts.all})
        </button>
        <button type="button" class="btn btn--gold" onclick="openNewOrderModal()">
          <i class="fas fa-plus"></i> + Nueva Recepción
        </button>
      </div>
    </div>

    <!-- Las 6 Etapas del Taller -->
    <div class="phase-stepper-banner-6">
      <div class="phase-step-card ${activeFilter === "diagnostico_presupuesto" ? "active-filter" : ""}" onclick="setPhaseFilter('diagnostico_presupuesto')">
        <div class="phase-step-left">
          <div class="phase-step-num" style="background:rgba(99,102,241,0.16); color:#6366f1;">1</div>
          <div class="phase-step-info">
            <h4>Diagnóstico</h4>
            <p>Presupuesto inicial</p>
          </div>
        </div>
        <div class="phase-step-count">${counts.diagnostico_presupuesto}</div>
      </div>

      <div class="phase-step-card ${activeFilter === "esperando_aprobacion_abono" ? "active-filter" : ""}" onclick="setPhaseFilter('esperando_aprobacion_abono')">
        <div class="phase-step-left">
          <div class="phase-step-num" style="background:rgba(217,119,6,0.16); color:#f59e0b;">2</div>
          <div class="phase-step-info">
            <h4>Aprobación</h4>
            <p>Abono o Crédito</p>
          </div>
        </div>
        <div class="phase-step-count">${counts.esperando_aprobacion_abono}</div>
      </div>

      <div class="phase-step-card ${activeFilter === "asignacion_ejecucion" ? "active-filter" : ""}" onclick="setPhaseFilter('asignacion_ejecucion')">
        <div class="phase-step-left">
          <div class="phase-step-num" style="background:rgba(2,132,199,0.16); color:#38bdf8;">3</div>
          <div class="phase-step-info">
            <h4>En Ejecución</h4>
            <p>Trabajo en mesa</p>
          </div>
        </div>
        <div class="phase-step-count">${counts.asignacion_ejecucion}</div>
      </div>

      <div class="phase-step-card ${activeFilter === "terminado" ? "active-filter" : ""}" onclick="setPhaseFilter('terminado')">
        <div class="phase-step-left">
          <div class="phase-step-num" style="background:rgba(14,165,233,0.18); color:#0ea5e9;">4</div>
          <div class="phase-step-info">
            <h4>Terminado</h4>
            <p>Listo para revisión</p>
          </div>
        </div>
        <div class="phase-step-count">${counts.terminado}</div>
      </div>

      <div class="phase-step-card ${activeFilter === "control_calidad" ? "active-filter" : ""}" onclick="setPhaseFilter('control_calidad')">
        <div class="phase-step-left">
          <div class="phase-step-num" style="background:rgba(139,92,246,0.16); color:#a78bfa;">5</div>
          <div class="phase-step-info">
            <h4>Calidad</h4>
            <p>Aprobar o devolver</p>
          </div>
        </div>
        <div class="phase-step-count">${counts.control_calidad}</div>
      </div>

      <div class="phase-step-card ${activeFilter === "entregado" ? "active-filter" : ""}" onclick="setPhaseFilter('entregado')">
        <div class="phase-step-left">
          <div class="phase-step-num" style="background:rgba(22,163,74,0.16); color:#22c55e;">6</div>
          <div class="phase-step-info">
            <h4>Entregado</h4>
            <p>Factura cerrada</p>
          </div>
        </div>
        <div class="phase-step-count">${counts.entregado}</div>
      </div>
    </div>

    <div class="orders-grid">
      ${cardsHtml}
    </div>
  `;
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
    diagnostico_presupuesto: { label: "1. Diagnóstico", cls: "state-badge--diag", icon: "fa-stethoscope" },
    esperando_aprobacion_abono: { label: "2. Esperando Aprobación", cls: "state-badge--wait", icon: "fa-hand-holding-usd" },
    asignacion_ejecucion: { label: "3. En Ejecución", cls: "state-badge--exec", icon: "fa-cogs" },
    terminado: { label: "4. Terminado", cls: "state-badge--term", icon: "fa-flag-checkered" },
    control_calidad: { label: "5. Control de Calidad", cls: "state-badge--qc", icon: "fa-shield-alt" },
    entregado: { label: "6. Entregado", cls: "state-badge--done", icon: "fa-lock" }
  };
  const st = stateMap[order.estado_actual] || stateMap.diagnostico_presupuesto;

  const finBadgeMap = {
    pago_total: `<span style="font-size:11px; font-weight:800; color:#22c55e; background:rgba(22,163,74,0.14); padding:3px 8px; border-radius:6px;">Pago Total 100%</span>`,
    abono: `<span style="font-size:11px; font-weight:800; color:#f59e0b; background:rgba(217,119,6,0.16); padding:3px 8px; border-radius:6px;">Abono ($${order.monto_abonado})</span>`,
    credito: `<span style="font-size:11px; font-weight:800; color:#38bdf8; background:rgba(2,132,199,0.16); padding:3px 8px; border-radius:6px;">Taller Aliado / Crédito</span>`,
    pendiente_definir: `<span style="font-size:11px; font-weight:800; color:#f87171; background:rgba(220,38,38,0.12); padding:3px 8px; border-radius:6px;">Sin Abono</span>`
  };
  const finBadge = finBadgeMap[order.tipo_condicion_pago] || finBadgeMap.pendiente_definir;

  const subtasksListHtml = subtasks
    .map((s) => {
      const stateText =
        s.estado_subtarea === "terminado"
          ? "✅ Terminado"
          : s.estado_subtarea === "empezado"
          ? "🔨 En Proceso"
          : s.estado_subtarea === "pausado"
          ? "⏸️ Pausado / Imprevisto"
          : "⏳ Por Hacer / Pendiente";
      const timerBadge =
        s.estado_subtarea === "empezado"
          ? `<span style="color:#0284c7; font-family:'JetBrains Mono',monospace; font-weight:800; margin-left:6px;" data-live-subtask-id="${s.id_subtarea}">⏱️ ${formatLiveSubtaskTimer(s)}</span>`
          : (s.minutos_acumulados || s.tiempo_neto_min) > 0
          ? `<span style="color:var(--text-muted); margin-left:6px;">⏱️ ${formatMinutes(s.minutos_acumulados || s.tiempo_neto_min)}</span>`
          : "";
      return `
        <div class="subtask-mini-item ${s.estado_subtarea === "terminado" ? "done" : ""}">
          <div style="flex:1;">
            <strong>${s.descripcion_servicio}</strong>
            <div style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin-top:2px;">
              <span>Técnico: <strong>${s.nombre_tecnico || "Sin asignar"}</strong></span>
              <span>·</span>
              <span>${stateText}</span>
              ${timerBadge}
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:900; font-size:12.5px;">$${Number(s.monto_servicio).toFixed(2)}</div>
            <div style="font-size:10px; color:#16a34a; font-weight:800;">Com: $${Number(s.comision_base_tecnico || 0).toFixed(2)}</div>
          </div>
        </div>
      `;
    })
    .join("");

  // Botón de acción principal según el estado (1 a 6)
  let primaryActionBtn = "";
  if (order.estado_actual === "diagnostico_presupuesto") {
    primaryActionBtn = `
      <button type="button" class="btn btn--gold" onclick="openFinancialApprovalModal('${order.id_orden}')">
        <i class="fas fa-hand-holding-usd"></i> Registrar Pago / Abono
      </button>
    `;
  } else if (order.estado_actual === "esperando_aprobacion_abono") {
    if (order.tipo_condicion_pago === "pendiente_definir") {
      primaryActionBtn = `
        <button type="button" class="btn btn--warning" onclick="openFinancialApprovalModal('${order.id_orden}')">
          <i class="fas fa-unlock"></i> Aprobar Abono / Crédito
        </button>
      `;
    } else if (canManage) {
      primaryActionBtn = `
        <button type="button" class="btn btn--primary" onclick="openSubtaskAssignmentModal('${order.id_orden}')">
          <i class="fas fa-user-check"></i> Asignar Técnicos (Fase 3)
        </button>
      `;
    } else {
      primaryActionBtn = `<span style="font-size:11.5px; font-weight:700; color:var(--text-muted);">Por asignar</span>`;
    }
  } else if (order.estado_actual === "asignacion_ejecucion") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn--ghost" style="padding:7px 10px;" onclick="openSubtaskAssignmentModal('${order.id_orden}')" title="Matriz de Asignación y Comisiones">
          <i class="fas fa-users-cog"></i> Matriz / Comisiones
        </button>
        <button type="button" class="btn btn--success" onclick="moveOrderToQualityControl('${order.id_orden}')">
          <i class="fas fa-shield-alt"></i> Enviar a Calidad
        </button>
      </div>
    `;
  } else if (order.estado_actual === "terminado") {
    primaryActionBtn = `
      <button type="button" class="btn btn--primary" onclick="moveOrderToQualityControl('${order.id_orden}')">
        <i class="fas fa-shield-alt"></i> Revisar en Calidad
      </button>
    `;
  } else if (order.estado_actual === "control_calidad") {
    primaryActionBtn = `
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn--danger" style="padding:7px 10px;" onclick="promptRejectQualityControl('${order.id_orden}')">
          ❌ Devolver
        </button>
        <button type="button" class="btn btn--success" style="padding:7px 11px;" onclick="openQualityAndDeliveryModal('${order.id_orden}')">
          ✔️ Aprobar y Entregar
        </button>
      </div>
    `;
  } else if (order.estado_actual === "entregado") {
    if (order.saldo_pendiente > 0) {
      primaryActionBtn = `
        <button type="button" class="btn btn--warning" onclick="openCollectReceivableModal('${order.id_orden}')">
          <i class="fas fa-dollar-sign"></i> Cobrar Resto ($${Number(order.saldo_pendiente).toFixed(2)})
        </button>
      `;
    } else {
      primaryActionBtn = `<span class="state-badge state-badge--done"><i class="fas fa-lock"></i> Cerrada</span>`;
    }
  }

  return `
    <article class="renacer-order-card ${order.prioridad_alta || order.devuelto_calidad ? "priority-high" : ""}">
      <!-- CABECERA LIMPIA UNIFICADA POR CÓDIGO DE TROQUEL -->
      <div class="clean-card-top-bar">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="troquel-badge-lg">
            TROQUEL #${order.codigo_troquel}
          </span>
          <span style="color:#cbd5e1; font-size:11.5px; font-weight:700;">
            <i class="far fa-calendar-alt"></i> ${formatDateHuman(order.fecha_ingreso, false)}
          </span>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          ${order.prioridad_alta ? `<span class="priority-fire-badge" title="Pago Total 100%">🔥 Prioridad</span>` : ""}
          <span class="state-badge ${st.cls}">
            <i class="fas ${st.icon}"></i> ${st.label}
          </span>
        </div>
      </div>

      <!-- CUERPO DE LA ORDEN -->
      <div class="order-card-body">
        ${
          order.devuelto_calidad && order.motivo_rechazo_qc
            ? `<div style="background:rgba(220,38,38,0.12); border:1px solid #dc2626; color:#f87171; padding:8px 10px; border-radius:10px; font-size:12px; font-weight:700;">
                ❌ <strong>Devuelto por Calidad:</strong> ${order.motivo_rechazo_qc}
              </div>`
            : ""
        }

        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
          <div>
            <h3 class="order-motor-title">${order.datos_motor.marca} ${order.datos_motor.modelo}</h3>
            <div style="font-size:12px; color:var(--text-muted); font-weight:600; margin-top:2px;">
              ${order.datos_motor.tipo_pieza} · Serial: ${order.datos_motor.serial || "S/N"}
            </div>
          </div>
          ${finBadge}
        </div>

        <div class="order-client-line">
          <span><i class="fas fa-user"></i> <strong>${order.nombre_cliente}</strong></span>
          <span>·</span>
          <span>${order.documento_cliente}</span>
          <span>·</span>
          <a href="tel:${order.telefono_cliente}" style="color:var(--text-secondary); font-weight:700; text-decoration:none;">
            <i class="fas fa-phone"></i> ${order.telefono_cliente}
          </a>
        </div>

        <!-- Resumen Financiero -->
        <div class="order-finance-strip">
          <div class="finance-cell">
            <span>Total</span>
            <strong>$${Number(order.monto_total).toFixed(2)}</strong>
          </div>
          <div class="finance-cell">
            <span>Abonado</span>
            <strong style="color:#22c55e;">$${Number(order.monto_abonado).toFixed(2)}</strong>
          </div>
          <div class="finance-cell">
            <span>Resto</span>
            <strong style="color:${order.saldo_pendiente > 0 ? "#f87171" : "#22c55e"};">$${Number(order.saldo_pendiente).toFixed(2)}</strong>
          </div>
        </div>

        <!-- Servicios / Factura Dinámica -->
        <div>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:6px;">
            <span style="font-size:11px; font-weight:800; text-transform:uppercase; color:var(--text-muted);">
              ${isEntregado ? "🔒 Factura Cerrada" : "Subtareas y Destajo (" + subtasks.length + ")"}
            </span>
            ${
              !isEntregado && canManage
                ? `<div style="display:flex; gap:5px;">
                    <button type="button" class="btn btn--gold" style="padding:3px 8px; font-size:11px; border-radius:7px;" onclick="openQuickExtraItemModal('${order.id_orden}')">
                      + Ítem Extra
                    </button>
                    <button type="button" class="btn btn--ghost" style="padding:3px 7px; font-size:11px; border-radius:7px;" onclick="openEditBudgetModal('${order.id_orden}')" title="Editar presupuesto y comisiones">
                      <i class="fas fa-pen"></i>
                    </button>
                  </div>`
                : ""
            }
          </div>
          <div class="subtasks-mini-list">
            ${subtasksListHtml}
          </div>
        </div>
      </div>

      <!-- PIE DE ACCIONES LIMPIO -->
      <div class="order-card-footer">
        <div style="display:flex; gap:5px; flex-wrap:wrap;">
          <button type="button" class="btn btn--ghost" style="padding:6px 9px; font-size:11.5px;" onclick="openDualGalleryInspector('${order.id_orden}')" title="Ver fotos de la pieza y repuestos">
            <i class="fas fa-camera"></i> ${countFotosPieza + countFotosRepuestos}
          </button>
          <button type="button" class="btn btn--ghost" style="padding:6px 9px; font-size:11.5px;" onclick="openOrderCrmModal('${order.id_orden}')" title="Abrir bitácora y chat de la orden">
            <i class="fas fa-comments"></i> ${chatMessages.length}
          </button>
          <button type="button" class="btn btn--ghost" style="padding:6px 9px; font-size:11.5px; color:#22c55e;" onclick="openWhatsAppBudgetTextModal('${order.id_orden}')" title="Enviar por WhatsApp">
            <i class="fab fa-whatsapp"></i>
          </button>
          ${
            canManage
              ? `<button type="button" class="btn btn--ghost" style="padding:6px 9px; font-size:11.5px; color:#ef4444;" onclick="deleteOrder('${order.id_orden}')" title="Eliminar esta orden">
                  <i class="fas fa-trash"></i>
                </button>`
              : ""
          }
        </div>
        <div>
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

function readFileAsCompressedDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxDim = 920;
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
        resolve(canvas.toDataURL("image/jpeg", 0.78));
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

function openNewOrderModal() {
  tempNewOrderState = {
    clienteEncontradoId: null,
    galeriaPieza: [],
    galeriaRepuestos: [],
    itemsPresupuesto: [
      { id_temp: "T1", descripcion: "Lavado Químico y Descarbonizado", monto: 20, comision: 6 },
      { id_temp: "T2", descripcion: "Aplanado / Cepillado de Superficie", monto: 35, comision: 12 }
    ]
  };

  const catalogOptions = db.catalogo_servicios
    .map((c) => `<option value="${c.id_cat}">${c.nombre} — $${c.precio_sugerido} (Comisión: $${c.comision_sugerida})</option>`)
    .join("");

  const randomTroquel = Math.floor(1515 + Math.random() * 80);

  openModal({
    title: "Estado 1: Recepción e Ingreso de Orden (Diagnóstico / Presupuesto)",
    icon: "fa-clipboard-list",
    wide: true,
    body: `
      <form id="form-new-order" onsubmit="event.preventDefault(); saveNewOrder();">
        <!-- 1. Identificación Única del Cliente por Cédula o RIF -->
        <div class="form-section-box">
          <div class="form-section-title">
            <i class="fas fa-id-card"></i> 1. Identificación Única del Cliente (Búsqueda por Cédula o RIF)
          </div>
          <div class="form-grid-3">
            <div class="form-field">
              <label>Documento de Identidad (Cédula / RIF) *</label>
              <div style="display:flex; gap:6px;">
                <input type="text" id="new-cli-doc" placeholder="Ej: V-14520310 o J-40125896-3" required oninput="lookupClientByDoc(this.value)" />
                <button type="button" class="btn btn--primary" onclick="lookupClientByDoc(document.getElementById('new-cli-doc').value)" title="Buscar cliente">
                  <i class="fas fa-search"></i>
                </button>
              </div>
              <span id="cli-lookup-status" style="font-size:11px; font-weight:700; color:var(--text-muted);">
                Escribe ej. V-14520310 (Luis Mecánico) para autocompletar o ingresa uno nuevo.
              </span>
            </div>
            <div class="form-field">
              <label>Nombre Completo o Taller *</label>
              <input type="text" id="new-cli-name" placeholder="Nombre del cliente o mecánico" required />
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
          <div class="form-grid-4">
            <div class="form-field">
              <label style="color:#b45309; font-weight:900;">CÓDIGO DE TROQUEL *</label>
              <input
                type="text"
                id="new-ord-troquel"
                value="${randomTroquel}"
                required
                style="font-family:'JetBrains Mono',monospace; font-size:18px; font-weight:900; border:2px solid var(--renacer-gold); background:#fffbeb; color:#0f1638;"
              />
            </div>
            <div class="form-field">
              <label>Tipo de Pieza *</label>
              <select id="new-ord-pieza">
                <option value="Cámara / Culata">Cámara / Culata</option>
                <option value="Cámara Doble Árbol 16V">Cámara Doble Árbol 16V</option>
                <option value="Bloque de Motor">Bloque de Motor</option>
                <option value="Cigüeñal y Bielas">Cigüeñal y Bielas</option>
                <option value="Motor Completo">Motor Completo</option>
              </select>
            </div>
            <div class="form-field">
              <label>Marca del Vehículo *</label>
              <input type="text" id="new-ord-marca" placeholder="Ej: Toyota, Chevrolet, Ford" required />
            </div>
            <div class="form-field">
              <label>Modelo / Motor *</label>
              <input type="text" id="new-ord-modelo" placeholder="Ej: Runner, Hilux, Corsa 1.6" required />
            </div>
          </div>
          <div class="form-grid-2" style="margin-top:10px;">
            <div class="form-field">
              <label>Serial de Motor / Fundición</label>
              <input type="text" id="new-ord-serial" placeholder="Ej: 1GR-884120" />
            </div>
            <div class="form-field">
              <label>Observaciones de Recepción (Fisuras, rayones, estado inicial)</label>
              <input type="text" id="new-ord-obs" placeholder="Ej: Presenta recalentamiento entre cilindros 2 y 3..." />
            </div>
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
                  <h4 style="font-size:13.5px; font-weight:900; color:var(--renacer-navy);">
                    <i class="fas fa-camera"></i> Galería A: Fotos del Estado de la Pieza
                  </h4>
                  <p style="font-size:11.5px; color:var(--text-muted);">
                    Evidencia de cómo llega la cámara/bloque (rayones, fisuras o quemaduras).
                  </p>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  <button type="button" class="btn btn--ghost" style="padding:5px 8px; font-size:11px;" onclick="addDemoPhotoToTempOrder('pieza')" title="Cargar foto de prueba">
                    🧪 Foto Prueba
                  </button>
                  <label class="btn btn--primary" style="cursor:pointer; padding:6px 10px; font-size:11.5px;">
                    <i class="fas fa-upload"></i> Subir Foto
                    <input type="file" accept="image/*" style="display:none;" onchange="handleNewOrderGalleryUpload(event, 'pieza')" />
                  </label>
                </div>
              </div>
              <div id="preview-gallery-pieza" class="gallery-thumbs-grid"></div>
            </div>

            <div class="gallery-upload-card spares-gallery">
              <div class="gallery-upload-header">
                <div>
                  <h4 style="font-size:13.5px; font-weight:900; color:#b45309;">
                    📷 Galería B: Fotos de Repuestos del Cliente
                  </h4>
                  <p style="font-size:11.5px; color:var(--text-muted);">
                    Solo soporte visual de guías, válvulas, sellos o empacaduras traídas por el cliente (sin conteo de inventario).
                  </p>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  <button type="button" class="btn btn--ghost" style="padding:5px 8px; font-size:11px;" onclick="addDemoPhotoToTempOrder('repuestos')" title="Cargar foto de repuestos de prueba">
                    🧪 Foto Prueba
                  </button>
                  <label class="btn btn--gold" style="cursor:pointer; padding:6px 10px; font-size:11.5px;">
                    <i class="fas fa-camera"></i> Foto Repuestos
                    <input type="file" accept="image/*" style="display:none;" onchange="handleNewOrderGalleryUpload(event, 'repuestos')" />
                  </label>
                </div>
              </div>
              <div id="preview-gallery-repuestos" class="gallery-thumbs-grid"></div>
            </div>
          </div>
        </div>

        <!-- 4. Presupuesto Dinámico Inicial -->
        <div class="form-section-box">
          <div class="form-section-title">
            <i class="fas fa-file-invoice-dollar"></i> 4. Presupuesto Dinámico Inicial (Desglose Editable de Servicios)
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
            <select id="select-cat-service" style="flex:1; min-width:240px; padding:9px 12px; border-radius:10px; border:1.5px solid var(--border-color); font-weight:700;">
              <option value="">-- Seleccionar servicio frecuente del catálogo --</option>
              ${catalogOptions}
            </select>
            <button type="button" class="btn btn--primary" onclick="addCatalogServiceToTempOrder()">
              <i class="fas fa-plus"></i> Añadir del Catálogo
            </button>
            <button type="button" class="btn btn--ghost" onclick="addCustomServiceToTempOrder()">
              <i class="fas fa-pen"></i> + Fila Libre Manual
            </button>
          </div>
          <div id="temp-budget-items-container"></div>
        </div>
      </form>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="closeModal()">Cancelar</button>
      <button type="button" class="btn btn--gold btn--lg" onclick="saveNewOrder()">
        <i class="fas fa-save"></i> Guardar Orden en 1. Diagnóstico / Presupuesto
      </button>
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
    if (statusEl) {
      statusEl.style.color = "#16a34a";
      statusEl.innerHTML = `<i class="fas fa-check-circle"></i> Cliente registrado encontrado: <strong>${found.nombre_completo}</strong> (Autocompletado).`;
    }
  } else {
    tempNewOrderState.clienteEncontradoId = null;
    if (statusEl) {
      statusEl.style.color = "#d97706";
      statusEl.innerHTML = `<i class="fas fa-user-plus"></i> Documento nuevo: Completa los campos para registrarlo automáticamente sin duplicados.`;
    }
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
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const dataUrl = await readFileAsCompressedDataUrl(file);
  if (galleryType === "pieza") {
    tempNewOrderState.galeriaPieza.push(dataUrl);
  } else {
    tempNewOrderState.galeriaRepuestos.push(dataUrl);
  }
  renderTempOrderGalleries();
  showToast("Fotografía agregada a la galería.");
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
            <img src="${src}" alt="Foto pieza ${i + 1}" />
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
            <img src="${src}" alt="Foto repuestos ${i + 1}" />
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

function addCustomServiceToTempOrder() {
  tempNewOrderState.itemsPresupuesto.push({
    id_temp: "T-" + Date.now() + Math.random().toString(36).slice(2, 5),
    descripcion: "Servicio / Mano de Obra Adicional",
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
      <div style="display:grid; grid-template-columns: 1fr 125px 135px 40px; gap:8px; align-items:center; margin-bottom:8px;">
        <input
          type="text"
          value="${item.descripcion}"
          oninput="updateTempBudgetItem(${idx}, 'descripcion', this.value)"
          placeholder="Descripción del servicio"
          style="padding:8px 10px; border-radius:8px; border:1px solid var(--border-color); font-weight:700;"
        />
        <div>
          <label style="font-size:10px; display:block; color:var(--text-muted); font-weight:800;">PRECIO CLIENTE ($)</label>
          <input
            type="number"
            step="0.5"
            value="${item.monto}"
            oninput="updateTempBudgetItem(${idx}, 'monto', this.value)"
            style="width:100%; padding:7px 8px; border-radius:8px; border:1px solid var(--border-color); font-weight:900;"
          />
        </div>
        <div>
          <label style="font-size:10px; display:block; color:#15803d; font-weight:800;">COMISIÓN TÉCNICO ($)</label>
          <input
            type="number"
            step="0.5"
            value="${item.comision}"
            oninput="updateTempBudgetItem(${idx}, 'comision', this.value)"
            style="width:100%; padding:7px 8px; border-radius:8px; border:1px solid rgba(22,163,74,0.4); font-weight:900; color:#15803d;"
          />
        </div>
        <button type="button" class="btn btn--danger" style="padding:8px;" onclick="removeTempBudgetItem(${idx})" title="Quitar ítem">
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
      <strong id="temp-budget-total-display" style="font-family:'JetBrains Mono',monospace; font-size:22px; font-weight:900; color:var(--renacer-navy);">
        $${total.toFixed(2)}
      </strong>
    </div>
  `;
}

function saveNewOrder() {
  const doc = (document.getElementById("new-cli-doc")?.value || "").trim().toUpperCase();
  const name = (document.getElementById("new-cli-name")?.value || "").trim();
  const phone = (document.getElementById("new-cli-phone")?.value || "").trim();
  const address = (document.getElementById("new-cli-address")?.value || "").trim();
  const isAllied = document.getElementById("new-cli-allied")?.value === "true";

  const troquel = (document.getElementById("new-ord-troquel")?.value || "").trim();
  const pieza = document.getElementById("new-ord-pieza")?.value || "Cámara / Culata";
  const marca = (document.getElementById("new-ord-marca")?.value || "").trim();
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
    estado_actual: "diagnostico_presupuesto",
    subestado_ejecucion: "pendiente",
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
    mensaje: `Pieza recibida con Troquel #${cleanTroquel}. Presupuesto inicial: $${montoTotal.toFixed(2)}.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Troquel #${cleanTroquel} registrado en 1. Diagnóstico / Presupuesto.`);
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
          <div style="font-family:'JetBrains Mono',monospace; font-size:24px; font-weight:900; color:var(--renacer-navy);">
            $${Number(order.monto_total).toFixed(2)}
          </div>
        </div>
      </div>

      <!-- Selector de las 3 Opciones Financieras -->
      <div class="fin-options-grid">
        <div id="fin-card-pago_total" class="fin-option-card" onclick="selectFinCondition('pago_total', ${order.monto_total})">
          <span class="fin-option-badge" style="background:rgba(22,163,74,0.16); color:#15803d;">OPCIÓN A · PRIORIDAD ALTA 🔥</span>
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
      <i class="fas fa-receipt"></i> Detalle del ${optionKey === "pago_total" ? "Pago Total (100%)" : "Abono Inicial"} y Soporte Fotográfico Obligatorio
    </div>
    <div class="form-grid-3">
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
        <label>Método de Pago *</label>
        <select id="fin-input-metodo">
          <option value="pago_movil">Transferencia / Pago Móvil</option>
          <option value="efectivo">Efectivo (Billetes)</option>
          <option value="transferencia">Zelle / Divisas Digital</option>
        </select>
      </div>
    </div>

    <div style="margin-top:12px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; background:var(--bg-card); padding:12px; border-radius:12px; border:1.5px dashed var(--border-color);">
      <div>
        <div style="font-size:13px; font-weight:900;">📸 Soporte Multimedia Obligatorio (Capture o Foto de Billetes)</div>
        <div style="font-size:11.5px; color:var(--text-muted);">Adjunta la captura de la transferencia/Pago Móvil o la foto de los billetes recibidos en efectivo.</div>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <img id="fin-proof-preview" src="${tempFinConditionState.proofPhotoDataUrl}" alt="Comprobante" style="width:68px; height:52px; object-fit:cover; border-radius:8px; border:1px solid var(--border-color);" />
        <label class="btn btn--primary" style="cursor:pointer;">
          <i class="fas fa-camera"></i> Subir Foto Capture / Billetes
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
      order.prioridad_alta ? "🔥 Marcada con PRIORIDAD ALTA." : ""
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

function openSubtaskAssignmentModal(orderId) {
  if (currentUser.rol !== "admin" && currentUser.rol !== "jefe_taller") {
    showToast("Solo el Jefe de Taller o Administración puede asignar subtareas a los técnicos.", "error");
    return;
  }

  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  if (order.tipo_condicion_pago === "pendiente_definir") {
    showToast("Primero debes registrar Pago Total, Abono o activar Excepción / Taller Aliado.", "error");
    openFinancialApprovalModal(orderId);
    return;
  }

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  const technicians = db.usuarios.filter((u) => u.rol === "tecnico" && u.activo);

  const techOptionsHtml = (selectedId) =>
    `<option value="">-- Seleccionar Técnico --</option>` +
    technicians
      .map(
        (t) =>
          `<option value="${t.id_usuario}" ${t.id_usuario === selectedId ? "selected" : ""}>${t.nombre} (${t.especialidad})</option>`
      )
      .join("");

  const stateBadgeLabel = (st) => {
    if (st === "terminado") return `<span class="state-badge state-badge--done">✅ Terminado</span>`;
    if (st === "empezado") return `<span class="state-badge state-badge--exec">🔨 En Proceso</span>`;
    if (st === "pausado") return `<span class="state-badge state-badge--wait">⏸️ Pausado / Imprevisto</span>`;
    return `<span class="state-badge state-badge--diag">⏳ Por Hacer / Pendiente</span>`;
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
      </tr>
    `
    )
    .join("");

  const quickAssignButtons = technicians
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
            <span class="troquel-badge-lg">TROQUEL #${order.codigo_troquel}</span>
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
              <div>📸 <strong>${(order.galeria_fotos_pieza || []).length} foto(s)</strong> estado inicial de la pieza</div>
              <div>📷 <strong>${(order.galeria_fotos_repuestos || []).length} foto(s)</strong> repuestos en mesa</div>
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
        <i class="fas fa-play-circle"></i> Confirmar Matriz y Pasar a 3. Asignación y Ejecución
      </button>
    `
  });

  updateLiveAssignmentTotals(order.id_orden);
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
        <strong>🔧 ${info.nombre}</strong> (${info.tareasCount} tarea/s)<br/>
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
      if (!s.estado_subtarea) s.estado_subtarea = "pendiente"; // Por Hacer / Pendiente por defecto
      assignedCount++;
    } else {
      s.tecnico_id = null;
      s.nombre_tecnico = "Sin asignar";
    }
  });

  if (assignedCount === 0) {
    showToast("Asigna al menos una subtarea a un técnico antes de pasar a Ejecución.", "error");
    return;
  }

  order.monto_total = nuevoMontoTotal;
  order.saldo_pendiente = Math.max(0, nuevoMontoTotal - (Number(order.monto_abonado) || 0));
  order.estado_actual = "asignacion_ejecucion";
  const nowStr = cleanDateISO(new Date().toISOString(), true);

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "asignacion",
    mensaje: `Matriz de asignación confirmada por ${currentUser.nombre}. Orden en 3. Asignación y Ejecución.`,
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
    mensaje: `➕ Ítem Extra añadido a la factura abierta: "${desc}" (+$${price.toFixed(2)}). Nuevo Total Factura: $${order.monto_total.toFixed(2)} | Resto Pendiente: $${order.saldo_pendiente.toFixed(2)}.`,
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

  const itemsHtml = subtasks
    .map(
      (s) => `
      <div style="display:grid; grid-template-columns: 1fr 120px 120px; gap:8px; align-items:center; margin-bottom:8px;">
        <input type="text" id="edit-sub-desc-${s.id_subtarea}" value="${s.descripcion_servicio}" style="padding:8px; border-radius:8px; border:1px solid var(--border-color); font-weight:700;" />
        <input type="number" step="0.5" id="edit-sub-price-${s.id_subtarea}" value="${s.monto_servicio}" style="padding:8px; border-radius:8px; border:1px solid var(--border-color); font-weight:900;" />
        <input type="number" step="0.5" id="edit-sub-comm-${s.id_subtarea}" value="${s.comision_base_tecnico}" style="padding:8px; border-radius:8px; border:1px solid rgba(22,163,74,0.4); font-weight:900; color:#15803d;" />
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
        Edita los montos de los servicios o registra un nuevo abono parcial del cliente. La factura permanece abierta hasta el estado 6. Entregado.
      </p>
      <div style="display:grid; grid-template-columns: 1fr 120px 120px; gap:8px; font-size:11px; font-weight:900; color:var(--text-muted); margin-bottom:6px;">
        <span>SERVICIO / SUBTAREA</span>
        <span>MONTO CLIENTE ($)</span>
        <span>COMISIÓN TÉCNICO ($)</span>
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
    mensaje: `🏁 Trabajo marcado como 4. Terminado por ${currentUser.nombre}. Pieza enviada a revisión de Control de Calidad.`,
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
    mensaje: `🔍 Orden en 5. Control de Calidad para evaluación de tolerancia y acabado.`,
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
        <h2 style="font-size:20px; font-weight:900;">4. Terminado ➔ 5. Control de Calidad ➔ 6. Entregado</h2>
        <p style="font-size:13px; color:var(--text-muted);">
          <strong>Opción A:</strong> [ ✔️ Aprobar y Pasar a Entregado ] congela la factura y registra el ingreso en caja.<br/>
          <strong>Opción B:</strong> [ ❌ Rechazar y Devolver al Técnico ] exige motivo del fallo, regresa la orden a <em>3. Asignación y Ejecución</em> y notifica al chat del técnico.
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

/* ---------- OPCIÓN B DE FASE 2: [ ❌ Rechazar y Devolver al Técnico ] ---------- */
function promptRejectQualityControl(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const subtasks = db.subtareas.filter((s) => s.orden_id === orderId);
  const techNames = [...new Set(subtasks.map((s) => s.nombre_tecnico).filter(Boolean))].join(", ") || "Técnico asignado";

  openModal({
    title: `❌ Rechazar Control de Calidad y Devolver al Técnico — Troquel #${order.codigo_troquel}`,
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
        ❌ Confirmar Rechazo y Devolver a 3. Asignación y Ejecución
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
    mensaje: `❌ RECHAZADO EN CONTROL DE CALIDAD — Devuelto a 3. Asignación y Ejecución. Motivo del fallo / corrección: "${reason}"`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Orden ${order.id_orden} devuelta a 3. Asignación y Ejecución y notificada al chat del técnico.`, "error");
}

/* ---------- OPCIÓN A DE FASE 2: [ ✔️ Aprobar y Pasar a Entregado ] ---------- */
function openQualityAndDeliveryModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  openModal({
    title: `✔️ Control de Calidad y Paso a 6. Entregado — Troquel #${order.codigo_troquel}`,
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
            <div class="form-grid-2">
              <div class="form-field">
                <label>Modalidad al Entregar la Pieza</label>
                <select id="qc-delivery-pay-mode" onchange="toggleDeliveryPayAmount(this.value, ${order.saldo_pendiente})">
                  <option value="cobrar_todo">Cliente liquida el 100% del Resto ahora ($${Number(order.saldo_pendiente).toFixed(2)})</option>
                  <option value="entregar_credito">Entregar a Crédito / Taller Aliado (Dejar en "Entregadas y Por Cobrar")</option>
                </select>
              </div>
              <div class="form-field">
                <label>Monto Cobrado en Caja al Entregar ($)</label>
                <input type="number" id="qc-collect-amount" value="${order.saldo_pendiente}" min="0" max="${order.saldo_pendiente}" step="0.5" style="font-weight:900; color:#16a34a;" />
              </div>
            </div>
          `
            : `<p style="font-size:13px; font-weight:800; color:#16a34a;"><i class="fas fa-check-circle"></i> Esta orden ya tiene el 100% de su factura pagada.</p>`
        }
      </div>
    `,
    footer: `
      <button type="button" class="btn btn--danger" onclick="promptRejectQualityControl('${order.id_orden}')">
        ❌ Rechazar y Devolver al Técnico
      </button>
      <button type="button" class="btn btn--success btn--lg" onclick="approveAndDeliverOrder('${order.id_orden}')">
        ✔️ Aprobar y Pasar a 6. Entregado (Bloquear Factura)
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
      metodo: "pago_movil",
      orden_id: order.id_orden
    });
  }

  order.estado_actual = "entregado";
  order.subestado_ejecucion = "terminado";
  order.factura_bloqueada = true;
  order.devuelto_calidad = false;

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "entrega",
    mensaje: `✔️ Control de Calidad APROBADO por ${currentUser.nombre}. Orden en estado 6. Entregado y Factura Bloqueada definitivamente ($${Number(order.monto_total).toFixed(2)}). ${
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
   ENVÍO DE PRESUPUESTO / ORDEN EN TEXTO PLANO POR WHATSAPP CON NRO. DE TROQUEL
   (SOLICITADO EN AUDIOS DE JESÚS ANDRADE)
   ============================================================================ */
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
    `⚙️ *RECTIFICADORA RENACER (JOB 8:7)*\n` +
    `📋 *ORDEN DE SERVICIO / PRESUPUESTO*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔢 *Nro. de Orden:* ${order.id_orden}\n` +
    `🏷️ *CÓDIGO DE TROQUEL (Nro. Pieza):* #${order.codigo_troquel}\n` +
    `👤 *Cliente:* ${order.nombre_cliente} (${order.documento_cliente})\n` +
    `🚗 *Pieza / Motor:* ${order.datos_motor.tipo_pieza} — ${order.datos_motor.marca} ${order.datos_motor.modelo}\n` +
    `📌 *Estado Actual:* ${stateNames[order.estado_actual] || order.estado_actual}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🛠️ *DESGLOSE DE TRABAJOS:*\n` +
    `${itemsLines}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 *TOTAL PRESUPUESTO:* $${Number(order.monto_total).toFixed(2)}\n` +
    `✅ *MONTO ABONADO:* $${Number(order.monto_abonado).toFixed(2)}\n` +
    `⏳ *RESTO PENDIENTE:* $${Number(order.saldo_pendiente).toFixed(2)}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📍 _Conserve su Nro. de Troquel (#${order.codigo_troquel}) para cualquier consulta._`
  );
}

function openWhatsAppBudgetTextModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const textMsg = buildWhatsAppBudgetPlainText(order);
  const cleanPhone = (order.telefono_cliente || "").replace(/\D/g, "");
  const intlPhone = cleanPhone.startsWith("0") ? "58" + cleanPhone.slice(1) : cleanPhone;
  const waUrl = `https://wa.me/${intlPhone}?text=${encodeURIComponent(textMsg)}`;

  openModal({
    title: `Enviar Presupuesto / Orden en Texto por WhatsApp — Troquel #${order.codigo_troquel}`,
    icon: "fa-comment-dots",
    body: `
      <p style="font-size:13px; color:var(--text-muted); margin-bottom:10px;">
        Texto plano listo para enviar por WhatsApp a <strong>${order.nombre_cliente} (${order.telefono_cliente})</strong> con el <strong>Código de Troquel #${order.codigo_troquel}</strong>, el desglose de servicios y el saldo pendiente:
      </p>
      <textarea
        id="wa-budget-textarea"
        rows="13"
        style="width:100%; padding:12px; border-radius:12px; border:1.5px solid var(--border-color); font-family:'JetBrains Mono',monospace; font-size:12.5px; line-height:1.45; background:var(--bg-input); color:var(--text-main);"
      >${textMsg}</textarea>
    `,
    footer: `
      <button type="button" class="btn btn--ghost" onclick="copyTextToClipboard(document.getElementById('wa-budget-textarea').value)">
        <i class="fas fa-copy"></i> Copiar Texto
      </button>
      <a href="${waUrl}" target="_blank" rel="noopener" class="btn btn--success btn--lg" style="text-decoration:none;">
        <i class="fab fa-whatsapp"></i> Enviar Ahora por WhatsApp
      </a>
    `
  });
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
   + FILTRO DE "ENTREGADAS Y POR COBRAR", POR CLIENTE E INTERVALO DE FECHAS)
   ============================================================================ */
function renderAccountsReceivableScreen() {
  // Todas las órdenes con saldo_pendiente > 0
  const allPendingOrders = db.ordenes.filter((o) => Number(o.saldo_pendiente) > 0);

  // KPIs por categoría
  const sumAllPending = allPendingOrders.reduce((acc, o) => acc + Number(o.saldo_pendiente), 0);
  const sumEntregadasPorCobrar = allPendingOrders
    .filter((o) => o.estado_actual === "entregado")
    .reduce((acc, o) => acc + Number(o.saldo_pendiente), 0);
  const sumEnEsperaRespuesta = allPendingOrders
    .filter((o) => o.estado_actual === "diagnostico_presupuesto" || o.estado_actual === "esperando_aprobacion_abono")
    .reduce((acc, o) => acc + Number(o.saldo_pendiente), 0);
  const sumEnTaller = allPendingOrders
    .filter((o) => o.estado_actual === "asignacion_ejecucion" || o.estado_actual === "terminado" || o.estado_actual === "control_calidad")
    .reduce((acc, o) => acc + Number(o.saldo_pendiente), 0);

  // Aplicar filtros seleccionados (arFilterState, arFilterClient, arDateFrom, arDateTo)
  let filtered = allPendingOrders.slice();

  if (arFilterState === "entregadas_por_cobrar") {
    filtered = filtered.filter((o) => o.estado_actual === "entregado");
  } else if (arFilterState === "en_espera_respuesta") {
    filtered = filtered.filter((o) => o.estado_actual === "diagnostico_presupuesto" || o.estado_actual === "esperando_aprobacion_abono");
  } else if (arFilterState === "en_taller") {
    filtered = filtered.filter((o) => o.estado_actual === "asignacion_ejecucion" || o.estado_actual === "terminado" || o.estado_actual === "control_calidad");
  }

  if (arFilterClient !== "all") {
    filtered = filtered.filter((o) => o.cliente_id === arFilterClient);
  }

  if (arDateFrom) {
    filtered = filtered.filter((o) => cleanDateISO(o.fecha_ingreso) >= arDateFrom);
  }
  if (arDateTo) {
    filtered = filtered.filter((o) => cleanDateISO(o.fecha_ingreso) <= arDateTo);
  }

  // Agrupar por Cliente / Mecánico exactamente como la tabla dinámica de Excel de Jesús
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
        subtotalResto: 0
      };
    }
    groupedByClient[key].ordenes.push(o);
    groupedByClient[key].subtotalResto += Number(o.saldo_pendiente) || 0;
  });

  const groupsList = Object.values(groupedByClient);
  const totalGeneralFiltered = groupsList.reduce((acc, g) => acc + g.subtotalResto, 0);

  const clientOptionsHtml =
    `<option value="all">Todos los Clientes / Mecánicos (${db.clientes.length})</option>` +
    db.clientes
      .map(
        (c) =>
          `<option value="${c.id_cliente}" ${arFilterClient === c.id_cliente ? "selected" : ""}>${c.nombre_cliente || c.nombre_completo} (${c.documento_identidad})</option>`
      )
      .join("");

  const stateBadgeLabel = (st) => {
    if (st === "entregado") return `<span class="state-badge state-badge--done">📦 Entregada y Por Cobrar</span>`;
    if (st === "diagnostico_presupuesto" || st === "esperando_aprobacion_abono") return `<span class="state-badge state-badge--wait">⏳ En espera por respuesta</span>`;
    return `<span class="state-badge state-badge--exec">🔨 En Taller (${st.replace(/_/g, " ")})</span>`;
  };

  const excelRowsHtml = groupsList.length
    ? groupsList
        .map((grp) => {
          const itemRows = grp.ordenes
            .map(
              (ord) => `
              <tr class="ar-order-item-row">
                <td style="font-family:'JetBrains Mono',monospace; font-weight:900; font-size:14px;">
                  TROQUEL #${ord.codigo_troquel}
                </td>
                <td>
                  <strong>${ord.datos_motor.marca} ${ord.datos_motor.modelo}</strong>
                  <div style="font-size:11px; color:var(--text-muted);">${ord.datos_motor.tipo_pieza} · Ingreso: ${formatDateHuman(ord.fecha_ingreso, false)}</div>
                </td>
                <td>${stateBadgeLabel(ord.estado_actual)}</td>
                <td style="font-family:'JetBrains Mono',monospace; font-weight:700;">$${Number(ord.monto_total).toFixed(2)}</td>
                <td style="font-family:'JetBrains Mono',monospace; font-weight:700; color:#16a34a;">$${Number(ord.monto_abonado).toFixed(2)}</td>
                <td style="text-align:right; font-family:'JetBrains Mono',monospace; font-weight:900; font-size:15px; color:#dc2626;">
                  $ ${Number(ord.saldo_pendiente).toFixed(2)}
                </td>
                <td style="text-align:right;">
                  <div style="display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap;">
                    <button type="button" class="btn btn--gold" style="padding:5px 10px; font-size:11.5px;" onclick="openCollectReceivableModal('${ord.id_orden}')">
                      <i class="fas fa-dollar-sign"></i> Abonar / Cobrar
                    </button>
                    <button type="button" class="btn btn--ghost" style="padding:5px 9px; font-size:11.5px;" onclick="openWhatsAppBudgetTextModal('${ord.id_orden}')" title="Enviar detalle por WhatsApp">
                      <i class="fab fa-whatsapp"></i>
                    </button>
                  </div>
                </td>
              </tr>
            `
            )
            .join("");

          return `
            <tr class="ar-client-group-row">
              <td colspan="5">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <span style="font-size:15px; font-weight:900;">👤 ${grp.nombre_cliente}</span>
                  <span style="font-size:11.5px; color:var(--text-muted); font-weight:700;">(${grp.documento_cliente})</span>
                  <a href="tel:${grp.telefono_cliente}" class="btn btn--ghost" style="padding:3px 9px; font-size:11px; text-decoration:none;">
                    <i class="fas fa-phone"></i> ${grp.telefono_cliente}
                  </a>
                  <button type="button" class="btn btn--ghost" style="padding:3px 9px; font-size:11px;" onclick="openClientHistoryModal('${grp.cliente_id}')">
                    <i class="fas fa-history"></i> Historial de Pagos
                  </button>
                  <button type="button" class="btn btn--success" style="padding:3px 9px; font-size:11px;" onclick="sendClientStatementWhatsApp('${grp.cliente_id}')">
                    <i class="fab fa-whatsapp"></i> Enviar Estado de Cuenta (${grp.ordenes.length} pieza/s)
                  </button>
                </div>
              </td>
              <td style="text-align:right; font-family:'JetBrains Mono',monospace; font-size:14px; font-weight:900; color:#b45309;">
                Subtotal: $ ${grp.subtotalResto.toFixed(2)}
              </td>
              <td></td>
            </tr>
            ${itemRows}
          `;
        })
        .join("")
    : `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--text-muted);">No hay saldos pendientes que coincidan con el filtro seleccionado.</td></tr>`;

  return `
    <!-- Tarjetas de Resumen Rápido (Clic para filtrar) -->
    <div class="kpi-strip">
      <div class="kpi-card ${arFilterState === "all" ? "active-kpi" : ""}" style="cursor:pointer;" onclick="setArFilter('state', 'all')">
        <span class="kpi-label">Total General por Cobrar</span>
        <div class="kpi-value" style="color:#dc2626;">$${sumAllPending.toFixed(2)}</div>
        <span class="kpi-sub">${allPendingOrders.length} pieza(s) con saldo abierto</span>
      </div>
      <div class="kpi-card ${arFilterState === "entregadas_por_cobrar" ? "active-kpi" : ""}" style="cursor:pointer;" onclick="setArFilter('state', 'entregadas_por_cobrar')">
        <span class="kpi-label">📦 Entregadas y Por Cobrar</span>
        <div class="kpi-value" style="color:#b45309;">$${sumEntregadasPorCobrar.toFixed(2)}</div>
        <span class="kpi-sub">Piezas retiradas a crédito</span>
      </div>
      <div class="kpi-card ${arFilterState === "en_espera_respuesta" ? "active-kpi" : ""}" style="cursor:pointer;" onclick="setArFilter('state', 'en_espera_respuesta')">
        <span class="kpi-label">⏳ En Espera por Respuesta</span>
        <div class="kpi-value" style="color:#d97706;">$${sumEnEsperaRespuesta.toFixed(2)}</div>
        <span class="kpi-sub">Presupuestos por confirmar</span>
      </div>
      <div class="kpi-card ${arFilterState === "en_taller" ? "active-kpi" : ""}" style="cursor:pointer;" onclick="setArFilter('state', 'en_taller')">
        <span class="kpi-label">🔨 En Taller (Ejecución / QC)</span>
        <div class="kpi-value" style="color:#0284c7;">$${sumEnTaller.toFixed(2)}</div>
        <span class="kpi-sub">Resto por liquidar al entregar</span>
      </div>
    </div>

    <!-- Barra de Filtros estilo Tabla Dinámica Excel (Estado, Cliente, Desde / Hasta) -->
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:16px; padding:14px 16px; margin-bottom:16px;">
      <div class="form-grid-4">
        <div class="form-field">
          <label><i class="fas fa-filter"></i> Estado de la Cuenta</label>
          <select onchange="setArFilter('state', this.value)">
            <option value="all" ${arFilterState === "all" ? "selected" : ""}>Todas con Saldo Pendiente</option>
            <option value="en_espera_respuesta" ${arFilterState === "en_espera_respuesta" ? "selected" : ""}>⏳ En espera por respuesta / aprobación</option>
            <option value="entregadas_por_cobrar" ${arFilterState === "entregadas_por_cobrar" ? "selected" : ""}>📦 Entregadas y Por Cobrar (Crédito)</option>
            <option value="en_taller" ${arFilterState === "en_taller" ? "selected" : ""}>🔨 En Taller (Ejecución / Terminado / QC)</option>
          </select>
        </div>
        <div class="form-field">
          <label><i class="fas fa-user-tie"></i> Filtrar por Cliente / Mecánico</label>
          <select onchange="setArFilter('client', this.value)">
            ${clientOptionsHtml}
          </select>
        </div>
        <div class="form-field">
          <label><i class="fas fa-calendar-alt"></i> Fecha Desde</label>
          <input type="date" value="${arDateFrom}" onchange="setArFilter('from', this.value)" />
        </div>
        <div class="form-field">
          <label><i class="fas fa-calendar-check"></i> Fecha Hasta</label>
          <div style="display:flex; gap:6px;">
            <input type="date" value="${arDateTo}" onchange="setArFilter('to', this.value)" style="flex:1;" />
            <button type="button" class="btn btn--ghost" onclick="resetArFilters()" title="Limpiar filtros">
              <i class="fas fa-undo"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Tabla agrupada estilo Excel de Jesús Andrade (Nro Troquel | Marca | Suma de Resto) -->
    <div class="data-table-wrapper">
      <table class="ar-excel-table">
        <thead>
          <tr>
            <th>Nro (Troquel / Orden)</th>
            <th>Marca / Pieza</th>
            <th>Estado Actual</th>
            <th>Total Factura</th>
            <th>Abonado</th>
            <th style="text-align:right;">Suma de Resto</th>
            <th style="text-align:right;">Acciones Rápidas</th>
          </tr>
        </thead>
        <tbody>
          ${excelRowsHtml}
        </tbody>
        <tfoot>
          <tr class="ar-total-general-row">
            <td colspan="5">Total general (${filtered.length} pieza/s en esta vista)</td>
            <td style="text-align:right; font-family:'JetBrains Mono',monospace;">$ ${totalGeneralFiltered.toFixed(2)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
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
  arFilterState = "all";
  arFilterClient = "all";
  arDateFrom = "";
  arDateTo = "";
  renderScreen();
}

function openCollectReceivableModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

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

      <div class="form-grid-2">
        <div class="form-field">
          <label>Monto a Cobrar Ahora ($) *</label>
          <input type="number" id="ar-collect-amount" value="${order.saldo_pendiente}" min="1" max="${order.saldo_pendiente}" step="0.5" style="font-weight:900; font-size:17px; color:#16a34a;" />
        </div>
        <div class="form-field">
          <label>Método de Pago *</label>
          <select id="ar-collect-method">
            <option value="pago_movil">Pago Móvil / Transferencia</option>
            <option value="efectivo">Efectivo (Divisas)</option>
            <option value="transferencia">Zelle / Otro</option>
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

function confirmCollectReceivable(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;

  const amount = Math.max(0, Number(document.getElementById("ar-collect-amount")?.value) || 0);
  const method = document.getElementById("ar-collect-method")?.value || "pago_movil";

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
    orden_id: order.id_orden
  });

  db.bitacora.push({
    id_mensaje: "MSG-" + Date.now(),
    orden_id: order.id_orden,
    codigo_troquel: order.codigo_troquel,
    autor_id: currentUser.id_usuario,
    autor_nombre: currentUser.nombre,
    autor_rol: currentUser.rol_label,
    tipo_evento: "cobro_resto",
    mensaje: `💵 Pago recibido por $${amount.toFixed(2)} (${method}). Nuevo Resto Pendiente: $${order.saldo_pendiente.toFixed(2)}.`,
    foto_adjunta_url: "",
    fecha_hora: nowStr
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast(`Pago de $${amount.toFixed(2)} registrado en caja. Resto actual: $${order.saldo_pendiente.toFixed(2)}.`);
}

function sendClientStatementWhatsApp(clientId) {
  const client = db.clientes.find((c) => c.id_cliente === clientId);
  const pendingOrders = db.ordenes.filter((o) => o.cliente_id === clientId && Number(o.saldo_pendiente) > 0);
  if (!client || !pendingOrders.length) return;

  const totalDebt = pendingOrders.reduce((acc, o) => acc + Number(o.saldo_pendiente), 0);
  const lines = pendingOrders
    .map(
      (o) =>
        `• *Troquel #${o.codigo_troquel}* (${o.datos_motor.marca} ${o.datos_motor.modelo}) — Total: $${o.monto_total} | Abonado: $${o.monto_abonado} | *Resto: $${Number(o.saldo_pendiente).toFixed(2)}*`
    )
    .join("\n");

  const msg =
    `⚙️ *RECTIFICADORA RENACER (JOB 8:7)*\n` +
    `📄 *RELACIÓN DE SALDO PENDIENTE*\n` +
    `👤 *Cliente:* ${client.nombre_completo}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *TOTAL RESTANTE POR LIQUIDAR: $${totalDebt.toFixed(2)}*\n` +
    `Quedamos atentos a su comprobante de pago. ¡Gracias por su confianza!`;

  const cleanPhone = (client.telefono || "").replace(/\D/g, "");
  const intlPhone = cleanPhone.startsWith("0") ? "58" + cleanPhone.slice(1) : cleanPhone;
  window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, "_blank");
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
    if (parentOrder.estado_actual === "diagnostico_presupuesto" || parentOrder.estado_actual === "esperando_aprobacion_abono") {
      return false;
    }
    return true;
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
    pendiente: "⏳ POR HACER / PENDIENTE",
    empezado: "🔨 EN PROCESO (CRONÓMETRO ACTIVO)",
    pausado: "⏸️ PAUSADO / IMPREVISTO",
    terminado: "✅ TERMINADO (EN CONTROL DE CALIDAD)"
  };

  const tasksHtml = visibleSubtasks.length
    ? visibleSubtasks
        .map((sub) => {
          const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);
          const cover = (ord.galeria_fotos_pieza && ord.galeria_fotos_pieza[0]) || DEMO_PHOTOS.camaraCorsa;
          const sparesCover = (ord.galeria_fotos_repuestos && ord.galeria_fotos_repuestos[0]) || null;

          return `
            <div class="worker-task-card" style="${ord.devuelto_calidad ? "border:2px solid #dc2626;" : ""}">
              <div class="worker-task-header">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <span class="troquel-badge-lg">TROQUEL #${ord.codigo_troquel}</span>
                  <div>
                    <div style="font-weight:900; font-size:15px;">${sub.descripcion_servicio}</div>
                    <div style="font-size:12px; color:var(--text-muted);">${ord.datos_motor.tipo_pieza} · ${ord.datos_motor.marca} ${ord.datos_motor.modelo} · Ingreso: ${formatDateHuman(ord.fecha_ingreso, false)}</div>
                  </div>
                </div>
                <div style="text-align:right;">
                  <span style="font-size:10px; font-weight:800; color:var(--text-muted); display:block;">COMISIÓN ASIGNADA</span>
                  <strong style="font-family:'JetBrains Mono',monospace; font-size:20px; font-weight:900; color:#16a34a;">
                    +$${Number(sub.comision_base_tecnico).toFixed(2)}
                  </strong>
                </div>
              </div>

              ${
                ord.devuelto_calidad && ord.motivo_rechazo_qc
                  ? `<div style="margin:12px 18px 0; background:rgba(220,38,38,0.12); border:1.5px solid #dc2626; color:#dc2626; padding:10px 12px; border-radius:10px; font-size:12.5px; font-weight:800;">
                      ❌ <strong>DEVUELTO POR CONTROL DE CALIDAD:</strong> ${ord.motivo_rechazo_qc}
                    </div>`
                  : ""
              }

              <div class="worker-task-body">
                <!-- 3.A SOPORTE VISUAL: GALERÍA DE PIEZA Y REPUESTOS EN MESA -->
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
                  <div style="background:var(--bg-input); padding:10px; border-radius:12px; display:flex; gap:10px; align-items:center; cursor:pointer;" onclick="openDualGalleryInspector('${ord.id_orden}')">
                    <img src="${cover}" style="width:68px; height:54px; object-fit:cover; border-radius:8px;" />
                    <div style="font-size:12px;">
                      <strong>📸 Fotos Iniciales Pieza (${(ord.galeria_fotos_pieza || []).length})</strong>
                      <div style="color:var(--text-muted); font-size:11px;">Ampliar estado físico de la tapa</div>
                    </div>
                  </div>

                  <div style="background:rgba(245,196,0,0.08); border:1px solid rgba(245,196,0,0.35); padding:10px; border-radius:12px; display:flex; gap:10px; align-items:center; cursor:pointer;" onclick="openDualGalleryInspector('${ord.id_orden}')">
                    ${
                      sparesCover
                        ? `<img src="${sparesCover}" style="width:68px; height:54px; object-fit:cover; border-radius:8px;" />`
                        : `<div style="width:68px; height:54px; border-radius:8px; background:rgba(0,0,0,0.06); display:grid; place-items:center;"><i class="fas fa-toolbox"></i></div>`
                    }
                    <div style="font-size:12px;">
                      <strong>📷 Repuestos en Mesa (${(ord.galeria_fotos_repuestos || []).length})</strong>
                      <div style="color:var(--text-muted); font-size:11px;">Ver válvulas/guías del cliente</div>
                    </div>
                  </div>
                </div>

                <!-- BARRA DE ESTADO EN TIEMPO REAL + CRONÓMETRO EN VIVO + CHAT ACTIVO -->
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; font-size:12.5px; background:var(--bg-input); padding:10px 14px; border-radius:10px;">
                  <span>Sub-estado actual: <strong>${substateLabelMap[sub.estado_subtarea] || sub.estado_subtarea.toUpperCase()}</strong></span>
                  <span
                    data-live-subtask-id="${sub.id_subtarea}"
                    style="font-family:'JetBrains Mono',monospace; font-weight:900; color:${sub.estado_subtarea === "empezado" ? "#0284c7" : "var(--text-main)"};"
                  >
                    <i class="fas fa-stopwatch"></i> ${formatLiveSubtaskTimer(sub)}
                  </span>
                  <button type="button" class="btn btn--ghost" style="padding:5px 12px; font-size:11.5px;" onclick="openOrderCrmModal('${ord.id_orden}')">
                    <i class="fas fa-comments"></i> Bitácora / Chat Activo con Gerencia
                  </button>
                </div>

                ${
                  sub.estado_subtarea !== "terminado"
                    ? `
                    <!-- 4. SELECTOR DE SUB-ESTADOS OPERATIVOS DEL TÉCNICO (FASE 3) -->
                    <div style="font-size:11px; font-weight:800; color:var(--text-muted); text-transform:uppercase; margin-top:2px;">
                      4. Sub-estados Operativos del Técnico (Control en Tiempo Real):
                    </div>
                    <div class="worker-big-buttons">
                      <button
                        type="button"
                        class="worker-state-btn ${sub.estado_subtarea === "pendiente" ? "active-state" : ""}"
                        onclick="setSubtaskToPending('${sub.id_subtarea}')"
                      >
                        <i class="fas fa-clock"></i>
                        <span>⏳ POR HACER / PENDIENTE</span>
                        <small style="font-size:10px; font-weight:700;">En cola de estación</small>
                      </button>

                      <button
                        type="button"
                        class="worker-state-btn btn-start ${sub.estado_subtarea === "empezado" ? "active-state" : ""}"
                        onclick="startSubtaskWork('${sub.id_subtarea}')"
                      >
                        <i class="fas fa-play"></i>
                        <span>🔨 EN PROCESO</span>
                        <small style="font-size:10px; font-weight:700;">Inicia reloj en máquina</small>
                      </button>

                      <button
                        type="button"
                        class="worker-state-btn btn-pause ${sub.estado_subtarea === "pausado" ? "active-state" : ""}"
                        onclick="openPauseSubtaskModal('${sub.id_subtarea}')"
                      >
                        <i class="fas fa-pause-circle"></i>
                        <span>⏸️ PAUSADO / IMPREVISTO</span>
                        <small style="font-size:10px; font-weight:700;">Exige nota a gerencia</small>
                      </button>
                    </div>

                    <!-- 5. BOTÓN DE FINALIZACIÓN CON VALIDACIÓN FOTOGRÁFICA OBLIGATORIA -->
                    <button
                      type="button"
                      class="btn btn--success btn--lg"
                      style="width:100%; justify-content:center; padding:12px 16px; font-size:13.5px; margin-top:4px;"
                      onclick="openCompleteSubtaskModal('${sub.id_subtarea}')"
                    >
                      <i class="fas fa-camera"></i> [ Terminar Tarea / Enviar a Control de Calidad ]
                    </button>
                  `
                    : `
                    <div style="background:rgba(22,163,74,0.12); border:1px solid rgba(22,163,74,0.35); border-radius:12px; padding:10px 14px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
                      <div style="font-size:13px; font-weight:800; color:#15803d;">
                        <i class="fas fa-check-circle"></i> ¡Tarea Terminada con Fotografía Obligatoria! Enviada a Control de Calidad · Comisión +$${Number(sub.comision_base_tecnico).toFixed(2)} (${formatMinutes(sub.minutos_acumulados)} invertidos).
                      </div>
                      ${
                        sub.foto_terminado_url
                          ? `<img src="${sub.foto_terminado_url}" style="width:58px; height:44px; object-fit:cover; border-radius:6px; border:1.5px solid #16a34a;" />`
                          : ""
                      }
                    </div>
                  `
                }
              </div>
            </div>
          `;
        })
        .join("")
    : `
      <div style="text-align:center; padding:42px 20px; background:var(--bg-card); border-radius:18px;">
        <i class="fas fa-mug-hot" style="font-size:36px; color:var(--text-muted); margin-bottom:10px;"></i>
        <h3>No tienes subtareas asignadas activas en este momento</h3>
        <p style="font-size:13px; color:var(--text-muted);">Las órdenes en Diagnóstico o Esperando Aprobación permanecen ocultas hasta que el Jefe de Taller confirme la Matriz de Asignación.</p>
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
  if (sub.inicio_activo_ts) {
    const elapsed = Math.max(1, Math.round((Date.now() - Number(sub.inicio_activo_ts)) / 60000));
    sub.minutos_acumulados = (Number(sub.minutos_acumulados) || 0) + elapsed;
    sub.inicio_activo_ts = null;
  }
  sub.estado_subtarea = "pendiente";

  const ord = db.ordenes.find((o) => o.id_orden === sub.orden_id);
  if (ord) {
    const anyStarted = db.subtareas.some((s) => s.orden_id === ord.id_orden && s.estado_subtarea === "empezado");
    ord.subestado_ejecucion = anyStarted ? "empezado" : "pendiente";
  }

  saveDatabase();
  renderApp();
  showToast(`⏳ Subtarea "${sub.descripcion_servicio}" marcada como Por Hacer / Pendiente.`);
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
  showToast(`🔨 Trabajo "${sub.descripcion_servicio}" EN PROCESO. Cronómetro en tiempo real activado.`);
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
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='⚡ Ausencia de energía eléctrica en estación de maquinado.'">⚡ Ausencia de energía</button>
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='🔧 Herramienta / buril averiado, requiere ajuste.'">🔧 Herramienta averiada</button>
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='🔍 Se detectó fisura oculta o poro profundo en la pieza, esperando directriz de gerencia.'">🔍 Fisura oculta detectada</button>
          <button type="button" class="btn btn--ghost" style="font-size:11.5px; padding:5px 10px;" onclick="document.getElementById('pause-reason-input').value='❓ Duda técnica sobre medida de guías/válvulas aportadas por el cliente.'">❓ Duda técnica / Repuesto</button>
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
  if (sub.inicio_activo_ts) {
    const elapsed = Math.max(1, Math.round((Date.now() - Number(sub.inicio_activo_ts)) / 60000));
    sub.minutos_acumulados = (Number(sub.minutos_acumulados) || 0) + elapsed;
    sub.inicio_activo_ts = null;
  }

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
    title: `📸 Terminar Tarea y Enviar a Control de Calidad — Troquel #${ord ? ord.codigo_troquel : ""}`,
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
            🧪 Usar Foto de Prueba Rápida
          </button>
        </div>

        <div id="finish-photo-status-banner" style="background:rgba(220,38,38,0.1); color:#dc2626; padding:8px 12px; border-radius:8px; font-size:12px; font-weight:800; margin-bottom:12px;">
          🔒 Pendiente: Debes tomar o subir la foto de la pieza terminada para desbloquear el envío a Control de Calidad.
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
    banner.innerHTML = "✅ Fotografía del artículo finalizado validada. Ya puedes confirmar y enviar a Control de Calidad.";
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

  // Detener el cronómetro en vivo y sumar el tiempo real invertido
  if (sub.inicio_activo_ts) {
    const elapsed = Math.max(1, Math.round((Date.now() - Number(sub.inicio_activo_ts)) / 60000));
    sub.minutos_acumulados = (Number(sub.minutos_acumulados) || 0) + elapsed;
    sub.inicio_activo_ts = null;
  }
  if (!sub.minutos_acumulados || sub.minutos_acumulados === 0) {
    sub.minutos_acumulados = 35;
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
      mensaje: `✅ Tarea "${sub.descripcion_servicio}" FINALIZADA con fotografía obligatoria (Tiempo invertido: ${formatMinutes(sub.minutos_acumulados)}). ${
        allDone
          ? "🔔 NOTIFICACIÓN AL SUPERVISOR DE PLANTA: Todas las tareas de la pieza han sido completadas. La orden pasa a 5. Control de Calidad para revisión."
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
  const mySubs = db.subtareas.filter((s) => s.tecnico_id === currentUser.id_usuario);
  const doneSubs = mySubs.filter((s) => s.estado_subtarea === "terminado");
  const totalEarned = doneSubs.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
  const totalMinutes = mySubs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);

  return `
    <div style="background:var(--bg-card); border-radius:18px; padding:20px; border:1px solid var(--border-subtle); margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div>
        <h2 style="font-size:20px; font-weight:900;">💰 Mi Ficha de Producción y Comisiones — ${currentUser.nombre}</h2>
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
                  <td><strong>TROQUEL #${ord ? ord.codigo_troquel : s.orden_id}</strong><div style="font-size:11px; color:var(--text-muted);">${ord ? `${ord.datos_motor.marca} ${ord.datos_motor.modelo}` : ""}</div></td>
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
  `;
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
      <div style="border-radius:12px; overflow:hidden; border:1.5px solid var(--border-color); background:#000;">
        <img src="${url}" alt="Pieza ${i + 1}" style="width:100%; height:210px; object-fit:cover;" />
        <div style="padding:6px 10px; font-size:11.5px; font-weight:800; color:#fff; background:#0f172a;">
          Foto Estado de la Pieza #${i + 1} · Troquel #${order.codigo_troquel}
        </div>
      </div>
    `
    )
    .join("");

  const repuestosImgs = (order.galeria_fotos_repuestos || []).length
    ? order.galeria_fotos_repuestos
        .map(
          (url, i) => `
          <div style="border-radius:12px; overflow:hidden; border:2px solid var(--renacer-gold); background:#000;">
            <img src="${url}" alt="Repuestos ${i + 1}" style="width:100%; height:210px; object-fit:cover;" />
            <div style="padding:6px 10px; font-size:11.5px; font-weight:800; color:#0f1638; background:var(--renacer-gold);">
              📷 Repuestos del Cliente #${i + 1} (Soporte Visual para Mesa Técnica)
            </div>
          </div>
        `
        )
        .join("")
    : `<div style="padding:24px; background:var(--bg-input); border-radius:12px; font-size:13px; color:var(--text-muted);">El cliente no dejó repuestos físicos en recepción para esta orden.</div>`;

  const paymentProofHtml = order.comprobante_pago_foto
    ? `
      <div class="form-section-box" style="margin-top:14px;">
        <div class="form-section-title"><i class="fas fa-receipt"></i> Comprobante Fotográfico de Pago / Abono (${(order.metodo_pago || "efectivo").toUpperCase()})</div>
        <img src="${order.comprobante_pago_foto}" style="max-width:320px; border-radius:12px; border:1.5px solid var(--border-color);" />
      </div>
    `
    : "";

  openModal({
    title: `Inspección Multimedia Dual — TROQUEL #${order.codigo_troquel}`,
    icon: "fa-images",
    wide: true,
    body: `
      <div class="form-section-box">
        <div class="form-section-title">
          <i class="fas fa-camera"></i> Galería 1: Fotos del Estado de la Pieza (${(order.galeria_fotos_pieza || []).length})
        </div>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px;">
          ${piezaImgs}
        </div>
      </div>

      <div class="form-section-box" style="border-color:rgba(245,196,0,0.6); background:rgba(245,196,0,0.04);">
        <div class="form-section-title" style="color:#b45309;">
          📷 Galería 2: Fotos de Repuestos Aportados por el Cliente (${(order.galeria_fotos_repuestos || []).length})
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">
          Soporte visual exclusivo para que el técnico verifique en su mesa con qué guías, válvulas, sellos o empacaduras cuenta físicamente.
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

let tempCrmPhotoUrl = "";

function openOrderCrmModal(orderId) {
  const order = db.ordenes.find((o) => o.id_orden === orderId);
  if (!order) return;
  tempCrmPhotoUrl = "";

  const messages = db.bitacora.filter((m) => m.orden_id === orderId);

  const feedHtml = messages.length
    ? messages
        .map(
          (m) => `
          <div class="crm-msg-bubble" style="${m.tipo_evento === "rechazo_calidad" ? "border-color:#dc2626; background:rgba(220,38,38,0.06);" : m.tipo_evento === "pausa_imprevisto" ? "border-color:#f59e0b; background:rgba(245,158,11,0.08);" : ""}">
            <div class="crm-msg-meta">
              <span><strong>${m.autor_nombre}</strong> (${m.autor_rol})</span>
              <span>${formatDateHuman(m.fecha_hora, true)}</span>
            </div>
            <div class="crm-msg-text">${m.mensaje}</div>
            ${m.foto_adjunta_url ? `<img src="${m.foto_adjunta_url}" class="crm-msg-photo" alt="Adjunto" />` : ""}
          </div>
        `
        )
        .join("")
    : `<p style="font-size:13px; color:var(--text-muted);">Aún no hay comentarios en esta orden.</p>`;

  openModal({
    title: `Bitácora y Chat Interno en Tiempo Real — TROQUEL #${order.codigo_troquel}`,
    icon: "fa-comments",
    wide: true,
    body: `
      <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:10px;">
        Canal directo en tiempo real entre Administración, Jefes de Taller y Técnicos para reportar novedades, pausas o anomalías sobre la pieza.
      </div>
      <div class="crm-chat-feed" id="crm-feed-box">${feedHtml}</div>

      <div class="form-section-box" style="margin-top:14px; margin-bottom:0;">
        <div class="form-field">
          <label>Escribir Mensaje o Reportar Novedad en la Pieza</label>
          <textarea id="crm-new-msg-text" rows="2" placeholder="Ej: Se detectó asiento de válvula fisurado en cilindro #3, adjunto foto para aprobación de ítem extra..."></textarea>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; flex-wrap:wrap; gap:10px;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <label class="btn btn--ghost" style="cursor:pointer;">
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
}

async function handleCrmPhotoSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  tempCrmPhotoUrl = await readFileAsCompressedDataUrl(file);
  const st = document.getElementById("crm-photo-status");
  if (st) st.textContent = "📸 Foto adjunta lista para enviar";
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
  const technicians = db.usuarios.filter((u) => u.rol === "tecnico");
  const managementAndStaff = db.usuarios.filter((u) => u.rol !== "tecnico");

  const techRowsHtml = technicians
    .map((t) => {
      const subs = db.subtareas.filter((s) => s.tecnico_id === t.id_usuario);
      const completedUnpaid = subs.filter((s) => s.estado_subtarea === "terminado" && !s.comision_pagada);
      const inProgress = subs.filter((s) => s.estado_subtarea !== "terminado");
      const totalToPay = completedUnpaid.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
      const totalPending = inProgress.reduce((acc, s) => acc + (Number(s.comision_base_tecnico) || 0), 0);
      const totalMinutes = subs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);

      // Troqueles únicos trabajados por este técnico
      const troquelesSet = new Set();
      subs.forEach((s) => {
        const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
        if (ord && ord.codigo_troquel) troquelesSet.add(`#${ord.codigo_troquel}`);
      });
      const troquelesBadges = Array.from(troquelesSet)
        .map((tr) => `<span style="background:rgba(245,196,0,0.18); color:var(--text-main); border:1px solid rgba(245,196,0,0.5); padding:2px 7px; border-radius:6px; font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:800;">${tr}</span>`)
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
            <div style="font-size:11.5px; color:var(--text-muted);">${t.especialidad} · 📞 ${t.telefono} · PIN: <code>${t.pin || "1234"}</code></div>
          </td>
          <td>
            <span class="state-badge ${t.activo ? "state-badge--done" : "state-badge--wait"}">
              ${t.activo ? "ACTIVO" : "INACTIVO"}
            </span>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${activeDaysCount} día(s) activo(s)</div>
          </td>
          <td>
            <div><strong>${completedUnpaid.length}</strong> terminadas · <strong>${inProgress.length}</strong> en mesa</div>
            <div style="margin-top:4px; display:flex; gap:4px; flex-wrap:wrap;">${troquelesBadges || '<span style="font-size:11px; color:var(--text-muted);">Sin piezas asignadas</span>'}</div>
          </td>
          <td style="font-family:'JetBrains Mono',monospace; font-weight:800;">
            ${formatMinutes(totalMinutes)}
          </td>
          <td>
            <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:900; color:#16a34a;">
              $${totalToPay.toFixed(2)} <span style="font-size:10px; color:var(--text-muted); font-weight:700;">(Listo)</span>
            </div>
            ${
              totalPending > 0
                ? `<div style="font-family:'JetBrains Mono',monospace; font-size:12px; font-weight:800; color:#d97706;">+$${totalPending.toFixed(2)} en mesa</div>`
                : ""
            }
          </td>
          <td>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn--primary" style="padding:5px 10px; font-size:11.5px;" onclick="openWorkerProfileModal('${t.id_usuario}')">
                <i class="fas fa-clipboard-list"></i> Ficha / Trabajos y Tiempos
              </button>
              <button type="button" class="btn btn--ghost" style="padding:5px 9px; font-size:11.5px;" onclick="openEditWorkerModal('${t.id_usuario}')" title="Editar nombre, especialidad, teléfono o PIN">
                <i class="fas fa-edit"></i> Editar
              </button>
              ${
                totalToPay > 0
                  ? `<button type="button" class="btn btn--success" style="padding:5px 10px; font-size:11.5px;" onclick="payTechnicianWeeklyCommission('${t.id_usuario}', ${totalToPay})">
                      <i class="fas fa-hand-holding-usd"></i> Liquidar ($${totalToPay.toFixed(2)})
                    </button>`
                  : ""
              }
              <button type="button" class="btn btn--ghost" style="padding:5px 8px; font-size:11.5px; color:#dc2626;" onclick="deleteWorker('${t.id_usuario}')" title="Eliminar trabajador">
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
            ${
              u.id_usuario !== currentUser.id_usuario
                ? `<button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11.5px; color:#dc2626;" onclick="deleteWorker('${u.id_usuario}')"><i class="fas fa-trash-alt"></i></button>`
                : ""
            }
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
          <i class="fas fa-user-plus"></i> + Agregar Trabajador / Perfil
        </button>
      </div>
    </div>

    <div class="data-table-wrapper" style="margin-bottom:22px;">
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
            <span><strong>📅 ${formatDateHuman(d.fecha, false)}</strong> — ${d.observacion || "Actividad en taller"}</span>
            <span class="state-badge state-badge--done">${d.estado || "Activo"}</span>
          </div>
        `
        )
        .join("")
    : `<div style="padding:10px; font-size:12px; color:var(--text-muted);">Sin días activos registrados todavía.</div>`;

  openModal({
    title: `📋 Ficha Técnica de Producción y Tiempos — ${tech.nombre}`,
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

function payTechnicianWeeklyCommission(techId, amount) {
  const tech = db.usuarios.find((u) => u.id_usuario === techId);
  if (!tech) return;

  db.subtareas.forEach((s) => {
    if (s.tecnico_id === techId && s.estado_subtarea === "terminado" && !s.comision_pagada) {
      s.comision_pagada = true;
    }
  });

  db.finanzas_movimientos.unshift({
    id_mov: "MOV-" + Date.now(),
    fecha: new Date().toISOString().slice(0, 10),
    tipo: "egreso",
    categoria: "Pago de Nómina / Comisiones",
    concepto: `Liquidación de comisiones por destajo a ${tech.nombre}`,
    monto: Number(amount),
    metodo: "pago_movil",
    orden_id: "NOMINA"
  });

  saveDatabase();
  renderApp();
  showToast(`Comisión semanal de $${Number(amount).toFixed(2)} pagada a ${tech.nombre} y cargada al Libro Diario.`);
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
          <label>PIN de Acceso (4 dígitos)</label>
          <input type="text" id="new-worker-pin" value="1234" maxlength="8" />
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
  const pin = (document.getElementById("new-worker-pin")?.value || "1234").trim();

  if (!name || !spec) {
    showToast("Completa el nombre y la especialidad del trabajador.", "error");
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
    title: `✏️ Editar Perfil y PIN — ${u.nombre}`,
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
          <label>PIN de Seguridad</label>
          <input type="text" id="edit-worker-pin" value="${u.pin || "1234"}" maxlength="8" />
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
  const pin = (document.getElementById("edit-worker-pin")?.value || "1234").trim();
  const active = document.getElementById("edit-worker-active")?.value === "true";

  if (!name) {
    showToast("El nombre no puede estar vacío.", "error");
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
  const rowsHtml = db.asistencias.length
    ? db.asistencias
        .map((a) => {
          const workerSubs = db.subtareas.filter(
            (s) => s.tecnico_id === a.usuario_id || s.nombre_tecnico === a.nombre
          );
          const totalWorkerMins = workerSubs.reduce((acc, s) => acc + (Number(s.minutos_acumulados) || 0), 0);
          const troqueles = Array.from(
            new Set(
              workerSubs.map((s) => {
                const ord = db.ordenes.find((o) => o.id_orden === s.orden_id);
                return ord ? `#${ord.codigo_troquel} (${ord.datos_motor.marca})` : s.orden_id;
              })
            )
          ).join(", ");

          return `
            <tr>
              <td><strong>📅 ${formatDateHuman(a.fecha, false)}</strong></td>
              <td><strong>${a.nombre}</strong></td>
              <td>
                <div style="font-weight:800; color:var(--text-main);">${troqueles || "Actividad general en planta"}</div>
                <div style="font-size:11.5px; color:var(--text-muted);">${a.observacion || "Trabajo por destajo en piezas asignadas"}</div>
              </td>
              <td style="font-family:'JetBrains Mono',monospace; font-weight:800;">
                ${totalWorkerMins > 0 ? formatMinutes(totalWorkerMins) : "Por destajo"}
              </td>
              <td><span class="state-badge state-badge--done">${(a.estado || "ACTIVO").toUpperCase()}</span></td>
              <td style="text-align:right;">
                <button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11px; color:#dc2626;" onclick="deleteAttendanceRecord('${a.id_asist}')" title="Eliminar registro">
                  <i class="fas fa-trash-alt"></i>
                </button>
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="6" style="text-align:center; padding:26px; color:var(--text-muted);">No hay registros de días activos. Se registran automáticamente cuando un técnico inicia un trabajo o usando el botón superior.</td></tr>`;

  return `
    <div style="background:var(--bg-card); border-radius:18px; padding:16px 20px; border:1px solid var(--border-subtle); margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div>
        <span style="font-size:11px; font-weight:900; color:var(--renacer-gold); text-transform:uppercase;">
          MODALIDAD DE TALLER POR DESTAJO · SIN HORARIO FIJO DE ENTRADA/SALIDA
        </span>
        <h2 style="font-size:20px; font-weight:900;">📅 Días Activos, Fechas de Trabajo y Proyectos (#Troquel) por Trabajador</h2>
        <p style="font-size:13px; color:var(--text-muted);">
          Como los técnicos cobran por trabajo realizado y no por hora de llegada, aquí se registran qué fechas estuvieron activos en el taller, en qué piezas (#Troquel) trabajaron y cuánto tiempo invirtieron.
        </p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" class="btn btn--ghost" onclick="navigateTab('commissions')">
          <i class="fas fa-arrow-left"></i> Volver a Personal y Fichas
        </button>
        <button type="button" class="btn btn--gold" onclick="openAddActiveDayModal()">
          <i class="fas fa-calendar-plus"></i> + Registrar Día Activo / Proyecto
        </button>
      </div>
    </div>

    <div class="data-table-wrapper">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Fecha Activa</th>
            <th>Trabajador</th>
            <th>Proyectos / Troqueles Trabajados y Detalle</th>
            <th>Tiempo Acumulado en Piezas</th>
            <th>Estado</th>
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

function renderFinancesLedgerScreen() {
  const ingresos = db.finanzas_movimientos
    .filter((m) => m.tipo === "ingreso")
    .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);

  const egresos = db.finanzas_movimientos
    .filter((m) => m.tipo === "egreso")
    .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);

  const utilidadNeta = ingresos - egresos;
  const cuentasPorCobrar = db.ordenes.reduce((acc, o) => acc + (Number(o.saldo_pendiente) || 0), 0);

  let filteredMovs = db.finanzas_movimientos.slice();
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

  const clientFilterOptions =
    `<option value="all">Todos los Movimientos de Caja (${db.finanzas_movimientos.length})</option>` +
    db.clientes
      .map(
        (c) =>
          `<option value="${c.id_cliente}" ${ledgerClientFilter === c.id_cliente ? "selected" : ""}>👤 Historial de Pagos: ${c.nombre_completo} (${c.documento_identidad})</option>`
      )
      .join("");

  const movRowsHtml = filteredMovs.length
    ? filteredMovs
        .map(
          (m) => `
          <tr>
            <td><strong>${formatDateHuman(m.fecha, false)}</strong></td>
            <td>
              <span class="state-badge ${m.tipo === "ingreso" ? "state-badge--done" : "state-badge--wait"}">
                ${m.tipo === "ingreso" ? "⬆️ INGRESO" : "⬇️ EGRESO / GASTO"}
              </span>
            </td>
            <td><strong>${m.categoria}</strong></td>
            <td>${m.concepto}</td>
            <td>${(m.metodo || "efectivo").toUpperCase()}</td>
            <td style="font-family:'JetBrains Mono',monospace; font-size:15px; font-weight:900; color:${m.tipo === "ingreso" ? "#16a34a" : "#dc2626"};">
              ${m.tipo === "ingreso" ? "+" : "-"}$${Number(m.monto).toFixed(2)}
            </td>
            <td style="text-align:right;">
              <button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11px; color:#dc2626;" onclick="deleteFinanceMovement('${m.id_mov}')" title="Eliminar movimiento">
                <i class="fas fa-trash-alt"></i>
              </button>
            </td>
          </tr>
        `
        )
        .join("")
    : `<tr><td colspan="7" style="text-align:center; padding:26px; color:var(--text-muted);">No hay movimientos registrados para este filtro.</td></tr>`;

  return `
    <div class="kpi-strip">
      <div class="kpi-card">
        <span class="kpi-label">Ingresos Cobrados en Caja</span>
        <div class="kpi-value" style="color:#16a34a;">$${ingresos.toFixed(2)}</div>
        <span class="kpi-sub">Pagos Totales 100% + Abonos recibidos</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Gastos y Comisiones Pagadas</span>
        <div class="kpi-value" style="color:#dc2626;">$${egresos.toFixed(2)}</div>
        <span class="kpi-sub">Insumos, nómina, servicios y repuestos</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Disponibilidad Neta en Caja</span>
        <div class="kpi-value" style="color:var(--renacer-navy);">$${utilidadNeta.toFixed(2)}</div>
        <span class="kpi-sub">Balance real (Ingresos - Egresos)</span>
      </div>
      <div class="kpi-card" style="cursor:pointer;" onclick="navigateTab('accounts_receivable')">
        <span class="kpi-label">Cuentas por Cobrar (Resto)</span>
        <div class="kpi-value" style="color:#d97706;">$${cuentasPorCobrar.toFixed(2)}</div>
        <span class="kpi-sub">Toca para ir a Cuentas por Cobrar ➔</span>
      </div>
    </div>

    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:18px; padding:16px 20px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <div>
        <h2 style="font-size:19px; font-weight:900;">📊 Libro Diario de Caja e Historial de Pagos por Cliente</h2>
        <p style="font-size:12.5px; color:var(--text-muted);">Filtra los pagos realizados por cualquier cliente o registra ingresos y egresos operativos.</p>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <select
          style="padding:8px 12px; border-radius:10px; border:1.5px solid var(--border-color); background:var(--bg-input); color:var(--text-main); font-size:12.5px; font-weight:800;"
          onchange="setLedgerClientFilter(this.value)"
        >
          ${clientFilterOptions}
        </select>
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

    <div class="data-table-wrapper">
      <table class="renacer-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Categoría</th>
            <th>Concepto / Cliente / Troquel</th>
            <th>Método</th>
            <th>Monto ($)</th>
            <th style="text-align:right;">Acción</th>
          </tr>
        </thead>
        <tbody>
          ${movRowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function setLedgerClientFilter(val) {
  ledgerClientFilter = val;
  renderScreen();
}

function deleteFinanceMovement(movId) {
  if (!confirm("¿Eliminar este movimiento del Libro Diario?")) return;
  db.finanzas_movimientos = db.finanzas_movimientos.filter((m) => m.id_mov !== movId);
  saveDatabase();
  renderApp();
  showToast("Movimiento eliminado del Libro Diario.");
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
  if (type === "ingreso") db.finanzas_categorias.ingresos.push(name);
  else db.finanzas_categorias.egresos.push(name);
  saveDatabase();
  closeModal();
  showToast(`Categoría "${name}" agregada.`);
}

function openNewFinanceMovementModal(tipo) {
  const cats = tipo === "ingreso" ? db.finanzas_categorias.ingresos : db.finanzas_categorias.egresos;
  const catOptions = cats.map((c) => `<option value="${c}">${c}</option>`).join("");

  openModal({
    title: tipo === "ingreso" ? "Registrar Nuevo Ingreso en Caja" : "Registrar Gasto / Egreso Operativo",
    icon: tipo === "ingreso" ? "fa-arrow-up" : "fa-arrow-down",
    body: `
      <div class="form-grid-3">
        <div class="form-field">
          <label>Categoría *</label>
          <select id="mov-cat">${catOptions}</select>
        </div>
        <div class="form-field">
          <label>Monto ($) *</label>
          <input type="number" step="0.5" id="mov-amount" placeholder="Ej: 25.00" required />
        </div>
        <div class="form-field">
          <label>Método de Pago</label>
          <select id="mov-method">
            <option value="efectivo">Efectivo (Divisas / Caja)</option>
            <option value="pago_movil">Pago Móvil / Transferencia</option>
          </select>
        </div>
      </div>
      <div class="form-field" style="margin-top:10px;">
        <label>Concepto / Descripción Detallada *</label>
        <input type="text" id="mov-concept" placeholder="Ej: Compra de líquido desengrasante para tanque químico" required />
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
  const method = document.getElementById("mov-method")?.value || "efectivo";
  const concept = (document.getElementById("mov-concept")?.value || "").trim();

  if (!amount || !concept) {
    showToast("Ingresa monto y concepto del movimiento.", "error");
    return;
  }

  db.finanzas_movimientos.unshift({
    id_mov: "MOV-" + Date.now(),
    fecha: new Date().toISOString().slice(0, 10),
    tipo,
    categoria: cat,
    concepto: concept,
    monto: amount,
    metodo: method,
    orden_id: "-"
  });

  saveDatabase();
  closeModal();
  renderApp();
  showToast("Movimiento registrado en el Libro Diario.");
}

/* ============================================================================
   DIRECTORIO DE CLIENTES (CON HISTORIAL DE PAGOS + EDICIÓN) Y CATÁLOGO EDITABLE
   ============================================================================ */
function renderClientsAndCatalogScreen() {
  const clientRows = db.clientes
    .map((c) => {
      const clientOrders = db.ordenes.filter(
        (o) => o.cliente_id === c.id_cliente || o.documento_cliente === c.documento_identidad
      );
      const totalPaid = clientOrders.reduce((acc, o) => acc + (Number(o.monto_abonado) || 0), 0);
      const totalPending = clientOrders.reduce((acc, o) => acc + (Number(o.saldo_pendiente) || 0), 0);

      return `
        <tr>
          <td>
            <strong>${c.documento_identidad}</strong>
            <div style="font-size:11px; color:var(--text-muted);">${clientOrders.length} orden(es)</div>
          </td>
          <td>
            <div style="font-weight:900;">${c.nombre_completo}</div>
            <div style="font-size:11px; color:var(--text-muted);">📍 ${c.direccion || "Sin dirección"}</div>
          </td>
          <td><a href="tel:${c.telefono}" style="color:var(--renacer-navy); font-weight:800;">${c.telefono}</a></td>
          <td>
            <span class="state-badge ${c.es_taller_aliado ? "state-badge--exec" : "state-badge--diag"}">
              ${c.es_taller_aliado ? "🤝 TALLER ALIADO" : "PARTICULAR"}
            </span>
            <div style="font-size:11px; margin-top:4px; font-family:'JetBrains Mono',monospace;">
              Pagado: <strong style="color:#16a34a;">$${totalPaid.toFixed(2)}</strong> · Resto: <strong style="color:${totalPending > 0 ? "#dc2626" : "var(--text-muted)"};">$${totalPending.toFixed(2)}</strong>
            </div>
          </td>
          <td style="text-align:right;">
            <div style="display:flex; justify-content:flex-end; gap:5px; flex-wrap:wrap;">
              <button type="button" class="btn btn--primary" style="padding:4px 9px; font-size:11px;" onclick="openClientHistoryModal('${c.id_cliente}')" title="Ver historial de órdenes y pagos del cliente">
                <i class="fas fa-history"></i> Pagos
              </button>
              <button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11px;" onclick="openEditClientModal('${c.id_cliente}')" title="Editar datos del cliente">
                <i class="fas fa-edit"></i>
              </button>
              <button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11px; color:#dc2626;" onclick="deleteClient('${c.id_cliente}')" title="Eliminar cliente">
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const catRows = db.catalogo_servicios
    .map(
      (s) => `
      <tr>
        <td><strong>${s.nombre}</strong></td>
        <td style="font-family:'JetBrains Mono',monospace; font-weight:900;">$${Number(s.precio_sugerido).toFixed(2)}</td>
        <td style="font-family:'JetBrains Mono',monospace; font-weight:900; color:#16a34a;">$${Number(s.comision_sugerida).toFixed(2)}</td>
        <td style="text-align:right;">
          <div style="display:flex; justify-content:flex-end; gap:5px;">
            <button type="button" class="btn btn--ghost" style="padding:4px 9px; font-size:11px;" onclick="openEditCatalogServiceModal('${s.id_cat}')" title="Editar precio o comisión del servicio">
              <i class="fas fa-edit"></i> Editar
            </button>
            <button type="button" class="btn btn--ghost" style="padding:4px 8px; font-size:11px; color:#dc2626;" onclick="deleteCatalogService('${s.id_cat}')" title="Eliminar servicio">
              <i class="fas fa-trash-alt"></i>
            </button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");

  return `
    <div class="clients-catalog-grid" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:18px;">
      <div>
        <div style="background:var(--bg-card); border-radius:16px; padding:14px 18px; border:1px solid var(--border-subtle); margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <h3 style="font-size:16.5px; font-weight:900;"><i class="fas fa-address-book"></i> Directorio de Clientes e Historial de Pagos</h3>
          <button type="button" class="btn btn--gold" style="padding:6px 10px; font-size:11.5px;" onclick="openAddClientModal()">
            <i class="fas fa-user-plus"></i> + Nuevo Cliente
          </button>
        </div>
        <div class="data-table-wrapper">
          <table class="renacer-table">
            <thead>
              <tr>
                <th>Cédula / RIF</th>
                <th>Nombre / Taller</th>
                <th>Teléfono</th>
                <th>Tipo y Balance</th>
                <th style="text-align:right;">Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${clientRows}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div style="background:var(--bg-card); border-radius:16px; padding:14px 18px; border:1px solid var(--border-subtle); margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <h3 style="font-size:16.5px; font-weight:900;"><i class="fas fa-tools"></i> Catálogo de Servicios, Precios y Comisiones</h3>
          <button type="button" class="btn btn--gold" style="padding:6px 10px; font-size:11.5px;" onclick="openAddCatalogServiceModal()">
            <i class="fas fa-plus"></i> + Nuevo Servicio
          </button>
        </div>
        <div class="data-table-wrapper">
          <table class="renacer-table">
            <thead>
              <tr>
                <th>Servicio de Rectificación</th>
                <th>Precio Cliente</th>
                <th>Comisión Técnico</th>
                <th style="text-align:right;">Editar / Borrar</th>
              </tr>
            </thead>
            <tbody>
              ${catRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
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
    title: `📜 Historial de Pagos y Piezas — ${client.nombre_completo} (${client.documento_identidad})`,
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
        🤝 Clasificar como Mecánico / Taller Aliado (Habilita Crédito Flexible)
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
    title: `✏️ Editar Cliente — ${c.nombre_completo}`,
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
        🤝 Clasificar como Mecánico / Taller Aliado
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
      <div class="form-grid-2">
        <div class="form-field">
          <label>Precio Sugerido al Cliente ($) *</label>
          <input type="number" step="0.5" id="cat-srv-price" value="40" required />
        </div>
        <div class="form-field">
          <label>Comisión Base para el Técnico ($) *</label>
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
  const price = Math.max(0, Number(document.getElementById("cat-srv-price")?.value) || 0);
  const comm = Math.max(0, Number(document.getElementById("cat-srv-comm")?.value) || 0);
  if (!name) return;

  db.catalogo_servicios.push({
    id_cat: "CAT-" + Date.now(),
    nombre: name,
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
    title: `✏️ Editar Servicio del Catálogo`,
    icon: "fa-edit",
    body: `
      <div class="form-field" style="margin-bottom:10px;">
        <label>Nombre del Servicio *</label>
        <input type="text" id="edit-cat-name" value="${s.nombre}" required />
      </div>
      <div class="form-grid-2">
        <div class="form-field">
          <label>Precio Sugerido al Cliente ($) *</label>
          <input type="number" step="0.5" id="edit-cat-price" value="${Number(s.precio_sugerido) || 0}" required />
        </div>
        <div class="form-field">
          <label>Comisión Base para el Técnico ($) *</label>
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
  const price = Math.max(0, Number(document.getElementById("edit-cat-price")?.value) || 0);
  const comm = Math.max(0, Number(document.getElementById("edit-cat-comm")?.value) || 0);
  if (!name) {
    showToast("El nombre del servicio no puede estar vacío.", "error");
    return;
  }

  s.nombre = name;
  s.precio_sugerido = price;
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  const savedUserId = localStorage.getItem(SESSION_KEY);
  if (savedUserId) {
    const found = db.usuarios.find((u) => u.id_usuario === savedUserId);
    if (found) {
      quickLoginAs(savedUserId);
    }
  }

  // Cronómetro en tiempo real (Fase 3): actualiza cada segundo los trabajos "En Proceso"
  setInterval(tickLiveSubtaskTimers, 1000);

  // Sincronización automática directa con el Google Sheets vinculado
  syncFromGoogleSheets(true);
});
