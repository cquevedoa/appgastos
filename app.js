(() => {
  const $ = (id) => document.getElementById(id);

  const MESES_ORDEN = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];

  // Estado en memoria
  let datos = null;
  let usuarioActual = null;
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
  let pickerSelectActivoId = null;
  let pickerOpcionesCache = [];

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
      const yaTeniaController = Boolean(navigator.serviceWorker.controller);
      let recargando = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (yaTeniaController && !recargando) {
          recargando = true;
          window.location.reload();
        }
      });

      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then((reg) => {
            try { reg.update(); } catch (_) {}
          })
          .catch((err) => {
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

    if (gsiInicializado && $('authView') && !$('authView').classList.contains('hidden')) {
      inicializarBotonGoogle();
    }
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
    usuarioActual = user;
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

  function abrirConfirmacionLogout() {
    const pendientes = window.AppStorage.getQueue().length;
    const detalle = $('txtDetalleLogout');
    if (pendientes > 0) {
      detalle.textContent = `Tenés ${pendientes} ${pendientes === 1 ? 'operación pendiente' : 'operaciones pendientes'} de sincronizar. Tendrás que volver a iniciar sesión con tu cuenta de Google para acceder a tus gastos.`;
    } else if (usuarioActual && usuarioActual.email) {
      detalle.textContent = `Se cerrará la sesión de ${usuarioActual.email}. Tendrás que volver a iniciar sesión con Google para acceder.`;
    } else {
      detalle.textContent = 'Tendrás que volver a iniciar sesión con tu cuenta de Google para acceder a tus gastos.';
    }
    $('modalConfirmarLogout').classList.add('active');
  }

  function cerrarSesion() {
    document.querySelectorAll('.modal-overlay.active').forEach((m) => m.classList.remove('active'));
    window.AppStorage.clearSession();
    window.AppStorage.clearCachedData();
    datos = null;
    usuarioActual = null;
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

    // Cuentas disponibles (todas para poder filtrar el historial completo)
    const cuentasSet = new Set((datos && (datos.cuentasTodasFiltro || datos.cuentas)) || []);
    movs.forEach((m) => { if (m.cuenta) cuentasSet.add(m.cuenta); });
    selCuenta.innerHTML = '<option value="">Todas las cuentas</option>';
    Array.from(cuentasSet).sort().forEach((c) => {
      selCuenta.appendChild(new Option(c, c));
    });
    if (prevCuenta && cuentasSet.has(prevCuenta)) selCuenta.value = prevCuenta;

    sincronizarTextoSelector('filterMes');
    sincronizarTextoSelector('filterTipo');
    sincronizarTextoSelector('filterCuenta');
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

      const subtipoTransf = tipo === 'transferencia' ? (p.subtipoTransferencia || 'Interna') : '';
      const titulo = tipo === 'transferencia'
        ? (subtipoTransf === 'Externa' ? 'Transferencia Externa' : 'Transferencia Interna')
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
        subtipoTransferencia: subtipoTransf,
        ajusteDireccion: '',
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
      if (filtros.tipo) {
        if (filtros.tipo === 'transferencia_interna') {
          if (m.tipo !== 'transferencia' || (m.subtipoTransferencia || 'Interna') !== 'Interna') return false;
        } else if (filtros.tipo === 'transferencia_externa') {
          if (m.tipo !== 'transferencia' || m.subtipoTransferencia !== 'Externa') return false;
        } else if (m.tipo !== filtros.tipo) {
          return false;
        }
      }
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
    $('btnSelectFilterMes').classList.toggle('active-filter', Boolean(filtros.mes));
    $('btnSelectFilterTipo').classList.toggle('active-filter', Boolean(filtros.tipo));
    $('btnSelectFilterCuenta').classList.toggle('active-filter', Boolean(filtros.cuenta));
    $('btnClearSearch').classList.toggle('hidden', !filtros.texto);

    const hayFiltros = Boolean(textoNorm || filtros.mes || filtros.tipo || filtros.cuenta);
    const summaryEl = $('filterSummary');
    if (hayFiltros) {
      const totalEgr = filtrados
        .filter((m) => m.tipo === 'egreso' || (m.tipo === 'transferencia' && m.subtipoTransferencia === 'Externa'))
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
      const esTransfExterna = (m.tipo === 'transferencia' && m.subtipoTransferencia === 'Externa');
      const cssTipo = esTransfExterna ? 'transferencia_externa' : m.tipo;
      let signo = '-';
      if (m.tipo === 'ingreso') signo = '+';
      else if (m.tipo === 'transferencia') signo = esTransfExterna ? '-' : '';
      else if (m.tipo === 'ajuste') signo = m.ajusteDireccion === 'positivo' ? '+' : '-';

      const detalleSecundario = [m.cuenta, m.descripcion].filter(Boolean).join(' · ');
      let subLabel;
      if (m.tipo === 'pago_tdc') {
        subLabel = `Pago TDC · ${m.cuenta || 'Cuenta'}`;
      } else if (m.tipo === 'transferencia') {
        subLabel = `${esTransfExterna ? 'Transf. Externa' : 'Transf. Interna'}${detalleSecundario ? ' · ' + detalleSecundario : ''}`;
      } else if (m.tipo === 'ajuste') {
        subLabel = `Ajuste de saldo${detalleSecundario ? ' · ' + detalleSecundario : ''}`;
      } else {
        subLabel = `${m.subtitulo}${detalleSecundario ? ' · ' + detalleSecundario : ''}`;
      }

      return `
        <div class="mov-item${m.pending ? ' pending-item' : ''}" data-mov-idx="${idx}">
          <div class="mov-icon ${cssTipo}">
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
            <div class="mov-amount ${cssTipo}">${signo}${formatearMoneda(m.monto)}</div>
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
    if (mov.tipo === 'transferencia') return mov.subtipoTransferencia === 'Externa' ? 'outbound' : 'swap_horiz';
    if (mov.tipo === 'pago_tdc') return 'credit_score';
    if (mov.tipo === 'ajuste') return 'tune';
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
    const shell = $('appView');
    const isOpen = abrir !== undefined ? abrir : !card.classList.contains('open');
    card.classList.toggle('open', isOpen);
    if (shell) shell.classList.toggle('form-open', isOpen);
    $('iconToggleForm').textContent = isOpen ? 'expand_less' : 'add_circle';
    if (isOpen) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      limpiarFormularioEdicion();
      if (window.scrollY > 0) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }

  function llenarSelect(id, lista, placeholder) {
    const sel = $(id);
    sel.innerHTML = '';
    sel.appendChild(new Option(placeholder || 'Selecciona...', ''));
    (lista || []).forEach((i) => sel.appendChild(new Option(i, i)));
    sincronizarTextoSelector(id);
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
    sincronizarTextoSelector('subcategoria');
  }

  function seleccionarCuentaPorDefecto(selectId) {
    const sel = $(selectId);
    if (!sel) return;
    const def = (datos && datos.cuentaDefault) || 'Efectivo';
    const match = Array.from(sel.options).find((o) => o.value.toLowerCase() === def.toLowerCase());
    if (match) sel.value = match.value;
    sincronizarTextoSelector(selectId);
  }

  function setSubtipoTransferencia(subtipo) {
    const val = (String(subtipo || 'Interna').toLowerCase().includes('externa')) ? 'Externa' : 'Interna';
    $('subtipoTransferencia').value = val;
    document.querySelectorAll('.subtipo-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.subtipo === val);
    });

    if ($('tipoOperacion').value === 'Transferencia') {
      const esExterna = (val === 'Externa');
      $('divDestino').classList.toggle('hidden', esExterna);
      $('lblDescripcion').innerHTML = esExterna
        ? '<span class="material-symbols-rounded">person</span> Destinatario / Descripción'
        : '<span class="material-symbols-rounded">notes</span> Descripción (opcional)';
      $('descripcion').placeholder = esExterna
        ? 'Ej. Alquiler, Juan, servicio...'
        : 'Ej. Ahorro, pago compartido, detalle...';
    }
  }

  function obtenerEmailActual() {
    const u = usuarioActual || (window.AppStorage.getSession() && window.AppStorage.getSession().user);
    return String((u && u.email) || '').trim().toLowerCase();
  }

  function cuentaDisponibleEnCliente(nombre, propietario) {
    const email = obtenerEmailActual();
    if (!email) return true;
    const n = String(nombre || '').trim().toLowerCase();
    if (n === 'efectivo') return true;
    const prop = String(propietario || '').trim().toLowerCase();
    if (prop) {
      if (prop === 'compartida') return true;
      return prop === email;
    }
    if (n.includes('tdc')) {
      if (n.includes('rois')) return email.includes('roislenabreu');
      if (n.includes('carlos')) return email.includes('cquevedoarteaga');
      if (n.includes('ciudad') && n.includes('visa')) return email.includes('roislenabreu');
      return email.includes('cquevedoarteaga');
    }
    if (n.includes('rois')) return email.includes('roislenabreu');
    if (n.includes('carlos')) return email.includes('cquevedoarteaga');
    return true;
  }

  function obtenerCuentasOrigenEgreso() {
    if (!datos) return [];
    if (datos.propietarioFiltrado) return datos.cuentas || [];
    return (datos.cuentas || []).filter((c) => cuentaDisponibleEnCliente(c));
  }

  function obtenerCuentasNoTdcPropias() {
    if (!datos) return [];
    if (datos.propietarioFiltrado) return datos.cuentasNoTdc || [];
    return (datos.cuentasNoTdc || []).filter((c) => cuentaDisponibleEnCliente(c));
  }

  function obtenerCuentasDestinoTransferencia() {
    if (!datos) return [];
    return datos.cuentasDestinoTransferencia || datos.cuentasNoTdc || [];
  }

  function obtenerTdcsPropias() {
    if (!datos) return [];
    if (datos.propietarioFiltrado) return datos.tdcs || [];
    return (datos.tdcs || []).filter((t) => cuentaDisponibleEnCliente(t));
  }

  function asegurarOpcionEnSelect(selectId, valor) {
    const sel = $(selectId);
    const val = String(valor || '').trim();
    if (!sel || !val) return;
    const existe = Array.from(sel.options).some((o) => o.value === val);
    if (!existe) sel.appendChild(new Option(val, val));
    sel.value = val;
  }

  function setTipo(tipo) {
    if (!datos) return;
    $('tipoOperacion').value = tipo;
    document.querySelectorAll('.tipo-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tipo === tipo);
    });

    const usaCategoria = (tipo === 'Egreso' || tipo === 'Ingreso');
    const esTransf = (tipo === 'Transferencia');
    $('divCat').classList.toggle('hidden', !usaCategoria);
    $('divSubtipoTransf').classList.toggle('hidden', !esTransf);
    $('divDestino').classList.toggle('hidden', usaCategoria);

    $('lblDescripcion').innerHTML = '<span class="material-symbols-rounded">notes</span> Descripción (opcional)';
    $('descripcion').placeholder = 'Ej. Supermercado, cuota, detalle...';

    if (tipo === 'Egreso') {
      $('lblSubcategoria').innerHTML = '<span class="material-symbols-rounded">category</span> Categoría / Subcategoría';
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">account_balance_wallet</span> Medio de Pago';
      llenarSubcategoriasEgreso();
      llenarSelect('medioPago', obtenerCuentasOrigenEgreso());
    } else if (tipo === 'Ingreso') {
      $('lblSubcategoria').innerHTML = '<span class="material-symbols-rounded">payments</span> Concepto de Ingreso';
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">savings</span> Cuenta Destino';
      llenarSelect('subcategoria', datos.ingresos);
      llenarSelect('medioPago', obtenerCuentasNoTdcPropias());
    } else if (tipo === 'Transferencia') {
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">output</span> Cuenta Origen';
      $('lblDestino').innerHTML = '<span class="material-symbols-rounded">input</span> Cuenta Destino';
      llenarSelect('medioPago', obtenerCuentasNoTdcPropias());
      llenarSelect('cuentaDestino', obtenerCuentasDestinoTransferencia());
      setSubtipoTransferencia($('subtipoTransferencia').value || 'Interna');
    } else if (tipo === 'Pago TDC') {
      $('lblOrigen').innerHTML = '<span class="material-symbols-rounded">account_balance</span> Cuenta que Paga';
      $('lblDestino').innerHTML = '<span class="material-symbols-rounded">credit_card</span> Tarjeta a Pagar';
      llenarSelect('medioPago', obtenerCuentasNoTdcPropias());
      llenarSelect('cuentaDestino', obtenerTdcsPropias());
    }

    if (!$('editandoRow').value) {
      seleccionarCuentaPorDefecto('medioPago');
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

  function mascaraMontoConSigno(input) {
    const raw = String(input.value || '');
    const esNeg = raw.trim().startsWith('-');
    let v = raw.replace(/[^\d,]/g, '');
    const p = v.split(',');
    p[0] = p[0].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const cuerpo = p.length > 1
      ? (p[0] === '' ? '0' : p[0]) + ',' + p.slice(1).join('').substring(0, 2)
      : p[0];
    input.value = (esNeg ? '-' : '') + cuerpo;
  }

  function parsearMontoConSigno(str) {
    const s = String(str === undefined || str === null ? '' : str).trim();
    if (!s || s === '-') return NaN;
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }

  function formatearNumeroInput(num) {
    const n = Number(num) || 0;
    const neg = n < 0 ? '-' : '';
    const absStr = Math.abs(n).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    const [ent, dec] = absStr.split('.');
    const entFmt = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return neg + entFmt + (dec ? ',' + dec : '');
  }

  function limpiarFormularioEdicion() {
    $('editandoTipo').value = '';
    $('editandoRow').value = '';
    $('subtipoTransferencia').value = 'Interna';
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
    } else if (mov.tipo === 'ajuste') {
      $('btnEditarMov').classList.add('hidden');
      $('lblBtnBorrarMov').textContent = 'Borrar Ajuste';
    } else {
      $('btnEditarMov').classList.remove('hidden');
      $('lblBtnBorrarMov').textContent = 'Borrar Movimiento';
    }

    $('modalAcciones').classList.add('active');
  }

  function ejecutarEditarMovimiento() {
    if (!movimientoSeleccionado) return;
    $('modalAcciones').classList.remove('active');

    if (movimientoSeleccionado.tipo === 'ajuste') {
      mostrarToast('Los ajustes se borran o se crean nuevos desde el menú de perfil.', 'warn');
      return;
    }

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

    $('editandoTipo').value = m.tipo;
    $('editandoRow').value = m.rowNum;
    if (tipoOpUI === 'Transferencia') {
      $('subtipoTransferencia').value = m.subtipoTransferencia || 'Interna';
    }

    setTipo(tipoOpUI);

    $('monto').value = String(m.monto).replace('.', ',');
    mascaraMonto($('monto'));
    asegurarOpcionEnSelect('medioPago', m.cuenta || '');
    actualizarCuotas();

    let descLimpia = m.descripcion || '';
    if (tipoOpUI === 'Pago TDC') {
      asegurarOpcionEnSelect('cuentaDestino', m.titulo || '');
      const prefijo = 'Pago de tarjeta: ' + (m.titulo || '');
      if (descLimpia.startsWith(prefijo)) {
        descLimpia = descLimpia.slice(prefijo.length).trim();
      }
    } else if (tipoOpUI === 'Transferencia') {
      const subtipo = m.subtipoTransferencia || 'Interna';
      setSubtipoTransferencia(subtipo);
      if (subtipo === 'Interna') {
        const cuentas = obtenerCuentasDestinoTransferencia();
        const matchCuenta = cuentas.find((c) => descLimpia.startsWith('A: ' + c));
        if (matchCuenta) {
          asegurarOpcionEnSelect('cuentaDestino', matchCuenta);
          descLimpia = descLimpia.slice(('A: ' + matchCuenta).length).trim();
        }
      }
    }

    $('descripcion').value = descLimpia;
    $('fecha').value = m.fechaIso || fechaTsAIso(m.fechaTs);

    if (tipoOpUI === 'Egreso' || tipoOpUI === 'Ingreso') {
      $('subcategoria').value = m.titulo || '';
    }

    sincronizarTodosLosSelectores();
    editandoFingerprint = { monto: m.monto, titulo: m.titulo };

    $('formTitleText').textContent = 'Editar Operación';
    $('formTitleIcon').textContent = 'edit';
    $('submitBtnText').textContent = 'ACTUALIZAR OPERACIÓN';
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

    const subtipoTransf = (tipo === 'Transferencia') ? ($('subtipoTransferencia').value || 'Interna') : '';
    const esTransfInterna = (tipo === 'Transferencia' && subtipoTransf === 'Interna');

    if ((esTransfInterna || tipo === 'Pago TDC') && !$('cuentaDestino').value) {
      mostrarMensajeForm(tipo === 'Pago TDC' ? 'Elegí la tarjeta a pagar.' : 'Elegí la cuenta destino.', 'error');
      return;
    }
    if (esTransfInterna && $('cuentaDestino').value === $('medioPago').value) {
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
    const usaDestino = (esTransfInterna || tipo === 'Pago TDC');

    const payload = {
      clientId: generarClientId(),
      tipoOperacion: tipo,
      subtipoTransferencia: subtipoTransf,
      fecha: $('fecha').value,
      subcategoria: usaCategoria ? selSub.value : '',
      categoriaPadre: (tipo === 'Egreso' && opt) ? (opt.getAttribute('data-padre') || '') : '',
      medioPago: $('medioPago').value,
      cuentaDestino: usaDestino ? $('cuentaDestino').value : '',
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
  // MENÚ DE PERFIL: CUENTAS, SALDO INICIAL Y AJUSTE DE SALDO
  // ==========================================================================

  function obtenerSufijoUsuario() {
    const email = ((usuarioActual && usuarioActual.email) || '').toLowerCase();
    if (email.includes('roislenabreu')) return '(Rois)';
    if (email.includes('cquevedoarteaga')) return '(Carlos)';
    return '';
  }

  function previsualizarNombreCuenta(nombreBase) {
    const limpio = String(nombreBase || '').trim().replace(/\s+/g, ' ');
    if (!limpio) return '';
    if (limpio.toLowerCase() === 'efectivo') return 'Efectivo';
    const sufijo = obtenerSufijoUsuario();
    if (!sufijo) return limpio;
    if (limpio.toLowerCase().endsWith(sufijo.toLowerCase())) return limpio;
    return `${limpio} ${sufijo}`;
  }

  function obtenerCuentasConfig() {
    if (datos && datos.dashboard && Array.isArray(datos.dashboard.cuentasConfig)) {
      if (datos.propietarioFiltrado) return datos.dashboard.cuentasConfig;
      return datos.dashboard.cuentasConfig.filter((c) => cuentaDisponibleEnCliente(c.cuenta, c.propietario));
    }
    return obtenerCuentasNoTdcPropias().map((nombre) => ({
      cuenta: nombre,
      saldoInicial: 0,
      saldo: 0,
      esCompartida: nombre.toLowerCase() === 'efectivo',
      esDefault: nombre.toLowerCase() === 'efectivo'
    }));
  }

  function abrirModalPerfil() {
    const user = usuarioActual || (window.AppStorage.getSession() && window.AppStorage.getSession().user);
    if (user) {
      const av = $('perfilAvatar');
      if (user.picture) {
        av.innerHTML = `<img src="${escapeHtml(user.picture)}" alt="${escapeHtml(user.name || '')}" referrerpolicy="no-referrer">`;
      } else {
        av.textContent = (user.name || user.email || 'U').charAt(0).toUpperCase();
      }
      $('perfilNombre').textContent = user.name || user.email || 'Usuario';
      $('perfilEmail').textContent = user.email || '';
    }

    const sufijo = obtenerSufijoUsuario();
    const tagEl = $('perfilTagInfo');
    if (sufijo) {
      tagEl.textContent = `Mostrando tus cuentas ${sufijo} y Efectivo (compartido). Las nuevas cuentas llevarán ${sufijo} y quedarán asociadas a tu correo.`;
      tagEl.classList.remove('hidden');
    } else {
      tagEl.classList.add('hidden');
    }

    $('formNuevaCuenta').classList.add('hidden');
    renderListaCuentasPerfil();
    $('modalPerfil').classList.add('active');
  }

  function renderListaCuentasPerfil() {
    const cont = $('listaCuentasPerfil');
    const cuentas = obtenerCuentasConfig();
    $('lblCantidadCuentas').textContent = `${cuentas.length} cuenta${cuentas.length === 1 ? '' : 's'}`;

    if (!cuentas.length) {
      cont.innerHTML = '<div class="empty-state">No hay cuentas configuradas todavía.</div>';
      return;
    }

    cont.innerHTML = cuentas.map((c) => {
      const esNeg = (Number(c.saldo) || 0) < 0;
      const badgeHtml = c.esDefault
        ? '<span class="badge-default">Compartida</span>'
        : (c.esCompartida ? '<span class="badge-default">Compartida</span>' : '');
      return `
        <div class="account-card">
          <div class="account-card-top">
            <div class="account-name-wrap">
              <span class="account-name">${escapeHtml(c.cuenta)}</span>
              ${badgeHtml}
            </div>
            <span class="account-balance${esNeg ? ' negative' : ''}">${formatearMoneda(c.saldo)}</span>
          </div>
          <div class="account-card-bottom">
            <span class="account-init-meta">Inicial: ${formatearMoneda(c.saldoInicial)}</span>
            <div class="account-card-btns">
              <button type="button" class="mini-pill-btn" data-edit-init="${escapeHtml(c.cuenta)}">
                <span class="material-symbols-rounded">edit</span> Inicial
              </button>
              <button type="button" class="mini-pill-btn warn" data-adjust-acc="${escapeHtml(c.cuenta)}">
                <span class="material-symbols-rounded">tune</span> Ajustar
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function actualizarPreviewNombreCuenta() {
    const val = $('nuevaCuentaNombre').value;
    const prev = previsualizarNombreCuenta(val);
    const hint = $('previewNombreCuenta');
    if (prev) {
      hint.textContent = `Se guardará como: ${prev}`;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  }

  async function manejarSubmitNuevaCuenta(e) {
    e.preventDefault();
    if (!navigator.onLine) {
      mostrarToast('Necesitás conexión para agregar una cuenta.', 'warn');
      return;
    }

    const nombre = $('nuevaCuentaNombre').value.trim();
    if (!nombre) {
      mostrarToast('Ingresá el nombre de la cuenta.', 'error');
      return;
    }
    const saldoStr = $('nuevaCuentaSaldo').value.trim() || '0';
    const saldoNum = parsearMontoConSigno(saldoStr);
    if (!isFinite(saldoNum)) {
      mostrarToast('Ingresá un saldo inicial válido.', 'error');
      return;
    }

    const btn = $('btnGuardarNuevaCuenta');
    btn.disabled = true;
    btn.textContent = 'Creando...';

    try {
      const res = await window.AppApi.addAccount({ nombre, saldoInicial: saldoStr });
      mostrarToast(res.message || 'Cuenta creada.', 'success');
      $('nuevaCuentaNombre').value = '';
      $('nuevaCuentaSaldo').value = '0';
      $('previewNombreCuenta').classList.add('hidden');
      $('formNuevaCuenta').classList.add('hidden');
      if (res.datos) {
        lastSyncAt = Date.now();
        aplicarDatos(res.datos);
        actualizarTextoSync();
      }
      renderListaCuentasPerfil();
    } catch (err) {
      if (manejarErrorAuth(err)) return;
      mostrarToast(err.message || 'No se pudo crear la cuenta.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear cuenta';
    }
  }

  function abrirModalSaldoInicial(cuentaNombre) {
    const cuentas = obtenerCuentasConfig();
    const cta = cuentas.find((c) => c.cuenta === cuentaNombre);
    if (!cta) return;

    $('editSaldoInicialCuenta').value = cta.cuenta;
    $('lblCuentaSaldoInicial').textContent = `Cuenta: ${cta.cuenta}`;
    $('inputSaldoInicial').value = formatearNumeroInput(cta.saldoInicial || 0);
    $('modalSaldoInicial').classList.add('active');
    setTimeout(() => $('inputSaldoInicial').focus(), 120);
  }

  async function manejarSubmitSaldoInicial(e) {
    e.preventDefault();
    if (!navigator.onLine) {
      mostrarToast('Necesitás conexión para actualizar el saldo inicial.', 'warn');
      return;
    }

    const cuenta = $('editSaldoInicialCuenta').value;
    const saldoStr = $('inputSaldoInicial').value.trim() || '0';
    const saldoNum = parsearMontoConSigno(saldoStr);
    if (!isFinite(saldoNum)) {
      mostrarToast('Ingresá un monto válido.', 'error');
      return;
    }

    const btn = $('btnGuardarSaldoInicial');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const res = await window.AppApi.updateInitialBalance({ cuenta, saldoInicial: saldoStr });
      mostrarToast(res.message || 'Saldo inicial actualizado.', 'success');
      $('modalSaldoInicial').classList.remove('active');
      if (res.datos) {
        lastSyncAt = Date.now();
        aplicarDatos(res.datos);
        actualizarTextoSync();
      }
      renderListaCuentasPerfil();
    } catch (err) {
      if (manejarErrorAuth(err)) return;
      mostrarToast(err.message || 'No se pudo actualizar el saldo inicial.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
  }

  function abrirModalAjusteSaldo(cuentaPreseleccionada) {
    const cuentas = obtenerCuentasConfig();
    if (!cuentas.length) {
      mostrarToast('Primero agregá una cuenta.', 'warn');
      return;
    }

    const sel = $('ajusteCuenta');
    sel.innerHTML = '';
    cuentas.forEach((c) => sel.appendChild(new Option(c.cuenta, c.cuenta)));
    if (cuentaPreseleccionada && cuentas.some((c) => c.cuenta === cuentaPreseleccionada)) {
      sel.value = cuentaPreseleccionada;
    }

    sincronizarTextoSelector('ajusteCuenta');
    $('ajusteSaldoReal').value = '';
    $('ajusteDescripcion').value = '';
    actualizarInfoAjusteSaldo();
    $('modalAjusteSaldo').classList.add('active');
    setTimeout(() => $('ajusteSaldoReal').focus(), 120);
  }

  function actualizarInfoAjusteSaldo() {
    const cuenta = $('ajusteCuenta').value;
    const cta = obtenerCuentasConfig().find((c) => c.cuenta === cuenta);
    const saldoActual = cta ? (Number(cta.saldo) || 0) : 0;
    $('ajusteSaldoActualVal').textContent = formatearMoneda(saldoActual);
    actualizarPreviewAjuste();
  }

  function actualizarPreviewAjuste() {
    const prevEl = $('ajusteDiffPreview');
    const cuenta = $('ajusteCuenta').value;
    const cta = obtenerCuentasConfig().find((c) => c.cuenta === cuenta);
    const saldoActual = cta ? (Number(cta.saldo) || 0) : 0;
    const raw = $('ajusteSaldoReal').value.trim();

    if (!raw || raw === '-') {
      prevEl.classList.add('hidden');
      return;
    }
    const saldoReal = parsearMontoConSigno(raw);
    if (!isFinite(saldoReal)) {
      prevEl.classList.add('hidden');
      return;
    }

    const diff = Math.round((saldoReal - saldoActual) * 100) / 100;
    prevEl.classList.remove('hidden', 'pos', 'neg', 'zero');
    if (Math.abs(diff) < 0.01) {
      prevEl.classList.add('zero');
      prevEl.textContent = 'El saldo ya coincide, no hace falta registrar ajuste.';
    } else if (diff > 0) {
      prevEl.classList.add('pos');
      prevEl.textContent = `Ajuste positivo: +${formatearMoneda(diff)} (se registra en Ingresos, excluido del resumen mensual).`;
    } else {
      prevEl.classList.add('neg');
      prevEl.textContent = `Ajuste negativo: -${formatearMoneda(Math.abs(diff))} (se registra en Egresos, excluido del resumen mensual).`;
    }
  }

  async function manejarSubmitAjusteSaldo(e) {
    e.preventDefault();
    if (!navigator.onLine) {
      mostrarToast('Necesitás conexión para realizar un ajuste de saldo.', 'warn');
      return;
    }

    const cuenta = $('ajusteCuenta').value;
    const saldoRealStr = $('ajusteSaldoReal').value.trim();
    const saldoReal = parsearMontoConSigno(saldoRealStr);
    if (!cuenta || !isFinite(saldoReal)) {
      mostrarToast('Ingresá el saldo real actual de la cuenta.', 'error');
      return;
    }

    const btn = $('btnAplicarAjuste');
    btn.disabled = true;
    btn.textContent = 'Aplicando...';

    try {
      const res = await window.AppApi.adjustBalance({
        cuenta,
        saldoReal: saldoRealStr,
        descripcion: $('ajusteDescripcion').value.trim(),
        fecha: hoyLocal()
      });
      mostrarToast(res.message || 'Saldo ajustado.', 'success');
      $('modalAjusteSaldo').classList.remove('active');
      if (res.datos) {
        lastSyncAt = Date.now();
        aplicarDatos(res.datos);
        actualizarTextoSync();
      }
      renderListaCuentasPerfil();
    } catch (err) {
      if (manejarErrorAuth(err)) return;
      mostrarToast(err.message || 'No se pudo aplicar el ajuste.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Aplicar ajuste';
    }
  }

  // ==========================================================================
  // SELECTORES PERSONALIZADOS (BOTTOM SHEET MATERIAL 3)
  // ==========================================================================

  const SELECT_BUTTON_MAP = {
    subcategoria: 'btnSelectSubcategoria',
    medioPago: 'btnSelectMedioPago',
    cuentaDestino: 'btnSelectCuentaDestino',
    ajusteCuenta: 'btnSelectAjusteCuenta',
    filterMes: 'btnSelectFilterMes',
    filterTipo: 'btnSelectFilterTipo',
    filterCuenta: 'btnSelectFilterCuenta'
  };

  function iconoPorCategoria(catNombre) {
    const cat = String(catNombre || '').toLowerCase();
    if (cat.includes('alimento')) return 'restaurant';
    if (cat.includes('transporte')) return 'directions_bus';
    if (cat.includes('vivienda')) return 'home';
    if (cat.includes('servicio')) return 'receipt_long';
    if (cat.includes('salud')) return 'medical_services';
    if (cat.includes('ocio')) return 'sports_esports';
    if (cat.includes('indumentaria')) return 'checkroom';
    if (cat.includes('educaci')) return 'school';
    if (cat.includes('divisa')) return 'currency_exchange';
    return 'category';
  }

  function iconoPorCuenta(nombreCuenta) {
    const n = String(nombreCuenta || '').toLowerCase();
    if (!n) return 'all_inclusive';
    if (n.includes('tdc') || n.includes('visa') || n.includes('mastercard')) return 'credit_card';
    if (n === 'efectivo') return 'payments';
    if (n.includes('mp') || n.includes('mercado')) return 'account_balance_wallet';
    return 'account_balance';
  }

  function obtenerTituloSelector(selectId) {
    const tipo = $('tipoOperacion') ? $('tipoOperacion').value : 'Egreso';
    if (selectId === 'subcategoria') {
      return tipo === 'Ingreso' ? 'Concepto de Ingreso' : 'Categoría / Subcategoría';
    }
    if (selectId === 'medioPago') {
      if (tipo === 'Ingreso') return 'Cuenta Destino';
      if (tipo === 'Transferencia') return 'Cuenta Origen';
      if (tipo === 'Pago TDC') return 'Cuenta que Paga';
      return 'Medio de Pago';
    }
    if (selectId === 'cuentaDestino') {
      return tipo === 'Pago TDC' ? 'Tarjeta a Pagar' : 'Cuenta Destino';
    }
    if (selectId === 'ajusteCuenta') return 'Seleccionar Cuenta';
    if (selectId === 'filterMes') return 'Filtrar por Mes';
    if (selectId === 'filterTipo') return 'Filtrar por Tipo';
    if (selectId === 'filterCuenta') return 'Filtrar por Cuenta';
    return 'Seleccionar';
  }

  function sincronizarTextoSelector(selectId) {
    const sel = $(selectId);
    const btnId = SELECT_BUTTON_MAP[selectId];
    const btn = btnId ? $(btnId) : null;
    if (!sel || !btn) return;

    const textEl = btn.querySelector('.custom-select-text');
    const opt = sel.options[sel.selectedIndex];
    const label = opt ? opt.textContent : 'Selecciona...';
    const esVacio = !sel.value;

    if (selectId === 'subcategoria' && opt && opt.getAttribute('data-padre') && !esVacio) {
      textEl.textContent = `${opt.getAttribute('data-padre')} · ${label}`;
    } else {
      textEl.textContent = label;
    }

    if (btn.classList.contains('custom-select-btn')) {
      btn.classList.toggle('placeholder', esVacio);
    }
  }

  function sincronizarTodosLosSelectores() {
    Object.keys(SELECT_BUTTON_MAP).forEach((id) => sincronizarTextoSelector(id));
  }

  function esSelectorDeCuentas(selectId) {
    return selectId === 'medioPago' || selectId === 'cuentaDestino' || selectId === 'ajusteCuenta' || selectId === 'filterCuenta';
  }

  function abrirSelectorPersonalizado(selectId) {
    const sel = $(selectId);
    if (!sel) return;

    pickerSelectActivoId = selectId;
    $('pickerTitle').textContent = obtenerTituloSelector(selectId);

    const esFiltro = selectId.startsWith('filter');
    const cuentasMap = new Map(
      obtenerCuentasConfig().map((c) => [c.cuenta.toLowerCase(), c])
    );

    const items = [];
    let optIdxCounter = 0;
    Array.from(sel.children).forEach((child) => {
      if (child.tagName === 'OPTGROUP') {
        const groupLabel = child.label || '';
        Array.from(child.children).forEach((opt) => {
          const myIndex = optIdxCounter++;
          if (!opt.value && !esFiltro) return;
          items.push({
            optIndex: myIndex,
            group: groupLabel,
            value: opt.value,
            label: opt.textContent,
            padre: opt.getAttribute('data-padre') || groupLabel,
            icon: iconoPorCategoria(groupLabel),
            saldo: null
          });
        });
      } else if (child.tagName === 'OPTION') {
        const myIndex = optIdxCounter++;
        if (!child.value && !esFiltro) return;
        let icon = 'check_circle';
        let saldo = null;
        let sub = '';

        if (esSelectorDeCuentas(selectId)) {
          icon = iconoPorCuenta(child.value);
          const cta = cuentasMap.get(String(child.value || '').toLowerCase());
          if (cta) {
            saldo = cta.saldo;
            if (cta.esDefault) sub = 'Cuenta por defecto';
          }
        } else if (selectId === 'subcategoria') {
          icon = 'payments';
        } else if (selectId === 'filterMes') {
          icon = child.value ? 'calendar_month' : 'date_range';
        } else if (selectId === 'filterTipo') {
          if (child.value === 'egreso') icon = 'shopping_bag';
          else if (child.value === 'ingreso') icon = 'arrow_downward';
          else if (child.value === 'transferencia_externa') icon = 'outbound';
          else if (child.value.startsWith('transferencia')) icon = 'swap_horiz';
          else if (child.value === 'pago_tdc') icon = 'credit_score';
          else if (child.value === 'ajuste') icon = 'tune';
          else icon = 'filter_list';
        }

        items.push({
          optIndex: myIndex,
          group: '',
          value: child.value,
          label: child.textContent,
          padre: '',
          icon,
          sub,
          saldo
        });
      }
    });

    pickerOpcionesCache = items;

    const searchWrap = $('pickerSearchWrap');
    const searchInput = $('pickerSearchInput');
    searchInput.value = '';
    const mostrarBusqueda = items.length > 6;
    searchWrap.classList.toggle('hidden', !mostrarBusqueda);

    renderOpcionesSelector('');
    $('modalSelector').classList.add('active');
  }

  function renderOpcionesSelector(filtroTexto) {
    const cont = $('pickerOptionsList');
    const sel = pickerSelectActivoId ? $(pickerSelectActivoId) : null;
    const idxActual = sel ? sel.selectedIndex : -1;
    const q = String(filtroTexto || '').trim().toLowerCase();

    const filtrados = q
      ? pickerOpcionesCache.filter((it) =>
        `${it.label} ${it.group} ${it.sub || ''}`.toLowerCase().includes(q)
      )
      : pickerOpcionesCache;

    if (!filtrados.length) {
      cont.innerHTML = '<div class="empty-state">No se encontraron opciones.</div>';
      return;
    }

    let ultimoGrupo = null;
    const html = [];

    filtrados.forEach((it) => {
      if (it.group && it.group !== ultimoGrupo) {
        ultimoGrupo = it.group;
        html.push(`
          <div class="picker-group-label">
            <span class="material-symbols-rounded">${iconoPorCategoria(it.group)}</span>
            <span>${escapeHtml(it.group)}</span>
          </div>
        `);
      }

      const seleccionado = (it.optIndex === idxActual);
      const saldoHtml = (it.saldo !== null && it.saldo !== undefined)
        ? `<span class="picker-opt-bal${Number(it.saldo) < 0 ? ' neg' : ''}">${formatearMoneda(it.saldo)}</span>`
        : '';

      html.push(`
        <button type="button" class="picker-option${seleccionado ? ' selected' : ''}" data-pick-idx="${it.optIndex}">
          <div class="picker-opt-left">
            <div class="picker-opt-ico">
              <span class="material-symbols-rounded">${escapeHtml(it.icon)}</span>
            </div>
            <div class="picker-opt-text">
              <div class="picker-opt-title">${escapeHtml(it.label)}</div>
              ${it.sub ? `<div class="picker-opt-sub">${escapeHtml(it.sub)}</div>` : ''}
            </div>
          </div>
          <div class="picker-opt-right">
            ${saldoHtml}
            ${seleccionado ? '<span class="material-symbols-rounded picker-opt-check">check_circle</span>' : ''}
          </div>
        </button>
      `);
    });

    cont.innerHTML = html.join('');
  }

  function seleccionarOpcionPicker(optIndex) {
    if (!pickerSelectActivoId) return;
    const sel = $(pickerSelectActivoId);
    if (sel && optIndex >= 0 && optIndex < sel.options.length) {
      sel.selectedIndex = optIndex;
      sincronizarTextoSelector(pickerSelectActivoId);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    $('modalSelector').classList.remove('active');
    pickerSelectActivoId = null;
  }

  // ==========================================================================
  // EVENTOS UI
  // ==========================================================================

  function registrarEventosUI() {
    document.querySelectorAll('[data-select-for]').forEach((btn) => {
      btn.addEventListener('click', () => {
        abrirSelectorPersonalizado(btn.getAttribute('data-select-for'));
      });
    });
    $('pickerSearchInput').addEventListener('input', (e) => {
      renderOpcionesSelector(e.target.value);
    });
    $('pickerOptionsList').addEventListener('click', (e) => {
      const optBtn = e.target.closest('.picker-option[data-pick-idx]');
      if (!optBtn) return;
      seleccionarOpcionPicker(Number(optBtn.getAttribute('data-pick-idx')));
    });

    $('btnProfileMenu').addEventListener('click', abrirModalPerfil);
    $('btnToggleNuevaCuenta').addEventListener('click', () => {
      const form = $('formNuevaCuenta');
      const abrir = form.classList.contains('hidden');
      form.classList.toggle('hidden', !abrir);
      if (abrir) {
        $('nuevaCuentaNombre').focus();
      }
    });
    $('btnCancelarNuevaCuenta').addEventListener('click', () => {
      $('formNuevaCuenta').classList.add('hidden');
    });
    $('nuevaCuentaNombre').addEventListener('input', actualizarPreviewNombreCuenta);
    $('nuevaCuentaSaldo').addEventListener('input', (e) => mascaraMontoConSigno(e.target));
    $('formNuevaCuenta').addEventListener('submit', manejarSubmitNuevaCuenta);

    $('listaCuentasPerfil').addEventListener('click', (e) => {
      const btnInit = e.target.closest('[data-edit-init]');
      if (btnInit) {
        abrirModalSaldoInicial(btnInit.getAttribute('data-edit-init'));
        return;
      }
      const btnAdj = e.target.closest('[data-adjust-acc]');
      if (btnAdj) {
        abrirModalAjusteSaldo(btnAdj.getAttribute('data-adjust-acc'));
      }
    });

    $('btnAbrirAjusteRapido').addEventListener('click', () => abrirModalAjusteSaldo());
    $('inputSaldoInicial').addEventListener('input', (e) => mascaraMontoConSigno(e.target));
    $('formSaldoInicial').addEventListener('submit', manejarSubmitSaldoInicial);

    $('ajusteCuenta').addEventListener('change', actualizarInfoAjusteSaldo);
    $('ajusteSaldoReal').addEventListener('input', (e) => {
      mascaraMontoConSigno(e.target);
      actualizarPreviewAjuste();
    });
    $('formAjusteSaldo').addEventListener('submit', manejarSubmitAjusteSaldo);

    $('btnTheme').addEventListener('click', rotarTema);
    $('btnThemeAuth').addEventListener('click', rotarTema);
    $('btnSync').addEventListener('click', () => sincronizarTodo({ silencioso: false }));
    $('btnSyncQueue').addEventListener('click', () => sincronizarTodo({ silencioso: false }));
    $('btnLogout').addEventListener('click', abrirConfirmacionLogout);

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
        if ($('modalPerfil').classList.contains('active')) renderListaCuentasPerfil();
      }
    });

    $('btnToggleForm').addEventListener('click', () => toggleFormulario());
    $('btnCloseForm').addEventListener('click', () => toggleFormulario(false));

    document.querySelectorAll('.tipo-btn').forEach((btn) => {
      btn.addEventListener('click', () => setTipo(btn.dataset.tipo));
    });

    document.querySelectorAll('.subtipo-btn').forEach((btn) => {
      btn.addEventListener('click', () => setSubtipoTransferencia(btn.dataset.subtipo));
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
      sincronizarTextoSelector('filterMes');
      sincronizarTextoSelector('filterTipo');
      sincronizarTextoSelector('filterCuenta');
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
    $('btnConfirmarLogoutFinal').addEventListener('click', cerrarSesion);
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
