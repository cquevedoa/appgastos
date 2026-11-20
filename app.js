(() => {
  const $ = (id) => document.getElementById(id);

  const MESES_ORDEN = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];

  // Estado en memoria
  let datos = null;
  let lastSyncAt = null;
  let oculto = false;
  let themeMode = 'auto'; // 'auto' | 'dark' | 'light'
  let movimientosVisibles = 15;
  let movimientosFiltradosCache = [];
  let movimientoSeleccionado = null;
  let editandoFingerprint = null;
  let sincronizando = false;
  let deferredInstallPrompt = null;
  let gsiInicializado = false;

  const filtros = {
    texto: '',
    mes: '',
    tipo: '',
    cuenta: ''
  };

  // ==========================================================================
  // INICIALIZACIÓN
  // ==========================================================================

  document.addEventListener('DOMContentLoaded', () => {
    const prefs = window.AppStorage.getPrefs();
    oculto = Boolean(prefs.oculto);
    themeMode = prefs.theme || 'auto';

    aplicarTema(themeMode);
    actualizarIconoOjo();
    $('fecha').value = hoyLocal();

    registrarEventosUI();
    registrarServiceWorker();
    registrarEventosPWA();
    registrarEventosRed();

    arrancarSesion();
  });

  function registrarServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.warn('Service Worker no registrado:', err);
        });
      });
    }
  }

  function registrarEventosPWA() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (!$('appView').classList.contains('hidden')) {
        $('installBanner').classList.remove('hidden');
      }
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      $('installBanner').classList.add('hidden');
      mostrarToast('App instalada correctamente', 'success');
    });

    $('btnInstallPwa').addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        $('installBanner').classList.add('hidden');
      }
      deferredInstallPrompt = null;
    });

    $('btnDismissInstall').addEventListener('click', () => {
      $('installBanner').classList.add('hidden');
    });
  }

  function registrarEventosRed() {
    window.addEventListener('online', () => {
      actualizarBannerOffline();
      if (window.AppStorage.getSession()) {
        sincronizarTodo({ silencioso: false });
      }
    });
    window.addEventListener('offline', () => {
      actualizarBannerOffline();
      mostrarToast('Sin conexión. Podés seguir cargando gastos offline.', 'warn');
    });
  }

  // ==========================================================================
  // TEMA (AUTO / DARK / LIGHT)
  // ==========================================================================

  const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  darkMediaQuery.addEventListener('change', () => {
    if (themeMode === 'auto') aplicarTema('auto');
  });

  function aplicarTema(mode) {
    themeMode = mode;
    const isDark = mode === 'dark' || (mode === 'auto' && darkMediaQuery.matches);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

    const metaTheme = $('metaThemeColor');
    if (metaTheme) metaTheme.setAttribute('content', isDark ? '#0E131A' : '#0B57D0');

    const iconName = mode === 'auto' ? 'brightness_auto' : (mode === 'dark' ? 'dark_mode' : 'light_mode');
    if ($('themeIcon')) $('themeIcon').textContent = iconName;
    if ($('themeIconAuth')) $('themeIconAuth').textContent = iconName;
  }

  function rotarTema() {
    const next = themeMode === 'auto' ? 'dark' : (themeMode === 'dark' ? 'light' : 'auto');
    window.AppStorage.savePrefs({ theme: next });
    aplicarTema(next);
    const labels = { auto: 'Tema automático', dark: 'Modo oscuro', light: 'Modo claro' };
    mostrarToast(labels[next]);
  }

  // ==========================================================================
  // AUTENTICACIÓN CON GOOGLE SIGN-IN
  // ==========================================================================

  function arrancarSesion() {
    const session = window.AppStorage.getSession();
    if (session) {
      mostrarVistaApp(session.user);
      const cached = window.AppStorage.getCachedData();
      if (cached && cached.datos) {
        lastSyncAt = cached.lastSyncAt;
        aplicarDatos(cached.datos);
      }
      actualizarBannerOffline();
      if (navigator.onLine) {
        sincronizarTodo({ silencioso: Boolean(cached && cached.datos) });
      } else {
        actualizarTextoSync();
      }
    } else {
      mostrarVistaAuth();
    }
  }

  function mostrarVistaAuth(mensaje, tipo) {
    $('appView').classList.add('hidden');
    $('authView').classList.remove('hidden');

    if (mensaje) {
      mostrarMensajeAuth(mensaje, tipo || 'error');
    } else if (!window.AppApi.isConfigured()) {
      mostrarMensajeAuth(
        'Falta configurar APPS_SCRIPT_URL y GOOGLE_CLIENT_ID en pwa/config.js (ver SETUP.md).',
        'warn'
      );
    } else {
      ocultarMensajeAuth();
    }

    inicializarBotonGoogle();
  }

  function mostrarVistaApp(user) {
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');

    renderUsuario(user);
    if (deferredInstallPrompt) {
      $('installBanner').classList.remove('hidden');
    }
  }

  function renderUsuario(user) {
    const avatar = $('userAvatar');
    if (!user) return;
    if (user.picture) {
      avatar.innerHTML = `<img src="${escapeHtml(user.picture)}" alt="${escapeHtml(user.name || '')}" referrerpolicy="no-referrer">`;
    } else {
      const inicial = (user.name || user.email || 'U').charAt(0).toUpperCase();
      avatar.textContent = inicial;
    }
    avatar.title = user.email || '';
  }

  function inicializarBotonGoogle(reintentos = 0) {
    const container = $('googleSignInContainer');
    if (!window.AppApi.isConfigured()) {
      container.innerHTML = '';
      return;
    }

    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      if (reintentos < 25) {
        setTimeout(() => inicializarBotonGoogle(reintentos + 1), 250);
      } else {
        mostrarMensajeAuth('No se pudo cargar Google Sign-In. Verificá tu conexión a internet.', 'error');
      }
      return;
    }

    if (!gsiInicializado) {
      window.google.accounts.id.initialize({
        client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
        callback: manejarCredencialGoogle,
        auto_select: false,
        cancel_on_tap_outside: true
      });
      gsiInicializado = true;
    }

    container.innerHTML = '';
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    window.google.accounts.id.renderButton(container, {
      theme: isDark ? 'filled_black' : 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      locale: 'es',
      width: 280
    });
  }

  async function manejarCredencialGoogle(response) {
    if (!response || !response.credential) {
      mostrarMensajeAuth('No se recibió la credencial de Google.', 'error');
      return;
    }

    mostrarMensajeAuth('Verificando permisos con Google Sheets...', 'info');
    try {
      const res = await window.AppApi.loginWithGoogle(response.credential);
      ocultarMensajeAuth();
      lastSyncAt = Date.now();
      mostrarVistaApp(res.user);
      if (res.datos) {
        aplicarDatos(res.datos);
      }
      actualizarBannerOffline();
      actualizarTextoSync();
      mostrarToast(`Hola, ${res.user.name || res.user.email}`, 'success');
    } catch (err) {
      mostrarMensajeAuth(err.message || 'No se pudo iniciar sesión.', 'error');
    }
  }

  function cerrarSesion() {
    window.AppStorage.clearSession();
    window.AppStorage.clearCachedData();
    datos = null;
    lastSyncAt = null;
    if (window.google && window.google.accounts && window.google.accounts.id) {
      try { window.google.accounts.id.disableAutoSelect(); } catch (_) {}
    }
    mostrarVistaAuth('Sesión cerrada.', 'info');
  }

  function mostrarMensajeAuth(texto, tipo) {
    const el = $('authStatusMsg');
    el.textContent = texto;
    el.className = `auth-alert ${tipo || 'error'}`;
    el.classList.remove('hidden');
  }

  function ocultarMensajeAuth() {
    $('authStatusMsg').classList.add('hidden');
  }

  // ==========================================================================
  // SINCRONIZACIÓN Y COLA OFFLINE
  // ==========================================================================

  async function sincronizarTodo({ silencioso = false } = {}) {
    if (sincronizando) return;
    if (!navigator.onLine) {
      actualizarBannerOffline();
      if (!silencioso) mostrarToast('Sin conexión a internet', 'warn');
      return;
    }

    sincronizando = true;
    $('btnSync').classList.add('spinning');
    $('syncSubtext').textContent = 'Sincronizando...';

    try {
      // 1. Subir primero operaciones pendientes de la cola offline
      const enviados = await procesarColaOffline();

      // 2. Descargar estado más reciente del Google Sheet
      const res = await window.AppApi.getInitialData();
      if (res.user) renderUsuario(res.user);
      if (res.datos) {
        lastSyncAt = Date.now();
        aplicarDatos(res.datos);
      }

      if (enviados > 0) {
        mostrarToast(`Sincronizado (${enviados} operación${enviados > 1 ? 'es' : ''} pendiente${enviados > 1 ? 's' : ''} enviada${enviados > 1 ? 's' : ''})`, 'success');
      } else if (!silencioso) {
        mostrarToast('Datos actualizados desde Google Sheets', 'success');
      }
    } catch (err) {
      if (manejarErrorAuth(err)) return;
      if (!silencioso) {
        mostrarToast(err.message || 'No se pudo sincronizar', 'error');
      }
    } finally {
      sincronizando = false;
      $('btnSync').classList.remove('spinning');
      actualizarBannerOffline();
      actualizarTextoSync();
    }
  }

  async function procesarColaOffline() {
    const queue = window.AppStorage.getQueue();
    if (!queue.length) return 0;

    let sincronizados = 0;
    for (const item of queue) {
      try {
        const res = await window.AppApi.saveTransaction(item.payload);
        if (res && res.success) {
          window.AppStorage.removeFromQueue(item.clientId);
          sincronizados++;
          if (res.dashboard && datos) {
            datos.dashboard = res.dashboard;
            window.AppStorage.saveCachedData(datos);
          }
        }
      } catch (err) {
        if (manejarErrorAuth(err)) throw err;
        // Si es error de red, detenemos la cola para reintentar luego
        if (err.code === 'NETWORK_ERROR') break;
        // Si es error de validación del server, quitamos o informamos
        mostrarToast(`No se pudo sincronizar una operación pendiente: ${err.message}`, 'error');
        break;
      }
    }
    return sincronizados;
  }

  function manejarErrorAuth(err) {
    const authCodes = ['UNAUTHORIZED', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'FORBIDDEN_EMAIL'];
    if (err && authCodes.includes(err.code)) {
      mostrarVistaAuth(err.message || 'Sesión expirada. Iniciá sesión nuevamente.', 'error');
      return true;
    }
    return false;
  }

  function actualizarBannerOffline() {
    const banner = $('offlineBanner');
    const icon = $('offlineBannerIcon');
    const text = $('offlineBannerText');
    const btn = $('btnSyncQueue');
    const pendientes = window.AppStorage.getQueue().length;

    if (!navigator.onLine) {
      icon.textContent = 'cloud_off';
      text.textContent = pendientes > 0
        ? `Sin conexión · ${pendientes} operación${pendientes > 1 ? 'es' : ''} pendiente${pendientes > 1 ? 's' : ''}`
        : 'Sin conexión · Mostrando datos guardados';
      btn.classList.add('hidden');
      banner.classList.remove('hidden');
    } else if (pendientes > 0) {
      icon.textContent = 'cloud_upload';
      text.textContent = `${pendientes} operación${pendientes > 1 ? 'es' : ''} pendiente${pendientes > 1 ? 's' : ''} de subir`;
      btn.classList.remove('hidden');
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function actualizarTextoSync() {
    const el = $('syncSubtext');
    if (!navigator.onLine) {
      el.textContent = 'Modo offline';
      return;
    }
    if (!lastSyncAt) {
      el.textContent = 'Conectado a Google Sheets';
      return;
    }
    const d = new Date(lastSyncAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    el.textContent = `Sincronizado · ${hh}:${mm}`;
  }

  // ==========================================================================
  // RENDERIZADO DE DATOS, DASHBOARD Y DESGLOSE DE CUENTAS
  // ==========================================================================

  function aplicarDatos(d) {
    datos = d;
    $('submitBtn').disabled = false;
    if (!$('editandoRow').value) {
      $('submitBtnText').textContent = 'GUARDAR OPERACIÓN';
    }

    // Preservar selección actual si el formulario está abierto en edición
    if (!$('editandoRow').value) {
      setTipo($('tipoOperacion').value || 'Egreso');
    }

    poblarFiltros();
    if (d.dashboard) {
      renderDashboard(d.dashboard);
      renderDesgloseCuentas(d.dashboard.cuentasDetalle || []);
      renderMovimientos();
    }
  }

  function renderDashboard(dash) {
    $('lblMesActual').textContent = 'Resumen · ' + (dash.mesLabel || 'Mes actual');
    $('valSaldoGlobal').textContent = formatearMoneda(dash.saldoGlobal);
    $('valIngresosMes').textContent = formatearMoneda(dash.ingresosMes);
    $('valGastadoMes').textContent = formatearMoneda(dash.gastadoMes);
    $('valRestanteMes').textContent = formatearMoneda(dash.restanteMes);

    const pct = dash.ingresosMes > 0
      ? Math.min(100, Math.round((dash.gastadoMes / dash.ingresosMes) * 100))
      : (dash.gastadoMes > 0 ? 100 : 0);

    $('lblPorcentajeGasto').textContent = pct + '% gastado';
    const barra = $('barraMes');
    barra.style.width = pct + '%';
    barra.style.backgroundColor = pct >= 90 ? '#F6AEA9' : (pct >= 70 ? '#FDD663' : '#A8DAB5');
  }

  function renderDesgloseCuentas(cuentas) {
    const contenedor = $('listaCuentasDesglose');
    if (!cuentas || !cuentas.length) {
      contenedor.innerHTML = '<div class="empty-state" style="color:#fff;">No hay cuentas con saldo activo.</div>';
      return;
    }
    contenedor.innerHTML = cuentas.map((c) => `
      <div class="cuenta-desglose-row">
        <span style="color:#fff;">${escapeHtml(c.cuenta)}</span>
        <span style="font-weight:800; color:#A8DAB5;">${formatearMoneda(c.saldo)}</span>
      </div>
    `).join('');
  }

  async function toggleDesgloseCuentas() {
    const desglose = $('heroDesgloseCuentas');
    const chevron = $('chevronDesglose');
    const isOpen = desglose.classList.toggle('open');
    chevron.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';

    if (!isOpen) return;

    const cuentasCache = datos && datos.dashboard && datos.dashboard.cuentasDetalle;
    if (cuentasCache && cuentasCache.length) {
      renderDesgloseCuentas(cuentasCache);
    }

    if (navigator.onLine) {
      try {
        const res = await window.AppApi.getAccountBalances();
        if (res && Array.isArray(res.cuentas)) {
          if (datos && datos.dashboard) {
            datos.dashboard.cuentasDetalle = res.cuentas;
            window.AppStorage.saveCachedData(datos);
          }
          renderDesgloseCuentas(res.cuentas);
        }
      } catch (err) {
        if (!cuentasCache || !cuentasCache.length) {
          $('listaCuentasDesglose').innerHTML = '<div class="empty-state" style="color:#fff;">Error al cargar cuentas.</div>';
        }
        manejarErrorAuth(err);
      }
    }
  }

  // ==========================================================================
  // BÚSQUEDA, FILTROS Y MOVIMIENTOS (CON PENDIENTES OFFLINE)
  // ==========================================================================

  function poblarFiltros() {
    const movs = (datos && datos.dashboard && datos.dashboard.movimientos) || [];
    const selMes = $('filterMes');
    const selCuenta = $('filterCuenta');

    const prevMes = selMes.value;
    const prevCuenta = selCuenta.value;

    // Meses disponibles ordenados cronológicamente (más reciente primero)
    const mesesSet = new Set();
    movs.forEach((m) => { if (m.mes) mesesSet.add(m.mes.toLowerCase()); });
    const mesesDisponibles = Array.from(mesesSet).sort(
      (a, b) => MESES_ORDEN.indexOf(b) - MESES_ORDEN.indexOf(a)
    );

    selMes.innerHTML = '<option value="">Todos los meses</option>';
    mesesDisponibles.forEach((mes) => {
      const label = mes.charAt(0).toUpperCase() + mes.slice(1);
      selMes.appendChild(new Option(label, mes));
    });
    if (prevMes && mesesSet.has(prevMes)) selMes.value = prevMes;

    // Cuentas disponibles
    const cuentasSet = new Set((datos && datos.cuentas) || []);
    movs.forEach((m) => { if (m.cuenta) cuentasSet.add(m.cuenta); });
    selCuenta.innerHTML = '<option value="">Todas las cuentas</option>';
    Array.from(cuentasSet).sort().forEach((c) => {
      selCuenta.appendChild(new Option(c, c));
    });
    if (prevCuenta && cuentasSet.has(prevCuenta)) selCuenta.value = prevCuenta;
  }

  function obtenerMovimientosCombinados() {
    const serverMovs = (datos && datos.dashboard && datos.dashboard.movimientos) || [];
    const queue = window.AppStorage.getQueue();

    const pendingMovs = queue.map((item) => {
      const p = item.payload;
      const d = new Date((p.fecha || hoyLocal()) + 'T12:00:00');
      const monto = parseFloat(String(p.monto || '0').replace(/\./g, '').replace(',', '.')) || 0;
      let tipo = 'egreso';
      if (p.tipoOperacion === 'Ingreso') tipo = 'ingreso';
      else if (p.tipoOperacion === 'Transferencia') tipo = 'transferencia';
      else if (p.tipoOperacion === 'Pago TDC') tipo = 'pago_tdc';

      const titulo = tipo === 'transferencia'
        ? 'Salida'
        : (tipo === 'pago_tdc' ? (p.cuentaDestino || 'Pago TDC') : (p.subcategoria || p.tipoOperacion));

      const subtitulo = tipo === 'ingreso'
        ? 'Ingreso'
        : (tipo === 'transferencia' ? 'Transferencias' : (tipo === 'pago_tdc' ? 'Pagos TDC' : (p.categoriaPadre || 'Egreso')));

      return {
        pending: true,
        clientId: item.clientId,
        fechaTs: d.getTime(),
        fechaIso: p.fecha || hoyLocal(),
        fechaStr: formatearFechaCorta(d),
        mes: MESES_ORDEN[d.getMonth()],
        anio: d.getFullYear(),
        rowNum: -1,
        tipo,
        titulo,
        subtitulo,
        cuenta: p.medioPago || '',
        descripcion: p.descripcion || '',
        monto
      };
    }).reverse();

    return [...pendingMovs, ...serverMovs];
  }

  function renderMovimientos() {
    const todos = obtenerMovimientosCombinados();
    const cont = $('movList');
    const btn = $('btnVerMas');

    const textoNorm = filtros.texto.trim().toLowerCase();
    const filtrados = todos.filter((m) => {
      if (filtros.mes && (m.mes || '').toLowerCase() !== filtros.mes) return false;
      if (filtros.tipo && m.tipo !== filtros.tipo) return false;
      if (filtros.cuenta && m.cuenta !== filtros.cuenta) return false;
      if (textoNorm) {
        const haystack = [
          m.titulo, m.subtitulo, m.cuenta, m.descripcion, m.fechaStr, String(m.monto)
        ].join(' ').toLowerCase();
        if (!haystack.includes(textoNorm)) return false;
      }
      return true;
    });

    movimientosFiltradosCache = filtrados;

    // Resaltar selects activos y mostrar resumen si hay filtros aplicados
    $('filterMes').classList.toggle('active-filter', Boolean(filtros.mes));
    $('filterTipo').classList.toggle('active-filter', Boolean(filtros.tipo));
    $('filterCuenta').classList.toggle('active-filter', Boolean(filtros.cuenta));
    $('btnClearSearch').classList.toggle('hidden', !filtros.texto);

    const hayFiltros = Boolean(textoNorm || filtros.mes || filtros.tipo || filtros.cuenta);
    const summaryEl = $('filterSummary');
    if (hayFiltros) {
      const totalEgr = filtrados
        .filter((m) => m.tipo === 'egreso')
        .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);
      const totalIng = filtrados
        .filter((m) => m.tipo === 'ingreso')
        .reduce((acc, m) => acc + (Number(m.monto) || 0), 0);

      const partes = [`${filtrados.length} resultado${filtrados.length === 1 ? '' : 's'}`];
      if (totalEgr > 0) partes.push(`Egr: ${formatearMoneda(totalEgr)}`);
      if (totalIng > 0) partes.push(`Ing: ${formatearMoneda(totalIng)}`);
      $('filterSummaryText').textContent = partes.join(' · ');
      summaryEl.classList.remove('hidden');
    } else {
      summaryEl.classList.add('hidden');
    }

    if (!filtrados.length) {
      cont.innerHTML = hayFiltros
        ? '<div class="empty-state">No hay movimientos que coincidan con los filtros.</div>'
        : '<div class="empty-state">No hay movimientos registrados todavía.</div>';
      btn.classList.add('hidden');
      $('lblContadorMovs').textContent = '';
      return;
    }

    const slice = filtrados.slice(0, movimientosVisibles);
    $('lblContadorMovs').textContent = `Mostrando ${slice.length} de ${filtrados.length}`;

    cont.innerHTML = slice.map((m, idx) => {
      const signo = m.tipo === 'ingreso' ? '+' : (m.tipo === 'transferencia' ? '' : '-');
      const detalleSecundario = [m.cuenta, m.descripcion].filter(Boolean).join(' · ');
      const subLabel = m.tipo === 'pago_tdc'
        ? `Pago TDC · ${m.cuenta || 'Cuenta'}`
        : (m.tipo === 'transferencia'
          ? `Transferencia · ${detalleSecundario}`
          : `${m.subtitulo}${detalleSecundario ? ' · ' + detalleSecundario : ''}`);

      return `
        <div class="mov-item${m.pending ? ' pending-item' : ''}" data-mov-idx="${idx}">
          <div class="mov-icon ${m.tipo}">
            <span class="material-symbols-rounded">${iconoMovimiento(m)}</span>
          </div>
          <div class="mov-body">
            <div class="mov-title-row">
              <div class="mov-title">${escapeHtml(m.titulo)}</div>
              ${m.pending ? '<span class="badge-pending">Pendiente</span>' : ''}
            </div>
            <div class="mov-meta">${escapeHtml(subLabel)}</div>
          </div>
          <div class="mov-right">
            <div class="mov-amount ${m.tipo}">${signo}${formatearMoneda(m.monto)}</div>
            <div class="mov-date">${escapeHtml(m.fechaStr)}</div>
          </div>
        </div>
      `;
    }).join('');

    if (movimientosVisibles < filtrados.length) {
      const restantes = filtrados.length - movimientosVisibles;
      $('btnVerMasText').textContent = `Ver más (${Math.min(20, restantes)} más)`;
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  function iconoMovimiento(mov) {
    if (mov.tipo === 'ingreso') return 'arrow_downward';
    if (mov.tipo === 'transferencia') return 'swap_horiz';
    if (mov.tipo === 'pago_tdc') return 'credit_score';
    const cat = (mov.subtitulo || '').toLowerCase();
    if (cat.includes('alimento')) return 'restaurant';
    if (cat.includes('transporte')) return 'directions_bus';
    if (cat.includes('vivienda')) return 'home';
    if (cat.includes('servicio')) return 'receipt_long';
    if (cat.includes('salud')) return 'medical_services';
    if (cat.includes('ocio')) return 'sports_esports';
    if (cat.includes('indumentaria')) return 'checkroom';
    if (cat.includes('educaci')) return 'school';
    return 'shopping_bag';
  }

  // ==========================================================================
  // FORMULARIO: CREAR / EDITAR / BORRAR
  // ==========================================================================

  function toggleFormulario(abrir) {
    const card = $('formContainerCard');
    const isOpen = abrir !== undefined ? abrir : !card.classList.contains('open');
    card.classList.toggle('open', isOpen);
    $('iconToggleForm').textContent = isOpen ? 'expand_less' : 'add_circle';
    if (!isOpen) limpiarFormularioEdicion();
  }

  function llenarSelect(id, lista, placeholder) {
    const sel = $(id);
    sel.innerHTML = '';
    sel.appendChild(new Option(placeholder || 'Selecciona...', ''));
    (lista || []).forEach((i) => sel.appendChild(new Option(i, i)));
  }

  function llenarSubcategoriasEgreso() {
    const sel = $('subcategoria');
    sel.innerHTML = '';
    sel.appendChild(new Option('Selecciona...', ''));
    ((datos && datos.egresos) || []).forEach((c) => {
      const g = document.createElement('optgroup');
      g.label = c.categoria;
      c.subs.forEach((s) => {
        const o = new Option(s, s);
        o.setAttribute('data-padre', c.categoria);
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
  }

  function setTipo(tipo) {
    if (!datos) return;
    $('tipoOperacion').value = tipo;
    document.querySelectorAll('.tipo-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tipo === tipo);
    });

    const usaCategoria = (tipo === 'Egreso' || tipo === 'Ingreso');
    $('divCat').classList.toggle('hidden', !usaCategoria);
    $('divDestino').classList.toggle('hidden', usaCategoria);

    if (tipo === 'Egreso') {
      $('lblSubcategoria').innerHTML = '<span class="material-symbols-rounded">category</span> Categoría / Subcategoría';
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">account_balance_wallet</span> Medio de Pago';
      llenarSubcategoriasEgreso();
      llenarSelect('medioPago', datos.cuentas);
    } else if (tipo === 'Ingreso') {
      $('lblSubcategoria').innerHTML = '<span class="material-symbols-rounded">payments</span> Concepto de Ingreso';
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">savings</span> Cuenta Destino';
      llenarSelect('subcategoria', datos.ingresos);
      llenarSelect('medioPago', datos.cuentasNoTdc);
    } else if (tipo === 'Transferencia') {
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">output</span> Cuenta Origen';
      $('lblDestino').innerHTML = '<span class="material-symbols-rounded">input</span> Cuenta Destino';
      llenarSelect('medioPago', datos.cuentasNoTdc);
      llenarSelect('cuentaDestino', datos.cuentasNoTdc);
    } else if (tipo === 'Pago TDC') {
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">account_balance</span> Cuenta que Paga';
      $('lblDestino').innerHTML = '<span class="material-symbols-rounded">credit_card</span> Tarjeta a Pagar';
      llenarSelect('medioPago', datos.cuentasNoTdc);
      llenarSelect('cuentaDestino', datos.tdcs);
    }
    actualizarCuotas();
  }

  function actualizarCuotas() {
    const esEgresoTdc = $('tipoOperacion').value === 'Egreso' && $('medioPago').value.toUpperCase().includes('TDC');
    $('divCuotas').classList.toggle('hidden', !esEgresoTdc);
    if (!esEgresoTdc) $('cuotas').value = 1;
  }

  function mascaraMonto(input) {
    let v = input.value.replace(/[^\d,]/g, '');
    const p = v.split(',');
    p[0] = p[0].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    input.value = p.length > 1
      ? (p[0] === '' ? '0' : p[0]) + ',' + p.slice(1).join('').substring(0, 2)
      : p[0];
  }

  function limpiarFormularioEdicion() {
    $('editandoTipo').value = '';
    $('editandoRow').value = '';
    editandoFingerprint = null;
    $('formTitleText').textContent = 'Registrar Operación';
    $('formTitleIcon').textContent = 'add_circle';
    $('submitBtnText').textContent = 'GUARDAR OPERACIÓN';
    $('monto').value = '';
    $('descripcion').value = '';
    $('cuotas').value = 1;
    $('fecha').value = hoyLocal();
    if (datos) setTipo('Egreso');
  }

  function abrirAccionesMovimiento(mov) {
    movimientoSeleccionado = mov;
    $('tituloAccionesModal').textContent = mov.titulo || 'Movimiento';
    $('modalAccionesInfo').textContent = `${mov.fechaStr} · ${mov.cuenta || 'Sin cuenta'} · ${formatearMoneda(mov.monto)}`;

    if (mov.pending) {
      $('btnEditarMov').classList.add('hidden');
      $('lblBtnBorrarMov').textContent = 'Cancelar operación pendiente';
    } else {
      $('btnEditarMov').classList.remove('hidden');
      $('lblBtnBorrarMov').textContent = 'Borrar Movimiento';
    }

    $('modalAcciones').classList.add('active');
  }

  function ejecutarEditarMovimiento() {
    if (!movimientoSeleccionado) return;
    $('modalAcciones').classList.remove('active');

    if (!navigator.onLine) {
      mostrarToast('Necesitás conexión para editar un movimiento ya sincronizado.', 'warn');
      return;
    }

    const m = movimientoSeleccionado;
    toggleFormulario(true);

    let tipoOpUI = 'Egreso';
    if (m.tipo === 'ingreso') tipoOpUI = 'Ingreso';
    else if (m.tipo === 'transferencia') tipoOpUI = 'Transferencia';
    else if (m.tipo === 'pago_tdc') tipoOpUI = 'Pago TDC';

    setTipo(tipoOpUI);

    $('monto').value = String(m.monto).replace('.', ',');
    mascaraMonto($('monto'));
    $('medioPago').value = m.cuenta || '';
    actualizarCuotas();

    let descLimpia = m.descripcion || '';
    if (tipoOpUI === 'Pago TDC') {
      $('cuentaDestino').value = m.titulo || '';
      const prefijo = 'Pago de tarjeta: ' + (m.titulo || '');
      if (descLimpia.startsWith(prefijo)) {
        descLimpia = descLimpia.slice(prefijo.length).trim();
      }
    } else if (tipoOpUI === 'Transferencia') {
      // Intentar extraer cuenta destino de "A: <Cuenta> <desc>"
      const cuentas = (datos && datos.cuentasNoTdc) || [];
      const matchCuenta = cuentas.find((c) => descLimpia.startsWith('A: ' + c));
      if (matchCuenta) {
        $('cuentaDestino').value = matchCuenta;
        descLimpia = descLimpia.slice(('A: ' + matchCuenta).length).trim();
      }
    }

    $('descripcion').value = descLimpia;
    $('fecha').value = m.fechaIso || fechaTsAIso(m.fechaTs);

    if (tipoOpUI === 'Egreso' || tipoOpUI === 'Ingreso') {
      $('subcategoria').value = m.titulo || '';
    }

    $('editandoTipo').value = m.tipo;
    $('editandoRow').value = m.rowNum;
    editandoFingerprint = { monto: m.monto, titulo: m.titulo };

    $('formTitleText').textContent = 'Editar Operación';
    $('formTitleIcon').textContent = 'edit';
    $('submitBtnText').textContent = 'ACTUALIZAR OPERACIÓN';
    $('formContainerCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function ejecutarBorrarMovimiento() {
    if (!movimientoSeleccionado) return;
    $('modalAcciones').classList.remove('active');

    if (movimientoSeleccionado.pending) {
      window.AppStorage.removeFromQueue(movimientoSeleccionado.clientId);
      movimientoSeleccionado = null;
      actualizarBannerOffline();
      renderMovimientos();
      mostrarToast('Operación pendiente eliminada de la cola.', 'success');
      return;
    }

    if (!navigator.onLine) {
      mostrarToast('Necesitás conexión para borrar un movimiento de Google Sheets.', 'warn');
      return;
    }

    $('txtDetalleBorrar').textContent =
      `¿Deseás eliminar "${movimientoSeleccionado.titulo}" por ${formatearMoneda(movimientoSeleccionado.monto)}?`;
    $('modalConfirmarBorrar').classList.add('active');
  }

  async function confirmarBorrarMovimientoFinal() {
    if (!movimientoSeleccionado) return;
    const mov = movimientoSeleccionado;
    $('modalConfirmarBorrar').classList.remove('active');

    const btn = $('btnConfirmarBorrarFinal');
    btn.disabled = true;

    try {
      const res = await window.AppApi.deleteTransaction(mov.tipo, mov.rowNum, {
        monto: mov.monto,
        titulo: mov.titulo
      });
      mostrarToast(res.message || 'Movimiento borrado.', 'success');
      if (res.dashboard && datos) {
        datos.dashboard = res.dashboard;
        lastSyncAt = Date.now();
        window.AppStorage.saveCachedData(datos);
        renderDashboard(res.dashboard);
        renderDesgloseCuentas(res.dashboard.cuentasDetalle || []);
        poblarFiltros();
        renderMovimientos();
        actualizarTextoSync();
      }
    } catch (err) {
      if (manejarErrorAuth(err)) return;
      if (err.data && err.data.dashboard && datos) {
        datos.dashboard = err.data.dashboard;
        window.AppStorage.saveCachedData(datos);
        renderDashboard(datos.dashboard);
        renderMovimientos();
      }
      mostrarToast(err.message || 'Error al borrar.', 'error');
    } finally {
      btn.disabled = false;
      movimientoSeleccionado = null;
    }
  }

  async function manejarSubmitFormulario(e) {
    e.preventDefault();
    const tipo = $('tipoOperacion').value;

    const montoVal = parseFloat($('monto').value.replace(/\./g, '').replace(',', '.'));
    if (!isFinite(montoVal) || montoVal <= 0) {
      mostrarMensajeForm('Ingresá un monto válido.', 'error');
      return;
    }
    if (!$('fecha').value) {
      mostrarMensajeForm('Elegí una fecha.', 'error');
      return;
    }
    if ((tipo === 'Egreso' || tipo === 'Ingreso') && !$('subcategoria').value) {
      mostrarMensajeForm('Elegí una subcategoría o concepto.', 'error');
      return;
    }
    if (!$('medioPago').value) {
      mostrarMensajeForm('Elegí la cuenta / medio de pago.', 'error');
      return;
    }
    if ((tipo === 'Transferencia' || tipo === 'Pago TDC') && !$('cuentaDestino').value) {
      mostrarMensajeForm(tipo === 'Pago TDC' ? 'Elegí la tarjeta a pagar.' : 'Elegí la cuenta destino.', 'error');
      return;
    }
    if (tipo === 'Transferencia' && $('cuentaDestino').value === $('medioPago').value) {
      mostrarMensajeForm('La cuenta origen y destino no pueden ser la misma.', 'error');
      return;
    }

    const estaEditando = Boolean($('editandoRow').value);
    if (estaEditando && !navigator.onLine) {
      mostrarMensajeForm('Necesitás conexión para actualizar una operación existente.', 'warn');
      return;
    }

    const selSub = $('subcategoria');
    const opt = selSub.options[selSub.selectedIndex];
    const usaCategoria = (tipo === 'Egreso' || tipo === 'Ingreso');

    const payload = {
      clientId: generarClientId(),
      tipoOperacion: tipo,
      fecha: $('fecha').value,
      subcategoria: usaCategoria ? selSub.value : '',
      categoriaPadre: (tipo === 'Egreso' && opt) ? (opt.getAttribute('data-padre') || '') : '',
      medioPago: $('medioPago').value,
      cuentaDestino: usaCategoria ? '' : $('cuentaDestino').value,
      monto: $('monto').value,
      cuotas: $('cuotas').value,
      descripcion: $('descripcion').value,
      editandoTipo: $('editandoTipo').value,
      editandoRow: $('editandoRow').value,
      fingerprint: editandoFingerprint
    };

    // Si estamos offline y es una operación nueva -> encolar localmente
    if (!navigator.onLine) {
      window.AppStorage.enqueueTransaction(payload);
      limpiarFormularioEdicion();
      toggleFormulario(false);
      actualizarBannerOffline();
      renderMovimientos();
      mostrarToast('Guardado offline. Se subirá automáticamente al volver la señal.', 'warn');
      return;
    }

    const btn = $('submitBtn');
    btn.disabled = true;
    $('submitBtnText').textContent = 'GUARDANDO...';

    try {
      const res = await window.AppApi.saveTransaction(payload);
      mostrarToast(res.message || 'Operación guardada.', 'success');
      limpiarFormularioEdicion();
      toggleFormulario(false);

      if (res.dashboard && datos) {
        datos.dashboard = res.dashboard;
        lastSyncAt = Date.now();
        window.AppStorage.saveCachedData(datos);
        renderDashboard(res.dashboard);
        renderDesgloseCuentas(res.dashboard.cuentasDetalle || []);
        poblarFiltros();
        renderMovimientos();
        actualizarTextoSync();
      }
    } catch (err) {
      if (manejarErrorAuth(err)) return;

      // Si falló por red al crear una operación nueva, ofrecer / guardar en cola offline automáticamente
      if (err.code === 'NETWORK_ERROR' && !estaEditando) {
        window.AppStorage.enqueueTransaction(payload);
        limpiarFormularioEdicion();
        toggleFormulario(false);
        actualizarBannerOffline();
        renderMovimientos();
        mostrarToast('Sin conexión. Operación encolada para sincronizar luego.', 'warn');
        return;
      }

      if (err.data && err.data.dashboard && datos) {
        datos.dashboard = err.data.dashboard;
        window.AppStorage.saveCachedData(datos);
        renderDashboard(datos.dashboard);
        renderMovimientos();
      }
      mostrarMensajeForm(err.message || 'Error al guardar.', 'error');
    } finally {
      btn.disabled = false;
      $('submitBtnText').textContent = $('editandoRow').value ? 'ACTUALIZAR OPERACIÓN' : 'GUARDAR OPERACIÓN';
    }
  }

  // ==========================================================================
  // EVENTOS UI
  // ==========================================================================

  function registrarEventosUI() {
    $('btnTheme').addEventListener('click', rotarTema);
    $('btnThemeAuth').addEventListener('click', rotarTema);
    $('btnSync').addEventListener('click', () => sincronizarTodo({ silencioso: false }));
    $('btnSyncQueue').addEventListener('click', () => sincronizarTodo({ silencioso: false }));
    $('btnLogout').addEventListener('click', cerrarSesion);

    $('heroCard').addEventListener('click', () => toggleDesgloseCuentas());
    $('heroDesgloseCuentas').addEventListener('click', (e) => e.stopPropagation());
    $('monthPanel').addEventListener('click', (e) => e.stopPropagation());
    $('btnPrivacidad').addEventListener('click', (e) => {
      e.stopPropagation();
      oculto = !oculto;
      window.AppStorage.savePrefs({ oculto });
      actualizarIconoOjo();
      if (datos && datos.dashboard) {
        renderDashboard(datos.dashboard);
        renderDesgloseCuentas(datos.dashboard.cuentasDetalle || []);
        renderMovimientos();
      }
    });

    $('btnToggleForm').addEventListener('click', () => toggleFormulario());
    $('btnCloseForm').addEventListener('click', () => toggleFormulario(false));

    document.querySelectorAll('.tipo-btn').forEach((btn) => {
      btn.addEventListener('click', () => setTipo(btn.dataset.tipo));
    });

    $('monto').addEventListener('input', (e) => mascaraMonto(e.target));
    $('medioPago').addEventListener('change', actualizarCuotas);
    $('mainForm').addEventListener('submit', manejarSubmitFormulario);

    // Búsqueda y filtros
    $('searchMovs').addEventListener('input', (e) => {
      filtros.texto = e.target.value;
      movimientosVisibles = 15;
      renderMovimientos();
    });
    $('btnClearSearch').addEventListener('click', () => {
      filtros.texto = '';
      $('searchMovs').value = '';
      movimientosVisibles = 15;
      renderMovimientos();
    });
    $('filterMes').addEventListener('change', (e) => {
      filtros.mes = e.target.value;
      movimientosVisibles = 15;
      renderMovimientos();
    });
    $('filterTipo').addEventListener('change', (e) => {
      filtros.tipo = e.target.value;
      movimientosVisibles = 15;
      renderMovimientos();
    });
    $('filterCuenta').addEventListener('change', (e) => {
      filtros.cuenta = e.target.value;
      movimientosVisibles = 15;
      renderMovimientos();
    });
    $('btnResetFilters').addEventListener('click', () => {
      filtros.texto = '';
      filtros.mes = '';
      filtros.tipo = '';
      filtros.cuenta = '';
      $('searchMovs').value = '';
      $('filterMes').value = '';
      $('filterTipo').value = '';
      $('filterCuenta').value = '';
      movimientosVisibles = 15;
      renderMovimientos();
    });

    // Delegación de clicks en la lista de movimientos (evita XSS / problemas con comillas)
    $('movList').addEventListener('click', (e) => {
      const card = e.target.closest('.mov-item[data-mov-idx]');
      if (!card) return;
      const idx = Number(card.dataset.movIdx);
      const mov = movimientosFiltradosCache[idx];
      if (mov) abrirAccionesMovimiento(mov);
    });

    $('btnVerMas').addEventListener('click', () => {
      movimientosVisibles += 20;
      renderMovimientos();
    });

    // Modales
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('active');
      });
    });
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-close-modal');
        if ($(id)) $(id).classList.remove('active');
      });
    });

    $('btnEditarMov').addEventListener('click', ejecutarEditarMovimiento);
    $('btnBorrarMov').addEventListener('click', ejecutarBorrarMovimiento);
    $('btnConfirmarBorrarFinal').addEventListener('click', confirmarBorrarMovimientoFinal);
  }

  // ==========================================================================
  // UTILIDADES
  // ==========================================================================

  function actualizarIconoOjo() {
    $('eyeIcon').textContent = oculto ? 'visibility_off' : 'visibility';
  }

  function hoyLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fechaTsAIso(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function formatearFechaCorta(date) {
    const mesesCortos = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return String(date.getDate()).padStart(2, '0') + ' ' + mesesCortos[date.getMonth()];
  }

  function formatearMoneda(valor) {
    if (oculto) return '$ •••••';
    const num = Number(valor) || 0;
    const signo = num < 0 ? '-' : '';
    return signo + '$ ' + Math.abs(num).toLocaleString('es-AR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function generarClientId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function mostrarMensajeForm(texto, tipo) {
    const m = $('msg');
    m.textContent = texto;
    m.className = tipo || 'error';
    m.style.display = 'block';
    clearTimeout(mostrarMensajeForm._t);
    mostrarMensajeForm._t = setTimeout(() => { m.style.display = 'none'; }, 4500);
  }

  function mostrarToast(texto, tipo) {
    const t = $('toast');
    t.textContent = texto;
    t.className = 'toast show' + (tipo ? ' ' + tipo : '');
    clearTimeout(mostrarToast._t);
    mostrarToast._t = setTimeout(() => { t.classList.remove('show'); }, 3500);
  }
})();
