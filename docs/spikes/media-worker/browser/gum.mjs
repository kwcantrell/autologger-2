import { webkit } from 'playwright';
const b = await webkit.launch(); const c = await b.newContext({ permissions: ['microphone'] }); const p = await c.newPage();
await p.goto(process.argv[2]);
console.log(await p.evaluate(async () => { const r = { MediaRecorder: typeof MediaRecorder, AudioContext: typeof AudioContext, mediaDevices: !!navigator.mediaDevices };
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); r.gum = s.getAudioTracks().map(t => t.label); } catch (e) { r.gumError = e.name + ': ' + e.message; } return r; }));
await b.close();
