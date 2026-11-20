/**
 * Cliente HTTP para la API REST de Google Apps Script (doPost).
 * Usa Content-Type: text/plain;charset=utf-8 para evitar preflight CORS en Apps Script.
 */
window.AppApi = (() => {
  function getConfig() {
    return window.APP_CONFIG || {};
  }

  function isConfigured() {
    const cfg = getConfig();
    return Boolean(
      cfg.APPS_SCRIPT_URL &&
      !cfg.APPS_SCRIPT_URL.includes('TU_DEPLOYMENT_ID') &&
      cfg.GOOGLE_CLIENT_ID &&
      !cfg.GOOGLE_CLIENT_ID.includes('TU_CLIENT_ID')
    );
  }

  async function post(action, payload = {}, requireAuth = true) {
    const cfg = getConfig();
    if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.includes('TU_DEPLOYMENT_ID')) {
      const err = new Error('Falta configurar APPS_SCRIPT_URL en pwa/config.js.');
      err.code = 'NOT_CONFIGURED';
      throw err;
    }

    const session = window.AppStorage.getSession();
    if (requireAuth && !session) {
      const err = new Error('Sesión expirada. Volvé a iniciar sesión.');
      err.code = 'UNAUTHORIZED';
      throw err;
    }

    const controller = new AbortController();
    const timeoutMs = cfg.REQUEST_TIMEOUT_MS || 20000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(cfg.APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action,
          token: requireAuth && session ? session.sessionToken : '',
          payload
        }),
        signal: controller.signal
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        const err = new Error('La respuesta del servidor no es JSON válido. Verificá que el despliegue de Apps Script permita acceso a "Cualquier persona".');
        err.code = 'BAD_RESPONSE';
        throw err;
      }

      if (data && data.success === false) {
        const authCodes = ['UNAUTHORIZED', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'FORBIDDEN_EMAIL'];
        if (authCodes.includes(data.code)) {
          window.AppStorage.clearSession();
        }
        const err = new Error(data.message || 'Error en el servidor.');
        err.code = data.code || 'API_ERROR';
        err.data = data;
        throw err;
      }

      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error('Tiempo de espera agotado al conectar con Google Sheets.');
        timeoutErr.code = 'NETWORK_ERROR';
        throw timeoutErr;
      }
      if (err instanceof TypeError) {
        const netErr = new Error('Sin conexión con el servidor.');
        netErr.code = 'NETWORK_ERROR';
        throw netErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isConfigured,

    async loginWithGoogle(idToken) {
      const res = await post('login', { idToken }, false);
      window.AppStorage.saveSession({
        sessionToken: res.sessionToken,
        expiresAt: res.expiresAt,
        user: res.user
      });
      if (res.datos) {
        window.AppStorage.saveCachedData(res.datos);
      }
      return res;
    },

    async getInitialData() {
      const res = await post('getInitialData', {}, true);
      if (res.datos) {
        window.AppStorage.saveCachedData(res.datos);
      }
      return res;
    },

    async getAccountBalances() {
      return post('getAccountBalances', {}, true);
    },

    async saveTransaction(payload) {
      const res = await post('saveTransaction', payload, true);
      return res;
    },

    async deleteTransaction(tipo, rowNum, fingerprint) {
      const res = await post('deleteTransaction', { tipo, rowNum, fingerprint }, true);
      return res;
    }
  };
})();
