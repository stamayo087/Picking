// ===== CONFIGURACIÓN =====
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzCLSWQBuRt4_ocXu4csU9rm437fBEL_0W1yBjFFsOF6_JCUWQCuJXi6YE199ULYbaBQQ/exec';

let CONFIG = { sheetId: '', apiKey: '' };
let allPedidos   = [];   // todos los pedidos de "Pedidos"
let registros    = {};   // { factura: { dir, counts, fecha } } — último registro guardado en "registro"
let rawPedidos   = [];
let currentPedido = null;
let scanCounts   = {};   // conteos en sesión actual (se fusionan con registros al abrir)

// ===== SCANNER EN SEGUNDO PLANO =====
let scanBuffer = '';
let scanTimer  = null;
const SCAN_TIMEOUT = 80;

document.addEventListener('keydown', handleGlobalKey);

function handleGlobalKey(e) {
  if (!currentPedido) return;
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
  const saved = localStorage.getItem('pedidos_config');
  if (saved) {
    try {
      CONFIG = JSON.parse(saved);
      if (CONFIG.sheetId && CONFIG.apiKey) { closeSetupModal(); loadAll(); }
    } catch(e) {}
  }
});

// ===== SETUP =====
function saveConfig() {
  const id  = document.getElementById('sheetId').value.trim();
  const key = document.getElementById('apiKey').value.trim();
  if (!id || !key) { showSetupError('Por favor completa todos los campos.'); return; }
  CONFIG.sheetId = id; CONFIG.apiKey = key;
  localStorage.setItem('pedidos_config', JSON.stringify(CONFIG));
  closeSetupModal(); loadAll();
}
function openSetup() {
  document.getElementById('sheetId').value = CONFIG.sheetId || '';
  document.getElementById('apiKey').value  = CONFIG.apiKey  || '';
  document.getElementById('setupModal').classList.add('active');
}
function closeSetupModal() { document.getElementById('setupModal').classList.remove('active'); }
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
  if (tab === 'informe') renderInforme();
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
    // Cargar pedidos y registros en paralelo
    const [pedidosData, registroData] = await Promise.all([
      sheetsGet('Pedidos!A1:K'),
      sheetsGet('registro!A1:L').catch(() => ({ values: [] }))
    ]);

    // Procesar hoja Pedidos
    const pRows = pedidosData.values || [];
    if (pRows.length >= 2) {
      allPedidos = groupPedidos(pRows[0], pRows.slice(1).filter(r => r.some(c => c)));
    } else { allPedidos = []; }

    // Procesar hoja registro — tomar el ÚLTIMO registro por factura
    // Cols: Factura(0),Fecha(1),Obs(2),Cliente(3),Sucursal(4),Direccion(5),Telefono(6),sku(7),NomProd(8),Cantidad(9),CantDesp(10),Fecharegistro(11),Cajas(12)
    const rRows = (registroData.values || []).slice(1).filter(r => r[0]);
    registros = {};
    rRows.forEach(r => {
      const factura = r[0] || '';
      const sku     = r[7] || '';
      const cant    = parseInt(r[10]) || 0;
      const dir     = r[5] || '';
      const cajas   = parseInt(r[12]) || 1;
      if (!registros[factura]) registros[factura] = { dir: '', cajas: 1, counts: {} };
      registros[factura].counts[sku] = cant;
      registros[factura].dir   = dir;
      registros[factura].cajas = cajas;
    });

    // Inicializar scanCounts desde registros (último guardado)
    scanCounts = {};
    Object.keys(registros).forEach(f => {
      scanCounts[f] = { ...registros[f].counts };
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
      Cantidad:parseInt(r[iCa])||0,Despachado:parseInt(r[iDe])||0 });
  });
  return Object.values(mapa);
}

// ===== PROGRESO =====
function getPedidoProgress(pedido) {
  const c = scanCounts[pedido.Factura] || {};
  let total=0,done=0;
  pedido.items.forEach(i => { total+=i.Cantidad; done+=Math.min(c[i.Sku]||0,i.Cantidad); });
  return { total, done, pct: total>0 ? Math.round((done/total)*100) : 0 };
}

// ===== RENDER PEDIDOS (solo no completados) =====
function renderPedidos() {
  const grid = document.getElementById('pedidosGrid');
  const pendientes = allPedidos.filter(p => getPedidoProgress(p).pct < 100);
  const completados = allPedidos.filter(p => getPedidoProgress(p).pct === 100);

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
  document.getElementById('statCompletos').textContent  = completados.length;
  document.getElementById('statParciales').textContent  = enProgreso;
  document.getElementById('statPendientes').textContent = sinIniciar;

  // Badge historial
  const badge = document.getElementById('historialBadge');
  if (completados.length > 0) {
    badge.textContent = completados.length;
    badge.style.display = 'inline-flex';
  } else { badge.style.display = 'none'; }

  const filtered = getFilteredPedidos(pendientes);
  document.getElementById('pedidosSubtitle').textContent = filtered.length + ' pedido(s) pendiente(s)';

  if (!filtered.length) {
    grid.innerHTML = completados.length > 0
      ? `<div class="empty-state"><div class="empty-icon">🎉</div><p>¡Todos los pedidos están separados!</p><span>Revisa el Historial para ver los completados</span></div>`
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

// ===== RENDER HISTORIAL (solo completados) =====
function renderHistorial() {
  const grid = document.getElementById('historialGrid');
  const completados = allPedidos.filter(p => getPedidoProgress(p).pct === 100);
  const q = (document.getElementById('searchHistorial')?.value||'').toLowerCase();
  const filtered = completados.filter(p =>
    !q || p.Factura.toLowerCase().includes(q) || p.Cliente.toLowerCase().includes(q)
  );
  document.getElementById('historialSubtitle').textContent = filtered.length + ' pedido(s) completado(s)';

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>No hay pedidos completados aún</p><span>Los pedidos al 100% aparecerán aquí automáticamente</span></div>`;
    return;
  }
  grid.innerHTML = filtered.map(p => buildPedidoCard(p, true)).join('');
}
function filterHistorial() { renderHistorial(); }

// ===== CARD PEDIDO =====
function buildPedidoCard(p, isHistorial) {
  const pr    = getPedidoProgress(p);
  const est   = pr.pct===100?'completado':pr.pct>0?'en-progreso':'pendiente';
  const badge = pr.pct===100?'✓ Separado':pr.pct>0?'↻ En progreso':'○ Pendiente';
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
      <span class="card-enter">${isHistorial?'Ver →':'Abrir →'}</span>
    </div>
  </div>`;
}

// ===== MODAL PEDIDO =====
function openPedido(factura) {
  const pedido = allPedidos.find(p => p.Factura===factura);
  if (!pedido) return;
  currentPedido = pedido;

  // Inicializar scanCounts desde último registro guardado
  if (!scanCounts[factura]) scanCounts[factura] = {};
  if (registros[factura]) {
    // Fusionar: si ya hay conteos en sesión úsalos, si no tomar del registro guardado
    Object.keys(registros[factura].counts).forEach(sku => {
      if (!(sku in scanCounts[factura])) {
        scanCounts[factura][sku] = registros[factura].counts[sku];
      }
    });
  }

  document.getElementById('modalFactura').textContent = factura;
  // Dirección y cajas: última guardada en registro > original del pedido
  const dir   = registros[factura]?.dir   || pedido.Direccion;
  const cajas = registros[factura]?.cajas || 1;
  document.getElementById('editDireccion').value = dir;
  document.getElementById('editCajas').value     = cajas;

  const info = [
    {label:'Fecha',     value:pedido.Fecha},
    {label:'Cliente',   value:pedido.Cliente},
    {label:'Sucursal',  value:pedido.Sucursal},
    {label:'Teléfono',  value:pedido.Telefono},
    {label:'Observación',value:pedido.Observacion||'—'},
  ];
  document.getElementById('orderInfoGrid').innerHTML = info.map(i=>
    `<div class="info-item"><span class="info-label">${i.label}</span><span class="info-value">${escHtml(i.value)}</span></div>`
  ).join('');

  renderProductosTable();
  document.getElementById('pedidoModal').classList.add('active');
  document.getElementById('scannerStatus').classList.remove('hidden');
  loadMediaForPedido(factura);
}

function closeModal() {
  document.getElementById('pedidoModal').classList.remove('active');
  document.getElementById('scannerStatus').classList.add('hidden');
  scanBuffer=''; clearTimeout(scanTimer);
  currentPedido = null;
  renderPedidos();
  renderHistorial();
}

// ===== RENDER TABLA PRODUCTOS =====
function renderProductosTable() {
  if (!currentPedido) return;
  const counts = scanCounts[currentPedido.Factura] || {};
  const body = document.getElementById('productosBody');
  let totalItems=0, doneItems=0;

  body.innerHTML = currentPedido.items.map((item) => {
    const pedido = item.Cantidad;
    const esc    = counts[item.Sku] || 0;
    totalItems  += pedido;
    doneItems   += Math.min(esc, pedido);

    let rowClass='',badgeClass='badge-pendiente',badgeText='○ Pendiente';
    if (esc>0&&esc<pedido)       {rowClass='row-falta'; badgeClass='badge-falta';  badgeText=`⚠ Faltan ${pedido-esc}`;}
    else if(esc===pedido&&pedido>0){rowClass='row-ok';  badgeClass='badge-ok';    badgeText='✓ Completo';}
    else if(esc>pedido)           {rowClass='row-exceso';badgeClass='badge-exceso';badgeText=`⚡ Exceso +${esc-pedido}`;}

    return `<tr class="${rowClass}">
      <td><strong>${escHtml(item.Sku)}</strong></td>
      <td>${escHtml(item.NombreProducto)}</td>
      <td style="text-align:center;font-weight:700">${pedido}</td>
      <td style="text-align:center;padding:4px 8px">
        <div class="qty-controls">
          <button class="qty-btn" onclick="adjustQty('${escHtml(item.Sku)}',-1)">−</button>
          <input type="number" min="0" class="qty-manual" value="${esc}"
            onchange="setQtyManual('${escHtml(item.Sku)}',this.value)"
            onclick="this.select()" />
          <button class="qty-btn" onclick="adjustQty('${escHtml(item.Sku)}',1)">+</button>
        </div>
      </td>
      <td><span class="badge-estado ${badgeClass}">${badgeText}</span></td>
    </tr>`;
  }).join('');

  const pct = totalItems>0 ? Math.round((doneItems/totalItems)*100) : 0;
  document.getElementById('progressFill').style.width = pct+'%';
  document.getElementById('progressText').textContent = `${doneItems} / ${totalItems} unidades — ${pct}%`;
}

// ===== AJUSTE MANUAL CANTIDAD =====
function adjustQty(sku, delta) {
  if (!currentPedido) return;
  const f = currentPedido.Factura;
  if (!scanCounts[f]) scanCounts[f]={};
  scanCounts[f][sku] = Math.max(0,(scanCounts[f][sku]||0)+delta);
  renderProductosTable();
}
function setQtyManual(sku, val) {
  if (!currentPedido) return;
  const f = currentPedido.Factura;
  if (!scanCounts[f]) scanCounts[f]={};
  scanCounts[f][sku] = Math.max(0,parseInt(val)||0);
  renderProductosTable();
}

// ===== SCANNER =====
function processScan(sku) {
  if (!currentPedido) return;
  const f = currentPedido.Factura;
  if (!scanCounts[f]) scanCounts[f]={};
  const item = currentPedido.items.find(i => i.Sku.toLowerCase()===sku.toLowerCase());
  if (!item) { showToast('⚠ SKU no encontrado: '+sku,'warning'); return; }

  scanCounts[f][item.Sku] = (scanCounts[f][item.Sku]||0)+1;
  const nuevo=scanCounts[f][item.Sku], pedido=item.Cantidad;
  flashRow(item.Sku);
  if(nuevo===pedido)    showToast('✓ '+item.NombreProducto+' — COMPLETO','success');
  else if(nuevo>pedido) showToast('⚡ '+item.NombreProducto+' — Exceso: '+nuevo+'/'+pedido,'warning');
  else                  showToast('→ '+item.NombreProducto+': '+nuevo+'/'+pedido,'');
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
  renderProductosTable();
  showToast('Conteo reiniciado','');
}

// ===== CAJAS =====
function adjustCajas(delta) {
  const input = document.getElementById('editCajas');
  input.value = Math.max(1, (parseInt(input.value)||1) + delta);
}

// ===== GUARDAR REGISTRO =====
async function saveRegistro() {
  if (!currentPedido) return;
  const factura = currentPedido.Factura;
  const counts  = scanCounts[factura]||{};
  const dir     = document.getElementById('editDireccion').value.trim();
  const cajas   = parseInt(document.getElementById('editCajas').value)||1;
  const ahora   = new Date().toLocaleString('es-CO',{timeZone:'America/Bogota'});

  // Estructura registro: Factura,Fecha,Obs,Cliente,Sucursal,Direccion,Telefono,Sku,NomProd,Cantidad,CantDesp,Fecharegistro,Cajas
  const rows = currentPedido.items.map(item => [
    factura, currentPedido.Fecha, currentPedido.Observacion,
    currentPedido.Cliente, currentPedido.Sucursal, dir, currentPedido.Telefono,
    item.Sku, item.NombreProducto, item.Cantidad, counts[item.Sku]||0, ahora, cajas
  ]);

  showLoading('Guardando registro...');
  try {
    await scriptPost('appendRegistro', rows);
    registros[factura] = { dir, cajas, counts: {...counts} };
    showToast('✓ Registro guardado correctamente','success');
    closeModal();
  } catch(e) {
    showToast('Error al guardar: '+e.message,'error');
  } finally { hideLoading(); }
}

// ===== DESPACHAR PEDIDO =====
async function despacharPedido() {
  if (!currentPedido) return;
  const p       = currentPedido;
  const factura = p.Factura;
  const counts  = scanCounts[factura]||{};
  const dir     = document.getElementById('editDireccion').value.trim();
  const cajas   = parseInt(document.getElementById('editCajas').value)||1;
  const pr      = getPedidoProgress(p);

  const faltantes = p.items.filter(i => (counts[i.Sku]||0) < i.Cantidad);
  let msg = `¿Confirmar despacho de la factura ${factura}?\n\nProgreso: ${pr.pct}% (${pr.done}/${pr.total} unidades)\nCajas: ${cajas}`;
  if (faltantes.length > 0) {
    msg += `\n\n⚠️ Hay ${faltantes.length} producto(s) incompleto(s):\n`;
    msg += faltantes.slice(0,5).map(i=>`• ${i.NombreProducto}: ${counts[i.Sku]||0}/${i.Cantidad}`).join('\n');
    if (faltantes.length>5) msg += `\n...y ${faltantes.length-5} más`;
  }
  if (!confirm(msg)) return;

  const ahora = new Date().toLocaleString('es-CO',{timeZone:'America/Bogota'});

  // Guardar en hoja registro (con cajas)
  const regRows = p.items.map(item => [
    factura, p.Fecha, p.Observacion, p.Cliente, p.Sucursal, dir, p.Telefono,
    item.Sku, item.NombreProducto, item.Cantidad, counts[item.Sku]||0, ahora, cajas
  ]);

  // Guardar en hoja despachos
  const despRows = p.items.map(item => {
    const esc      = counts[item.Sku]||0;
    const faltante = Math.max(0, item.Cantidad - esc);
    return [factura, p.Fecha, p.Cliente, p.Sucursal, p.Telefono, dir,
      item.Sku, item.NombreProducto, item.Cantidad, esc, faltante, ahora, cajas];
  });

  showLoading('Despachando pedido...');
  try {
    await scriptPost('appendRegistro', regRows);
    await scriptPost('appendDespachos', despRows);

    registros[factura] = { dir, cajas, counts: {...counts}, despachado: true, fechaDespacho: ahora };
    if (!despachados) window.despachados = {};
    despachados[factura] = { items: p.items, counts: {...counts}, dir, cajas, fechaDespacho: ahora,
      Cliente: p.Cliente, Sucursal: p.Sucursal, Telefono: p.Telefono, Fecha: p.Fecha };

    showToast('🚚 Pedido despachado correctamente','success');
    // Sin impresión automática — el usuario imprime con el botón 🖨️
    closeModal();
    renderInforme();
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

  // Generar una página por caja con el contador X/Total
  const pages = [];
  for (let caja = 1; caja <= cajas; caja++) {
    pages.push(`
    <div class="sticker-page" ${caja < cajas ? 'style="page-break-after:always"' : ''}>
      <div class="top">
        <div class="despacho-label">Despacho</div>
        <div class="factura-num">${escHtml(p.Factura)}</div>
        <hr class="sep">
        <div class="row"><span class="lbl">Cliente</span><span class="val">${escHtml(p.Cliente)}</span></div>
        <div class="row"><span class="lbl">Sucursal</span><span class="val">${escHtml(p.Sucursal)}</span></div>
        <div class="row"><span class="lbl">Teléfono</span><span class="val">${escHtml(p.Telefono)}</span></div>
        <div class="row"><span class="lbl">Fecha</span><span class="val">${escHtml(p.Fecha)}</span></div>
        <hr class="sep">
        <div class="lbl" style="margin-bottom:1.5mm">Dirección de entrega</div>
        <div class="dir-val">${escHtml(dir)}</div>
      </div>
      <div class="bottom">
        <div class="caja-counter">
          <span class="caja-actual">${caja}</span>
          <span class="caja-sep">/</span>
          <span class="caja-total">${cajas}</span>
        </div>
        <div class="caja-label">CAJA ${caja} DE ${cajas}</div>
        <div class="ts">${ahora}</div>
      </div>
    </div>`);
  }

  const html = `<html><head><meta charset="UTF-8"><title>Etiquetas ${escHtml(p.Factura)}</title>
  <style>
    @page { size: 100mm 100mm; margin: 0; }
    * { box-sizing:border-box; margin:0; padding:0; font-family:Arial,sans-serif; }
    body { background:white; }
    .sticker-page {
      width:100mm; height:100mm; padding:5mm;
      display:flex; flex-direction:column; justify-content:space-between;
      overflow:hidden;
    }
    .despacho-label { font-size:6.5pt; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:1px; margin-bottom:1.5mm; }
    .factura-num { font-size:17pt; font-weight:900; color:#1a2744; line-height:1; }
    .sep { border:none; border-top:0.4mm solid #1a2744; margin:2.5mm 0; }
    .row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:1.2mm; }
    .lbl { font-size:6pt; color:#94a3b8; text-transform:uppercase; font-weight:600; letter-spacing:0.3px; flex-shrink:0; }
    .val { font-size:8pt; font-weight:700; color:#1a2744; text-align:right; max-width:58mm; word-break:break-word; }
    .dir-val { font-size:7.5pt; font-weight:700; color:#1a2744; line-height:1.3; }
    .bottom { border-top:0.4mm solid #e2e8f0; padding-top:2mm; display:flex; flex-direction:column; align-items:center; }
    .caja-counter { display:flex; align-items:baseline; gap:1mm; line-height:1; }
    .caja-actual { font-size:22pt; font-weight:900; color:#1a2744; }
    .caja-sep    { font-size:14pt; font-weight:700; color:#94a3b8; }
    .caja-total  { font-size:14pt; font-weight:700; color:#64748b; }
    .caja-label  { font-size:7pt; font-weight:700; color:#1a2744; text-transform:uppercase; letter-spacing:0.5px; margin-top:1mm; }
    .ts { font-size:5.5pt; color:#94a3b8; margin-top:1.5mm; }
  </style></head>
  <body>${pages.join('')}</body></html>`;

  const win = window.open('','_blank',`width=420,height=${Math.min(cajas,3)*430}`);
  win.document.write(html);
  win.document.close();
  win.onload = () => { win.print(); win.onafterprint = () => win.close(); };
}

// ===== MULTIMEDIA — FOTOS Y VIDEOS =====
let mediaCache = {}; // { factura: [ {fileId, name, mimeType, viewUrl, thumbUrl}, ... ] }

async function loadMediaForPedido(factura) {
  document.getElementById('mediaGrid').querySelectorAll('.media-thumb').forEach(el => el.remove());
  if (mediaCache[factura]) { renderMediaGrid(factura); return; }
  try {
    const facturaSafe = factura.replace(/[^a-zA-Z0-9_\-]/g,'_');
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
  // Limpiar miniaturas anteriores
  grid.querySelectorAll('.media-thumb').forEach(el => el.remove());

  const files = mediaCache[factura] || [];
  if (!files.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';

  files.forEach(f => {
    const div = document.createElement('div');
    div.className = 'media-thumb';
    div.title = f.name;
    div.onclick = () => openLightbox(f);

    const isImg = f.thumbUrl !== null;
    if (isImg) {
      div.innerHTML = `
        <img src="${f.thumbUrl}" alt="${escHtml(f.name)}" loading="lazy" />
        <span class="media-thumb-name">${escHtml(f.name)}</span>`;
    } else {
      // Video — mostrar ícono
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
    // Imagen — mostrar en tamaño completo
    content.innerHTML = `<img src="${file.thumbUrl.replace('w400','w800')}" alt="${escHtml(file.name)}" style="max-width:100%;max-height:65vh;border-radius:8px;display:block;margin:0 auto" />`;
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
let despachados = {};  // { factura: { items, counts, dir, fechaDespacho, Cliente, Sucursal, ... } }

function getInformeRows() {
  const rows = [];
  Object.entries(despachados).forEach(([factura, d]) => {
    d.items.forEach(item => {
      const esc      = d.counts[item.Sku]||0;
      const faltante = Math.max(0, item.Cantidad - esc);
      if (faltante > 0) {
        rows.push({
          Factura: factura, Fecha: d.Fecha, Cliente: d.Cliente,
          Sucursal: d.Sucursal, Telefono: d.Telefono, Direccion: d.dir,
          Sku: item.Sku, NombreProducto: item.NombreProducto,
          CantPedida: item.Cantidad, CantDespachada: esc,
          Faltante: faltante, FechaDespacho: d.fechaDespacho
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

  // Badge
  const badge = document.getElementById('informeBadge');
  const facturasFaltantes = new Set(allRows.map(r=>r.Factura)).size;
  if (facturasFaltantes>0) { badge.textContent=facturasFaltantes; badge.style.display='inline-flex'; }
  else badge.style.display='none';

  document.getElementById('informeSubtitle').textContent =
    `${rows.length} línea(s) con faltantes en ${new Set(rows.map(r=>r.Factura)).size} pedido(s)`;

  const body   = document.getElementById('informeBody');
  const empty  = document.getElementById('informeEmpty');
  const table  = document.getElementById('informeTable');

  // Stats
  const totalFaltantes = rows.reduce((s,r)=>s+r.Faltante,0);
  const nFacturas      = new Set(rows.map(r=>r.Factura)).size;
  const nSkus          = new Set(rows.map(r=>r.Sku)).size;
  document.getElementById('informeStats').innerHTML = `
    <div class="informe-stat"><span>${nFacturas}</span><small>Pedidos con faltantes</small></div>
    <div class="informe-stat"><span>${nSkus}</span><small>SKUs afectados</small></div>
    <div class="informe-stat red"><span>${totalFaltantes}</span><small>Unidades faltantes</small></div>`;

  if (!rows.length) {
    table.style.display = 'none';
    empty.classList.remove('hidden');
    return;
  }
  table.style.display = '';
  empty.classList.add('hidden');

  body.innerHTML = rows.map(r => `<tr>
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
  </tr>`).join('');
}
function filterInforme() { renderInforme(); }

function exportInformeCSV() {
  const rows = getInformeRows();
  if (!rows.length) { showToast('No hay faltantes para exportar','warning'); return; }
  const headers = ['Factura','Fecha','Cliente','Sucursal','Telefono','Direccion','SKU','Nombre Producto','Cant Pedida','Cant Despachada','Faltante','Fecha Despacho'];
  const csv = [headers.join(','),
    ...rows.map(r => [r.Factura,r.Fecha,r.Cliente,r.Sucursal,r.Telefono,r.Direccion,
      r.Sku,r.NombreProducto,r.CantPedida,r.CantDespachada,r.Faltante,r.FechaDespacho
    ].map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(','))
  ].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
  a.download = `faltantes_${new Date().toISOString().slice(0,10)}.csv`;
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
  const keys=new Set(),dups=[],dupRows=new Set();
  rows.forEach((r,i)=>{
    const k=(r['Factura']||'')+'|'+(r['Sku']||'');
    if(keys.has(k)){dups.push(`F:${r['Factura']} SKU:${r['Sku']}`);dupRows.add(i);}
    keys.add(k);
  });
  const warn=document.getElementById('duplicateWarning');
  if(dups.length>0){
    warn.classList.remove('hidden');
    document.getElementById('duplicateDetail').textContent=dups.length+' duplicado(s): '+dups.slice(0,3).join(', ')+(dups.length>3?' ...':'');
  } else warn.classList.add('hidden');
  const table=document.getElementById('previewTable');
  table.querySelector('thead').innerHTML='<tr>'+headers.map(h=>`<th>${escHtml(h)}</th>`).join('')+'</tr>';
  table.querySelector('tbody').innerHTML=rows.map((r,i)=>
    `<tr class="${dupRows.has(i)?'duplicate-row':''}">`+headers.map(h=>`<td>${escHtml(r[h]||'')}</td>`).join('')+'</tr>'
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
  if(CONFIG.sheetId&&CONFIG.apiKey){
    showLoading('Verificando duplicados...');
    try{
      const data=await sheetsGet('Pedidos!A2:H');
      (data.values||[]).forEach(r=>existingKeys.add((r[0]||'')+'|'+(r[7]||'')));
    }catch(e){}
  }
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
    if(CONFIG.sheetId&&CONFIG.apiKey){ loadAll(); switchTab('pedidos'); }
    else hideLoading();
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
