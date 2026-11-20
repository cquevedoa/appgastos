/**
 * Persistencia local (sesión, caché de datos, cola offline y preferencias).
 */
window.AppStorage = (() => {
  const KEYS = {
    SESSION: 'appgastos_session_v1',
    DATA: 'appgastos_data_v1',
    QUEUE: 'appgastos_offline_queue_v1',
    PREFS: 'appgastos_prefs_v1'
  };

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('No se pudo guardar en localStorage:', err);
    }
  }

  return {
    // --- Sesión ---
    getSession() {
      const s = readJson(KEYS.SESSION, null);
      if (!s || !s.sessionToken) return null;
      if (s.expiresAt && Date.now() >= Number(s.expiresAt)) {
        this.clearSession();
        return null;
      }
      return s;
    },
    saveSession(session) {
      writeJson(KEYS.SESSION, session);
    },
    clearSession() {
      localStorage.removeItem(KEYS.SESSION);
    },

    // --- Caché de datos del Google Sheet ---
    getCachedData() {
      return readJson(KEYS.DATA, null);
    },
    saveCachedData(datos) {
      writeJson(KEYS.DATA, {
        datos,
        lastSyncAt: Date.now()
      });
    },
    clearCachedData() {
      localStorage.removeItem(KEYS.DATA);
    },

    // --- Cola offline de operaciones pendientes ---
    getQueue() {
      const q = readJson(KEYS.QUEUE, []);
      return Array.isArray(q) ? q : [];
    },
    saveQueue(queue) {
      writeJson(KEYS.QUEUE, queue);
    },
    enqueueTransaction(txPayload) {
      const queue = this.getQueue();
      const item = {
        clientId: txPayload.clientId,
        createdAt: Date.now(),
        payload: txPayload
      };
      queue.push(item);
      this.saveQueue(queue);
      return item;
    },
    removeFromQueue(clientId) {
      const queue = this.getQueue().filter((item) => item.clientId !== clientId);
      this.saveQueue(queue);
      return queue;
    },
    clearQueue() {
      localStorage.removeItem(KEYS.QUEUE);
    },

    // --- Preferencias de usuario (tema, privacidad) ---
    getPrefs() {
      return Object.assign(
        { theme: 'auto', oculto: false },
        readJson(KEYS.PREFS, {})
      );
    },
    savePrefs(patch) {
      const next = Object.assign(this.getPrefs(), patch);
      writeJson(KEYS.PREFS, next);
      return next;
    }
  };
})();
