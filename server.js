import readline from 'node:readline';

const CDP_PORT = 9222;
let sessionArgonPromptCount = 0;

function logDebug(...args) {
  process.stderr.write(`[gemini-web-mcp] ${args.join(' ')}\n`);
}

async function sendCdpCommand(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for CDP response for ${method}`));
    }, 45000);

    const onMessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          cleanup();
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) {
        // ignore other events
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
    };

    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function getOrCreateGeminiPageWs() {
  let targetsRes;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    targetsRes = await res.json();
  } catch (err) {
    throw new Error(
      `No se pudo conectar a Google Chrome en el puerto ${CDP_PORT}.\n` +
      `Asegúrate de haber abierto Google Chrome ejecutando iniciar_chrome_gemini.bat`
    );
  }

  let geminiTarget = targetsRes.find(
    (t) => t.type === 'page' && t.url && t.url.includes('gemini.google.com')
  );

  if (!geminiTarget) {
    logDebug('Creando nueva pestaña para gemini.google.com...');
    const newTabRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?https://gemini.google.com/app`, {
      method: 'PUT',
    });
    geminiTarget = await newTabRes.json();
    await new Promise((r) => setTimeout(r, 4000));
  }

  const ws = new WebSocket(geminiTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error('Fallo al conectar WebSocket con la pestaña'));
  });

  return ws;
}

export async function askGeminiWeb(prompt) {
  const ws = await getOrCreateGeminiPageWs();
  try {
    await sendCdpCommand(ws, 'Runtime.enable');
    await sendCdpCommand(ws, 'Page.enable');

    logDebug('Navegando o verificando URL de Gemini...');
    const checkState = await sendCdpCommand(ws, 'Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true,
    });
    
    if (!checkState.result.value.includes('gemini.google.com')) {
      await sendCdpCommand(ws, 'Page.navigate', { url: 'https://gemini.google.com/app' });
      await new Promise((r) => setTimeout(r, 5000));
    }

    logDebug('Verificando y asegurando modelo Gemini 4 Argon...');
    const modelSwitchCode = `
      (async function() {
        // 1. Localizar el selector de modo
        const btn = document.querySelector('button[data-test-id="bard-mode-menu-button"], button.input-area-switch');
        if (!btn) {
          return { status: 'no_mode_button', text: 'no encontrado' };
        }

        const currentText = (btn.innerText || btn.getAttribute('aria-label') || '').trim();

        // 2. Abrir el menú de modos para validar cuota y estado real
        btn.click();
        await new Promise(r => setTimeout(r, 500));

        // 3. Buscar la opción que contenga Argon (ej: "4 Argon")
        const menuItems = Array.from(document.querySelectorAll(
          '[data-test-id*="mode-option"], gem-menu-item, [role="menuitem"], .mat-mdc-menu-item'
        ));

        const argonItem = menuItems.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
          return t.includes('argon');
        });

        if (argonItem) {
          const itemText = (argonItem.innerText || argonItem.getAttribute('aria-label') || '').trim();
          const isLimitReached = (
            argonItem.hasAttribute('disabled') ||
            argonItem.classList.contains('disabled') ||
            argonItem.getAttribute('aria-disabled') === 'true' ||
            /(l[ií]mite|agotad|disponible de nuevo|try again later|limit reached|come back later)/i.test(itemText)
          );

          if (isLimitReached) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            return { status: 'argon_quota_exceeded', details: itemText };
          }

          argonItem.click();
          await new Promise(r => setTimeout(r, 700));
          const updatedText = btn.innerText.trim();
          return { status: 'switched_to_argon', from: currentText, to: updatedText, details: itemText };
        }

        // Si no se encontró en el menú pero el botón ya decía Argon, continuar
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        if (currentText.toLowerCase().includes('argon')) {
          return { status: 'already_argon', currentText };
        }
        return { status: 'argon_not_found_in_menu', currentText };
      })()
    `;

    const modelCheck = await sendCdpCommand(ws, 'Runtime.evaluate', {
      expression: modelSwitchCode,
      awaitPromise: true,
      returnByValue: true,
    });
    logDebug('Estado de selección de modelo:', JSON.stringify(modelCheck.result?.value));

    if (modelCheck.result?.value?.status === 'argon_quota_exceeded') {
      const details = modelCheck.result.value.details || '';
      return `⚠️ [ALERTA DE CUOTA AGOTADA EN GEMINI ARGON]\nGoogle indica que has alcanzado el límite de uso para el modelo 4 Argon en la web.\nDetalle mostrado por Gemini: "${details}"\n\n💡 Sugerencia: Puedes esperar el reinicio de cuota o utilizar temporalmente Gemini Flash en la web.`;
    }

    logDebug('Buscando caja de texto en Gemini Web...');
    const escapedPrompt = JSON.stringify(prompt);
    const injectCode = `
      (function() {
        const selectors = [
          'div.ql-editor',
          'div[contenteditable="true"]',
          'rich-textarea p',
          'rich-textarea div[contenteditable="true"]',
          'textarea[aria-label*="prompt"]',
          'textarea'
        ];
        
        let el = null;
        for (const sel of selectors) {
          const found = document.querySelector(sel);
          if (found && (found.offsetParent !== null || found.isContentEditable)) {
            el = found;
            break;
          }
        }
        
        if (!el) return { success: false, error: 'No se encontró el campo de texto de Gemini Web' };
        
        if (!el) return { success: false, error: 'No se encontró el campo de texto de Gemini Web' };
        
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        return { success: true };
      })()
    `;

    let injected = false;
    for (let i = 0; i < 15; i++) {
      const res = await sendCdpCommand(ws, 'Runtime.evaluate', {
        expression: injectCode,
        returnByValue: true,
      });
      if (res.result.value && res.result.value.success) {
        injected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!injected) {
      throw new Error('No se pudo encontrar el editor de texto de Gemini. ¿Iniciaste sesión en gemini.google.com en esa ventana de Chrome?');
    }

    // Capturar el estado de respuestas previo antes de enviar para evitar lecturas cacheadas
    const preSendCheck = await sendCdpCommand(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const els = document.querySelectorAll('message-content');
        return { count: els.length, text: els.length > 0 ? els[els.length - 1].innerText.trim() : '' };
      })()`,
      returnByValue: true
    });
    const initialCount = preSendCheck.result?.value?.count || 0;
    const initialLastText = preSendCheck.result?.value?.text || '';

    logDebug('Insertando texto mediante Input.insertText de CDP...');
    await sendCdpCommand(ws, 'Input.insertText', { text: prompt });
    await new Promise((r) => setTimeout(r, 400));

    logDebug('Enviando mensaje mediante click nativo de mouse...');
    const getCoordsCode = `
      (() => {
        const sendButtons = [
          'button[aria-label*="Enviar mensaje"]',
          'button[aria-label*="Enviar"]',
          'button[aria-label*="Send"]',
          'button.send-button',
          '.send-button-container button',
          'button[data-test-id="send-button"]'
        ];
        for (const sel of sendButtons) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            const rect = btn.getBoundingClientRect();
            return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
        return { found: false };
      })()
    `;

    const coordsRes = await sendCdpCommand(ws, 'Runtime.evaluate', {
      expression: getCoordsCode,
      returnByValue: true,
    });

    if (coordsRes.result?.value?.found) {
      const { x, y } = coordsRes.result.value;
      logDebug('Disparando click nativo de mouse vía CDP en coords:', Math.round(x), Math.round(y));
      await sendCdpCommand(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sendCdpCommand(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 100));
      await sendCdpCommand(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else {
      logDebug('Botón no clickeable, enviando Enter nativo vía CDP...');
      await sendCdpCommand(ws, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        unmodifiedText: '\\r',
        text: '\\r'
      });
      await sendCdpCommand(ws, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      });
    }

    logDebug('Esperando generación de respuesta...');
    await new Promise((r) => setTimeout(r, 2500));

    const waitForCompletionCode = `
      (function() {
        const isGenerating = !!document.querySelector(
          'button[aria-label*="Detener"], button[aria-label*="Stop"], .generating, [data-test-id="stop-button"]'
        );

        const responseEls = document.querySelectorAll(
          'message-content, model-response, .model-response-text'
        );
        
        let lastText = '';
        if (responseEls.length > 0) {
          const lastEl = responseEls[responseEls.length - 1];
          lastText = lastEl.innerText || lastEl.textContent || '';
        }

        const isNew = (responseEls.length > ${initialCount}) || (lastText.trim() !== ${JSON.stringify(initialLastText)});

        return {
          isGenerating: isGenerating,
          isNew: isNew,
          textLength: lastText.trim().length,
          lastText: lastText.trim()
        };
      })()
    `;

    let finalResponse = '';
    let stableCount = 0;
    let prevLength = -1;

    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await sendCdpCommand(ws, 'Runtime.evaluate', {
        expression: waitForCompletionCode,
        returnByValue: true,
      });

      const val = state.result.value || {};
      if (val.isNew && !val.isGenerating && val.textLength > 30) {
        if (val.textLength === prevLength) {
          stableCount++;
          if (stableCount >= 2) {
            finalResponse = val.lastText;
            break;
          }
        } else {
          stableCount = 0;
          prevLength = val.textLength;
        }
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!finalResponse) {
      const fallback = await sendCdpCommand(ws, 'Runtime.evaluate', {
        expression: `
          (function() {
            const els = document.querySelectorAll('model-response, message-content, .model-response-text');
            if (els.length > 0) return els[els.length - 1].innerText;
            return 'No se pudo capturar el texto final de la respuesta.';
          })()
        `,
        returnByValue: true,
      });
      finalResponse = fallback.result.value;
    }

    const quotaRegex = /(has alcanzado el l[ií]mite|l[ií]mite alcanzado para este modelo|you'?ve reached your limit|superado el l[ií]mite|prueba con gemini flash|l[ií]mite de mensajes)/i;
    if (quotaRegex.test(finalResponse)) {
      finalResponse = `🚨 [AVISO DE CUOTA AGOTADA EN GEMINI ARGON]\nGoogle indica que has alcanzado el límite de uso:\n\n${finalResponse}\n\n💡 Sugerencia: Puedes esperar el reinicio de la ventana de cuota o utilizar temporalmente Gemini Flash en la web.`;
    } else {
      sessionArgonPromptCount++;
      finalResponse = `${finalResponse}\n\n---\n📊 [Sesión MCP]: Consulta #${sessionArgonPromptCount} con Gemini 4 Argon.`;
    }

    return finalResponse;
  } finally {
    ws.close();
  }
}

// Bucle principal de JSON-RPC 2.0 (MCP stdio)
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    const { id, method, params } = request;

    if (method === 'initialize') {
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'gemini-web-argon',
            version: '1.0.0',
          },
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
    } else if (method === 'notifications/initialized') {
      // ack
    } else if (method === 'tools/list') {
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'gemini_web_ask',
              description:
                'Envía una consulta o instrucción a Gemini Web (con el modelo Gemini Argon / Advanced) en tu Google Chrome activo y devuelve la respuesta.',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'La instrucción, pregunta o tarea para Gemini Argon.',
                  },
                },
                required: ['prompt'],
              },
            },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const prompt = params?.arguments?.prompt;

      if (toolName === 'gemini_web_ask') {
        try {
          const answer = await askGeminiWeb(prompt);
          const response = {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: answer,
                },
              ],
            },
          };
          process.stdout.write(JSON.stringify(response) + '\n');
        } catch (err) {
          const errorResponse = {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error al interactuar con Gemini Web: ${err.message}`,
                },
              ],
              isError: true,
            },
          };
          process.stdout.write(JSON.stringify(errorResponse) + '\n');
        }
      } else {
        const errorResponse = {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Herramienta desconocida: ${toolName}`,
          },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    } else if (method === 'ping') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n');
    }
  } catch (err) {
    logDebug('Error procesando mensaje MCP:', err);
  }
});
