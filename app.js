// ===== CONFIGURACIÓN =====
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxWECy4QTAdqTqyWBKdE5v6Up2r4QMhGwF0m3rWZ15Zf-1Wa3FSUftoc-ZVBBmqYvR8Aw/exec';

// Usuarios válidos — usuario y contraseña son el mismo texto
const USUARIOS_VALIDOS = ['AuxB1','AuxB2','AuxB3','AuxB4','AuxB5','AuxB6'];
let currentUser = null;

let CONFIG = {
  sheetId: '1eR59BR0sXU-Gt_SWFR7_4_7u6_Pe2Aw1w0Hb5Un-MT0',
  apiKey:  'AIzaSyA_gaEbgmUhqOgSlkKUZSfhJ0Efd0Ey8zk'
};
let allPedidos   = [];
let registros    = {};
let despachadosFacturas = new Set();
let despachados  = {};
let despachosLog = [];
let rawPedidos   = [];
let currentPedido = null;
let scanCounts   = {};

// ===== PERSISTENCIA LOCAL DE ESCANEOS (localStorage) =====
const SCAN_STORAGE_KEY = 'pedidos_scan_counts';

function saveScanLocal(factura) {
  try {
    const stored = JSON.parse(localStorage.getItem(SCAN_STORAGE_KEY) || '{}');
    stored[factura] = scanCounts[factura] || {};
    localStorage.setItem(SCAN_STORAGE_KEY, JSON.stringify(stored));
  } catch(e) { /* sin localStorage disponible */ }
}

function loadScanLocal(factura) {
  try {
    const stored = JSON.parse(localStorage.getItem(SCAN_STORAGE_KEY) || '{}');
    return stored[factura] || null;
  } catch(e) { return null; }
}

function clearScanLocal(factura) {
  try {
    const stored = JSON.parse(localStorage.getItem(SCAN_STORAGE_KEY) || '{}');
    delete stored[factura];
    localStorage.setItem(SCAN_STORAGE_KEY, JSON.stringify(stored));
  } catch(e) {}
}

function getEnProcesoFacturas() {
  try {
    const stored = JSON.parse(localStorage.getItem(SCAN_STORAGE_KEY) || '{}');
    return new Set(Object.keys(stored).filter(f => {
      const c = stored[f];
      return c && Object.values(c).some(v => v > 0);
    }));
  } catch(e) { return new Set(); }
}

// ===== AUTO-REFRESH (30 segundos) =====
let autoRefreshInterval = null;
const AUTO_REFRESH_MS   = 30000;

function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(async () => {
    if (currentPedido) return; // no refrescar si hay modal abierto
    await silentRefresh();
  }, AUTO_REFRESH_MS);
}

async function silentRefresh() {
  try {
    const [registroData, despachosData] = await Promise.all([
      sheetsGet('registro!A1:O').catch(() => ({ values: [] })),
      sheetsGet('despachos!A1:O').catch(() => ({ values: [] }))
    ]);
    const prevDespachadosSize = despachadosFacturas.size;
    // Snapshot enviados antes de actualizar
    const prevEnviados = JSON.stringify(
      Object.fromEntries(Object.entries(despachados).map(([f,d]) => [f, d.items.map(i=>i.Enviado)]))
    );
    procesarRegistros(registroData);
    procesarDespachos(despachosData);
    const newEnviados = JSON.stringify(
      Object.fromEntries(Object.entries(despachados).map(([f,d]) => [f, d.items.map(i=>i.Enviado)]))
    );
    const hayNuevosDespachos = despachadosFacturas.size !== prevDespachadosSize;
    const hayCambioEnviados  = prevEnviados !== newEnviados;
    if (hayNuevosDespachos) {
      renderPedidos();
      renderHistorial();
    }
    if (hayCambioEnviados || document.getElementById('tab-content-informe').classList.contains('active')) {
      renderInforme();
    }
    updateSyncStatus(true);
  } catch(e) { /* silencioso */ }
}

function procesarRegistros(registroData) {
  const rRows = (registroData.values || []).slice(1).filter(r => r[0]);
  registros = {};
  despachadosFacturas = new Set();
  despachosLog = [];
  const despachosVistos = new Set();
  const skuContador = {};
  rRows.forEach(r => {
    const factura     = r[0] || '';
    const fechaPedido = r[1] || '';
    const cliente     = r[3] || '';
    const sucursal    = r[4] || '';
    const dir         = r[5] || '';
    const telefono    = r[6] || '';
    const sku         = r[7] || '';
    const cant        = parseInt(r[10]) || 0;
    const fechaReg    = r[11] || '';
    const cajas       = parseInt(r[12]) || 1;
    const despachado  = (r[13]||'').toString().toUpperCase()==='TRUE';
    const despachador = r[14] || '';

    if (!registros[factura]) registros[factura] = { dir: '', cajas: 1, counts: {} };
    registros[factura].dir   = dir;
    registros[factura].cajas = cajas;

    if (!skuContador[factura]) skuContador[factura] = {};
    if (!skuContador[factura][sku]) skuContador[factura][sku] = 0;
    skuContador[factura][sku]++;
    const itemKey = (sku||'').toLowerCase() + ':' + skuContador[factura][sku];
    registros[factura].counts[itemKey] = cant;
    registros[factura].counts[sku]     = cant;

    if (despachado) {
      despachadosFacturas.add(factura);
      if (!despachosVistos.has(factura)) {
        despachosVistos.add(factura);
        despachosLog.push({
          Despachador: despachador, Factura: factura, Cliente: cliente,
          Sucursal: sucursal, Direccion: dir, Telefono: telefono,
          FechaPedido: fechaPedido, FechaDespacho: fechaReg
        });
      }
    }
  });
  scanCounts = {};
  Object.keys(registros).forEach(f => { scanCounts[f] = { ...registros[f].counts }; });
}

function procesarDespachos(despachosData) {
  const dRows = (despachosData.values || []).slice(1).filter(r => r[0]);
  despachados = {};
  dRows.forEach(r => {
    const factura = r[0] || '';
    if (!despachados[factura]) {
      despachados[factura] = {
        Fecha: r[1]||'', Cliente: r[2]||'', Sucursal: r[3]||'', Telefono: r[4]||'',
        dir: r[5]||'', cajas: parseInt(r[12])||1, fechaDespacho: r[11]||'',
        items: []
      };
    }
    despachados[factura].items.push({
      Sku: r[6]||'', NombreProducto: r[7]||'',
      Cantidad: parseInt(r[8])||0, Despachado: parseInt(r[9])||0, Faltante: parseInt(r[10])||0,
      Enviado: (r[13]||'').toString().toUpperCase()==='TRUE',
      FechaEnvio: r[14]||''
    });
  });
}

// ===== LOGIN =====
function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value.trim();
  const errEl = document.getElementById('loginError');

  if (!user || !pass) {
    errEl.textContent = 'Ingresa usuario y contraseña.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!USUARIOS_VALIDOS.includes(user) || user !== pass) {
    errEl.textContent = 'Usuario o contraseña incorrectos.';
    errEl.classList.remove('hidden');
    return;
  }

  currentUser = user;
  sessionStorage.setItem('pedidos_user', user);
  document.getElementById('loginModal').classList.remove('active');
  document.getElementById('userBadgeName').textContent = user;
  errEl.classList.add('hidden');
  loadAll().then(() => startAutoRefresh());
}

function doLogout() {
  if (!confirm('¿Cerrar sesión?')) return;
  sessionStorage.removeItem('pedidos_user');
  currentUser = null;
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginModal').classList.add('active');
}

// ===== SCANNER EN SEGUNDO PLANO =====
let scanBuffer = '';
let scanTimer  = null;
const SCAN_TIMEOUT = 80;

document.addEventListener('keydown', handleGlobalKey);

function handleGlobalKey(e) {
  if (!currentPedido) return;
  if (despachadosFacturas.has(currentPedido.Factura)) return; // solo lectura, sin escáner activo
  const id  = document.activeElement?.id;
  const cls = document.activeElement?.classList;
  if (id === 'editDireccion') return;
  if (cls && cls.contains('qty-manual')) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(scanTimer);
    if (scanBuffer.trim()) processScan(scanBuffer.trim());
    scanBuffer = '';
    return;
  }
  if (e.key.length === 1) {
    scanBuffer += e.key;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (scanBuffer.trim().length > 2) processScan(scanBuffer.trim());
      scanBuffer = '';
    }, SCAN_TIMEOUT);
  }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  // Config embebida — carga directo después del login
});

// ===== SETUP =====
function saveConfig() {
  closeSetupModal();
  loadAll();
}
function openSetup() {
  switchSetupTab('productos');
  renderProductosList();
  document.getElementById('setupModal').classList.add('active');
}
function closeSetupModal() { document.getElementById('setupModal').classList.remove('active'); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const setupModal = document.getElementById('setupModal');
    if (setupModal && setupModal.classList.contains('active')) closeSetupModal();
  }
});
function showSetupError(msg) {
  const el = document.getElementById('setupError');
  el.textContent = msg; el.classList.remove('hidden');
}

// ===== TABS =====
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-content-' + tab).classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'informe')   renderInforme();
  if (tab === 'despachos') renderDespachosReport();
}

// ===== API SHEETS (lectura) =====
async function sheetsGet(range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.sheetId}/values/${encodeURIComponent(range)}?key=${CONFIG.apiKey}`;
  const res = await fetch(url);
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Error al leer'); }
  return res.json();
}

// ===== APPS SCRIPT (escritura) =====
async function scriptPost(action, rows) {
  await fetch(APPS_SCRIPT_URL, {
    method: 'POST', mode: 'no-cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, rows })
  });
}

// ===== CARGA COMPLETA =====
async function loadAll() {
  showLoading('Cargando datos...');
  try {
    // Cargar pedidos, registros, productos y despachos en paralelo
    const [pedidosData, registroData, productosData, despachosData] = await Promise.all([
      sheetsGet('Pedidos!A1:K'),
      sheetsGet('registro!A1:O').catch(() => ({ values: [] })),
      sheetsGet('Productos!A1:Z').catch(() => ({ values: [] })),
      sheetsGet('despachos!A1:N').catch(() => ({ values: [] }))
    ]);

    // Procesar hoja Pedidos
    const pRows = pedidosData.values || [];
    if (pRows.length >= 2) {
      allPedidos = groupPedidos(pRows[0], pRows.slice(1).filter(r => r.some(c => c)));
    } else { allPedidos = []; }
    updateConsecutivoDisplay();

    // Procesar hoja Productos — mapa CodBarras -> UndVenta + lista para el visor
    const prodRows = productosData.values || [];
    productosMap  = {};
    productosList = [];
    if (prodRows.length >= 2) {
      const headers = prodRows[0];
      const iCod = headers.findIndex(h => h.toLowerCase().trim() === 'codbarras');
      const iUnd = headers.findIndex(h => h.toLowerCase().trim() === 'undventa');
      if (iCod > -1 && iUnd > -1) {
        prodRows.slice(1).forEach(r => {
          const cod = (r[iCod] || '').toString().trim();
          const und = parseFloat(r[iUnd]) || 1;
          if (cod) {
            productosMap[cod.toLowerCase()] = und;
            productosList.push({ CodBarras: cod, UndVenta: und });
          }
        });
      }
    }
    renderProductosList();

    // Procesar hoja registro — tomar el ÚLTIMO registro por factura
    // Cols: Factura(0),Fecha(1),Obs(2),Cliente(3),Sucursal(4),Direccion(5),Telefono(6),sku(7),NomProd(8),
    //       Cantidad(9),CantDesp(10),Fecharegistro(11),Cajas(12),Despachado(13),Despachador(14)
    const rRows = (registroData.values || []).slice(1).filter(r => r[0]);
    registros = {};
    despachadosFacturas = new Set();
    despachosLog = [];
    const despachosVistos = new Set();
    // Primer paso: acumular todos los skus por factura con su ocurrencia (para reconstruir itemKey)
    const skuOcurrencias = {}; // { factura: { sku: count } }
    rRows.forEach(r => {
      const factura = r[0] || '';
      const sku     = r[7] || '';
      if (!factura || !sku) return;
      if (!skuOcurrencias[factura]) skuOcurrencias[factura] = {};
      skuOcurrencias[factura][sku] = 0; // inicializar
    });

    // Segundo paso: procesar filas asignando itemKey correcto
    const skuContador = {}; // { factura: { sku: ocurrencia_actual } }
    rRows.forEach(r => {
      const factura     = r[0] || '';
      const fechaPedido = r[1] || '';
      const cliente     = r[3] || '';
      const sucursal    = r[4] || '';
      const dir         = r[5] || '';
      const telefono    = r[6] || '';
      const sku         = r[7] || '';
      const cant        = parseInt(r[10]) || 0;
      const fechaReg    = r[11] || '';
      const cajas       = parseInt(r[12]) || 1;
      const despachado  = (r[13]||'').toString().toUpperCase()==='TRUE';
      const despachador = r[14] || '';

      if (!registros[factura]) registros[factura] = { dir: '', cajas: 1, counts: {} };
      registros[factura].dir   = dir;
      registros[factura].cajas = cajas;

      // Reconstruir itemKey igual a como lo hace groupPedidos: "sku:ocurrencia"
      if (!skuContador[factura]) skuContador[factura] = {};
      if (!skuContador[factura][sku]) skuContador[factura][sku] = 0;
      skuContador[factura][sku]++;
      const itemKey = (sku||'').toLowerCase() + ':' + skuContador[factura][sku];
      registros[factura].counts[itemKey] = cant;
      // También guardar por SKU directo como fallback
      registros[factura].counts[sku] = cant;

      if (despachado) {
        despachadosFacturas.add(factura);
        if (!despachosVistos.has(factura)) {
          despachosVistos.add(factura);
          despachosLog.push({
            Despachador: despachador, Factura: factura, Cliente: cliente,
            Sucursal: sucursal, Direccion: dir, Telefono: telefono,
            FechaPedido: fechaPedido, FechaDespacho: fechaReg
          });
        }
      }
    });

    // Inicializar scanCounts desde registros (último guardado)
    scanCounts = {};
    Object.keys(registros).forEach(f => {
      scanCounts[f] = { ...registros[f].counts };
    });

    // Procesar hoja despachos — pedidos ya despachados + faltantes con Enviado/FechaEnvio
    // Cols: Factura(0),Fecha(1),Cliente(2),Sucursal(3),Telefono(4),Direccion(5),Sku(6),NomProd(7),
    //       CantPedida(8),CantDespachada(9),Faltante(10),FechaDespacho(11),Cajas(12),Enviado(13),FechaEnvio(14)
    const dRows = (despachosData.values || []).slice(1).filter(r => r[0]);
    despachados = {};
    dRows.forEach(r => {
      const factura = r[0] || '';
      if (!despachados[factura]) {
        despachados[factura] = {
          Fecha: r[1]||'', Cliente: r[2]||'', Sucursal: r[3]||'', Telefono: r[4]||'',
          dir: r[5]||'', cajas: parseInt(r[12])||1, fechaDespacho: r[11]||'',
          items: [], rowIndexBase: null
        };
      }
      despachados[factura].items.push({
        Sku: r[6]||'', NombreProducto: r[7]||'',
        Cantidad: parseInt(r[8])||0, Despachado: parseInt(r[9])||0, Faltante: parseInt(r[10])||0,
        Enviado: (r[13]||'').toString().toUpperCase()==='TRUE' || (r[13]||'')===true,
        FechaEnvio: r[14]||''
      });
    });

    renderPedidos();
    renderHistorial();
    updateSyncStatus(true);
  } catch(e) {
    updateSyncStatus(false);
    showToast('Error al cargar: ' + e.message, 'error');
  } finally { hideLoading(); }
}

function refreshData() { loadAll(); }

// Mapa CodBarras -> UndVenta cargado desde hoja "Productos"
let productosMap  = {};
let productosList = []; // lista plana [{CodBarras, UndVenta}] para el visor en Configuración
function getUndVenta(sku) {
  const v = productosMap[(sku||'').toLowerCase()];
  return (v && v > 0) ? v : 1;
}

// ===== INDICADOR DE ÚLTIMO CONSECUTIVO (Factura) =====
function getUltimoConsecutivo() {
  let max = null;
  allPedidos.forEach(p => {
    const n = parseInt((p.Factura||'').toString().replace(/[^0-9]/g,''));
    if (!isNaN(n) && (max === null || n > max)) max = n;
  });
  return max;
}
function updateConsecutivoDisplay() {
  const max = getUltimoConsecutivo();
  const text = (max !== null) ? max.toString() : '—';
  const elP = document.getElementById('consecutivoNumPedidos');
  const elS = document.getElementById('consecutivoNumSubir');
  if (elP) elP.textContent = text;
  if (elS) elS.textContent = text;
}

// ===== CONFIGURACIÓN — TABS INTERNOS =====
function switchSetupTab(tab) {
  document.querySelectorAll('.setup-tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.setup-tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('setup-content-' + tab).classList.add('active');
  document.getElementById('setup-tab-' + tab).classList.add('active');
  if (tab === 'productos') renderProductosList();
}

// ===== VALIDACIÓN EN VIVO MIENTRAS ESCRIBE EL CÓDIGO =====
function checkCodBarrasEnVivo() {
  const codInput = document.getElementById('nuevoCodBarras');
  const cod = codInput.value.trim();
  const msgEl = document.getElementById('productosFormMsg');

  if (!cod) { msgEl.classList.add('hidden'); codInput.classList.remove('input-error'); return; }

  if (productosMap[cod.toLowerCase()] !== undefined) {
    msgEl.innerHTML = `⛔ Este código ya existe (Unidad Venta = ${productosMap[cod.toLowerCase()]})`;
    msgEl.classList.remove('hidden');
    codInput.classList.add('input-error');
  } else {
    msgEl.classList.add('hidden');
    codInput.classList.remove('input-error');
  }
}

// ===== FORMULARIO AGREGAR PRODUCTO (CodBarras + UndVenta) =====
async function agregarProducto() {
  const cod = document.getElementById('nuevoCodBarras').value.trim();
  const und = parseFloat(document.getElementById('nuevoUndVenta').value) || 1;
  const msgEl = document.getElementById('productosFormMsg');
  const codInput = document.getElementById('nuevoCodBarras');
  msgEl.classList.add('hidden');
  codInput.classList.remove('input-error');

  if (!cod) {
    msgEl.textContent = 'Ingresa el código de barras.';
    msgEl.classList.remove('hidden');
    return;
  }
  if (productosMap[cod.toLowerCase()] !== undefined) {
    msgEl.innerHTML = `⛔ <strong>El código "${escHtml(cod)}" ya está registrado</strong> con Unidad Venta = ${productosMap[cod.toLowerCase()]}. No se permiten SKU duplicados.`;
    msgEl.classList.remove('hidden');
    codInput.classList.add('input-error');
    showToast(`⚠ El SKU "${cod}" ya existe — no se puede duplicar`, 'warning');
    // Resaltar la fila existente en la lista de abajo
    document.getElementById('searchProductos').value = cod;
    filterProductosList();
    return;
  }

  showLoading('Guardando producto...');
  try {
    await scriptPost('appendProducto', [[cod, und]]);
    productosMap[cod.toLowerCase()] = und;
    productosList.push({ CodBarras: cod, UndVenta: und });
    renderProductosList();
    document.getElementById('nuevoCodBarras').value = '';
    document.getElementById('nuevoUndVenta').value  = '';
    showToast('✓ Producto agregado correctamente', 'success');
  } catch(e) {
    msgEl.textContent = 'Error al guardar: ' + e.message;
    msgEl.classList.remove('hidden');
  } finally { hideLoading(); }
}

function renderProductosList() {
  const body  = document.getElementById('productosListBody');
  const empty = document.getElementById('productosListEmpty');
  const table = document.getElementById('productosListTable');
  if (!body) return;

  const q = (document.getElementById('searchProductos')?.value||'').toLowerCase();
  const filtered = productosList.filter(p => !q || p.CodBarras.toLowerCase().includes(q));

  if (!filtered.length) {
    table.style.display = 'none';
    empty.classList.remove('hidden');
    return;
  }
  table.style.display = '';
  empty.classList.add('hidden');

  body.innerHTML = filtered.map(p => `<tr>
    <td><code>${escHtml(p.CodBarras)}</code></td>
    <td style="text-align:center;font-weight:700">${p.UndVenta}</td>
  </tr>`).join('');
}
function filterProductosList() { renderProductosList(); }

// ===== AGRUPAR PEDIDOS =====
function groupPedidos(headers, rows) {
  const idx = name => headers.findIndex(h => h.toLowerCase().trim() === name.toLowerCase());
  const iF=idx('factura'),iFe=idx('fecha'),iO=idx('observacion'),iC=idx('cliente'),
        iS=idx('sucursal'),iD=idx('direccion'),iT=idx('telefono'),
        iSk=idx('sku'),iN=idx('nombre producto'),iCa=idx('cantidad'),iDe=idx('despachado');
  const mapa = {};
  rows.forEach(r => {
    const f = r[iF]||''; if (!f) return;
    if (!mapa[f]) mapa[f] = { Factura:f,Fecha:r[iFe]||'',Observacion:r[iO]||'',
      Cliente:r[iC]||'',Sucursal:r[iS]||'',Direccion:r[iD]||'',Telefono:r[iT]||'',items:[] };
    mapa[f].items.push({ Sku:r[iSk]||'',NombreProducto:r[iN]||'',
      Cantidad:parseInt(r[iCa])||0,Despachado:parseInt(r[iDe])||0,
      Bonificado:false });
  });

  // Ordenar por SKU y asignar itemKey único (sku + ocurrencia) + marcar duplicados
  return Object.values(mapa).map(pedido => {
    pedido.items.sort((a,b) => (a.Sku||'').localeCompare(b.Sku||''));
    const skuCount = {};
    pedido.items.forEach(item => {
      const s = (item.Sku||'').toLowerCase();
      skuCount[s] = (skuCount[s]||0) + 1;
      item.itemKey = s + ':' + skuCount[s]; // clave única: "sku:1", "sku:2", etc.
      item.SkuOcurrencia = skuCount[s];     // 1 = primero, 2 = segundo (duplicado), etc.
    });
    // Segunda pasada: marcar los que tienen más de una ocurrencia total
    const skuTotal = {};
    pedido.items.forEach(item => {
      const s = (item.Sku||'').toLowerCase();
      skuTotal[s] = (skuTotal[s]||0) + 1;
    });
    pedido.items.forEach(item => {
      const s = (item.Sku||'').toLowerCase();
      item.EsDuplicado = skuTotal[s] > 1; // cualquier aparición de un SKU repetido
    });
    return pedido;
  });
}

// ===== PROGRESO =====
function getPedidoProgress(pedido) {
  const c = scanCounts[pedido.Factura] || {};
  let total=0, done=0;
  pedido.items.forEach(i => {
    total += i.Cantidad;
    done  += Math.min(c[scanKey(i)]||0, i.Cantidad);
  });
  return { total, done, pct: total>0 ? Math.round((done/total)*100) : 0 };
}

// ===== RENDER PEDIDOS (excluye despachados) =====
function renderPedidos() {
  const grid = document.getElementById('pedidosGrid');
  const pendientes  = allPedidos.filter(p => !despachadosFacturas.has(p.Factura));
  const despachadosCount = allPedidos.filter(p => despachadosFacturas.has(p.Factura)).length;

  // Poblar filtro sucursal
  const sucursales = [...new Set(allPedidos.map(p => p.Sucursal).filter(Boolean))];
  const sel = document.getElementById('filterSucursal');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todas las sucursales</option>' +
    sucursales.map(s => `<option value="${s}" ${s===cur?'selected':''}>${s}</option>`).join('');

  // Stats globales
  let enProgreso=0, sinIniciar=0;
  pendientes.forEach(p => {
    const pr = getPedidoProgress(p);
    if (pr.pct>0) enProgreso++; else sinIniciar++;
  });
  document.getElementById('statTotal').textContent     = allPedidos.length;
  document.getElementById('statCompletos').textContent  = despachadosCount;
  document.getElementById('statParciales').textContent  = enProgreso;
  document.getElementById('statPendientes').textContent = sinIniciar;

  // Badge historial
  const badge = document.getElementById('historialBadge');
  if (despachadosCount > 0) {
    badge.textContent = despachadosCount;
    badge.style.display = 'inline-flex';
  } else { badge.style.display = 'none'; }

  const filtered = getFilteredPedidos(pendientes);
  document.getElementById('pedidosSubtitle').textContent = filtered.length + ' pedido(s) pendiente(s)';

  if (!filtered.length) {
    grid.innerHTML = despachadosCount > 0
      ? `<div class="empty-state"><div class="empty-icon">🎉</div><p>¡Todos los pedidos están despachados!</p><span>Revisa el Historial para ver los despachados</span></div>`
      : `<div class="empty-state"><div class="empty-icon">📋</div><p>No hay pedidos</p><span>Sube pedidos en la pestaña "Subir Pedidos"</span></div>`;
    return;
  }
  grid.innerHTML = filtered.map(p => buildPedidoCard(p, false)).join('');
}

function getFilteredPedidos(lista) {
  const q   = (document.getElementById('searchPedido')?.value||'').toLowerCase();
  const suc = document.getElementById('filterSucursal')?.value||'';
  return lista.filter(p => {
    const mq = !q || p.Factura.toLowerCase().includes(q)||p.Cliente.toLowerCase().includes(q)||p.Sucursal.toLowerCase().includes(q);
    return mq && (!suc||p.Sucursal===suc);
  });
}
function filterPedidos() { renderPedidos(); }

// ===== RENDER HISTORIAL (solo despachados) =====
function renderHistorial() {
  const grid = document.getElementById('historialGrid');
  const despachadosList = allPedidos.filter(p => despachadosFacturas.has(p.Factura));
  const q = (document.getElementById('searchHistorial')?.value||'').toLowerCase();
  const filtered = despachadosList.filter(p =>
    !q || p.Factura.toLowerCase().includes(q) || p.Cliente.toLowerCase().includes(q)
  );
  document.getElementById('historialSubtitle').textContent = filtered.length + ' pedido(s) despachado(s)';

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>No hay pedidos despachados aún</p><span>Los pedidos despachados aparecerán aquí automáticamente</span></div>`;
    return;
  }
  grid.innerHTML = filtered.map(p => buildPedidoCard(p, true)).join('');
}
function filterHistorial() { renderHistorial(); }

function editarPedidoDesdeHistorial(factura) {
  const clave = prompt('Ingresa la clave para editar este pedido:');
  if (clave === null) return;
  if (clave.trim() !== '901143584') {
    showToast('⛔ Clave incorrecta — edición cancelada', 'error');
    return;
  }
  // Quitar de despachados para que vuelva a Pedidos para Alistar
  despachadosFacturas.delete(factura);
  // Limpiar scanCounts y localStorage para ese pedido
  delete scanCounts[factura];
  clearScanLocal(factura);
  // Abrir el pedido en modo editable
  openPedido(factura);
  showToast('✏️ Pedido desbloqueado para edición', 'success');
  renderPedidos();
  renderHistorial();
}

// ===== CARD PEDIDO =====
function buildPedidoCard(p, isHistorial) {
  const pr    = getPedidoProgress(p);
  const despachado = despachadosFacturas.has(p.Factura);
  const localData  = loadScanLocal(p.Factura);
  const enProceso  = !despachado && localData && Object.values(localData).some(v => v > 0);
  const est   = despachado ? 'completado' : enProceso ? 'en-progreso' : pr.pct > 0 ? 'en-progreso' : 'pendiente';
  const badge = despachado ? '🚚 Despachado' : enProceso ? '⏳ En Proceso' : pr.pct > 0 ? '↻ En progreso' : '○ Pendiente';
  // Usar dirección del último registro si existe
  const dir = (registros[p.Factura]?.dir) || p.Direccion;
  return `<div class="pedido-card ${est}" onclick="openPedido('${escHtml(p.Factura)}')">
    <div class="card-header">
      <span class="card-factura">📄 ${escHtml(p.Factura)}</span>
      <span class="card-badge ${est}">${badge}</span>
    </div>
    <div class="card-body">
      <div class="card-row"><span class="label">🗓 Fecha</span><span class="value">${escHtml(p.Fecha)}</span></div>
      <div class="card-row"><span class="label">👤 Cliente</span><span class="value">${escHtml(p.Cliente)}</span></div>
      <div class="card-row"><span class="label">🏪 Sucursal</span><span class="value">${escHtml(p.Sucursal)}</span></div>
      <div class="card-row"><span class="label">📞 Teléfono</span><span class="value">${escHtml(p.Telefono)}</span></div>
      <div class="card-row"><span class="label">📍 Dirección</span><span class="value">${escHtml(dir)}</span></div>
      ${p.Observacion?`<div class="card-obs">💬 ${escHtml(p.Observacion)}</div>`:''}
    </div>
    <div class="card-footer">
      <div class="card-progress">
        <div class="mini-bar"><div class="mini-bar-fill ${est}" style="width:${pr.pct}%"></div></div>
        <span class="card-progress-text">${pr.done}/${pr.total} uds · ${pr.pct}%</span>
      </div>
      ${isHistorial
        ? `<button class="btn-editar-historial" onclick="event.stopPropagation();editarPedidoDesdeHistorial('${escHtml(p.Factura)}')">✏️ Editar</button>`
        : `<span class="card-enter">Abrir →</span>`}
    </div>
  </div>`;
}

// ===== MODAL PEDIDO =====
function openPedido(factura) {
  const pedido = allPedidos.find(p => p.Factura===factura);
  if (!pedido) return;
  currentPedido = pedido;

  // Inicializar scanCounts: prioridad localStorage > registros de Sheets
  if (!scanCounts[factura]) scanCounts[factura] = {};
  // 1. Cargar desde Sheets (base)
  if (registros[factura]) {
    Object.keys(registros[factura].counts).forEach(k => {
      if (!(k in scanCounts[factura])) {
        scanCounts[factura][k] = registros[factura].counts[k];
      }
    });
  }
  // 2. Sobreescribir con localStorage si hay trabajo en proceso guardado
  const localCounts = loadScanLocal(factura);
  if (localCounts && Object.keys(localCounts).length > 0) {
    scanCounts[factura] = { ...scanCounts[factura], ...localCounts };
  }

  const yaDespachado = despachadosFacturas.has(factura);

  document.getElementById('modalFactura').textContent = factura;
  // Dirección y cajas: última guardada en registro > original del pedido
  const dir   = registros[factura]?.dir   || pedido.Direccion;
  const cajas = registros[factura]?.cajas || 1;
  document.getElementById('editDireccion').value = dir;
  document.getElementById('editCajas').value     = cajas;
  document.getElementById('editDireccion').disabled = yaDespachado;
  document.getElementById('editCajas').disabled      = yaDespachado;

  const info = [
    {label:'Fecha',     value:pedido.Fecha},
    {label:'Cliente',   value:pedido.Cliente},
    {label:'Sucursal',  value:pedido.Sucursal},
    {label:'Teléfono',  value:pedido.Telefono},
    {label:'Observación',value:pedido.Observacion||'—'},
  ];
  if (yaDespachado) {
    const log = despachosLog.find(l => l.Factura === factura);
    info.push({label:'Despachado por', value: log?.Despachador || registros[factura]?.despachador || '—'});
    info.push({label:'Fecha despacho', value: log?.FechaDespacho || registros[factura]?.fechaDespacho || '—'});
  }
  document.getElementById('orderInfoGrid').innerHTML = info.map(i=>
    `<div class="info-item"><span class="info-label">${i.label}</span><span class="info-value">${escHtml(i.value)}</span></div>`
  ).join('');

  // Banner de solo lectura si ya fue despachado
  const banner = document.getElementById('readonlyBanner');
  if (yaDespachado) {
    banner.classList.remove('hidden');
    document.getElementById('scannerStatus').classList.add('hidden');
    document.getElementById('despacharBtn').classList.add('hidden');
  } else {
    banner.classList.add('hidden');
    document.getElementById('scannerStatus').classList.remove('hidden');
    document.getElementById('despacharBtn').classList.remove('hidden');
  }

  renderProductosTable();
  document.getElementById('pedidoModal').classList.add('active');
  loadMediaForPedido(factura);
}

function closeModal() {
  document.getElementById('pedidoModal').classList.remove('active');
  document.getElementById('scannerStatus').classList.add('hidden');
  scanBuffer=''; clearTimeout(scanTimer);
  currentPedido = null;
  renderPedidos();
  renderHistorial();
  renderDespachosReport();
}

// ===== RENDER TABLA PRODUCTOS =====
function renderProductosTable() {
  if (!currentPedido) return;
  const counts = scanCounts[currentPedido.Factura] || {};
  const body = document.getElementById('productosBody');
  const readOnly = despachadosFacturas.has(currentPedido.Factura);
  let totalItems=0, doneItems=0;

  body.innerHTML = currentPedido.items.map((item) => {
    const pedido = item.Cantidad;
    const esc    = counts[scanKey(item)] || 0;
    totalItems  += pedido;
    doneItems   += Math.min(esc, pedido);

    let rowClass='',badgeClass='badge-pendiente',badgeText='○ Pendiente';
    if (esc>0&&esc<pedido)        {rowClass='row-falta'; badgeClass='badge-falta';  badgeText=`⚠ Faltan ${pedido-esc}`;}
    else if(esc===pedido&&pedido>0){rowClass='row-ok';   badgeClass='badge-ok';    badgeText='✓ Completo';}
    else if(esc>pedido)            {rowClass='row-exceso';badgeClass='badge-exceso';badgeText=`⚡ Exceso +${esc-pedido}`;}

    const qtyCell = readOnly
      ? `<span class="qty-readonly">${esc}</span>`
      : `<div class="qty-controls">
          <button class="qty-btn" onclick="adjustQty('${escHtml(item.itemKey)}',-1)">−</button>
          <input type="number" min="0" class="qty-manual" value="${esc}"
            onchange="setQtyManual('${escHtml(item.itemKey)}',this.value)"
            onclick="this.select()" />
          <button class="qty-btn" onclick="adjustQty('${escHtml(item.itemKey)}',1)">+</button>
        </div>`;

    // Casilla "Bonificado" + botón X borrar — solo para filas con SKU duplicado
    const bonificadoCell = item.EsDuplicado && !readOnly
      ? `<div class="dup-actions">
           <label class="bonificado-label">
             <input type="checkbox" class="bonificado-check" ${item.Bonificado?'checked':''}
               onchange="toggleBonificado('${escHtml(item.itemKey)}',this.checked)" />
             Bonificado
           </label>
           <button class="btn-borrar-dup" onclick="borrarItemDuplicado('${escHtml(item.itemKey)}')" title="Borrar este item duplicado">✕</button>
         </div>`
      : '';

    // SKU badge duplicado en TODAS las ocurrencias del SKU repetido — color azul
    const skuCell = item.EsDuplicado
      ? `<strong>${escHtml(item.Sku)}</strong> <span class="sku-dup-badge">dup</span>`
      : `<strong>${escHtml(item.Sku)}</strong>`;

    return `<tr class="${rowClass}${item.EsDuplicado?' row-duplicado':''}${item.Bonificado?' row-bonificado':''}">
      <td>${skuCell}</td>
      <td>${escHtml(item.NombreProducto)}</td>
      <td style="text-align:center;font-weight:700">${pedido}</td>
      <td style="text-align:center;padding:4px 8px">${qtyCell}</td>
      <td><span class="badge-estado ${badgeClass}">${badgeText}</span>${bonificadoCell}</td>
    </tr>`;
  }).join('');

  const pct = totalItems>0 ? Math.round((doneItems/totalItems)*100) : 0;
  document.getElementById('progressFill').style.width = pct+'%';
  document.getElementById('progressText').textContent = `${doneItems} / ${totalItems} unidades — ${pct}%`;
}

// ===== AJUSTE MANUAL CANTIDAD =====
// Clave única por item en scanCounts (usa itemKey asignado en groupPedidos)
function scanKey(item) { return item.itemKey || (item.Sku||'').toLowerCase(); }

function adjustQty(itemKey, delta) {
  if (!currentPedido) return;
  const f = currentPedido.Factura;
  if (!scanCounts[f]) scanCounts[f]={};
  scanCounts[f][itemKey] = Math.max(0,(scanCounts[f][itemKey]||0)+delta);
  saveScanLocal(f);
  renderProductosTable();
}

function setQtyManual(itemKey, val) {
  if (!currentPedido) return;
  const f = currentPedido.Factura;
  if (!scanCounts[f]) scanCounts[f]={};
  scanCounts[f][itemKey] = Math.max(0,parseInt(val)||0);
  saveScanLocal(f);
  renderProductosTable();
}

function toggleBonificado(itemKey, checked) {
  if (!currentPedido) return;
  const item = currentPedido.items.find(i => i.itemKey === itemKey);
  if (item) { item.Bonificado = checked; }
  renderProductosTable();
}

function borrarItemDuplicado(itemKey) {
  if (!currentPedido) return;
  const item = currentPedido.items.find(i => i.itemKey === itemKey);
  if (!item) return;

  // Confirmación con descripción del item
  const confirmar = confirm(
    `¿Deseas borrar este producto duplicado?\n\n` +
    `SKU: ${item.Sku}\n` +
    `Producto: ${item.NombreProducto}\n` +
    `Cantidad: ${item.Cantidad}\n\n` +
    `Esta acción solo afecta la sesión actual.`
  );
  if (!confirmar) return;

  // Pedir clave de autorización
  const clave = prompt('Ingresa la clave de autorización para borrar:');
  if (clave === null) return; // canceló
  if (clave.trim() !== '901143584') {
    showToast('⛔ Clave incorrecta — borrado cancelado', 'error');
    return;
  }

  // Borrar el item del pedido
  currentPedido.items = currentPedido.items.filter(i => i.itemKey !== itemKey);

  // Limpiar scanCount para ese item
  const f = currentPedido.Factura;
  if (scanCounts[f]) delete scanCounts[f][itemKey];
  saveScanLocal(f);

  // Re-evaluar duplicados (puede que ya no haya duplicados del mismo SKU)
  const skuTotal = {};
  currentPedido.items.forEach(i => {
    const s = (i.Sku||'').toLowerCase();
    skuTotal[s] = (skuTotal[s]||0) + 1;
  });
  currentPedido.items.forEach(i => {
    i.EsDuplicado = skuTotal[(i.Sku||'').toLowerCase()] > 1;
  });

  showToast('✓ Producto borrado de la separación', 'success');
  renderProductosTable();
}

// ===== SCANNER =====
function processScan(sku) {
  if (!currentPedido) return;
  const f = currentPedido.Factura;
  if (!scanCounts[f]) scanCounts[f]={};

  // Buscar todos los items con este SKU en orden de aparición
  const matchingItems = currentPedido.items.filter(i => i.Sku.toLowerCase()===sku.toLowerCase());
  if (!matchingItems.length) { showToast('⚠ SKU no encontrado: '+sku,'warning'); return; }

  // Llenar en orden: primero el que no esté completo aún
  let item = matchingItems.find(i => (scanCounts[f][scanKey(i)]||0) < i.Cantidad);
  if (!item) item = matchingItems[matchingItems.length-1]; // todos completos → sumar al último

  const multiplicador = getUndVenta(item.Sku);
  const key = scanKey(item);
  scanCounts[f][key] = (scanCounts[f][key]||0) + multiplicador;
  saveScanLocal(f);
  const nuevo = scanCounts[f][key], pedido = item.Cantidad;
  flashRow(item.Sku);

  const sufijoMult = multiplicador > 1 ? ` (x${multiplicador})` : '';
  const sufijoBon  = item.EsDuplicado ? ` [${item.SkuOcurrencia}°]` : '';
  if(nuevo===pedido)    showToast('✓ '+item.NombreProducto+sufijoBon+' — COMPLETO'+sufijoMult,'success');
  else if(nuevo>pedido) showToast('⚡ Exceso: '+nuevo+'/'+pedido+sufijoBon+sufijoMult,'warning');
  else                  showToast('→ '+item.NombreProducto+sufijoBon+': '+nuevo+'/'+pedido+sufijoMult,'');
  renderProductosTable();
}
function flashRow(sku) {
  document.querySelectorAll('#productosBody tr').forEach(row => {
    if (row.querySelector('td:first-child strong')?.textContent===sku) {
      row.classList.add('scan-flash');
      setTimeout(()=>row.classList.remove('scan-flash'),500);
    }
  });
}
function resetCounts() {
  if (!currentPedido) return;
  if (!confirm('¿Reiniciar el conteo de este pedido?')) return;
  scanCounts[currentPedido.Factura]={};
  clearScanLocal(currentPedido.Factura);
  renderProductosTable();
  showToast('Conteo reiniciado','');
}

// ===== CAJAS =====
function adjustCajas(delta) {
  const input = document.getElementById('editCajas');
  input.value = Math.max(1, (parseInt(input.value)||1) + delta);
}

// ===== DESPACHAR PEDIDO (única acción: guarda registro + pasa a historial + genera faltantes) =====
async function despacharPedido() {
  if (!currentPedido) return;
  const p       = currentPedido;
  const factura = p.Factura;
  const counts  = scanCounts[factura]||{};
  const dir     = document.getElementById('editDireccion').value.trim();
  const cajas   = parseInt(document.getElementById('editCajas').value)||1;
  const pr      = getPedidoProgress(p);

  const faltantes = p.items.filter(i => (counts[scanKey(i)]||0) < i.Cantidad);
  let msg = `¿Confirmar despacho de la factura ${factura}?\n\nDespachado por: ${currentUser}\nProgreso: ${pr.pct}% (${pr.done}/${pr.total} unidades)\nCajas: ${cajas}`;
  if (faltantes.length > 0) {
    msg += `\n\n⚠️ Hay ${faltantes.length} producto(s) incompleto(s) — quedarán registrados en el Informe de Faltantes:\n`;
    msg += faltantes.slice(0,5).map(i=>`• ${i.NombreProducto}: ${counts[scanKey(i)]||0}/${i.Cantidad}`).join('\n');
    if (faltantes.length>5) msg += `\n...y ${faltantes.length-5} más`;
  }
  if (!confirm(msg)) return;

  const ahora = new Date().toLocaleString('es-CO',{timeZone:'America/Bogota'});

  // 1. Guardar TODO en hoja registro + marca Despachado=TRUE + Despachador
  const regRows = p.items.map(item => [
    factura, p.Fecha, p.Observacion, p.Cliente, p.Sucursal, dir, p.Telefono,
    item.Sku, item.NombreProducto, item.Cantidad, counts[scanKey(item)]||0, ahora, cajas, 'TRUE', currentUser
  ]);

  // 2. Guardar SOLO los que tienen faltante REAL > 0 en hoja despachos
  const despRows = faltantes.map(item => {
    const esc      = counts[scanKey(item)]||0;
    const faltante = Math.max(0, item.Cantidad - esc);
    return [factura, p.Fecha, p.Cliente, p.Sucursal, p.Telefono, dir,
      item.Sku, item.NombreProducto, item.Cantidad, esc, faltante, ahora, cajas, 'FALSE', ''];
  });

  showLoading('Despachando pedido...');
  try {
    await scriptPost('appendRegistro', regRows);
    if (despRows.length > 0) await scriptPost('appendDespachos', despRows);

    // Actualizar memoria — pedido pasa a historial (despachado=true)
    registros[factura] = { dir, cajas, counts: {...counts}, despachado: true, fechaDespacho: ahora };
    despachadosFacturas.add(factura);
    despachosLog.push({
      Despachador: currentUser, Factura: factura, Cliente: p.Cliente,
      Sucursal: p.Sucursal, Direccion: dir, Telefono: p.Telefono,
      FechaPedido: p.Fecha, FechaDespacho: ahora
    });

    if (despRows.length > 0) {
      if (!despachados[factura]) {
        despachados[factura] = { Fecha:p.Fecha, Cliente:p.Cliente, Sucursal:p.Sucursal,
          Telefono:p.Telefono, dir, cajas, fechaDespacho: ahora, items: [] };
      }
      faltantes.forEach(item => {
        const esc = counts[scanKey(item)]||0;
        despachados[factura].items.push({
          Sku:item.Sku, NombreProducto:item.NombreProducto, Cantidad:item.Cantidad,
          Despachado:esc, Faltante: Math.max(0,item.Cantidad-esc), Enviado:false, FechaEnvio:''
        });
      });
    }

    showToast('🚚 Pedido despachado — movido a Historial'+(despRows.length?` (${despRows.length} faltante(s) registrados)`:''), 'success');
    clearScanLocal(factura);
    closeModal();
    renderPedidos();
    renderHistorial();
    renderInforme();
    setTimeout(() => silentRefresh(), 3000);
  } catch(e) {
    showToast('Error al despachar: '+e.message,'error');
  } finally { hideLoading(); }
}

// ===== IMPRIMIR STICKERS POR CAJA (100x100mm) =====
function printSticker() {
  if (!currentPedido) return;
  const p     = currentPedido;
  const dir   = document.getElementById('editDireccion').value.trim() || p.Direccion;
  const cajas = parseInt(document.getElementById('editCajas').value)||1;
  const ahora = new Date().toLocaleString('es-CO',{timeZone:'America/Bogota'});
  const LOGO  = 'data:image/jpeg;base64,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';

  const pages = [];
  for (let caja = 1; caja <= cajas; caja++) {
    const esUltima = caja === cajas;
    pages.push(`<div class="sp"${!esUltima ? ' style="page-break-after:always"' : ''}>

      <!-- REMITENTE -->
      <div class="rem">
        <img src="${LOGO}" class="logo" alt="Logo"/>
        <div class="rem-info">
          <div class="rem-nom">GRUPO TYT SAS</div>
          <div class="rem-d">Tel: 316 5550167</div>
          <div class="rem-d">Cr 53 #48-15 P7 Medellin-Colombia</div>
        </div>
      </div>

      <hr class="sep"/>

      <!-- DESTINATARIO -->
      <div class="dest">
        <div class="dest-lbl">DESTINATARIO</div>
        <div class="fnum">${escHtml(p.Factura)}</div>
        <div class="cli">${escHtml(p.Cliente)}</div>
        <div class="row-d"><span class="lbl">Sucursal</span><span class="val">${escHtml(p.Sucursal)}</span></div>
        <div class="row-d"><span class="lbl">Tel</span><span class="val">${escHtml(p.Telefono)}</span></div>
        <div class="row-d"><span class="lbl">Fecha</span><span class="val">${escHtml(p.Fecha)}</span></div>
        <div class="dir">${escHtml(dir)}</div>
      </div>

      <!-- CAJA COUNTER -->
      <div class="bot">
        <hr class="sep"/>
        <div class="cnt">
          <span class="ca">${caja}</span><span class="cs">/</span><span class="ct">${cajas}</span>
        </div>
        <div class="cl">CAJA ${caja} DE ${cajas}</div>
        <div class="ts">${ahora}</div>
      </div>

    </div>`);
  }

  const html = `<html><head><meta charset="UTF-8">
  <title>Etiquetas ${escHtml(p.Factura)}</title>
  <style>
    /* ── TSC TE200: 100mm x 80mm, sin márgenes ── */
    @page {
      size: 100mm 80mm;
      margin: 0mm;
    }
    html, body {
      width: 100mm;
      height: 80mm;
      margin: 0;
      padding: 0;
      background: white;
    }
    * { box-sizing: border-box; font-family: Arial, sans-serif; }

    /* Una etiqueta ocupa exactamente la página */
    .sp {
      width: 100mm;
      height: 80mm;
      padding: 3mm 3.5mm 2.5mm 3.5mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
    }

    /* REMITENTE */
    .rem      { display:flex; align-items:center; gap:2.5mm; flex-shrink:0; }
    .logo     { width:20mm; height:20mm; object-fit:contain; flex-shrink:0; }
    .rem-info { display:flex; flex-direction:column; gap:0.6mm; }
    .rem-nom  { font-size:10pt; font-weight:900; color:#1a2744; }
    .rem-d    { font-size:7.5pt; color:#475569; line-height:1.3; }

    /* SEPARADOR */
    .sep { border:none; border-top:0.4mm solid #1a2744; margin:1.8mm 0; flex-shrink:0; }

    /* DESTINATARIO */
    .dest     { flex:1; display:flex; flex-direction:column; gap:0.9mm; }
    .dest-lbl { font-size:7pt; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.8px; }
    .fnum     { font-size:19pt; font-weight:900; color:#1a2744; line-height:1; }
    .cli      { font-size:9.5pt; font-weight:700; color:#1a2744; }
    .row-d    { display:flex; justify-content:space-between; align-items:baseline; }
    .lbl      { font-size:7pt; color:#94a3b8; text-transform:uppercase; font-weight:600; flex-shrink:0; }
    .val      { font-size:8.5pt; font-weight:700; color:#1a2744; text-align:right; max-width:55mm; word-break:break-word; }
    .dir      { font-size:8.5pt; font-weight:700; color:#0f172a; line-height:1.25;
                background:#f1f5f9; padding:1mm 1.5mm; border-radius:1mm; margin-top:0.8mm; }

    /* CONTADOR CAJA */
    .bot { flex-shrink:0; display:flex; flex-direction:column; align-items:center; }
    .cnt { display:flex; align-items:baseline; gap:0.5mm; line-height:1; }
    .ca  { font-size:22pt; font-weight:900; color:#1a2744; }
    .cs  { font-size:14pt; font-weight:700; color:#94a3b8; }
    .ct  { font-size:14pt; font-weight:700; color:#64748b; }
    .cl  { font-size:8pt; font-weight:700; color:#1a2744; text-transform:uppercase; letter-spacing:0.5px; margin-top:0.4mm; }
    .ts  { font-size:6pt; color:#94a3b8; margin-top:0.4mm; }
  </style></head>
  <body>${pages.join('')}</body></html>`;

  const win = window.open('','_blank','width=450,height=400');
  win.document.write(html);
  win.document.close();
  win.onload = () => { win.print(); win.onafterprint = () => win.close(); };
}

// ===== MULTIMEDIA — FOTOS Y VIDEOS =====
let mediaCache = {}; // { factura: [ {fileId, name, mimeType, viewUrl, thumbUrl}, ... ] }

async function loadMediaForPedido(factura) {
  document.getElementById('mediaGrid').querySelectorAll('.media-thumb').forEach(el => el.remove());
  document.getElementById('mediaEmpty').style.display = '';

  // Limpiar caché para siempre cargar fresco al abrir
  delete mediaCache[factura];

  const facturaSafe = factura.toString().replace(/[^a-zA-Z0-9_\-]/g,'_');

  // Intentar primero con fetch directo (funciona desde PC/Chrome)
  try {
    const url  = `${APPS_SCRIPT_URL}?action=getFiles&factura=${encodeURIComponent(facturaSafe)}`;
    const res  = await fetch(url, { mode: 'cors' });
    const data = await res.json();
    mediaCache[factura] = data.ok ? (data.data || []) : [];
    renderMediaGrid(factura);
    return;
  } catch(e) {
    // fetch bloqueado por CORS → intentar JSONP (funciona desde móvil)
  }

  // Fallback: JSONP
  try {
    const data = await fetchJsonp(
      `${APPS_SCRIPT_URL}?action=getFiles&factura=${encodeURIComponent(facturaSafe)}`
    );
    mediaCache[factura] = data.ok ? (data.data || []) : [];
  } catch(e) {
    mediaCache[factura] = [];
  }
  renderMediaGrid(factura);
}

// JSONP — GET sin CORS desde móvil a Apps Script
function fetchJsonp(url) {
  return new Promise((resolve) => {
    const cbName = 'jsonp_cb_' + Date.now();
    const script = document.createElement('script');
    const timeout = setTimeout(() => { cleanup(); resolve({ok:false,data:[]}); }, 10000);
    window[cbName] = (data) => { clearTimeout(timeout); cleanup(); resolve(data); };
    script.src     = url + '&callback=' + cbName;
    script.onerror = () => { clearTimeout(timeout); cleanup(); resolve({ok:false,data:[]}); };
    document.head.appendChild(script);
    function cleanup() {
      try { document.head.removeChild(script); } catch(e){}
      delete window[cbName];
    }
  });
}

function renderMediaGrid(factura) {
  const grid  = document.getElementById('mediaGrid');
  const empty = document.getElementById('mediaEmpty');
  grid.querySelectorAll('.media-thumb').forEach(el => el.remove());

  const files = mediaCache[factura] || [];
  if (!files.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';

  files.forEach(f => {
    const div = document.createElement('div');
    div.className = 'media-thumb';
    div.title     = f.name;
    div.onclick   = () => openLightbox(f);

    const isImg = f.thumbUrl !== null;
    if (isImg) {
      // Usar URL de thumbnail pública de Drive (no requiere auth)
      const thumbSrc = `https://drive.google.com/thumbnail?id=${f.fileId}&sz=w200`;
      div.innerHTML = `
        <img src="${thumbSrc}" alt="${escHtml(f.name)}" loading="lazy"
          onerror="this.parentElement.innerHTML='<div class=\'media-img-icon\'>🖼️</div><span class=\'media-thumb-name\'>${escHtml(f.name)}</span>'" />
        <span class="media-thumb-name">${escHtml(f.name)}</span>`;
    } else {
      div.innerHTML = `
        <div class="media-video-icon">▶</div>
        <span class="media-thumb-name">${escHtml(f.name)}</span>`;
    }
    grid.appendChild(div);
  });
}

async function uploadMediaFiles(e) {
  const files   = Array.from(e.target.files);
  const factura = currentPedido?.Factura;
  if (!files.length || !factura) return;
  e.target.value = '';

  const tooBig = files.filter(f => f.size > 20 * 1024 * 1024);
  if (tooBig.length) showToast(`⚠ ${tooBig.length} archivo(s) superan 20MB`, 'warning');
  const valid = files.filter(f => f.size <= 20 * 1024 * 1024);
  if (!valid.length) return;

  const prog     = document.getElementById('mediaProgress');
  const progFill = document.getElementById('mediaProgressFill');
  const progText = document.getElementById('mediaProgressText');
  prog.classList.remove('hidden');

  for (let i = 0; i < valid.length; i++) {
    const file = valid[i];
    progText.textContent = `Subiendo ${i+1}/${valid.length}: ${file.name}`;
    progFill.style.width = Math.round((i / valid.length) * 100) + '%';
    try {
      await uploadViaIframe(file, factura);
      showToast('✓ ' + file.name + ' subido — cargando...', 'success');
    } catch(err) {
      showToast('Error: ' + err.message, 'error');
    }
  }

  progFill.style.width = '100%';
  progText.textContent = 'Procesando en Drive...';
  // Esperar 5s para que Drive indexe el archivo y luego recargar
  await new Promise(r => setTimeout(r, 5000));
  delete mediaCache[factura];
  await loadMediaForPedido(factura);
  prog.classList.add('hidden');
}

function uploadViaIframe(file, factura) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Error leyendo archivo'));
    reader.onload  = (ev) => {
      const b64 = ev.target.result.split(',')[1];
      const iframeName = 'upload_frame_' + Date.now();
      const iframe = document.createElement('iframe');
      iframe.name  = iframeName;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      const form = document.createElement('form');
      form.method  = 'POST';
      form.action  = APPS_SCRIPT_URL;
      form.target  = iframeName;

      const addField = (name, value) => {
        const inp = document.createElement('input');
        inp.type  = 'hidden';
        inp.name  = name;
        inp.value = value;
        form.appendChild(inp);
      };

      // Apps Script recibirá e.parameter.* para cada campo
      addField('action',   'uploadFile');
      addField('factura',  factura);
      addField('fileName', file.name);
      addField('mimeType', file.type);
      addField('base64',   b64);

      document.body.appendChild(form);

      const timeout = setTimeout(() => { cleanup(); resolve(); }, 35000);
      iframe.onload = () => { clearTimeout(timeout); cleanup(); resolve(); };
      form.submit();

      function cleanup() {
        try { document.body.removeChild(form); } catch(e){}
        setTimeout(() => { try { document.body.removeChild(iframe); } catch(e){} }, 500);
      }
    };
    reader.readAsDataURL(file);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===== LIGHTBOX =====
function openLightbox(file) {
  const box     = document.getElementById('lightbox');
  const content = document.getElementById('lightboxContent');
  const name    = document.getElementById('lightboxName');
  const link    = document.getElementById('lightboxOpen');

  name.textContent = file.name;
  link.href        = file.viewUrl;

  if (file.thumbUrl) {
    // Usar thumbnail pública de Drive para preview grande
    const bigThumb = `https://drive.google.com/thumbnail?id=${file.fileId}&sz=w800`;
    content.innerHTML = `
      <img src="${bigThumb}" alt="${escHtml(file.name)}"
        style="max-width:100%;max-height:65vh;border-radius:8px;display:block;margin:0 auto"
        onerror="this.src='https://drive.google.com/thumbnail?id=${file.fileId}&sz=w400'" />`;
  } else {
    // Video — botón para abrir en Drive (no se puede embeber directamente)
    content.innerHTML = `
      <div style="text-align:center;padding:40px 20px">
        <div style="font-size:64px;margin-bottom:16px">🎬</div>
        <p style="font-size:15px;font-weight:600;color:#1a2744;margin-bottom:8px">${escHtml(file.name)}</p>
        <p style="font-size:13px;color:#64748b;margin-bottom:20px">Los videos se abren en Google Drive</p>
        <a href="${file.viewUrl}" target="_blank" style="background:#1a2744;color:white;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">▶ Ver video en Drive</a>
      </div>`;
  }

  box.classList.add('active');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
  document.getElementById('lightboxContent').innerHTML = '';
}

// ===== INFORME DE FALTANTES =====
// Guardamos despachos en memoria local (también se leen de Sheets si se recarga)
// Mapa de pedidos despachados con faltantes (factura -> { items, Cliente, Sucursal, ... })

function getInformeRows() {
  const rows = [];
  Object.entries(despachados).forEach(([factura, d]) => {
    d.items.forEach((item, idx) => {
      if (item.Faltante > 0) {
        rows.push({
          Factura: factura, Fecha: d.Fecha, Cliente: d.Cliente,
          Sucursal: d.Sucursal, Telefono: d.Telefono, Direccion: d.dir,
          Sku: item.Sku, NombreProducto: item.NombreProducto,
          CantPedida: item.Cantidad, CantDespachada: item.Despachado,
          Faltante: item.Faltante, FechaDespacho: d.fechaDespacho,
          Enviado: item.Enviado, FechaEnvio: item.FechaEnvio,
          _itemIndex: idx // referencia para actualizar en memoria
        });
      }
    });
  });
  return rows;
}

function renderInforme() {
  const allRows = getInformeRows();
  const q = (document.getElementById('searchInforme')?.value||'').toLowerCase();
  const rows = allRows.filter(r =>
    !q || r.Factura.toLowerCase().includes(q) || r.Cliente.toLowerCase().includes(q) ||
    r.Sku.toLowerCase().includes(q) || r.NombreProducto.toLowerCase().includes(q)
  );

  const badge = document.getElementById('informeBadge');
  const facturasFaltantes = new Set(allRows.map(r=>r.Factura)).size;
  if (facturasFaltantes>0) { badge.textContent=facturasFaltantes; badge.style.display='inline-flex'; }
  else badge.style.display='none';

  document.getElementById('informeSubtitle').textContent =
    `${rows.length} línea(s) con faltantes en ${new Set(rows.map(r=>r.Factura)).size} pedido(s)`;

  const body  = document.getElementById('informeBody');
  const empty = document.getElementById('informeEmpty');
  const table = document.getElementById('informeTable');

  const totalFaltantes = rows.reduce((s,r)=>s+r.Faltante,0);
  const nFacturas      = new Set(rows.map(r=>r.Factura)).size;
  const nSkus          = new Set(rows.map(r=>r.Sku)).size;
  const nEnviados      = rows.filter(r=>r.Enviado).length;
  document.getElementById('informeStats').innerHTML = `
    <div class="informe-stat"><span>${nFacturas}</span><small>Pedidos con faltantes</small></div>
    <div class="informe-stat"><span>${nSkus}</span><small>SKUs afectados</small></div>
    <div class="informe-stat red"><span>${totalFaltantes}</span><small>Unidades faltantes</small></div>
    <div class="informe-stat green"><span>${nEnviados}</span><small>Ya enviados</small></div>`;

  if (!rows.length) {
    table.style.display = 'none';
    empty.classList.remove('hidden');
    return;
  }
  table.style.display = '';
  empty.classList.add('hidden');

  body.innerHTML = rows.map(r => `<tr class="${r.Enviado?'row-enviado':''}">
    <td><strong>${escHtml(r.Factura)}</strong></td>
    <td>${escHtml(r.Fecha)}</td>
    <td>${escHtml(r.Cliente)}</td>
    <td>${escHtml(r.Sucursal)}</td>
    <td>${escHtml(r.Telefono)}</td>
    <td>${escHtml(r.Direccion)}</td>
    <td><code>${escHtml(r.Sku)}</code></td>
    <td>${escHtml(r.NombreProducto)}</td>
    <td style="text-align:center">${r.CantPedida}</td>
    <td style="text-align:center;color:var(--green-dark);font-weight:700">${r.CantDespachada}</td>
    <td style="text-align:center"><span class="faltante-badge">${r.Faltante}</span></td>
    <td style="font-size:11px;color:var(--gray-500)">${escHtml(r.FechaDespacho)}</td>
    <td style="text-align:center">
      <input type="checkbox" class="enviado-check" ${r.Enviado?'checked':''}
        onchange="toggleEnviado('${escHtml(r.Factura)}', ${r._itemIndex}, this.checked)" />
    </td>
    <td>
      <input type="date" class="fecha-envio-input" value="${r.FechaEnvio ? toDateInputValue(r.FechaEnvio) : ''}"
        onchange="setFechaEnvio('${escHtml(r.Factura)}', ${r._itemIndex}, this.value)" />
    </td>
  </tr>`).join('');
}
function filterInforme() { renderInforme(); }

function toDateInputValue(val) {
  // Intenta convertir distintos formatos a yyyy-mm-dd para el input date
  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0,10);
}

// ===== ACTUALIZAR ENVIADO / FECHA ENVÍO (persistido en Sheets) =====
async function toggleEnviado(factura, itemIndex, checked) {
  if (!despachados[factura] || !despachados[factura].items[itemIndex]) return;
  const item = despachados[factura].items[itemIndex];
  item.Enviado = checked;
  if (checked && !item.FechaEnvio) {
    item.FechaEnvio = new Date().toISOString().slice(0,10);
  }
  renderInforme();
  await persistEnvioUpdate(factura, item);
}

async function setFechaEnvio(factura, itemIndex, value) {
  if (!despachados[factura] || !despachados[factura].items[itemIndex]) return;
  const item = despachados[factura].items[itemIndex];
  item.FechaEnvio = value;
  await persistEnvioUpdate(factura, item);
  showToast('✓ Fecha de envío actualizada','success');
}

async function persistEnvioUpdate(factura, item) {
  try {
    // Usar fetch con respuesta real (no no-cors) para confirmar guardado
    const resp = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateEnvio', rows: [[
        factura, item.Sku, item.Enviado ? 'TRUE' : 'FALSE', item.FechaEnvio || ''
      ]]})
    });
    // Forzar refresh en 3s para que otros usuarios vean el cambio
    setTimeout(() => silentRefresh(), 3000);
  } catch(e) {
    showToast('No se pudo guardar el estado de envío: '+e.message, 'error');
  }
}

function exportInformeCSV() {
  const rows = getInformeRows();
  if (!rows.length) { showToast('No hay faltantes para exportar','warning'); return; }
  const headers = ['Factura','Fecha','Cliente','Sucursal','Telefono','Direccion','SKU','Nombre Producto','Cant Pedida','Cant Despachada','Faltante','Fecha Despacho','Enviado','Fecha Envio'];
  const csv = [headers.join(','),
    ...rows.map(r => [r.Factura,r.Fecha,r.Cliente,r.Sucursal,r.Telefono,r.Direccion,
      r.Sku,r.NombreProducto,r.CantPedida,r.CantDespachada,r.Faltante,r.FechaDespacho,
      r.Enviado?'SI':'NO', r.FechaEnvio
    ].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','))
  ].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download = `faltantes_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  showToast('✓ CSV exportado','success');
}

// ===== INFORME DE DESPACHOS POR RANGO DE FECHAS =====
function parseFlexibleDate(val) {
  // FechaDespacho viene como string localizado (es-CO), intentamos parsear de forma robusta
  if (!val) return null;
  const d = new Date(val);
  if (!isNaN(d.getTime())) return d;
  return null;
}

function getDespachosReportRows() {
  const desdeStr = document.getElementById('despachosDesde')?.value;
  const hastaStr = document.getElementById('despachosHasta')?.value;
  const usuario   = document.getElementById('despachosUsuarioFiltro')?.value || '';
  const q = (document.getElementById('searchDespachosReport')?.value||'').toLowerCase();

  const desde = desdeStr ? new Date(desdeStr+'T00:00:00') : null;
  const hasta = hastaStr ? new Date(hastaStr+'T23:59:59') : null;

  return despachosLog.filter(r => {
    if (usuario && r.Despachador !== usuario) return false;
    if (q && !(r.Factura.toLowerCase().includes(q) || r.Cliente.toLowerCase().includes(q))) return false;
    if (desde || hasta) {
      const fd = parseFlexibleDate(r.FechaDespacho);
      if (!fd) return true; // si no se puede parsear, no filtramos por fecha (se muestra)
      if (desde && fd < desde) return false;
      if (hasta && fd > hasta) return false;
    }
    return true;
  });
}

function populateDespachosUsuarioFiltro() {
  const sel = document.getElementById('despachosUsuarioFiltro');
  if (!sel) return;
  const cur = sel.value;
  const usuarios = [...new Set(despachosLog.map(r=>r.Despachador).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Todos</option>' +
    usuarios.map(u => `<option value="${escHtml(u)}" ${u===cur?'selected':''}>${escHtml(u)}</option>`).join('');
}

function renderDespachosReport() {
  populateDespachosUsuarioFiltro();
  const rows = getDespachosReportRows();

  document.getElementById('despachosSubtitle').textContent = `${rows.length} despacho(s) encontrado(s)`;

  const nUsuarios = new Set(rows.map(r=>r.Despachador)).size;
  document.getElementById('despachosReportStats').innerHTML = `
    <div class="informe-stat"><span>${rows.length}</span><small>Pedidos despachados</small></div>
    <div class="informe-stat"><span>${nUsuarios}</span><small>Despachadores activos</small></div>`;

  const body  = document.getElementById('despachosReportBody');
  const empty = document.getElementById('despachosReportEmpty');
  const table = document.getElementById('despachosReportTable');

  if (!rows.length) {
    table.style.display = 'none';
    empty.classList.remove('hidden');
    return;
  }
  table.style.display = '';
  empty.classList.add('hidden');

  // Ordenar por fecha de despacho descendente (más reciente primero)
  const sorted = [...rows].sort((a,b) => {
    const da = parseFlexibleDate(a.FechaDespacho), db = parseFlexibleDate(b.FechaDespacho);
    if (!da || !db) return 0;
    return db - da;
  });

  body.innerHTML = sorted.map(r => `<tr class="clickable-row" onclick="openPedido('${escHtml(r.Factura)}')">
    <td><strong>${escHtml(r.Despachador||'—')}</strong></td>
    <td>${escHtml(r.Factura)}</td>
    <td>${escHtml(r.Cliente)}</td>
    <td>${escHtml(r.Direccion)}</td>
    <td>${escHtml(r.Telefono)}</td>
    <td>${escHtml(r.FechaPedido)}</td>
    <td style="font-size:11px;color:var(--gray-500)">${escHtml(r.FechaDespacho)}</td>
  </tr>`).join('');
}
function filterDespachosReport() { renderDespachosReport(); }

function exportDespachosReportCSV() {
  const rows = getDespachosReportRows();
  if (!rows.length) { showToast('No hay despachos para exportar','warning'); return; }
  const headers = ['Despachador','Factura','Cliente','Sucursal','Direccion','Telefono','Fecha Pedido','Fecha Despacho'];
  const csv = [headers.join(','),
    ...rows.map(r => [r.Despachador,r.Factura,r.Cliente,r.Sucursal,r.Direccion,r.Telefono,r.FechaPedido,r.FechaDespacho]
      .map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','))
  ].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download = `despachos_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  showToast('✓ CSV exportado','success');
}

function printInforme() {
  const rows = getInformeRows();
  if (!rows.length) { showToast('No hay faltantes para imprimir','warning'); return; }
  const ahora = new Date().toLocaleString('es-CO',{timeZone:'America/Bogota'});

  const rowsHTML = rows.map(r=>`<tr>
    <td>${escHtml(r.Factura)}</td><td>${escHtml(r.Fecha)}</td>
    <td>${escHtml(r.Cliente)}</td><td>${escHtml(r.Sucursal)}</td>
    <td>${escHtml(r.Sku)}</td><td>${escHtml(r.NombreProducto)}</td>
    <td style="text-align:center">${r.CantPedida}</td>
    <td style="text-align:center">${r.CantDespachada}</td>
    <td style="text-align:center;font-weight:700;color:#dc2626">${r.Faltante}</td>
    <td>${escHtml(r.FechaDespacho)}</td>
    <td style="text-align:center">${r.Enviado?'✓ Sí':'No'}</td>
    <td>${escHtml(r.FechaEnvio||'—')}</td>
  </tr>`).join('');

  const html = `<html><head><meta charset="UTF-8"><title>Informe Faltantes</title>
  <style>
    @page { size: A4 landscape; margin: 15mm; }
    * { box-sizing:border-box; font-family:Arial,sans-serif; }
    body { font-size:9pt; color:#1a2744; }
    h1 { font-size:14pt; margin-bottom:2mm; }
    .sub { font-size:8pt; color:#64748b; margin-bottom:5mm; }
    table { width:100%; border-collapse:collapse; }
    th { background:#1a2744; color:white; padding:2mm 3mm; font-size:8pt; text-align:left; }
    td { padding:2mm 3mm; border-bottom:0.2mm solid #e2e8f0; font-size:8pt; }
    tr:nth-child(even) td { background:#f8fafc; }
  </style></head>
  <body>
    <h1>Informe de Productos Faltantes</h1>
    <div class="sub">Generado: ${ahora} · ${rows.length} líneas · ${new Set(rows.map(r=>r.Factura)).size} pedidos</div>
    <table>
      <thead><tr>
        <th>Factura</th><th>Fecha</th><th>Cliente</th><th>Sucursal</th>
        <th>SKU</th><th>Producto</th><th>Pedido</th><th>Despachado</th><th>Faltante</th><th>Fecha Despacho</th>
        <th>Enviado</th><th>Fecha Envío</th>
      </tr></thead>
      <tbody>${rowsHTML}</tbody>
    </table>
  </body></html>`;

  const win = window.open('','_blank','width=900,height=600');
  win.document.write(html);
  win.document.close();
  win.onload = () => { win.print(); win.onafterprint = () => win.close(); };
}

// ===== SUBIR PEDIDOS CSV =====
function dragOver(e)  { e.preventDefault(); document.getElementById('uploadBox').classList.add('drag-over'); }
function dragLeave(e) { document.getElementById('uploadBox').classList.remove('drag-over'); }
function dropFile(e)  {
  e.preventDefault(); document.getElementById('uploadBox').classList.remove('drag-over');
  const file = e.dataTransfer.files[0]; if (file) parseCSV(file);
}
function loadFile(e) {
  const file = e.target.files[0]; if (file) parseCSV(file); e.target.value='';
}
function parseCSV(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const lines = e.target.result.split(/\r?\n/).filter(l=>l.trim());
    if (lines.length<2) { showToast('Archivo vacío o mal formado','error'); return; }
    const sep=detectSeparator(lines[0]), headers=parseCSVLine(lines[0],sep);
    rawPedidos = lines.slice(1).map(l=>{
      const r=parseCSVLine(l,sep), obj={};
      headers.forEach((h,i)=>{ obj[h.trim()]=(r[i]||'').trim(); });
      return obj;
    }).filter(r=>Object.values(r).some(v=>v));
    showPreview(headers,rawPedidos);
  };
  reader.readAsText(file,'UTF-8');
}
function detectSeparator(line) {
  const t=(line.match(/\t/g)||[]).length,c=(line.match(/,/g)||[]).length,s=(line.match(/;/g)||[]).length;
  if(t>=c&&t>=s)return'\t'; if(s>=c)return';'; return',';
}
function parseCSVLine(line,sep) {
  const res=[]; let cur='',inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){inQ=!inQ;}
    else if(ch===sep&&!inQ){res.push(cur);cur='';}
    else{cur+=ch;}
  }
  res.push(cur); return res;
}
function showPreview(headers,rows) {
  document.getElementById('previewCount').textContent=rows.length;
  document.getElementById('previewContainer').classList.remove('hidden');
  document.getElementById('uploadBox').style.display='none';

  // Sin validación de duplicados Factura+SKU — se permite cargar normalmente
  const warn=document.getElementById('duplicateWarning');
  warn.classList.add('hidden');
  warn.classList.remove('duplicate-warning-blocking');
  const btnSubir = document.getElementById('btnSubirPedidos');
  if (btnSubir) { btnSubir.disabled = false; btnSubir.title = ''; }

  const table=document.getElementById('previewTable');
  table.querySelector('thead').innerHTML='<tr>'+headers.map(h=>`<th>${escHtml(h)}</th>`).join('')+'</tr>';
  table.querySelector('tbody').innerHTML=rows.map((r,i)=>
    `<tr>`+headers.map(h=>`<td>${escHtml(r[h]||'')}</td>`).join('')+'</tr>'
  ).join('');
}
function clearPreview() {
  rawPedidos=[];
  document.getElementById('previewContainer').classList.add('hidden');
  document.getElementById('uploadBox').style.display='';
}
async function uploadToSheets() {
  if(!rawPedidos.length) return;
  let existingKeys=new Set();
  showLoading('Verificando duplicados...');
  try{
    const data=await sheetsGet('Pedidos!A2:H');
    (data.values||[]).forEach(r=>existingKeys.add((r[0]||'')+'|'+(r[7]||'')));
  }catch(e){}
  const dups=rawPedidos.filter(r=>existingKeys.has((r['Factura']||'')+'|'+(r['Sku']||'')));
  if(dups.length>0){
    hideLoading();
    const det=dups.slice(0,5).map(r=>`Factura ${r['Factura']} / SKU ${r['Sku']}`).join(', ');
    if(!confirm(`⚠️ ${dups.length} registro(s) ya existen:\n${det}\n\n¿Continuar de todas formas?`)) return;
  }
  const COLS=['Factura','Fecha','Observacion','Cliente','Sucursal','Direccion','Telefono','Sku','Nombre Producto','Cantidad','Despachado'];
  const rows=rawPedidos.map(r=>COLS.map(c=>r[c]||''));
  showLoading('Subiendo pedidos...');
  try{
    await scriptPost('appendPedidos',rows);
    showToast(`✓ ${rawPedidos.length} registros subidos`,'success');
    clearPreview();
    loadAll(); switchTab('pedidos');
  }catch(e){ showToast('Error al subir: '+e.message,'error'); hideLoading(); }
}

// ===== SYNC =====
function updateSyncStatus(ok) {
  const dot=document.querySelector('.status-dot'),txt=document.getElementById('syncText');
  if(ok){dot.style.background='var(--green)';dot.style.boxShadow='0 0 8px var(--green)';txt.textContent='Conectado';}
  else  {dot.style.background='var(--red)';  dot.style.boxShadow='0 0 8px var(--red)';  txt.textContent='Sin conexión';}
}

// ===== UTILS =====
function showLoading(msg){document.getElementById('loadingText').textContent=msg||'Cargando...';document.getElementById('loadingOverlay').classList.remove('hidden');}
function hideLoading(){document.getElementById('loadingOverlay').classList.add('hidden');}
let toastTimer;
function showToast(msg,type){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast'+(type?' '+type:'');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.add('hidden'),3000);
}
function escHtml(str){
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
