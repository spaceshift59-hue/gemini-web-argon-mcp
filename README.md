# MCP Server: Gemini Web (Gemini 4 Argon / Gemini Advanced)

Servidor MCP independiente que permite a agentes de IA (Antigravity, Claude Desktop, Cursor, etc.) interactuar directamente con tu sesión activa de **Gemini Web** (`https://gemini.google.com/app`) mediante Chrome DevTools Protocol (CDP), aprovechando el modelo **Gemini 4 Argon** sin necesidad de API keys de pago.

---

## 🔒 Privacidad y Seguridad

* **Sin credenciales almacenadas:** Este servidor **no** almacena cookies, tokens ni contraseñas.
* **Sesión local independiente:** Cada usuario que ejecute el servidor utiliza su propio navegador Chrome local y su propia cuenta de Google mediante un perfil aislado (`%LOCALAPPDATA%\Google\Chrome\GeminiProfile`).
* **Seguro para repositorios públicos:** Esta carpeta no contiene datos personales ni rutas privadas.

---

## 🚀 Requisitos

1. **Google Chrome** instalado.
2. **Node.js** v18+ (recomendado v20+ o v24+, utiliza `fetch` y `WebSocket` nativos, sin necesidad de ejecutar `npm install`).
3. Una cuenta de Google con acceso a Gemini Web.

---

## 🛠️ Configuración e Instalación

### 1. Iniciar Google Chrome con depuración remota

Ejecuta el script incluido:
```cmd
iniciar_chrome_gemini.bat
```
*(O en Linux/macOS, inicia Chrome con los flags: `--remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="<ruta_perfil_dedicado>" https://gemini.google.com/app`)*

* En la ventana de Chrome que se abrirá, inicia sesión con tu cuenta de Google en `gemini.google.com`.
* Deja esa ventana abierta en segundo plano.

---

### 2. Registrar el Servidor en tu Cliente MCP

Agrega la siguiente configuración a tu archivo de configuración MCP (por ejemplo `~/.gemini/config/mcp_config.json` en Antigravity o `claude_desktop_config.json` en Claude Desktop):

```json
{
  "mcpServers": {
    "gemini-web-argon": {
      "command": "node",
      "args": [
        "ruta/a/mcp_gemini_argon/server.js"
      ]
    }
  }
}
```

> **Nota:** Reemplaza `"ruta/a/mcp_gemini_argon/server.js"` con la ruta absoluta donde clonaste este repositorio en tu equipo.

---

## 🧰 Herramientas Expuestas

* **`gemini_web_ask`**: Envía una consulta o instrucción a Gemini Web (Gemini Argon), espera a que el modelo razone y finalice la generación, y devuelve el texto completo de la respuesta al agente.
