import { askGeminiWeb } from './server.js';

const prompt = process.argv.slice(2).join(' ') || 'Hola Gemini, responde con un breve saludo de 5 palabras para verificar conexion.';

console.log('Enviando prompt a Gemini Web:', prompt);
try {
  const res = await askGeminiWeb(prompt);
  console.log('--- RESPUESTA GEMINI WEB ---');
  console.log(res);
  console.log('--- FIN RESPUESTA ---');
  process.exit(0);
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
