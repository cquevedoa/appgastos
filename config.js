/**
 * Configuración de la PWA Control Financiero.
 * Completá APPS_SCRIPT_URL y GOOGLE_CLIENT_ID antes de publicar.
 */
window.APP_CONFIG = {
  // URL de la Web App desplegada desde Google Apps Script (/exec)
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbxDNzl_J6WR7SKOI3fiXuXchvahnmAKAcWT-Uky9G69e7scsjEedgOyD_FiKSjV_d5iAw/exec',

  // Client ID de OAuth 2.0 (Google Cloud Console -> Credenciales -> Aplicación web)
  // Debe coincidir exactamente con GOOGLE_CLIENT_ID en Código.js
  GOOGLE_CLIENT_ID: '721505803145-4q3dh55m2ocmket3id29u5oupv9fhk9f.apps.googleusercontent.com',

  APP_NAME: 'Control Financiero',
  REQUEST_TIMEOUT_MS: 20000
};
