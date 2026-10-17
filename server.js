import readline from 'node:readline';

const CDP_PORT = 9222;

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
        
        el.focus();
        if (el.isContentEditable) {
          el.innerText = ${escapedPrompt};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.value = ${escapedPrompt};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        
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

    logDebug('Enviando mensaje...');
    await new Promise((r) => setTimeout(r, 500));

    const clickSendCode = `
      (function() {
        const sendButtons = [
          'button[aria-label*="Enviar"]',
          'button[aria-label*="Send"]',
          'button.send-button',
          '.send-button-container button',
          'button[data-test-id="send-button"]'
        ];
        for (const sel of sendButtons) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled) {
            btn.click();
            return { clicked: true, method: 'click' };
          }
        }
        
        const active = document.activeElement;
        if (active) {
          active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          return { clicked: true, method: 'enter' };
        }
        return { clicked: false };
      })()
    `;

    const sendRes = await sendCdpCommand(ws, 'Runtime.evaluate', {
      expression: clickSendCode,
      returnByValue: true,
    });
    logDebug('Resultado de envío:', JSON.stringify(sendRes.result.value));

    logDebug('Esperando generación de respuesta...');
    await new Promise((r) => setTimeout(r, 3000));

    const waitForCompletionCode = `
      (function() {
        const isGenerating = !!document.querySelector(
          'button[aria-label*="Detener"], button[aria-label*="Stop"], .generating, [data-test-id="stop-button"]'
        );

        const responseEls = document.querySelectorAll(
          'model-response, .model-response-text, message-content, .markdown'
        );
        
        let lastText = '';
        if (responseEls.length > 0) {
          const lastEl = responseEls[responseEls.length - 1];
          lastText = lastEl.innerText || lastEl.textContent || '';
        }

        return {
          isGenerating: isGenerating,
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
      if (!val.isGenerating && val.textLength > 0) {
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
